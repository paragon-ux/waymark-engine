// Regressions for the waymark-engine reviews of f859003: unindexed extensions, qualified names,
// file-scoped asks, traversal options, literal-vs-symbol routing, path collisions, memory freshness,
// facet charting, bootstrap/heal, plain-text rendering, and the MCP server's prompts and daemons.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { McpServer } from "../src/mcp/server.js";
import { ask } from "../src/capnAdapter.js";
import { queryMultiSymbols } from "../src/codedbAdapter.js";
import { discoverSymbolsInRepo } from "../src/astExtractor.js";
import { collectRepoPaths, detectLiteralIntent, invalidatePathsCache, isSkippedDir, routeDiscovery } from "../src/discoveryRouter.js";
import { canonicalRoot, WaymarkDaemon } from "../src/daemon.js";
import { parseChartedEntry, readChartedEntries } from "../src/memoryEntries.js";
import {
  bootstrapSemanticMap,
  chartMemoryEntry,
  getSemanticMapStatus,
  healSemanticMap,
  isNotApplicableAnswer,
  normalizeFacetQuestion,
} from "../src/semanticMap.js";
import { renderPlainText } from "../src/renderPlainText.js";
import { closeAllResidentClients } from "../src/residentCodedb.js";
import { memoryStoreDir } from "../src/stateDir.js";
import type { CallGraphData } from "../src/types.js";
import { initMemoryStoreSync } from "./capnContract.js";
import { skipCodedb } from "./codedb.js";

function write(repo: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, "utf8");
}

function gitRepo(prefix: string, files: Record<string, string>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  for (const [rel, text] of Object.entries(files)) write(repo, rel, text);
  return repo;
}

const FIXTURE_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "demo", main: "main.js", scripts: { build: "tsc", test: "node --test" } }, null, 2),
  "scripts/hook.mjs": [
    "export function rewriteCommandWithRtk(cmd) {",
    "  return normalizeCommand(cmd);",
    "}",
    "function normalizeCommand(cmd) {",
    "  return cmd.trim();",
    "}",
    "",
  ].join("\n"),
  "lib/helpers.cjs": "function helperFn(x) {\n  return x;\n}\nmodule.exports = { helperFn };\n",
  "src/widget.mts": "export class Widget {\n  render(): string {\n    return \"w\";\n  }\n}\n",
  "src/conf.cts": "export const loadConf = (): number => 1;\n",
  "Cargo.toml": "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
  "main.js": [
    'import { rewriteCommandWithRtk } from "./scripts/hook.mjs";',
    "export function runMain() {",
    '  return rewriteCommandWithRtk(" x ");',
    "}",
    "",
  ].join("\n"),
  "src/daemon.ts": [
    "export class WaymarkDaemon {",
    "  start(): number {",
    "    return boot();",
    "  }",
    "}",
    "export class Mutex {",
    "  lock(): void {}",
    "}",
    "export function boot(): number {",
    "  return 1;",
    "}",
    "",
  ].join("\n"),
  "src/app.ts": 'import { boot } from "./daemon";\nexport function launch(): number {\n  return boot();\n}\n',
  "src/empty.ts": "",
};

/** Resident codedb holds the repository open on Windows, so it is closed before the folder is removed. */
async function removeRepo(repo: string): Promise<void> {
  closeAllResidentClients();
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      fs.rmSync(repo, { recursive: true, force: true });
      return;
    } catch (error) {
      // The killed codedb process can take a moment to release its working directory.
      if ((error as NodeJS.ErrnoException).code !== "EBUSY" || Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function fixtureRepo(): string {
  const repo = gitRepo("waymark-review-", FIXTURE_FILES);
  initMemoryStoreSync(repo);
  return repo;
}

async function toolCall(server: McpServer, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; body: any }> {
  const raw = await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
  const parsed = JSON.parse(raw ?? "{}");
  const text = parsed.result?.content?.[0]?.text ?? "";
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { isError: parsed.result?.isError === true, text, body };
}

async function rpc(server: McpServer, method: string, params: Record<string, unknown>): Promise<any> {
  return JSON.parse((await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }))) ?? "{}");
}

const noMemory = async () => ({ hit: false, result: null });

// ---------------------------------------------------------------------------
// 1. AST, call graph & router
// ---------------------------------------------------------------------------

test(".mjs/.cjs/.mts/.cts/.toml definitions resolve through the tree-sitter fallback", { skip: skipCodedb() }, async () => {
  const repo = fixtureRepo();
  try {
    const def = await ask(repo, "capn-cli", "", "rewriteCommandWithRtk");
    assert.equal(def.status, "hit");
    assert.match(String((def as any).result), /rewriteCommandWithRtk function scripts\/hook\.mjs 1/u);

    const qualified = await ask(repo, "capn-cli", "", "Widget.render");
    assert.equal(qualified.status, "hit");
    assert.match(String((qualified as any).result), /Widget\.render method src\/widget\.mts 2/u);

    const toml = await ask(repo, "capn-cli", "", "package.name");
    assert.equal(toml.status, "hit");
    assert.match(String((toml as any).result), /Cargo\.toml/u);

    const batch = await queryMultiSymbols(repo, ["rewriteCommandWithRtk", "helperFn", "Widget.render", "loadConf", "noSuchSymbolAnywhere"]);
    assert.equal(batch.hits, 4);
    assert.equal(batch.symbols.helperFn?.path, "lib/helpers.cjs");
    assert.equal(batch.symbols.loadConf?.path, "src/conf.cts");
    assert.equal(batch.symbols.noSuchSymbolAnywhere?.status, "miss");

    const listed = await discoverSymbolsInRepo(repo, "helperFn");
    assert.ok(listed.results.some((r) => r.path === "lib/helpers.cjs"), JSON.stringify(listed));

    const arch = await ask(repo, "capn-cli", "", "architecture");
    assert.equal(arch.status, "hit");
    assert.match(String((arch as any).result), /scripts\/hook\.mjs javascript \d+ lines [1-9]\d* symbols/u);
    assert.match(String((arch as any).result), /src\/widget\.mts typescript \d+ lines [1-9]\d* symbols/u);
    assert.match(String((arch as any).result), /Cargo\.toml toml \d+ lines [1-9]\d* symbols/u);
  } finally {
    await removeRepo(repo);
  }
});

test("call graphs reach .mjs definitions, with callers from codedb-indexed files", { skip: skipCodedb() }, async () => {
  const repo = fixtureRepo();
  try {
    const flat = await ask(repo, "capn-cli", "", "who calls rewriteCommandWithRtk");
    assert.equal(flat.status, "hit");
    assert.match(String((flat as any).result), /callers: runMain/u);
    assert.match(String((flat as any).result), /callees: normalizeCommand/u);

    const deep = await ask(repo, "capn-cli", "", "who calls rewriteCommandWithRtk", { depth: 2, direction: "callees" });
    const graph = (deep as any).result as CallGraphData;
    assert.equal(graph.tool, "call_graph");
    assert.equal(graph.path, "scripts/hook.mjs");
    assert.deepEqual(graph.callees?.map((n) => n.name), ["normalizeCommand"]);
    assert.equal(graph.callers, undefined);
  } finally {
    await removeRepo(repo);
  }
});

test("qualified Class.method resolves in search_graph, multi-symbol, and repo discovery", { skip: skipCodedb() }, async () => {
  const repo = fixtureRepo();
  try {
    for (const question of ["WaymarkDaemon.start", "where is WaymarkDaemon.start"]) {
      const res = await ask(repo, "capn-cli", "", question);
      assert.equal(res.status, "hit", question);
      assert.match(String((res as any).result), /WaymarkDaemon\.start method src\/daemon\.ts 2/u, question);
    }
    const batch = await queryMultiSymbols(repo, ["WaymarkDaemon.start", "Mutex.lock"]);
    assert.equal(batch.hits, 2);
    assert.equal(batch.symbols["WaymarkDaemon.start"]?.line, 2);
    // A dotted name with no qualified match is never widened to an arbitrary bare match in a batch.
    assert.equal((await queryMultiSymbols(repo, ["Nope.start"])).symbols["Nope.start"]?.status, "miss");

    const listed = await discoverSymbolsInRepo(repo, "WaymarkDaemon.start");
    assert.equal(listed.count, 1);
    assert.equal(listed.results[0]?.path, "src/daemon.ts");
  } finally {
    await removeRepo(repo);
  }
});

test("direction is honored without depth, and a bare symbol with a traversal option is traced", { skip: skipCodedb() }, async () => {
  const repo = fixtureRepo();
  try {
    const callers = await ask(repo, "capn-cli", "", "who calls boot", { direction: "callers" });
    const graph = (callers as any).result as CallGraphData;
    assert.equal(graph.tool, "call_graph");
    assert.equal(graph.direction, "callers");
    assert.equal(graph.callees, undefined);
    assert.ok(graph.callers?.some((n) => n.name === "launch"), JSON.stringify(graph));

    const traced = await ask(repo, "capn-cli", "", "boot", { depth: 1 });
    assert.equal(((traced as any).result as CallGraphData).tool, "call_graph");
    const plain = await ask(repo, "capn-cli", "", "boot");
    assert.match(String((plain as any).result), /^total: /u);
  } finally {
    await removeRepo(repo);
  }
});

test("a dotted method whose name is a file extension falls back to a symbol lookup", { skip: skipCodedb() }, async () => {
  const repo = fixtureRepo();
  try {
    assert.equal(detectLiteralIntent("Mutex.lock").couldBeSymbol, true);
    assert.equal(detectLiteralIntent("src/Mutex.lock").couldBeSymbol, false);
    const res = await ask(repo, "capn-cli", "", "Mutex.lock");
    assert.equal(res.status, "hit");
    assert.equal((res as any).provider, "codedb");
    assert.match(String((res as any).result), /Mutex\.lock method src\/daemon\.ts 7/u);
    // A real file still wins, and a missing literal that is no symbol still misses as a path.
    assert.equal((await ask(repo, "capn-cli", "", "package.json")).status, "hit");
    const missing = await ask(repo, "capn-cli", "", "nothing.lock");
    assert.equal(missing.status, "miss");
    assert.equal((missing as any).provider, "literal-path");
  } finally {
    await removeRepo(repo);
  }
});

test("waymark_ask path + query filters that file without outline, and 0 symbols misses either way", async () => {
  const repo = fixtureRepo();
  const server = new McpServer({ root: repo, enableDaemon: false });
  try {
    const filtered = await toolCall(server, "waymark_ask", { root: repo, path: "package.json", query: "scripts" });
    assert.equal(filtered.isError, false);
    assert.equal(filtered.body.path, "package.json");
    assert.ok(filtered.body.symbols.length > 0);
    assert.ok(filtered.body.symbols.every((s: any) => s.name.includes("scripts")), filtered.text);

    const plain = await toolCall(server, "waymark_ask", { root: repo, path: "package.json", query: "scripts", plain: true });
    assert.match(plain.text, /^\[symbols: package\.json\]/u);

    for (const args of [
      { path: "package.json", query: "noSuchKey" },
      { path: "package.json", query: "noSuchKey", outline: true },
      { path: "src/empty.ts" },
      { path: "src/empty.ts", outline: true },
    ]) {
      const res = await toolCall(server, "waymark_ask", { root: repo, ...args });
      assert.equal(res.body?.status, "miss", JSON.stringify(args));
      assert.equal(res.body?.missCode, "SYMBOL_NOT_FOUND", JSON.stringify(args));
    }

    // A path with a question is answered from that file only.
    const scoped = await toolCall(server, "waymark_ask", { root: repo, path: "src/daemon.ts", question: "where is start defined" });
    assert.equal(scoped.body.status, "hit");
    assert.equal(scoped.body.result.path, "src/daemon.ts");
    assert.deepEqual(scoped.body.result.symbols.map((s: any) => s.name), ["start"]);
    const scopedMiss = await toolCall(server, "waymark_ask", { root: repo, path: "src/app.ts", question: "where is rewriteCommandWithRtk defined" });
    assert.equal(scopedMiss.body.status, "miss");
    assert.equal(scopedMiss.body.missCode, "SYMBOL_NOT_FOUND");
  } finally {
    server.close();
    await removeRepo(repo);
  }
});

test("tier path reports AMBIGUOUS_PATH_COLLISION for a multi-file substring", async () => {
  const repo = gitRepo("waymark-review-paths-", {
    "src/mcp/capnIndex.ts": "export const a = 1;\n",
    "src/mcp/server.ts": "export const b = 1;\n",
    "README.md": "# demo\n",
  });
  try {
    invalidatePathsCache();
    const res = await routeDiscovery({ root: repo, question: "mcp", options: { tier: "path" }, queryCapnMemory: noMemory });
    assert.equal(res.status, "miss");
    assert.equal((res as any).missCode, "AMBIGUOUS_PATH_COLLISION");
    assert.deepEqual((res as any).matches.map((m: any) => m.file).sort(), ["src/mcp/capnIndex.ts", "src/mcp/server.ts"]);
    assert.equal((res as any).matches[0].kind, "substring");
    const none = await routeDiscovery({ root: repo, question: "nothing-here", options: { tier: "path" }, queryCapnMemory: noMemory });
    assert.equal((none as any).missCode, "SYMBOL_NOT_FOUND");
  } finally {
    await removeRepo(repo);
  }
});

test("tool-named folders are skipped only at the root; nested source folders stay visible", async () => {
  const repo = gitRepo("waymark-review-skip-", {
    "src/waymark/core.ts": "",
    "src/claude/agent.ts": "",
    "src/eval/run.ts": "",
    "waymark/scratch.ts": "",
    "eval/bench.ts": "",
    "src/.claude/state.json": "",
    "pkg/node_modules/dep/index.js": "",
  });
  try {
    invalidatePathsCache();
    const paths = collectRepoPaths(repo, 0);
    for (const kept of ["src/waymark/core.ts", "src/claude/agent.ts", "src/eval/run.ts"]) assert.ok(paths.includes(kept), kept);
    for (const skipped of ["waymark/scratch.ts", "eval/bench.ts", "src/.claude/state.json", "pkg/node_modules/dep/index.js"]) {
      assert.ok(!paths.includes(skipped), skipped);
    }
    assert.equal(isSkippedDir("waymark", 0), true);
    assert.equal(isSkippedDir("waymark", 1), false);
    assert.equal(isSkippedDir(".claude", 4), true);
  } finally {
    invalidatePathsCache();
    await removeRepo(repo);
  }
});

test("facet questions reach charted memory with their [FACET:...] tag", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-review-facet-"));
  try {
    const asked: string[] = [];
    const res = await routeDiscovery({
      root: repo,
      question: "entrypoints",
      options: { facet: "lifecycle" },
      queryCapnMemory: async (_root, _exe, question) => {
        asked.push(question);
        return { hit: false, result: null };
      },
    });
    assert.equal(res.status, "miss");
    assert.deepEqual(asked, ["[FACET:LIFECYCLE] entrypoints"]);
  } finally {
    await removeRepo(repo);
  }
});

test("plain text never carries a codedb name's trailing carriage return", () => {
  const hit = renderPlainText({ waymark: 1, kind: "ask", status: "hit", provider: "fuzzy-lexical", confidence: "approximate", result: { name: "import x;\r", path: "a.js", line: 3, score: 90 } });
  assert.equal(hit.includes("\r"), false);
  assert.match(hit, /import x; -> a\.js:3/u);
  const junction = renderPlainText({ status: "junction", executedOption: { tier: "fuzzy-lexical", result: { name: "y\r", path: "b.js", line: 1 } } });
  assert.equal(junction.includes("\r"), false);
  const listing = renderPlainText({ ok: true, tool: "symbol", query: "q", results: [{ name: "q\r", kind: "function", path: "c.js", line: 2 }] });
  assert.equal(listing.includes("\r"), false);
});

// ---------------------------------------------------------------------------
// 2. waymark_memory & the Semantic Repo Map
// ---------------------------------------------------------------------------

const SHA = "a".repeat(64);

function memoryRepo(): string {
  const repo = gitRepo("waymark-review-memory-", {
    "package.json": JSON.stringify({ name: "svc", main: "src/index.ts" }),
    "src/index.ts": "export function main(): void { start(); }\nfunction start(): void {}\n",
    "src/paths.ts": "export function normalize(p: string): string { return p; }\n",
    "src/types.ts": "export class AppError extends Error {}\n",
  });
  initMemoryStoreSync(repo);
  return repo;
}

function writeEntry(repo: string, id: string, body: string): void {
  fs.writeFileSync(path.join(memoryStoreDir(repo), "entries", `${id}.md`), body, "utf8");
}

test("charted entries parse with CRLF endings and quoted keys, newest first", async () => {
  const parsed = parseChartedEntry(
    ["---", "capn: 1", "id: abcd1234", "at: 2026-01-01T00:00:00.000Z", "files:", `  "src/index.ts": ${SHA}`, "---", "", "# [FACET:LIFECYCLE] Q", "answer", ""].join("\r\n"),
    "fallback",
  );
  assert.ok(parsed);
  assert.equal(parsed.id, "abcd1234");
  assert.deepEqual(parsed.files, ["src/index.ts"]);
  assert.equal(parsed.fileHashes["src/index.ts"], SHA);
  assert.equal(parsed.question, "[FACET:LIFECYCLE] Q");
  assert.equal(parsed.details, "answer");

  const repo = memoryRepo();
  try {
    const entry = (id: string, at: string, question: string) =>
      ["---", "capn: 1", `id: ${id}`, `at: ${at}`, "files:", "  src/index.ts: x", "---", "", `# ${question}`, "details", ""].join("\r\n");
    writeEntry(repo, "00000001", entry("00000001", "2026-01-01T00:00:00.000Z", "[FACET:LIFECYCLE] older"));
    writeEntry(repo, "ffffffff", entry("ffffffff", "2026-03-01T00:00:00.000Z", "[FACET:LIFECYCLE] newer"));
    assert.deepEqual(readChartedEntries(repo).map((e) => e.id), ["ffffffff", "00000001"]);
    const status = getSemanticMapStatus(repo);
    assert.equal(status.facets.lifecycle.status, "active");
    assert.equal(status.facets.lifecycle.entryId, "ffffffff");
  } finally {
    await removeRepo(repo);
  }
});

test("status reports a changed backing file as drifted, and an exact ask never returns the stale entry", async () => {
  const repo = memoryRepo();
  try {
    const charted = await chartMemoryEntry(repo, "capn-cli", "", { facet: "lifecycle", question: "What starts the service?", answer: "main() in src/index.ts", files: ["src/index.ts"] });
    assert.equal(charted.published, true);
    const exact = await ask(repo, "capn-cli", "", "[FACET:LIFECYCLE] What starts the service?", { tier: "capn", autoResolve: true });
    assert.equal(exact.status, "hit");
    assert.equal((exact as any).result.score, 100);

    fs.appendFileSync(path.join(repo, "src", "index.ts"), "// edited\n");
    const status = getSemanticMapStatus(repo);
    assert.equal(status.facets.lifecycle.status, "drifted");
    assert.deepEqual(status.facets.lifecycle.staleFiles, ["src/index.ts"]);

    const stale = await ask(repo, "capn-cli", "", "[FACET:LIFECYCLE] What starts the service?", { tier: "capn", autoResolve: true });
    assert.equal(stale.status, "miss");
    // capn prunes the entry while answering; the result names it.
    assert.ok((stale as any).memoryPruned?.some((line: string) => line.includes("changed: src/index.ts")), JSON.stringify(stale));
  } finally {
    await removeRepo(repo);
  }
});

test("chart validates facets case-insensitively, bounds text, and replaces a facet's earlier entry", async () => {
  const repo = memoryRepo();
  try {
    await assert.rejects(() => chartMemoryEntry(repo, "capn-cli", "", { facet: "bogus_facet", question: "q", answer: "a", files: ["src/index.ts"] }), /INVALID_ARGUMENT|Unknown facet "bogus_facet"/u);
    await assert.rejects(() => chartMemoryEntry(repo, "capn-cli", "", { question: "[facet:bogus] q", answer: "a", files: ["src/index.ts"] }), /Unknown facet "bogus"/u);
    // A lowercase embedded tag is still a facet, so the backing-file guard applies.
    await assert.rejects(() => chartMemoryEntry(repo, "capn-cli", "", { question: "[facet:boundaries] what connects?", answer: "a", files: [] }), /Anti-Hallucination Guard/u);
    await assert.rejects(() => chartMemoryEntry(repo, "capn-cli", "", { question: "x".repeat(241), answer: "a", files: [] }), /question must contain 1 to 240/u);
    await assert.rejects(() => chartMemoryEntry(repo, "capn-cli", "", { question: "q", answer: "x".repeat(4001), files: [] }), /answer must contain 1 to 4000/u);
    assert.deepEqual(normalizeFacetQuestion("[facet:boundaries] What connects?"), { question: "[FACET:BOUNDARIES] What connects?", facet: "boundaries" });

    const first = await chartMemoryEntry(repo, "capn-cli", "", { facet: "lifecycle", question: "What are the entrypoints?", answer: "main in src/index.ts", files: ["src/index.ts"] });
    const second = await chartMemoryEntry(repo, "capn-cli", "", { facet: "LIFECYCLE", question: "Second lifecycle question?", answer: "main again", files: ["src/index.ts"] });
    assert.equal(first.published, true);
    assert.equal(second.published, true);
    assert.equal(second.replaced?.length, 1);
    assert.deepEqual(readChartedEntries(repo).map((e) => e.question), ["[FACET:LIFECYCLE] Second lifecycle question?"]);
    assert.equal(getSemanticMapStatus(repo).facets.lifecycle.question, "[FACET:LIFECYCLE] Second lifecycle question?");

    const server = new McpServer({ root: repo, enableDaemon: false });
    try {
      const res = await toolCall(server, "waymark_memory", { root: repo, action: "chart", facet: "invariants", question: "Path rule", answer: "normalize() in src/paths.ts", files: ["src/paths.ts"] });
      assert.equal(res.body.waymark, 1);
      assert.equal(res.body.kind, "chart");
      assert.equal(res.body.published, true);
      const bad = await toolCall(server, "waymark_memory", { root: repo, action: "chart", facet: "nope", question: "q", answer: "a", files: ["src/paths.ts"] });
      assert.equal(bad.isError, true);
      assert.equal(bad.body.code, "INVALID_ARGUMENT");
      const long = await toolCall(server, "waymark_memory", { root: repo, action: "chart", question: "q", answer: "x".repeat(4001), files: ["src/paths.ts"] });
      assert.equal(long.body.code, "TEXT_LIMIT");
    } finally {
      server.close();
    }
  } finally {
    await removeRepo(repo);
  }
});

test("not_applicable needs an explicit marker; prose that mentions it stays active", async () => {
  assert.equal(isNotApplicableAnswer("not_applicable: this CLI has no daemon"), true);
  assert.equal(isNotApplicableAnswer("status: not_applicable\nNo storage layer."), true);
  assert.equal(isNotApplicableAnswer("When a field is not_applicable, the validator throws an invariant error."), false);

  const repo = memoryRepo();
  try {
    await chartMemoryEntry(repo, "capn-cli", "", { facet: "invariants", question: "Validator rule", answer: "When a field is not_applicable, the validator throws an invariant error.", files: ["src/paths.ts"] });
    await chartMemoryEntry(repo, "capn-cli", "", { facet: "data_state", question: "Storage", answer: "not_applicable: nothing is persisted", files: ["src/index.ts"] });
    const status = getSemanticMapStatus(repo);
    assert.equal(status.facets.invariants.status, "active");
    assert.equal(status.facets.data_state.status, "not_applicable");
  } finally {
    await removeRepo(repo);
  }
});

test("bootstrap discovers candidate files from the repository instead of waymark-engine's own paths", async () => {
  const repo = gitRepo("waymark-review-bootstrap-", {
    "package.json": JSON.stringify({ name: "agy", main: "mcp/index.js", bin: { agy: "scripts/cli.mjs" } }),
    "mcp/index.js": "export function listenSocket(port) {\n  return net.createServer().listen(port);\n}\n",
    "lib/cache.js": "export function persistCache(state) {\n  fs.writeFileSync(cacheDir, JSON.stringify(state));\n}\n",
    "lib/guard.js": "export function sanitizePath(p) {\n  return path.normalize(p);\n}\n",
    "lib/errors.js": "export function failClosed(err) {\n  throw new Error(err);\n}\n",
    "scripts/cli.mjs": "export function main(argv) {\n  return start(argv);\n}\n",
    "tests/cache.test.js": "persistCache(state); fs.writeFileSync(cacheDir, state);\n",
  });
  initMemoryStoreSync(repo);
  try {
    const result = await bootstrapSemanticMap(repo);
    const draft = (id: string) => result.scaffolded.find((d) => d.id === id);
    assert.equal(result.scaffolded.length, 5);
    assert.ok(draft("boundaries")?.files.includes("mcp/index.js"), JSON.stringify(draft("boundaries")));
    assert.ok(draft("data_state")?.files.includes("lib/cache.js"), JSON.stringify(draft("data_state")));
    assert.ok(draft("invariants")?.files.includes("lib/guard.js"), JSON.stringify(draft("invariants")));
    assert.ok(draft("failure")?.files.includes("lib/errors.js"), JSON.stringify(draft("failure")));
    for (const d of result.scaffolded) {
      assert.ok(!d.files.includes("package.json"), `${d.id} cites package.json`);
      assert.ok(!d.files.some((f) => f.startsWith("tests/")), `${d.id} cites a test`);
    }
  } finally {
    await removeRepo(repo);
  }
});

test("bootstrap ignores keywords inside literals and matches camelCase file names", async () => {
  const repo = gitRepo("waymark-review-literals-", {
    // Keyword-heavy text, but only inside a string table, a message, and a pattern.
    "src/keywordTable.ts": [
      'export const WORDS = ["persist", "cache", "store", "state", "save", "write", "disk"];',
      'export const MESSAGE = "persist the cache state to disk and save the store";',
      "export const PATTERN = /persist|cache|state|store|disk/u;",
      "",
    ].join("\n"),
    "src/stateDir.ts": "export function stateDir(root: string): string {\n  return root;\n}\n",
  });
  initMemoryStoreSync(repo);
  try {
    const draft = (await bootstrapSemanticMap(repo)).scaffolded.find((d) => d.id === "data_state");
    assert.ok(draft, "data_state draft");
    assert.deepEqual(draft.files, ["src/stateDir.ts"]);
  } finally {
    await removeRepo(repo);
  }
});

test("heal uncharts drifted facets (dry_run only reports) and scaffolds their replacements", async () => {
  const repo = memoryRepo();
  try {
    write(repo, "src/temp-backing.ts", "export function stopAll(): void { shutdown(); }\n");
    await chartMemoryEntry(repo, "capn-cli", "", { facet: "lifecycle", question: "Shutdown", answer: "stopAll in src/temp-backing.ts", files: ["src/temp-backing.ts"] });
    fs.rmSync(path.join(repo, "src", "temp-backing.ts"));
    assert.deepEqual(getSemanticMapStatus(repo).drifted, ["lifecycle"]);

    const boot = await bootstrapSemanticMap(repo);
    assert.ok(boot.scaffolded.some((d) => d.id === "lifecycle"), "bootstrap drafts a drifted facet");

    const dry = await healSemanticMap(repo, { dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.pruned.map((p) => [p.facet, p.missingFiles]), [["lifecycle", ["src/temp-backing.ts"]]]);
    assert.equal(readChartedEntries(repo).length, 1);

    const healed = await healSemanticMap(repo);
    assert.equal(healed.ok, true);
    assert.equal(healed.pruned.length, 1);
    assert.equal(readChartedEntries(repo).length, 0);
    assert.equal(healed.status.facets.lifecycle.status, "missing");
    assert.ok(healed.scaffolded.some((d) => d.id === "lifecycle"));

    const plain = renderPlainText(dry);
    assert.match(plain, /^\[heal\] Status: OK \(dry-run\)/u);
    assert.match(plain, /Would unchart 1 drifted entry:\n- lifecycle \([0-9a-f]+\) \[missing: src\/temp-backing\.ts\]/u);
    assert.doesNotMatch(plain, /\[healed:/u);
  } finally {
    await removeRepo(repo);
  }
});

test("waymark_memory plain: true renders every action as text, and export honors format: json", async () => {
  const repo = memoryRepo();
  const server = new McpServer({ root: repo, enableDaemon: false });
  try {
    const plain = async (args: Record<string, unknown>) => (await toolCall(server, "waymark_memory", { root: repo, plain: true, ...args })).text;

    const boot = await plain({ action: "bootstrap" });
    assert.match(boot, /^\[bootstrap\] Status: OK/u);
    assert.match(boot, /Unverified drafts \(\d\)/u);
    assert.match(boot, /src\/index\.ts:1: export function main/u);
    assert.doesNotMatch(boot, /Run 'waymark memory bootstrap'/u);

    const chart = await plain({ action: "chart", facet: "lifecycle", question: "Entry", answer: "main in src/index.ts", files: ["src/index.ts"] });
    assert.match(chart, /^\[chart\] published \[facet: lifecycle\]: \[FACET:LIFECYCLE\] Entry/u);

    for (const action of ["init", "list", "context", "prune"]) {
      const text = await plain({ action });
      assert.match(text, new RegExp(`^\\[memory:${action}\\] ok`, "u"), text);
      assert.doesNotMatch(text, /^\{/u);
    }
    assert.match(await plain({ action: "list" }), /\[FACET:LIFECYCLE\] Entry/u);
    assert.match(await plain({ action: "bust", file: "src/index.ts" }), /^\[memory:bust\] ok/u);
    assert.match(await plain({ action: "unchart", id: "deadbeef", if_exists: true }), /^\[memory:unchart\] ok/u);
    assert.match(await plain({ action: "heal" }), /^\[heal\] Status: OK/u);
    assert.match(await plain({ action: "close" }), /^\[memory:close\] /u);

    const exported = JSON.parse(await plain({ action: "export", format: "json" }));
    assert.equal(exported.kind, "semantic_map");
    assert.match(await plain({ action: "export" }), /^# Architecture Consensus Map/u);
  } finally {
    server.close();
    await removeRepo(repo);
  }
});

test("memory guidance names the canonical MCP calls, never hidden tools or raw capn", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-review-guidance-"));
  const server = new McpServer({ root: repo, enableDaemon: false });
  try {
    const list = await toolCall(server, "waymark_memory", { root: repo, action: "list" });
    const context = await toolCall(server, "waymark_memory", { root: repo, action: "context" });
    for (const text of [String(list.body.output), String(context.body.output)]) {
      assert.match(text, /waymark_memory\(action: "init"\)/u);
      assert.doesNotMatch(text, /waymark_init|waymark_chart\b|waymark-context|\bcapn (?:ask|chart)\b/u);
    }
  } finally {
    server.close();
    await removeRepo(repo);
  }
});

// ---------------------------------------------------------------------------
// 3. MCP server, daemons & prompts
// ---------------------------------------------------------------------------

test("waymark_memory declares all, and close/evict never warm a daemon but stop a warm one", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-review-evict-"));
  const server = new McpServer({ root: repo, warmup: { enabled: true } });
  const { start: originalStart, stop: originalStop } = WaymarkDaemon.prototype;
  const calls = { started: [] as string[], stopped: [] as string[] };
  WaymarkDaemon.prototype.start = async function (this: WaymarkDaemon) {
    calls.started.push(canonicalRoot(this.root));
    return true;
  };
  WaymarkDaemon.prototype.stop = function (this: WaymarkDaemon) {
    calls.stopped.push(canonicalRoot(this.root));
  };
  try {
    const list = await rpc(server, "tools/list", {});
    const memory = list.result.tools.find((t: any) => t.name === "waymark_memory");
    assert.equal(memory.inputSchema.properties.all.type, "boolean");

    for (const action of ["close", "evict"]) {
      const res = await toolCall(server, "waymark_memory", { root: repo, action });
      assert.equal(res.body.ok, true);
      assert.equal(res.body.kind, action);
    }
    assert.deepEqual(calls.started, []);
    assert.deepEqual(server.getWarmupStatus(), []);

    assert.equal(await server.warmRoot(repo), "warm");
    assert.equal(calls.started.length, 1);
    const closed = await toolCall(server, "waymark_memory", { root: repo, action: "close" });
    assert.equal(closed.body.daemonsStopped, 1);
    assert.equal(closed.body.closed, true);
    assert.equal(calls.stopped.length, 1);
    assert.deepEqual(server.getWarmupStatus(), []);

    assert.equal(await server.warmRoot(repo), "warm");
    const all = await toolCall(server, "waymark_memory", { root: repo, action: "evict", all: true });
    assert.equal(all.body.all, true);
    assert.equal(all.body.daemonsStopped, 1);
    assert.deepEqual(server.getWarmupStatus(), []);
  } finally {
    WaymarkDaemon.prototype.start = originalStart;
    WaymarkDaemon.prototype.stop = originalStop;
    server.close();
    await removeRepo(repo);
  }
});

test("prompts validate required arguments and teach the canonical tool calls", async () => {
  const server = new McpServer({ enableDaemon: false });
  try {
    for (const [name, args] of [
      ["explore-subsystem", {}],
      ["explore-subsystem", { query: "   " }],
      ["architectural-map", {}],
      ["architectural-map", { topic: "" }],
    ] as const) {
      const res = await rpc(server, "prompts/get", { name, arguments: args });
      assert.equal(res.error?.code, -32602, `${name} ${JSON.stringify(args)}`);
      assert.match(res.error?.message ?? "", /requires a non-empty/u);
    }

    const listed = (await rpc(server, "prompts/list", {})).result.prompts as Array<{ name: string; description: string }>;
    const texts: Record<string, string> = {};
    for (const [name, args] of [
      ["explore-subsystem", { query: "verifyHop" }],
      ["architectural-map", { topic: "daemon lifecycle" }],
      ["bootstrap-semantic-map", {}],
    ] as const) {
      const res = await rpc(server, "prompts/get", { name, arguments: args });
      assert.equal(res.error, undefined, name);
      assert.equal(res.result.description, listed.find((p) => p.name === name)?.description, `${name} description`);
      texts[name] = res.result.messages[0].content.text;
      assert.doesNotMatch(texts[name]!, /waymark_chart|"unknown"/u, name);
      assert.match(texts[name]!, /plain: true/u, name);
    }
    assert.match(texts["explore-subsystem"]!, /"verifyHop"/u);
    assert.match(texts["explore-subsystem"]!, /outline: true/u);
    assert.match(texts["explore-subsystem"]!, /auto_resolve: false/u);
    assert.match(texts["architectural-map"]!, /depth: 2, direction: "both"/u);
    const bootstrap = texts["bootstrap-semantic-map"]!;
    assert.match(bootstrap, /waymark_memory\(action: "bootstrap"/u);
    assert.match(bootstrap, /facet: "<id>"/u);
    for (const id of ["lifecycle", "data_state", "boundaries", "invariants", "failure"]) assert.match(bootstrap, new RegExp(`"${id}"`, "u"));
  } finally {
    server.close();
  }
});
