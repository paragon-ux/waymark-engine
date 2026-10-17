import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { normalizeRelativePath, anchorForRange, resolveRepositoryFile } from "../src/paths.js";
import { verifyHop } from "../src/integrity.js";
import { collectRepoPaths, invalidatePathsCache } from "../src/discoveryRouter.js";
import { canonicalRoot, getDaemonAddress, getPidFilePath, stopDaemon, WaymarkDaemon, tryDaemonPing } from "../src/daemon.js";
import { getResidentClient, closeAllResidentClients, normalizeKeyRoot } from "../src/residentCodedb.js";
import { queryMultiSymbols, fuzzyCandidateCacheSize, pruneFuzzyCandidateCache, queryFuzzyCandidates, assertSupportedCodedbCommand, resolveCodedbCommand, runJson, queryStructural } from "../src/codedbAdapter.js";
import { logSessionEvent, resolveSessionLogPath, type SessionTelemetryEvent } from "../src/sessionLogger.js";
import { ask, capnStoreArgs, initCapn, publish, resolveCapnCommand } from "../src/capnAdapter.js";

import { getLiveDashboardHtml, LIVE_OBSERVER_HOST, startLiveReplObserver } from "../src/repl.js";
import { skipCodedb } from "./codedb.js";
import { discoverSymbolsInRepo } from "../src/astExtractor.js";
import { executePromptTest, loadManifest } from "../src/evaluator.js";
import { McpServer } from "../src/mcp/server.js";
import type { AskResult } from "../src/types.js";

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "waymark-audit-"));
}

test("path normalization accepts ..-prefixed filenames but rejects parent traversal", () => {
  assert.equal(normalizeRelativePath("..valid.ts"), "..valid.ts");
  assert.throws(() => normalizeRelativePath("../escape.ts"), /traversal/u);
  assert.throws(() => normalizeRelativePath("a/../../escape.ts"), /traversal/u);
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, "..valid.ts"), "export const valid = true;\n");
    assert.equal(path.basename(resolveRepositoryFile(root, "..valid.ts").real), "..valid.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("verifyHop validates persisted range and span before trusting a matching file hash", () => {
  const root = workspace();
  try {
    fs.writeFileSync(path.join(root, "source.ts"), "export function stable() {}\n");
    const anchor = anchorForRange(root, "source.ts", { start: 1, end: 1 });
    const base = {
      index: 0,
      path: "source.ts",
      label: "stable",
      inference: "test",
      range: { start: 1, end: 1 },
      ...anchor,
    };
    assert.equal(verifyHop(root, base, 10).status, "FRESH");
    assert.equal(verifyHop(root, { ...base, range: { start: 0, end: 1 } }, 10).status, "STALE");
    assert.equal(verifyHop(root, { ...base, normalizedSpanHash: "0".repeat(64) }, 10).status, "STALE");
    assert.equal(verifyHop(root, { ...base, spanLineCount: 2 }, 10).status, "STALE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("path discovery indexes supported hidden config directories and ignores runtime metadata", () => {
  const root = workspace();
  try {
    for (const file of [".github/workflows/check.yml", ".vscode/settings.json", ".git/config", ".capn/entries/a.md", ".waymark/sessions/active.jsonl", ".codedb/projects/x/data.log", ".codedb-core/projects/x/state", ".capn-hook/entries/a.md", ".claude/worktrees/wt/package.json", "node_modules/pkg/index.js"]) {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "fixture\n");
    }
    invalidatePathsCache();
    const first = collectRepoPaths(root);
    assert.ok(first.includes(".github/workflows/check.yml"));
    assert.ok(first.includes(".vscode/settings.json"));
    assert.ok(!first.some((p) => p.startsWith(".git/")));
    assert.ok(!first.some((p) => p.startsWith(".capn/")));
    assert.ok(!first.some((p) => p.startsWith(".waymark/")));
    for (const toolDir of [".codedb/", ".codedb-core/", ".capn-hook/", ".claude/"]) {
      assert.ok(!first.some((p) => p.startsWith(toolDir)), `${toolDir} must not appear in path results`);
    }
    assert.ok(!first.some((p) => p.startsWith("node_modules/")));
    const added = path.join(root, ".github", "new.yml");
    fs.writeFileSync(added, "new\n");
    invalidatePathsCache();
    assert.ok(collectRepoPaths(root).includes(".github/new.yml"));
  } finally {
    invalidatePathsCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("case-distinct repository roots keep distinct daemon and resident keys on case-sensitive hosts", (t) => {
  if (process.platform === "win32") return t.skip("Windows filesystems are commonly case-insensitive");
  const a = path.join(os.tmpdir(), `WaymarkCase-${process.pid}`);
  const b = path.join(os.tmpdir(), `waymarkcase-${process.pid}`);
  assert.notEqual(getDaemonAddress(a), getDaemonAddress(b));
  const command = { file: process.execPath, prefix: [], viaCmdShim: false };
  try {
    assert.notEqual(getResidentClient(a, command), getResidentClient(b, command));
  } finally {
    closeAllResidentClients();
  }
});

test("repository key normalization follows the selected platform case rules", () => {
  const upper = path.join(os.tmpdir(), "WaymarkCase", "Repo");
  const lower = path.join(os.tmpdir(), "waymarkcase", "repo");
  assert.notEqual(canonicalRoot(upper, "linux"), canonicalRoot(lower, "linux"));
  assert.notEqual(normalizeKeyRoot(upper, "linux"), normalizeKeyRoot(lower, "linux"));
  assert.equal(canonicalRoot(upper, "win32"), canonicalRoot(lower, "win32"));
  assert.equal(normalizeKeyRoot(upper, "win32"), normalizeKeyRoot(lower, "win32"));
});

test("force stop leaves forged and stale PID targets alone", async () => {
  const root = workspace();
  const pidFile = getPidFilePath(root);
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      if (victim.pid) resolve(); else victim.once("spawn", () => resolve());
      victim.once("error", reject);
    });
    fs.writeFileSync(getPidFilePath(root), String(victim.pid));
    assert.equal(await stopDaemon(root, { force: true, timeoutMs: 20 }), false);
    process.kill(victim.pid!, 0);
    assert.equal(fs.readFileSync(getPidFilePath(root), "utf8"), String(victim.pid));
    fs.writeFileSync(getPidFilePath(root), "2147483647");
    assert.equal(await stopDaemon(root, { force: true, timeoutMs: 20 }), false);
    assert.equal(fs.readFileSync(getPidFilePath(root), "utf8"), "2147483647");
  } finally {
    try { victim.kill("SIGKILL"); } catch {}
    try { fs.unlinkSync(pidFile); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("force stop gracefully stops the daemon at the selected repository socket", { skip: skipCodedb() }, async () => {
  const root = workspace();
  const daemon = new WaymarkDaemon(root, 0);
  try {
    await daemon.start();
    const recordedPid = Number(fs.readFileSync(daemon.pidFile, "utf8"));
    assert.equal(recordedPid, process.pid);
    assert.equal((await tryDaemonPing(root))?.ok, true);
    assert.equal(await stopDaemon(root, { force: true }), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    process.kill(recordedPid, 0);
    assert.equal(await tryDaemonPing(root, 50), null);
  } finally {
    daemon.stop();
    closeAllResidentClients();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live dashboard is loopback-only, omits permissive CORS, and renders telemetry as text", () => {
  assert.equal(LIVE_OBSERVER_HOST, "127.0.0.1");
  const html = getLiveDashboardHtml();
  assert.doesNotMatch(html, /innerHTML\s*=/u);
  assert.doesNotMatch(html, /Access-Control-Allow-Origin|\*\s*\/\s*\/\s*CORS/iu);

  class Element {
    children: Element[] = [];
    className = "";
    textContent = "";
    get firstChild(): Element | undefined { return this.children[0]; }
    appendChild(child: Element): void { this.children.push(child); }
    insertBefore(child: Element, before?: Element): void {
      const index = before ? this.children.indexOf(before) : -1;
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    }
    replaceChildren(): void { this.children = []; }
  }
  const listeners: Record<string, (event: { data: string }) => void> = {};
  const elements = new Map<string, Element>();
  const document = {
    getElementById(id: string) { const value = elements.get(id) ?? new Element(); elements.set(id, value); return value; },
    createElement() { return new Element(); },
  };
  const eventSourceUrls: string[] = [];
  class EventSource {
    constructor(url: string) { eventSourceUrls.push(url); }
    addEventListener(name: string, callback: (event: { data: string }) => void) { listeners[name] = callback; }
  }
  const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  vm.runInNewContext(script, {
    document,
    EventSource,
    URLSearchParams,
    encodeURIComponent,
    window: { location: { search: "?token=unit-test-token" } },
  });
  assert.deepEqual(eventSourceUrls, ["/events?token=unit-test-token"]);
  const hostile = "<img src=x onerror=alert(1)><script>alter()</script>";
  listeners.query!({ data: JSON.stringify({
    timestamp: hostile,
    caller: hostile,
    query: hostile,
    tierRoute: hostile,
    matchedSymbol: hostile,
    matchedPath: hostile,
    status: "hit\"><img src=x>",
    latencyMs: 1,
    payloadTokens: 2,
    tokensSavedPct: 3,
  }) });
  const eventList = elements.get("event-list")!;
  assert.equal(eventList.children.length, 1);
  const flattened = (node: Element): string => node.textContent + node.children.map(flattened).join("");
  assert.ok(flattened(eventList).includes(hostile));
  assert.ok(eventList.children.every((node) => node.children.length === 2));
});

test("opted-in live dashboard requires its token, rejects hostile origins and hosts, and forbids framing", async () => {
  const root = workspace();
  const portProbe = createServer();
  await new Promise<void>((resolve, reject) => {
    portProbe.once("error", reject);
    portProbe.listen(0, LIVE_OBSERVER_HOST, () => resolve());
  });
  const address = portProbe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));

  const env: NodeJS.ProcessEnv = { ...process.env, WAYMARK_TELEMETRY: "1", WAYMARK_DISABLE_RESIDENT: "1" };
  delete env.WAYMARK_HOOK_DISABLED;
  delete env.WAYMARK_HOOK_DEPTH;
  const cli = path.resolve(import.meta.dirname, "../src/cli.js");
  const child = spawn(process.execPath, [cli, "repl", "--live", "--port", String(port), "--root", root], {
    stdio: ["pipe", "pipe", "pipe"], env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    let viewerUrl: URL | undefined;
    for (let attempt = 0; attempt < 40 && !viewerUrl; attempt++) {
      const match = stdout.match(/Web Viewer:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/u);
      if (match?.[1]) viewerUrl = new URL(match[1]);
      else if (child.exitCode !== null) break;
      else await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(viewerUrl, `observer did not start or print its access URL: ${stderr}\n${stdout}`);
    assert.equal(viewerUrl.searchParams.get("token")?.length, 43);
    const base = new URL(viewerUrl);
    base.search = "";
    const tokenless = await fetch(base);
    assert.equal(tokenless.status, 403);
    assert.equal((await fetch(new URL("/events", base))).status, 403);
    assert.equal((await fetch(new URL("/api/stats", base))).status, 403);

    const forgedHostStatuses = await Promise.all([false, true].map((absoluteForm) => new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        hostname: base.hostname,
        port: Number(base.port),
        path: absoluteForm ? viewerUrl!.href : viewerUrl!.pathname + viewerUrl!.search,
        headers: { Host: "attacker.example" },
      }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    })));
    assert.deepEqual(forgedHostStatuses, [403, 403]);

    const hostileOrigin = await fetch(viewerUrl, { headers: { Origin: "https://attacker.example" } });
    assert.equal(hostileOrigin.status, 403);
    const response = await fetch(viewerUrl);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.match(await response.text(), /<script nonce="[A-Za-z0-9+/=]+">/u);

    const statsUrl = new URL(viewerUrl);
    statsUrl.pathname = "/api/stats";
    const stats = await fetch(statsUrl, { headers: { Origin: viewerUrl.origin } });
    assert.equal(stats.status, 200);
    assert.equal((await stats.json() as { total: number }).total, 0);

    const eventsUrl = new URL(`/events${viewerUrl.search}`, viewerUrl);
    const hostileEvents = await fetch(eventsUrl, { headers: { Origin: "https://attacker.example" } });
    assert.equal(hostileEvents.status, 403);
    const events = await fetch(eventsUrl, { headers: { Origin: viewerUrl.origin } });
    assert.equal(events.status, 200);
    await events.body?.cancel();
  } finally {
    try { child.kill(); } catch {}
    if (child.exitCode === null) await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live observer does not create a persistent log unless telemetry is opted in", async () => {
  const root = workspace();
  const oldTelemetry = process.env.WAYMARK_TELEMETRY;
  try {
    delete process.env.WAYMARK_TELEMETRY;
    await startLiveReplObserver({ rootDir: root, port: 0 });
    assert.equal(fs.existsSync(resolveSessionLogPath(root)), false);
  } finally {
    if (oldTelemetry === undefined) delete process.env.WAYMARK_TELEMETRY; else process.env.WAYMARK_TELEMETRY = oldTelemetry;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("multi-symbol accounting deduplicates names and ignores empty names", { skip: skipCodedb() }, async () => {
  const result = await queryMultiSymbols(path.resolve(import.meta.dirname, ".."), ["verifyHop", "verifyHop", "", "MissingAuditSymbolXYZ"]);
  assert.equal(result.total, 2);
  assert.equal(result.hits, 1);
  assert.equal(result.misses, 1);
  assert.equal(result.hits + result.misses, result.total);
  assert.deepEqual(Object.keys(result.symbols).sort(), ["MissingAuditSymbolXYZ", "verifyHop"]);
  const empty = await queryMultiSymbols(path.resolve(import.meta.dirname, ".."), []);
  assert.deepEqual({ status: empty.status, total: empty.total, hits: empty.hits, misses: empty.misses }, { status: "miss", total: 0, hits: 0, misses: 0 });
});

test("concurrent asks keep daemon selection request-scoped", { skip: skipCodedb() }, async () => {
  const root = workspace();
  const oldAuto = process.env.WAYMARK_AUTO_DAEMON;
  const oldDaemon = process.env.WAYMARK_DAEMON;
  const oldTelemetry = process.env.WAYMARK_TELEMETRY;
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "sample.ts"), "export function target() {}\nexport function caller() { target(); }\n");
    delete process.env.WAYMARK_AUTO_DAEMON;
    delete process.env.WAYMARK_DAEMON;
    delete process.env.WAYMARK_TELEMETRY;
    const [daemonResult, coldResult] = await Promise.all([
      ask(root, "capn-cli", "", "Who calls target?", { tier: "ast", daemon: true, dev: true }),
      ask(root, "capn-cli", "", "Who calls caller?", { tier: "ast", daemon: false, dev: true }),
    ]);
    assert.equal(daemonResult.status, "hit");
    assert.equal(coldResult.status, "hit");
    assert.equal((daemonResult as AskResult).dev?.daemonIpcUsed, true);
    assert.equal((coldResult as AskResult).dev?.daemonIpcUsed, false);
    assert.equal(process.env.WAYMARK_AUTO_DAEMON, undefined);
    assert.equal(process.env.WAYMARK_DAEMON, undefined);
  } finally {
    if (oldAuto === undefined) delete process.env.WAYMARK_AUTO_DAEMON; else process.env.WAYMARK_AUTO_DAEMON = oldAuto;
    if (oldDaemon === undefined) delete process.env.WAYMARK_DAEMON; else process.env.WAYMARK_DAEMON = oldDaemon;
    if (oldTelemetry === undefined) delete process.env.WAYMARK_TELEMETRY; else process.env.WAYMARK_TELEMETRY = oldTelemetry;
    await stopDaemon(root, { force: true });
    closeAllResidentClients();
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows command shims are rejected before cold and resident execution", async (t) => {
  const shim = { file: "C:/tools/codedb.cmd", prefix: [], viaCmdShim: true };
  assert.throws(() => assertSupportedCodedbCommand(shim, "win32"), (error: any) => error.code === "CODEDB_UNSUPPORTED_SHIM");
  assert.doesNotThrow(() => assertSupportedCodedbCommand({ ...shim, file: "C:/tools/codedb.exe", viaCmdShim: false }, "win32"));
  if (process.platform !== "win32") return t.skip("Windows process launch path is host-specific");
  const root = workspace();
  const oldDisable = process.env.WAYMARK_DISABLE_RESIDENT;
  try {
    process.env.WAYMARK_DISABLE_RESIDENT = "1";
    await assert.rejects(() => runJson(root, shim, ["symbol", "x", "--json"]), (error: any) => error.code === "CODEDB_UNSUPPORTED_SHIM");
    delete process.env.WAYMARK_DISABLE_RESIDENT;
    await assert.rejects(() => runJson(root, shim, ["symbol", "x", "--json"]), (error: any) => error.code === "CODEDB_UNSUPPORTED_SHIM");
    await assert.rejects(() => getResidentClient(root, shim).send(["symbol", "x", "--json"]), (error: any) => error.code === "CODEDB_UNSUPPORTED_SHIM");
  } finally {
    if (oldDisable === undefined) delete process.env.WAYMARK_DISABLE_RESIDENT; else process.env.WAYMARK_DISABLE_RESIDENT = oldDisable;
    closeAllResidentClients();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("codedb execution failures remain errors across structural, ask, batch, and repo-symbol APIs", async () => {
  const root = workspace();
  const missing = path.join(root, "missing-codedb.exe");
  const oldDisable = process.env.WAYMARK_DISABLE_RESIDENT;
  const oldExecutable = process.env.WAYMARK_CODEDB_EXECUTABLE;
  try {
    process.env.WAYMARK_DISABLE_RESIDENT = "1";
    const command = resolveCodedbCommand(missing);
    const run = await runJson(root, command, ["symbol", "Absent", "--json"]);
    assert.equal(run.ok, false);
    const structural = await queryStructural({ requiresParser: true, tool: "search_graph", query: "Absent" }, root, missing);
    assert.equal(structural.hit, false);
    assert.equal(structural.error, true);
    process.env.WAYMARK_CODEDB_EXECUTABLE = missing;
    const answer = await ask(root, "capn-cli", "", "Where is Absent declared?", { tier: "ast" });
    assert.equal(answer.status, "error");
    if (answer.status === "error") assert.equal(answer.errorCode, "CODEDB_BINARY_MISSING");
    await assert.rejects(() => queryMultiSymbols(root, ["Absent"], missing), (error: any) => error.code === "CODEDB_BINARY_MISSING");
    await assert.rejects(() => discoverSymbolsInRepo(root, "Absent"), (error: any) => error.code === "CODEDB_PROCESS_ERROR" && /ENOENT/u.test(error.message));
  } finally {
    if (oldDisable === undefined) delete process.env.WAYMARK_DISABLE_RESIDENT; else process.env.WAYMARK_DISABLE_RESIDENT = oldDisable;
    if (oldExecutable === undefined) delete process.env.WAYMARK_CODEDB_EXECUTABLE; else process.env.WAYMARK_CODEDB_EXECUTABLE = oldExecutable;
    closeAllResidentClients();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("semantic memory accepts topical lexical matches and rejects generic-token false positives", async () => {
  const root = workspace();
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, "notes.md"), "Payment webhook retries use a bounded exponential backoff schedule.\n");
    await initCapn(root);
    await publish(root, "capn-cli", "", "Where is type validation declared?", "The type validation policy constrains how the service handles declared values. Payment webhook retries use a bounded exponential backoff schedule.", ["notes.md"]);

    const backend = resolveCapnCommand("");
    const raw = execFileSync(backend.file, [...backend.prefix, ...capnStoreArgs(root), "ask", "Where is TotallyFakeClassDeclared?"], { cwd: root, encoding: "utf8" }).trim();
    assert.ok(raw.includes("Where is type validation declared?"), "fixture must reproduce a generic-token BM25 result");

    const positive = await ask(root, "capn-cli", "", "How do payment webhooks retry?", { tier: "capn", autoResolve: true });
    assert.equal(positive.status, "hit");
    const ambiguous = await ask(root, "capn-cli", "", "Which type validation policy is used?", { tier: "capn", autoResolve: true });
    assert.equal(ambiguous.status, "hit");
    const negative = await ask(root, "capn-cli", "", "Where is TotallyFakeClassDeclared?", { tier: "capn", autoResolve: true });
    assert.equal(negative.status, "miss");
    const adversarial = await ask(root, "capn-cli", "", "Where is $$TotallyFakeClassDeclared$$?", { tier: "capn", autoResolve: true });
    assert.equal(adversarial.status, "miss");
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("prompt evaluator enforces route, file, unsupported-step, and verification expectations", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const base = { id: "audit", category: "audit", name: "path discovery", path: "src/paths.ts", query: "sha256", expected_status: "hit" as const };
  assert.equal((await executePromptTest({ ...base, expected_routing: "tree-sitter", expected_file: "src/paths.ts" }, root)).passed, true);
  assert.equal((await executePromptTest({ ...base, expected_routing: "codedb", expected_file: "src/paths.ts" }, root)).passed, false);
  assert.equal((await executePromptTest({ ...base, expected_routing: "tree-sitter", expected_file: "src/types.ts" }, root)).passed, false);
  assert.equal((await executePromptTest({ ...base, expected_range: [1, 1], expected_anchor: "0".repeat(64) }, root)).passed, false);
  assert.equal((await executePromptTest({ ...base, expected_callers: [] }, root)).passed, false);
  assert.equal((await executePromptTest({ ...base, expected_range: [999, 1000] }, root)).passed, false);
  assert.equal((await executePromptTest({ id: "batch-symbol", category: "audit", name: "batch symbol expectation", symbols: ["ask"], expected_routing: "multi-symbols", expected_status: "hit", expected_symbol: "ask" }, root)).passed, true);

  const routedStep = await executePromptTest({
    id: "route-step", category: "audit", name: "actual step route", expected_routing: "agentic-pipeline", expected_status: "hit",
    steps: [{ step: 1, tool: "discover", args: { path: "src/integrity.ts", query: "verifyHop" }, expected_status: "hit", expected_routing: "tree-sitter", expected_file: "src/integrity.ts", expected_symbol: "verifyHop" }],
  }, root);
  assert.equal(routedStep.passed, true);
  const ignoredTopLevelExpectation = await executePromptTest({
    id: "top-level-step", category: "audit", name: "top-level step expectation", expected_routing: "agentic-pipeline", expected_status: "hit", expected_symbol: "NotVerifyHop",
    steps: [{ step: 1, tool: "discover", args: { path: "src/integrity.ts", query: "verifyHop" }, expected_symbol: "verifyHop" }],
  }, root);
  assert.equal(ignoredTopLevelExpectation.passed, false);
  const echoedStepRoute = await executePromptTest({
    id: "echoed-route", category: "audit", name: "tool name is not a route", expected_routing: "agentic-pipeline", expected_status: "hit",
    steps: [{ step: 1, tool: "discover", args: { path: "src/integrity.ts", query: "verifyHop" }, expected_status: "hit", expected_routing: "discover" }],
  }, root);
  assert.equal(echoedStepRoute.passed, false);

  const unsupported = await executePromptTest({
    id: "unsupported", category: "audit", name: "unsupported chart", expected_routing: "agentic-pipeline", expected_status: "hit",
    steps: [{ step: 1, tool: "chart", args: {} }],
  }, root);
  assert.equal(unsupported.passed, false);
  assert.match(unsupported.details ?? "", /Unsupported prompt step tool: chart/u);

  const wrongCaller = await executePromptTest({
    id: "caller", category: "audit", name: "wrong caller", expected_routing: "agentic-pipeline", expected_status: "hit",
    steps: [{ step: 1, tool: "ask", args: { question: "Who calls verifyHop?" }, expected_status: "hit", expected_callers: ["NeverCallsVerifyHop"], expected_callees: ["NeverCallee"] }],
  }, root);
  assert.equal(wrongCaller.passed, false);

  const wrongStepAnchor = await executePromptTest({
    id: "anchor", category: "audit", name: "wrong step anchor", expected_routing: "agentic-pipeline", expected_status: "hit",
    steps: [{ step: 1, tool: "verify", args: { target: "verifyHop" }, expected_valid: true, expected_anchor: "0".repeat(64) }],
  }, root);
  assert.equal(wrongStepAnchor.passed, false);

  const escapedExpectedFile = await executePromptTest({
    id: "escaped-file", category: "audit", name: "unresolvable expected path", expected_routing: "agentic-pipeline", expected_status: "hit",
    steps: [{ step: 1, tool: "verify", args: { target: "NoSuchPromptSymbolXYZ" }, expected_status: "miss", expected_valid: false, expected_file: "../outside.ts" }],
  }, root);
  assert.equal(escapedExpectedFile.passed, false);

  const invalidVerify = await executePromptTest({
    id: "verify", category: "audit", name: "invalid span verification", expected_routing: "agentic-pipeline", expected_status: "hit",
    steps: [{ step: 1, tool: "verify", args: { hop: { index: 0, path: "src/paths.ts", range: { start: 0, end: 0 } } }, expected_valid: true }],
  }, root);
  assert.equal(invalidVerify.passed, false);

  const manifest = path.join(workspace(), "invalid.jsonl");
  try {
    fs.writeFileSync(manifest, "{not-json}\n");
    assert.throws(() => loadManifest(manifest), /Invalid prompt manifest line 1/u);
    fs.writeFileSync(manifest, `${JSON.stringify({ id: "unknown", category: "audit", expected_unchecked: true })}\n`);
    assert.throws(() => loadManifest(manifest), /unsupported expectation: expected_unchecked/u);
    fs.writeFileSync(manifest, `${JSON.stringify({ id: "empty", category: "audit", steps: [] })}\n`);
    assert.throws(() => loadManifest(manifest), /steps must not be empty/u);
    fs.writeFileSync(manifest, `${JSON.stringify({ id: "range", category: "audit", range: [1, 2] })}\n`);
    assert.throws(() => loadManifest(manifest), /range is only supported for integrity records/u);
  } finally {
    fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
  }
});

test("subsystem requests are rejected across public, CLI, and MCP entry points", async () => {
  const root = workspace();
  try {
    const api = await ask(root, "capn-cli", "", "find symbols", { subsystem: "packages/api" });
    assert.equal(api.status, "error");
    if (api.status === "error") assert.equal(api.errorCode, "UNSUPPORTED_SUBSYSTEM");
    const noMemory = await ask(root, "none", "", "find symbols", { subsystem: "packages/api" });
    assert.equal(noMemory.status, "error");
    if (noMemory.status === "error") assert.equal(noMemory.errorCode, "UNSUPPORTED_SUBSYSTEM");

    const server = new McpServer({ root });
    for (const [name, args] of [
      ["waymark_ask", { question: "find symbols", subsystem: "packages/api", root }],
      ["waymark_memory", { action: "bootstrap", subsystem: "packages/api", root }],
      ["waymark_discover_symbols", { query: "Thing", subsystem: "packages/api", root }],
    ] as const) {
      const response = await server.handleMessage(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
      }));
      const body = JSON.parse(response ?? "{}");
      assert.equal(body.result?.isError, true, `${name} should reject subsystem scope`);
      assert.match(body.result?.content?.[0]?.text ?? "", /UNSUPPORTED_SUBSYSTEM/u);
    }

    const cli = path.resolve(import.meta.dirname, "../src/cli.js");
    assert.throws(
      () => execFileSync(process.execPath, [cli, "ask", "find symbols", "--subsystem", "packages/api", "--root", root, "--json"], { encoding: "utf8" }),
      (error: any) => error.status === 1 && String(error.stdout).includes("UNSUPPORTED_SUBSYSTEM"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fuzzy candidate cache expires entries and remains bounded under distinct queries", { skip: skipCodedb() }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (let i = 0; i < 270; i++) await queryFuzzyCandidates(`AuditCacheUniqueToken${i}`, root);
  assert.ok(fuzzyCandidateCacheSize() <= 256);
  pruneFuzzyCandidateCache(Date.now() + 60_001);
  assert.equal(fuzzyCandidateCacheSize(), 0);
});

function telemetryEvent(root: string, query: string): SessionTelemetryEvent {
  return {
    timestamp: new Date().toISOString(), caller: "cli", repoRoot: root, query,
    category: "ask", tierRoute: "Miss", payloadTokens: 1, latencyMs: 1, status: "miss",
  };
}

test("query telemetry is opt-in; explicit opt-in writes persistent events", () => {
  const root = workspace();
  const oldTelemetry = process.env.WAYMARK_TELEMETRY;
  const oldNoLog = process.env.WAYMARK_NO_LOG;
  const logPath = resolveSessionLogPath(root);
  try {
    delete process.env.WAYMARK_TELEMETRY;
    delete process.env.WAYMARK_NO_LOG;
    logSessionEvent(telemetryEvent(root, "private query"));
    assert.equal(fs.existsSync(logPath), false);
    process.env.WAYMARK_TELEMETRY = "1";
    logSessionEvent(telemetryEvent(root, "opted-in query"));
    assert.equal(fs.readFileSync(logPath, "utf8").trim().split("\n").length, 1);
  } finally {
    if (oldTelemetry === undefined) delete process.env.WAYMARK_TELEMETRY; else process.env.WAYMARK_TELEMETRY = oldTelemetry;
    if (oldNoLog === undefined) delete process.env.WAYMARK_NO_LOG; else process.env.WAYMARK_NO_LOG = oldNoLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary query logs positive latency only with telemetry opt-in", async () => {
  const root = workspace();
  const oldTelemetry = process.env.WAYMARK_TELEMETRY;
  const oldNoLog = process.env.WAYMARK_NO_LOG;
  try {
    fs.writeFileSync(path.join(root, "config.ts"), "export const value = true\n");
    delete process.env.WAYMARK_NO_LOG;
    delete process.env.WAYMARK_TELEMETRY;
    const privateResult = await ask(root, "capn-cli", "", "config.ts");
    assert.equal(privateResult.status, "hit");
    assert.equal(fs.existsSync(resolveSessionLogPath(root)), false);
    process.env.WAYMARK_TELEMETRY = "1";
    const loggedResult = await ask(root, "capn-cli", "", "config.ts");
    assert.equal(loggedResult.status, "hit");
    const event = JSON.parse(fs.readFileSync(resolveSessionLogPath(root), "utf8").trim()) as SessionTelemetryEvent;
    assert.ok(event.latencyMs >= 1);
  } finally {
    if (oldTelemetry === undefined) delete process.env.WAYMARK_TELEMETRY; else process.env.WAYMARK_TELEMETRY = oldTelemetry;
    if (oldNoLog === undefined) delete process.env.WAYMARK_NO_LOG; else process.env.WAYMARK_NO_LOG = oldNoLog;
    invalidatePathsCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
