import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ask, assertSupportedCapnCommand, migrateMemoryStore } from "../src/capnAdapter.js";
import { bundledCodedbBinary } from "../src/codedbAdapter.js";
import { discoverSymbolsInFile, MAX_SYMBOL_DISCOVERY_FILE_BYTES } from "../src/astExtractor.js";
import { collectRepoPaths, invalidatePathsCache, matchLiteralPath } from "../src/discoveryRouter.js";
import { PrefixTrie } from "../src/prefixTrie.js";
import { readChartedEntries, staleChartedEntries } from "../src/memoryEntries.js";
import { chartMemoryEntry, getSemanticMapStatus } from "../src/semanticMap.js";
import {
  getDaemonAddress,
  getDaemonRuntimeDir,
  getPidFilePath,
  readRegistry,
  registerDaemon,
  stopDaemon,
  tryDaemonPing,
  tryDaemonQuery,
  tryDaemonReload,
  unregisterDaemon,
  WaymarkDaemon,
} from "../src/daemon.js";
import { ResidentCodedbClient } from "../src/residentCodedb.js";
import { startLiveReplObserver } from "../src/repl.js";
import { McpServer } from "../src/mcp/server.js";
import { WAYMARK_TOOLS, waymarkAskTool } from "../src/mcp/capnTools.js";
import { memoryStoreDir, stateDir } from "../src/stateDir.js";
import { hasCodedb, skipCodedb } from "./codedb.js";
import { mkTrackedTempDir } from "./tempDirs.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRootDir = path.resolve(__dirname, "../..");
const cliPath = path.resolve(__dirname, "../src/cli.js");
const mcpIndexPath = path.resolve(__dirname, "../src/mcp/capnIndex.js");

function createSampleRepo(prefix = "waymark-day1-"): string {
  const repo = mkTrackedTempDir(prefix);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  fs.mkdirSync(path.join(repo, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(repo, "vendor", "pkg"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "app.ts"),
    [
      "export function version(): string { return '1.0.0'; }",
      "export function help(): string { return 'usage'; }",
      "export function computeBilling(x: number): number { return x * 2; }",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(repo, "src", "auth", "utils.ts"), "export function verifyToken(): boolean { return true; }\n", "utf8");
  fs.writeFileSync(path.join(repo, "vendor", "pkg", "dep.ts"), "export const vendorDep = 42;\n", "utf8");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "day1-sample", version: "1.0.0" }, null, 2), "utf8");
  return repo;
}

// ---------------------------------------------------------------------------
// SEC-001: MCP capn_executable removed and never executed
// ---------------------------------------------------------------------------
test("SEC-001: MCP tools omit capn_executable from schemas and ignore caller-supplied capn_executable", async () => {
  const repo = createSampleRepo();
  const proofPath = path.join(repo, "pwn-proof.txt");
  const pwnScript = path.join(repo, "pwn.mjs");
  fs.writeFileSync(pwnScript, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(proofPath)}, "pwned");\n`, "utf8");

  for (const tool of WAYMARK_TOOLS) {
    const props = (tool.definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.equal("capn_executable" in props, false, `Tool ${tool.definition.name} must not expose capn_executable`);
  }

  const server = new McpServer({ root: repo, warmup: { enabled: false } });
  try {
    await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "waymark_memory", arguments: { action: "init", root: repo, capn_executable: pwnScript } },
    }));
    await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "waymark_ask", arguments: { query: "How does billing work?", root: repo, capn_executable: pwnScript } },
    }));
    assert.equal(fs.existsSync(proofPath), false, "Attacker capn_executable script must never execute");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// SEC-002 + DB-003: Private 0700 runtime dir, 0600 socket, symlink rejection, registry safety
// ---------------------------------------------------------------------------
test("SEC-002 + DB-003: POSIX runtime dir is 0700, daemon socket is 0600, symlink runtime dir is rejected", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions test");

  const repo = createSampleRepo();
  const customRunBase = fs.mkdtempSync("/tmp/wm-rt-");
  const symlinkRunDir = path.join(customRunBase, "sym-run");
  const realTarget = path.join(customRunBase, "real-target");
  fs.mkdirSync(realTarget, { mode: 0o700 });
  fs.symlinkSync(realTarget, symlinkRunDir);

  const prevRunDir = process.env.WAYMARK_RUNTIME_DIR;
  try {
    process.env.WAYMARK_RUNTIME_DIR = symlinkRunDir;
    assert.throws(() => getDaemonRuntimeDir(), (err: any) => err.code === "UNSAFE_RUNTIME_DIR");
    process.env.WAYMARK_RUNTIME_DIR = `${symlinkRunDir}/`;
    assert.throws(() => getDaemonRuntimeDir(), (err: any) => err.code === "UNSAFE_RUNTIME_DIR");

    const privateRunDir = path.join(customRunBase, "private-run");
    process.env.WAYMARK_RUNTIME_DIR = privateRunDir;
    const rt = getDaemonRuntimeDir();
    assert.equal(fs.lstatSync(rt).mode & 0o777, 0o700);

    // Registry concurrent writes inside private dir
    const r1 = path.join(repo, "sub1");
    const r2 = path.join(repo, "sub2");
    fs.mkdirSync(r1, { recursive: true });
    fs.mkdirSync(r2, { recursive: true });
    registerDaemon(r1, 11111, getDaemonAddress(r1));
    registerDaemon(r2, 22222, getDaemonAddress(r2));
    const reg = readRegistry();
    assert.equal(Object.keys(reg).length, 2);
    assert.equal(fs.lstatSync(path.join(rt, "waymark-daemons.json")).mode & 0o777, 0o600);
    unregisterDaemon(r1);
    unregisterDaemon(r2);

    if (hasCodedb()) {
      const daemon = new WaymarkDaemon(repo, 0);
      try {
        const started = await daemon.start();
        assert.equal(started, true);
        assert.equal(fs.lstatSync(daemon.address).mode & 0o777, 0o600, "Daemon Unix socket must have mode 0600");
        assert.equal(fs.lstatSync(getPidFilePath(repo)).mode & 0o777, 0o600, "Daemon PID file must have mode 0600");
      } finally {
        daemon.stop();
      }
    }
  } finally {
    if (prevRunDir === undefined) delete process.env.WAYMARK_RUNTIME_DIR;
    else process.env.WAYMARK_RUNTIME_DIR = prevRunDir;
    fs.rmSync(customRunBase, { recursive: true, force: true });
  }
});

test("SEC-002 + macOS sun_path guard: POSIX runtime dir falls back to /tmp/waymark-<uid> when candidate socket path >= 100 bytes", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX Unix domain socket path test");

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const uidSegment = `waymark-${uid}`;
  const sampleSock = `wm-${"0".repeat(16)}.sock`;
  const expectedFallback = path.posix.join("/tmp", uidSegment);
  let fallbackExistedBefore = false;
  try {
    fs.lstatSync(expectedFallback);
    fallbackExistedBefore = true;
  } catch {
    fallbackExistedBefore = false;
  }
  const shortBase = fs.mkdtempSync("/tmp/wm-sp-");

  const savedEnv = {
    WAYMARK_RUNTIME_DIR: process.env.WAYMARK_RUNTIME_DIR,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
  };

  try {
    delete process.env.WAYMARK_RUNTIME_DIR;
    delete process.env.XDG_RUNTIME_DIR;
    delete process.env.TMP;
    delete process.env.TEMP;

    // 1. Overlong $TMPDIR (e.g., macOS /var/folders/.../T or long custom TMPDIR) falls back to /tmp/waymark-<uid>
    const longTmp = path.join(shortBase, "var", "folders", "ab", "cdefghijklmnopqrstuvwxyz0123456789_macos_tmpdir", "T");
    fs.mkdirSync(longTmp, { recursive: true });
    assert.ok(Buffer.byteLength(path.posix.join(longTmp, uidSegment, sampleSock), "utf8") >= 100);
    process.env.TMPDIR = longTmp;

    const rt = getDaemonRuntimeDir();
    assert.equal(rt, expectedFallback);
    assert.equal(getDaemonRuntimeDir("darwin"), expectedFallback);
    const fbStat = fs.lstatSync(rt);
    assert.equal(fbStat.isSymbolicLink(), false);
    assert.equal(fbStat.isDirectory(), true);
    assert.equal(fbStat.uid, uid);
    assert.equal(fbStat.mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(longTmp, uidSegment)), false, "Overlong TMPDIR should not be created");

    const fallbackSock = getDaemonAddress(shortBase);
    assert.ok(Buffer.byteLength(fallbackSock, "utf8") < 100);
    assert.equal(path.dirname(fallbackSock), expectedFallback);

    // Live Unix domain socket bind + connect round-trip against the fallback path
    const echoServer = net.createServer((sock) => {
      sock.once("data", (chunk) => {
        sock.end(chunk);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        echoServer.once("error", reject);
        echoServer.listen(fallbackSock, () => {
          echoServer.removeListener("error", reject);
          resolve();
        });
      });
      fs.chmodSync(fallbackSock, 0o600);
      assert.equal(fs.lstatSync(fallbackSock).mode & 0o777, 0o600);
      const reply = await new Promise<string>((resolve, reject) => {
        const client = net.connect(fallbackSock);
        let data = "";
        client.once("error", reject);
        client.on("data", (chunk) => { data += chunk.toString("utf8"); });
        client.on("end", () => resolve(data));
        client.write("ok");
      });
      assert.equal(reply, "ok");
    } finally {
      await new Promise<void>((resolve) => echoServer.close(() => resolve()));
      try { fs.unlinkSync(fallbackSock); } catch {}
    }

    // 2. Exact 99-byte vs 100-byte boundary (including trailing slashes)
    const fixedOverhead = Buffer.byteLength(path.posix.join(shortBase, uidSegment, sampleSock), "utf8") + 1;
    assert.ok(fixedOverhead < 99, `Unexpectedly long /tmp base path (overhead=${fixedOverhead})`);
    const dir99 = path.join(shortBase, "a".repeat(99 - fixedOverhead));
    const dir100 = path.join(shortBase, "b".repeat(100 - fixedOverhead));
    fs.mkdirSync(dir99, { recursive: true });
    fs.mkdirSync(dir100, { recursive: true });
    assert.equal(Buffer.byteLength(path.posix.join(dir99, uidSegment, sampleSock), "utf8"), 99);
    assert.equal(Buffer.byteLength(path.posix.join(dir100, uidSegment, sampleSock), "utf8"), 100);

    process.env.TMPDIR = dir99;
    const rt99 = getDaemonRuntimeDir();
    assert.equal(rt99, path.join(dir99, uidSegment));
    assert.equal(fs.lstatSync(rt99).mode & 0o777, 0o700);

    process.env.TMPDIR = `${dir99}///`;
    assert.equal(getDaemonRuntimeDir(), path.join(dir99, uidSegment));

    process.env.TMPDIR = dir100;
    assert.equal(getDaemonRuntimeDir(), expectedFallback);

    process.env.TMPDIR = `${dir100}///`;
    assert.equal(getDaemonRuntimeDir(), expectedFallback);

    // 3. Multi-byte UTF-8 directory (< 100 UTF-16 chars, >= 100 UTF-8 bytes) must trigger fallback
    const multiCount = Math.ceil((100 - fixedOverhead) / 2);
    const dirUtf8 = path.join(shortBase, "é".repeat(multiCount));
    fs.mkdirSync(dirUtf8, { recursive: true });
    const utf8Sock = path.posix.join(dirUtf8, uidSegment, sampleSock);
    assert.ok(utf8Sock.length < 100, `Expected < 100 UTF-16 chars, got ${utf8Sock.length}`);
    assert.ok(Buffer.byteLength(utf8Sock, "utf8") >= 100, `Expected >= 100 UTF-8 bytes, got ${Buffer.byteLength(utf8Sock, "utf8")}`);
    process.env.TMPDIR = dirUtf8;
    assert.equal(getDaemonRuntimeDir(), expectedFallback);

    // 4. Relative $TMPDIR and $XDG_RUNTIME_DIR fall back cleanly to /tmp/waymark-<uid>
    process.env.XDG_RUNTIME_DIR = "relative/xdg";
    process.env.TMPDIR = "relative/tmp";
    assert.equal(getDaemonRuntimeDir(), expectedFallback);
    delete process.env.XDG_RUNTIME_DIR;

    // 5. Overlong valid 0700 $XDG_RUNTIME_DIR with overlong $TMPDIR falls back to /tmp/waymark-<uid>
    const longXdg = path.join(shortBase, "x".repeat(75));
    fs.mkdirSync(longXdg, { recursive: true, mode: 0o700 });
    fs.chmodSync(longXdg, 0o700);
    assert.ok(Buffer.byteLength(path.posix.join(longXdg, "waymark", sampleSock), "utf8") >= 100);
    process.env.XDG_RUNTIME_DIR = longXdg;
    process.env.TMPDIR = longTmp;
    assert.equal(getDaemonRuntimeDir(), expectedFallback);
    assert.equal(fs.existsSync(path.join(longXdg, "waymark")), false);

    // 6. Valid short 0700 $XDG_RUNTIME_DIR is preferred even when $TMPDIR is overlong
    const shortXdg = path.join(shortBase, "xdg");
    fs.mkdirSync(shortXdg, { recursive: true, mode: 0o700 });
    fs.chmodSync(shortXdg, 0o700);
    assert.ok(Buffer.byteLength(path.posix.join(shortXdg, "waymark", sampleSock), "utf8") < 100);
    process.env.XDG_RUNTIME_DIR = shortXdg;
    process.env.TMPDIR = longTmp;
    const rtXdg = getDaemonRuntimeDir();
    assert.equal(rtXdg, path.join(shortXdg, "waymark"));
    assert.equal(fs.lstatSync(rtXdg).mode & 0o777, 0o700);

    // 7. Symlinked $XDG_RUNTIME_DIR with trailing slash must NOT bypass lstat symlink rejection
    const realXdg = path.join(shortBase, "real-xdg");
    const symXdg = path.join(shortBase, "sym-xdg");
    fs.mkdirSync(realXdg, { mode: 0o700 });
    fs.chmodSync(realXdg, 0o700);
    fs.symlinkSync(realXdg, symXdg);
    process.env.XDG_RUNTIME_DIR = `${symXdg}/`;
    process.env.TMPDIR = longTmp;
    assert.equal(getDaemonRuntimeDir(), expectedFallback);
    assert.equal(fs.existsSync(path.join(realXdg, "waymark")), false, "Symlinked XDG_RUNTIME_DIR with trailing slash must be rejected");

    // 8. $XDG_RUNTIME_DIR containing `symlink/..` must not validate target dirB (0700) while creating inside dirA (0755)
    const dirA = path.join(shortBase, "dirA");
    const dirB = path.join(shortBase, "dirB");
    const subB = path.join(dirB, "sub");
    fs.mkdirSync(dirA, { mode: 0o755 });
    fs.chmodSync(dirA, 0o755);
    fs.mkdirSync(subB, { recursive: true, mode: 0o700 });
    fs.chmodSync(dirB, 0o700);
    fs.symlinkSync(subB, path.join(dirA, "jump"));
    process.env.XDG_RUNTIME_DIR = `${dirA}/jump/..`;
    process.env.TMPDIR = longTmp;
    assert.equal(getDaemonRuntimeDir(), expectedFallback);
    assert.equal(fs.existsSync(path.join(dirA, "waymark")), false, "XDG_RUNTIME_DIR symlink/.. mismatch must be rejected");

    // 9. Hostile symlink at $XDG_RUNTIME_DIR/waymark inside valid 0700 $XDG_RUNTIME_DIR must throw UNSAFE_RUNTIME_DIR
    const poisonedXdg = path.join(shortBase, "poisoned-xdg");
    const hijackTarget = path.join(shortBase, "hijack");
    fs.mkdirSync(poisonedXdg, { mode: 0o700 });
    fs.chmodSync(poisonedXdg, 0o700);
    fs.mkdirSync(hijackTarget, { mode: 0o700 });
    fs.symlinkSync(hijackTarget, path.join(poisonedXdg, "waymark"));
    process.env.XDG_RUNTIME_DIR = poisonedXdg;
    assert.throws(() => getDaemonRuntimeDir(), (err: any) => err.code === "UNSAFE_RUNTIME_DIR");
    delete process.env.XDG_RUNTIME_DIR;

    // 10. Short $TMPDIR: hostile symlink throws UNSAFE_RUNTIME_DIR; loose 0755 dir is tightened to 0700
    const symTmp = path.join(shortBase, "t-sym");
    fs.mkdirSync(symTmp, { mode: 0o755 });
    fs.symlinkSync(hijackTarget, path.join(symTmp, uidSegment));
    process.env.TMPDIR = symTmp;
    assert.throws(() => getDaemonRuntimeDir(), (err: any) => err.code === "UNSAFE_RUNTIME_DIR");

    const looseTmp = path.join(shortBase, "t-loose");
    const looseCand = path.join(looseTmp, uidSegment);
    fs.mkdirSync(looseCand, { recursive: true, mode: 0o755 });
    fs.chmodSync(looseCand, 0o755);
    process.env.TMPDIR = looseTmp;
    const tightened = getDaemonRuntimeDir();
    assert.equal(tightened, looseCand);
    assert.equal(fs.lstatSync(tightened).mode & 0o777, 0o700);

    // 11. Explicit WAYMARK_RUNTIME_DIR >= 100-byte socket path or "/" fails closed with UNSAFE_RUNTIME_DIR
    const overlongExplicit = path.join(shortBase, "e".repeat(80));
    process.env.WAYMARK_RUNTIME_DIR = overlongExplicit;
    assert.throws(() => getDaemonRuntimeDir(), (err: any) => err.code === "UNSAFE_RUNTIME_DIR");
    assert.equal(fs.existsSync(overlongExplicit), false, "Overlong WAYMARK_RUNTIME_DIR must fail before creating directory");

    process.env.WAYMARK_RUNTIME_DIR = "/";
    assert.throws(() => getDaemonRuntimeDir(), (err: any) => err.code === "UNSAFE_RUNTIME_DIR");
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(shortBase, { recursive: true, force: true });
    if (!fallbackExistedBefore) {
      try {
        fs.rmdirSync(expectedFallback);
      } catch {
        // leave intact if non-empty
      }
    }
  }
});

// ---------------------------------------------------------------------------
// SEC-004: Windows .cmd/.bat capn shim rejection
// ---------------------------------------------------------------------------
test("SEC-004: assertSupportedCapnCommand rejects Windows .cmd/.bat shims and null bytes", () => {
  assert.throws(
    () => assertSupportedCapnCommand({ file: "C:\\tools\\capn.cmd", prefix: [], viaCmdShim: true }, "win32"),
    (err: any) => err.code === "CAPN_UNSUPPORTED_SHIM",
  );
  assert.throws(
    () => assertSupportedCapnCommand({ file: "C:\\tools\\capn.bat", prefix: [], viaCmdShim: true }, "win32"),
    (err: any) => err.code === "CAPN_UNSUPPORTED_SHIM",
  );
  assert.throws(
    () => assertSupportedCapnCommand({ file: "/usr/bin/capn\0evil", prefix: [], viaCmdShim: false }, "linux"),
    (err: any) => err.code === "CAPN_UNSAFE_ARGUMENT",
  );
  assert.doesNotThrow(
    () => assertSupportedCapnCommand({ file: process.execPath, prefix: ["/app/dist/capn.js"], viaCmdShim: false }, "win32"),
  );
});

// ---------------------------------------------------------------------------
// SEC-005 + MCP-003: Legacy waymark_chart path oracle elimination & chartMemoryEntry parity
// ---------------------------------------------------------------------------
test("SEC-005 + MCP-003: waymark_chart prevents host existence oracle, enforces facet replacement, and sets isError on failure", async () => {
  const repo = createSampleRepo();
  const server = new McpServer({ root: repo, warmup: { enabled: false } });
  try {
    const existingHost = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "waymark_chart", arguments: { root: repo, question: "Probe 1", answer: "a", files: ["/etc/passwd"] } },
    }));
    const missingHost = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "waymark_chart", arguments: { root: repo, question: "Probe 2", answer: "a", files: ["/etc/definitely_missing_waymark_999"] } },
    }));
    const body1 = JSON.parse(existingHost!).result;
    const body2 = JSON.parse(missingHost!).result;
    assert.equal(body1.isError, true);
    assert.equal(body2.isError, true);
    const err1 = JSON.parse(body1.content[0].text);
    const err2 = JSON.parse(body2.content[0].text);
    assert.equal(err1.code, "INVALID_PATH");
    assert.equal(err2.code, "INVALID_PATH");
    assert.doesNotMatch(err1.message, /resolved to/i);
    assert.doesNotMatch(err2.message, /resolved to/i);

    // Profile none returns published: false -> isError: true
    const failedPub = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "waymark_chart", arguments: { root: repo, profile: "none", question: "Test", answer: "Ans", files: ["src/app.ts"] } },
    }));
    assert.equal(JSON.parse(failedPub!).result.isError, true);

    // Facet charting via legacy waymark_chart replaces earlier facet entry
    await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "waymark_chart", arguments: { root: repo, facet: "lifecycle", question: "Entry A", answer: "A details", files: ["src/app.ts"] } },
    }));
    const second = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "waymark_chart", arguments: { root: repo, facet: "lifecycle", question: "Entry B", answer: "B details", files: ["src/app.ts"] } },
    }));
    const secondPayload = JSON.parse(JSON.parse(second!).result.content[0].text);
    assert.equal(secondPayload.published, true);
    assert.equal(secondPayload.replaced?.length, 1);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// SEC-006 + SEC-003 + RUN-010: Pre-read 1 MiB guard, Markdown html:false, LANGUAGE_EXTENSION_MISMATCH
// ---------------------------------------------------------------------------
test("SEC-006 + SEC-003 + RUN-010: pre-read size cap rejects oversized files, markdown ignores HTML, Go/Python mismatch throws", async () => {
  const repo = createSampleRepo();
  const hugePath = path.join(repo, "huge.json");
  // Sparse file > 1 MiB rejected by fstat before reading body
  const fd = fs.openSync(hugePath, "w");
  try {
    fs.ftruncateSync(fd, MAX_SYMBOL_DISCOVERY_FILE_BYTES + 4096);
  } finally {
    fs.closeSync(fd);
  }
  await assert.rejects(
    () => discoverSymbolsInFile(repo, "huge.json"),
    (err: any) => err.code === "FILE_TOO_LARGE",
  );

  // Markdown with inline HTML parses headings cleanly with html: false
  fs.writeFileSync(path.join(repo, "doc.md"), "# Title\n\n<div>raw html</div>\n\n## Section\n", "utf8");
  const md = await discoverSymbolsInFile(repo, "doc.md");
  assert.equal(md.language, "markdown");
  assert.ok(md.symbols.some((s) => s.name === "# Title"));
  assert.ok(md.symbols.some((s) => s.name === "## Section"));
  assert.equal(md.symbols.some((s) => s.name.includes("<div>")), false);

  // RUN-010: explicit language mismatch on Go extension must reject, never fall back to codedb outline
  fs.writeFileSync(path.join(repo, "main.go"), "package main\nfunc main() {}\n", "utf8");
  await assert.rejects(
    () => discoverSymbolsInFile(repo, "main.go", "python"),
    (err: any) => err.code === "LANGUAGE_EXTENSION_MISMATCH",
  );
});

// ---------------------------------------------------------------------------
// DB-001: Concurrent chartMemoryEntry preserves exactly 1 authoritative entry
// ---------------------------------------------------------------------------
test("DB-001: concurrent chartMemoryEntry calls on the same facet never mutually delete each other", async () => {
  const repo = createSampleRepo();
  const results = await Promise.all([
    chartMemoryEntry(repo, "capn-cli", "", { facet: "lifecycle", question: "Entrypoints A", answer: "Details A", files: ["src/app.ts"] }),
    chartMemoryEntry(repo, "capn-cli", "", { facet: "lifecycle", question: "Entrypoints B", answer: "Details B", files: ["src/app.ts"] }),
    chartMemoryEntry(repo, "capn-cli", "", { facet: "lifecycle", question: "Entrypoints C", answer: "Details C", files: ["src/app.ts"] }),
  ]);
  for (const r of results) {
    assert.equal(r.published, true, `Expected published=true, got: ${r.error}`);
  }
  const status = getSemanticMapStatus(repo);
  assert.equal(status.activeCount, 1, `Expected exactly 1 surviving lifecycle entry, got ${status.activeCount} (${status.status})`);
  assert.equal(status.facets.lifecycle.status, "active");
});

// ---------------------------------------------------------------------------
// DB-002: migrateMemoryStore rolls back copied entries when post-copy reindex fails
// ---------------------------------------------------------------------------
test("DB-002: migrateMemoryStore rolls back copied entries if reindex fails so retry succeeds", async () => {
  const repo = createSampleRepo();
  const legacyDir = path.join(repo, ".capn");
  fs.mkdirSync(path.join(legacyDir, "entries"), { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "config.json"), JSON.stringify({ embedding: false }), "utf8");
  fs.writeFileSync(
    path.join(legacyDir, "entries", "deadbeef.md"),
    "---\ncapn: 1\nid: deadbeef\nat: 2026-01-01T00:00:00.000Z\nfiles:\n  src/app.ts: 0000000000000000000000000000000000000000000000000000000000000000\n---\n\n# Legacy entry\n\nDetails.\n",
    "utf8",
  );

  // Flaky capn script: succeeds on 1st init (creating store), fails on 2nd init (reindex)
  const counterFile = path.join(repo, "call-count.txt");
  const flakyCapn = path.join(repo, "flaky-capn.mjs");
  fs.writeFileSync(
    flakyCapn,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      `const cf = ${JSON.stringify(counterFile)};`,
      'const n = fs.existsSync(cf) ? Number(fs.readFileSync(cf, "utf8")) + 1 : 1;',
      'fs.writeFileSync(cf, String(n), "utf8");',
      'const idx = process.argv.indexOf("--store-dir");',
      'const storeDir = idx !== -1 ? process.argv[idx + 1] : "";',
      'if (n === 1) {',
      '  fs.mkdirSync(path.join(storeDir, "entries"), { recursive: true });',
      '  fs.writeFileSync(path.join(storeDir, "config.json"), JSON.stringify({ embedding: false }), "utf8");',
      '  process.exit(0);',
      '}',
      'process.stderr.write("Simulated SQLite reindex failure\\n");',
      'process.exit(1);',
    ].join("\n"),
    "utf8",
  );

  const failed = await migrateMemoryStore(repo, flakyCapn);
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(failed.copied, 0);
  const leftover = fs.readdirSync(path.join(memoryStoreDir(repo), "entries")).filter((f) => f.endsWith(".md"));
  assert.deepEqual(leftover, [], "Rolled-back migration must leave zero copied .md entries behind");

  // Retry with real bundled capn succeeds cleanly without MIGRATE_DESTINATION_NOT_EMPTY
  const retried = await migrateMemoryStore(repo, "");
  assert.equal(retried.ok, true, String(retried.error));
  assert.equal(retried.copied, 1);
});

// ---------------------------------------------------------------------------
// RUN-001: Tier 2 literal path never extrapolates nonexistent directory-qualified paths
// ---------------------------------------------------------------------------
test("RUN-001: PrefixTrie and matchLiteralPath refuse nonexistent directory-qualified paths and partial dir suffixes", () => {
  const paths = ["src/app.ts", "src/auth/utils.ts", "package.json"];
  const trie = new PrefixTrie(paths);

  assert.deepEqual(trie.match("nonexistent/wrong/dir/app.ts"), []);
  assert.deepEqual(matchLiteralPath("nonexistent/wrong/dir/app.ts", paths), []);
  assert.deepEqual(trie.match("../../app.ts"), []);
  assert.deepEqual(matchLiteralPath("../../app.ts", paths), []);
  assert.deepEqual(trie.match("./app.ts"), []);
  assert.deepEqual(matchLiteralPath("./app.ts", paths), []);
  assert.deepEqual(trie.match("uth/utils.ts"), []);
  assert.deepEqual(matchLiteralPath("uth/utils.ts", paths), []);

  // Valid bare unique basename and segment-bounded suffix still match
  assert.deepEqual(trie.match("app.ts"), [{ file: "src/app.ts", kind: "basename" }]);
  assert.deepEqual(matchLiteralPath("app.ts", paths), [{ file: "src/app.ts", kind: "basename" }]);
  assert.deepEqual(trie.match("auth/utils.ts"), [{ file: "src/auth/utils.ts", kind: "suffix" }]);
  assert.deepEqual(matchLiteralPath("auth/utils.ts", paths), [{ file: "src/auth/utils.ts", kind: "suffix" }]);
});

// ---------------------------------------------------------------------------
// RUN-002: Forced --tier ast on literal filename package.json misses cleanly
// ---------------------------------------------------------------------------
test("RUN-002: forced --tier ast on literal filename package.json returns clean miss", { skip: skipCodedb() }, async () => {
  const repo = createSampleRepo();
  fs.writeFileSync(path.join(repo, "src", "jsonConst.ts"), "export const json = { ok: true };\n", "utf8");
  const res = await ask(repo, "capn-cli", "", "package.json", { tier: "ast" });
  assert.equal(res.status, "miss");
  assert.equal(res.provider, "codedb");
});

// ---------------------------------------------------------------------------
// RUN-004 + RUN-012: Auto-mode CAPN_NON_DETERMINISTIC_MODE, INVALID_FACET, CAPN_STORE_DIR_UNSUPPORTED
// ---------------------------------------------------------------------------
test("RUN-004 + RUN-012: auto-mode surfaces CAPN_NON_DETERMINISTIC_MODE and CAPN_STORE_DIR_UNSUPPORTED, and validates --facet", async () => {
  const repo = createSampleRepo();
  fs.mkdirSync(memoryStoreDir(repo), { recursive: true });
  fs.writeFileSync(path.join(memoryStoreDir(repo), "config.json"), JSON.stringify({ embedding: true }), "utf8");

  // Auto-mode narrative query (no tier override) must surface CAPN_NON_DETERMINISTIC_MODE
  const autoEmbed = await ask(repo, "capn-cli", "", "How does authentication work?");
  assert.equal(autoEmbed.status, "miss");
  assert.equal((autoEmbed as any).missCode, "CAPN_NON_DETERMINISTIC_MODE");

  // CLI exits 2 on CAPN_NON_DETERMINISTIC_MODE
  const cliEmbed = spawnSync(process.execPath, [cliPath, "ask", "How does authentication work?", "--root", repo], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(cliEmbed.status, 2);
  assert.equal(JSON.parse(cliEmbed.stdout).missCode, "CAPN_NON_DETERMINISTIC_MODE");

  // R2-MCP-003: MCP waymark_ask sets isError: true on CAPN_NON_DETERMINISTIC_MODE (JSON and plain)
  const mcpEmbedJson = await waymarkAskTool.handler({ question: "How does authentication work?", root: repo });
  assert.equal(mcpEmbedJson.isError, true, "MCP waymark_ask must set isError: true on CAPN_NON_DETERMINISTIC_MODE");
  assert.equal(JSON.parse(mcpEmbedJson.content[0]!.text).missCode, "CAPN_NON_DETERMINISTIC_MODE");
  const mcpEmbedPlain = await waymarkAskTool.handler({ question: "How does authentication work?", root: repo, plain: true });
  assert.equal(mcpEmbedPlain.isError, true, "MCP waymark_ask (plain) must set isError: true on CAPN_NON_DETERMINISTIC_MODE");

  // Invalid facet rejects with INVALID_FACET
  await assert.rejects(
    () => ask(repo, "capn-cli", "", "test", { facet: "nonexistent_facet" }),
    (err: any) => err.code === "INVALID_FACET",
  );

  // CAPN_STORE_DIR_UNSUPPORTED surfaces as explicit error instead of NO_CHARTED_MEMORY
  fs.writeFileSync(path.join(memoryStoreDir(repo), "config.json"), JSON.stringify({ embedding: false }), "utf8");
  const oldCapn = path.join(repo, "old-capn.mjs");
  fs.writeFileSync(oldCapn, 'process.stderr.write("Usage: capn <cmd>\\n"); process.exit(1);\n', "utf8");
  const unsup = await ask(repo, "capn-cli", oldCapn, "How does authentication work?");
  assert.equal(unsup.status, "error");
  assert.equal((unsup as any).errorCode, "CAPN_STORE_DIR_UNSUPPORTED");
});

// ---------------------------------------------------------------------------
// RUN-005 + RUN-006 + RUN-007 + RUN-008 + ARCH-001: CLI parsing, exit codes, chart parity
// ---------------------------------------------------------------------------
test("RUN-005 + RUN-006 + RUN-007 + RUN-008: CLI query words version/help, dash-prefixed --answer, chart --facet, and non-zero exit codes", () => {
  const repo = createSampleRepo();

  // RUN-005: `waymark ask version` and `waymark ask help` must NOT print CLI version/help
  const askVer = spawnSync(process.execPath, [cliPath, "ask", "version", "--root", repo, "--tier", "path"], { encoding: "utf8", windowsHide: true });
  assert.equal(askVer.status, 0);
  const askVerJson = JSON.parse(askVer.stdout);
  assert.equal(askVerJson.kind, "ask");

  const askHelp = spawnSync(process.execPath, [cliPath, "ask", "help", "--root", repo, "--tier", "path"], { encoding: "utf8", windowsHide: true });
  assert.equal(askHelp.status, 0);
  const askHelpJson = JSON.parse(askHelp.stdout);
  assert.equal(askHelpJson.kind, "ask");

  // RUN-006: --answer starting with "-" (Markdown bullet) and --flag=value work
  const chartBullet = spawnSync(
    process.execPath,
    [cliPath, "memory", "chart", "--root", repo, "--question", "Billing bullets", "--answer", "- Bullet one\n- Bullet two", "--files=src/app.ts"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(chartBullet.status, 0, chartBullet.stdout + chartBullet.stderr);
  assert.equal(JSON.parse(chartBullet.stdout).published, true);

  // RUN-008: top-level `waymark chart --facet lifecycle` populates Semantic Repo Map
  const topChart = spawnSync(
    process.execPath,
    [cliPath, "chart", "--root", repo, "--facet", "lifecycle", "--question", "Runtime entry", "--answer", "- Starts in src/app.ts", "--files", "src/app.ts"],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(topChart.status, 0, topChart.stdout + topChart.stderr);
  const mapStatus = getSemanticMapStatus(repo);
  assert.equal(mapStatus.facets.lifecycle.status, "active");

  // RUN-007: bust/prune with failing capn and stopped daemon reload/status exit non-zero
  const oldCapn = path.join(repo, "old-capn.mjs");
  fs.writeFileSync(oldCapn, 'process.stderr.write("Usage: capn <cmd>\\n"); process.exit(1);\n', "utf8");
  const badBust = spawnSync(process.execPath, [cliPath, "memory", "bust", "src/app.ts", "--root", repo, "--capn-executable", oldCapn], { encoding: "utf8", windowsHide: true });
  assert.equal(badBust.status, 2);
  const badPrune = spawnSync(process.execPath, [cliPath, "prune", "--root", repo, "--capn-executable", oldCapn], { encoding: "utf8", windowsHide: true });
  assert.equal(badPrune.status, 2);
  const stoppedReload = spawnSync(process.execPath, [cliPath, "daemon", "reload", "--root", repo], { encoding: "utf8", windowsHide: true });
  assert.equal(stoppedReload.status, 1);
  const stoppedStatus = spawnSync(process.execPath, [cliPath, "daemon", "status", "--root", repo], { encoding: "utf8", windowsHide: true });
  assert.equal(stoppedStatus.status, 1);
});

// ---------------------------------------------------------------------------
// RUN-009 + RUN-014: Live observer .waymark/.gitignore, EADDRINUSE handling, non-zero opt-in exit
// ---------------------------------------------------------------------------
test("RUN-009 + RUN-014: startLiveReplObserver returns 1 without telemetry, writes .waymark/.gitignore, and handles EADDRINUSE", async () => {
  const repo = createSampleRepo();
  const prevTel = process.env.WAYMARK_TELEMETRY;
  try {
    delete process.env.WAYMARK_TELEMETRY;
    const code = await startLiveReplObserver({ rootDir: repo, port: 0 });
    assert.equal(code, 1);

    const cliNoTel = spawnSync(process.execPath, [cliPath, "repl", "--live", "--port", "0", "--root", repo], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, WAYMARK_TELEMETRY: "0" },
    });
    assert.equal(cliNoTel.status, 1);

    // Occupy an ephemeral port to test graceful EADDRINUSE return code 1 + .waymark/.gitignore creation
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const occupiedPort = (blocker.address() as { port: number }).port;
    try {
      process.env.WAYMARK_TELEMETRY = "1";
      const bindFailCode = await startLiveReplObserver({ rootDir: repo, port: occupiedPort });
      assert.equal(bindFailCode, 1, "EADDRINUSE must return exit code 1 cleanly without unhandled error");
      assert.equal(fs.readFileSync(path.join(stateDir(repo), ".gitignore"), "utf8"), "*\n");
      const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8", windowsHide: true });
      assert.equal(gitStatus.includes(".waymark"), false, `git status must not list .waymark: ${gitStatus}`);
    } finally {
      blocker.close();
    }
  } finally {
    if (prevTel === undefined) delete process.env.WAYMARK_TELEMETRY;
    else process.env.WAYMARK_TELEMETRY = prevTel;
  }
});

// ---------------------------------------------------------------------------
// RUN-011 + MCP-001: Accurate Dev Mode diagnostics & MCP error/dev parity
// ---------------------------------------------------------------------------
test("RUN-011 + MCP-001: Dev Mode reports real daemonIpcUsed/trieHitType and MCP waymark_ask preserves dev/confidence/error fields", async () => {
  const repo = createSampleRepo();
  const res = await ask(repo, "capn-cli", "", "src/app.ts", { daemon: true, dev: true, tier: "path" });
  assert.equal(res.status, "hit");
  assert.equal((res as any).dev.daemonIpcUsed, false, "daemonIpcUsed must be false when daemon is stopped");
  assert.equal((res as any).dev.trieHitType, "exact");
  assert.equal((res as any).dev.invariantsPassed, true);

  const server = new McpServer({ root: repo, warmup: { enabled: false } });
  try {
    const mcpHit = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "waymark_ask", arguments: { root: repo, query: "src/app.ts", tier: "path", dev: true } },
    }));
    const mcpResult = JSON.parse(mcpHit!).result;
    assert.equal(mcpResult.isError, false);
    const body = JSON.parse(mcpResult.content[0].text);
    assert.equal(body.confidence, "exact");
    assert.equal(body.dev.daemonIpcUsed, false);
    assert.equal(body.dev.trieHitType, "exact");
    assert.equal(body.dev.invariantsPassed, true);

    // Trigger status: "error" via CAPN_STORE_DIR_UNSUPPORTED and verify isError: true + errorCode + plain format
    fs.mkdirSync(memoryStoreDir(repo), { recursive: true });
    fs.writeFileSync(path.join(memoryStoreDir(repo), "config.json"), JSON.stringify({ embedding: false }), "utf8");
    const oldCapn = path.join(repo, "old-capn.mjs");
    fs.writeFileSync(oldCapn, 'process.stderr.write("Usage: capn <cmd>\\n"); process.exit(1);\n', "utf8");
    const prevExe = process.env.WAYMARK_CAPN_EXECUTABLE;
    try {
      process.env.WAYMARK_CAPN_EXECUTABLE = oldCapn;
      const mcpErr = await server.handleMessage(JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "waymark_ask", arguments: { root: repo, query: "How does auth work?", tier: "capn" } },
      }));
      const errRes = JSON.parse(mcpErr!).result;
      assert.equal(errRes.isError, true);
      const errBody = JSON.parse(errRes.content[0].text);
      assert.equal(errBody.errorCode, "CAPN_STORE_DIR_UNSUPPORTED");
      assert.equal(errBody.retryable, false);

      const mcpPlainErr = await server.handleMessage(JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "waymark_ask", arguments: { root: repo, query: "How does auth work?", tier: "capn", plain: true } },
      }));
      const plainRes = JSON.parse(mcpPlainErr!).result;
      assert.equal(plainRes.isError, true);
      assert.match(plainRes.content[0].text, /^\[error: CAPN_STORE_DIR_UNSUPPORTED\]/);
    } finally {
      if (prevExe === undefined) delete process.env.WAYMARK_CAPN_EXECUTABLE;
      else process.env.WAYMARK_CAPN_EXECUTABLE = prevExe;
    }
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// RUN-013: Root-only skip list override via includeDirs & .waymark/config.json
// ---------------------------------------------------------------------------
test("RUN-013: vendor/ is skipped by default and un-excluded via includeDirs or .waymark/config.json", async () => {
  const repo = createSampleRepo();
  invalidatePathsCache();
  assert.equal(collectRepoPaths(repo).includes("vendor/pkg/dep.ts"), false);

  const included = await ask(repo, "capn-cli", "", "vendor/pkg/dep.ts", { tier: "path", includeDirs: ["vendor"] });
  assert.equal(included.status, "hit");
  assert.match(String((included as any).result), /vendor\/pkg\/dep\.ts/);

  fs.mkdirSync(stateDir(repo), { recursive: true });
  fs.writeFileSync(path.join(stateDir(repo), "config.json"), JSON.stringify({ includeDirs: ["vendor"] }), "utf8");
  invalidatePathsCache();
  assert.equal(collectRepoPaths(repo).includes("vendor/pkg/dep.ts"), true);
});

// ---------------------------------------------------------------------------
// MCP-002 + MCP-004 + MCP-005 + SVC-006: MCP schema/protocol/resource validation
// ---------------------------------------------------------------------------
test("MCP-002 + MCP-004 + MCP-005: JSON-RPC validation, waymark_map_status subsystem guard, capn://status state, depth/format validation", async () => {
  const repo = createSampleRepo();
  const server = new McpServer({ root: repo, warmup: { enabled: false } });
  try {
    // MCP-004: invalid JSON-RPC envelopes return -32600
    for (const raw of [
      "[]",
      '{"id":1}',
      '{"jsonrpc":"1.0","id":1,"method":"ping"}',
      '{"jsonrpc":"2.0","id":null,"method":"ping"}',
      '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
    ]) {
      const resp = JSON.parse((await server.handleMessage(raw))!);
      assert.equal(resp.error?.code, -32600, `Expected -32600 for ${raw}, got ${JSON.stringify(resp)}`);
    }

    // MCP-004: capn://status reports real storeStatus & resolved executable
    const statusBefore = JSON.parse((await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "capn://status" },
    })))!).result.contents[0].text;
    const parsedBefore = JSON.parse(statusBefore);
    assert.equal(parsedBefore.storeStatus, "uninitialized");
    assert.equal(parsedBefore.initialized, false);
    assert.notEqual(parsedBefore.capnExecutable, "capn");

    // MCP-002: waymark_map_status rejects subsystem
    const subRes = JSON.parse((await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "waymark_map_status", arguments: { root: repo, subsystem: "billing" } },
    })))!).result;
    assert.equal(subRes.isError, true);
    assert.equal(JSON.parse(subRes.content[0].text).code, "UNSUPPORTED_SUBSYSTEM");

    // MCP-005: invalid depth & export format rejected
    const badDepth = JSON.parse((await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "waymark_ask", arguments: { root: repo, query: "computeBilling", depth: 1.5 } },
    })))!).result;
    assert.equal(badDepth.isError, true);
    assert.equal(JSON.parse(badDepth.content[0].text).code, "INVALID_ARGUMENT");

    const badFormat = JSON.parse((await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "waymark_memory", arguments: { root: repo, action: "export", format: "xml" } },
    })))!).result;
    assert.equal(badFormat.isError, true);
    assert.equal(JSON.parse(badFormat.content[0].text).code, "INVALID_ARGUMENT");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// SVC-001 + SVC-002 + ARCH-002: Daemon --idle-timeout 3600, reload refreshes AST, memory close stops daemon
// ---------------------------------------------------------------------------
test("SVC-001 + SVC-002 + ARCH-002: daemon --idle-timeout 3600 starts, reload refreshes AST symbols, memory close stops daemon", { skip: skipCodedb() }, async () => {
  const repo = createSampleRepo();
  try {
    // SVC-001: --idle-timeout 3600 must start cleanly (previously overflowed 32-bit setTimeout and failed)
    const startRes = spawnSync(
      process.execPath,
      [cliPath, "daemon", "start", "--idle-timeout", "3600", "--root", repo],
      { encoding: "utf8", windowsHide: true, timeout: 25_000 },
    );
    assert.equal(startRes.status, 0, startRes.stdout + startRes.stderr);
    const startJson = JSON.parse(startRes.stdout);
    assert.equal(startJson.ok, true);
    assert.equal(startJson.status, "running");

    // SVC-002: Append new exported function, run daemon reload, and verify AST query sees it immediately
    fs.appendFileSync(path.join(repo, "src", "app.ts"), "\nexport function brandNewAfterReload(): number { return 777; }\n", "utf8");
    const reloadRes = await tryDaemonReload(repo);
    assert.equal(reloadRes?.ok, true);
    const queryRes = await tryDaemonQuery(repo, ["symbol", "brandNewAfterReload", "--json"]);
    assert.equal(queryRes?.ok, true);
    const hits = (queryRes?.payload?.results as Array<{ name: string }> | undefined) ?? [];
    assert.ok(hits.some((h) => h.name === "brandNewAfterReload"), `Expected brandNewAfterReload after reload, got ${JSON.stringify(hits)}`);

    // ARCH-002: `waymark memory close` stops the running daemon
    const closeRes = spawnSync(process.execPath, [cliPath, "memory", "close", "--root", repo], { encoding: "utf8", windowsHide: true });
    assert.equal(closeRes.status, 0);
    const closeJson = JSON.parse(closeRes.stdout);
    assert.equal(closeJson.closed, true);
    assert.equal(closeJson.daemonsStopped, 1);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await tryDaemonPing(repo, 200), null);
  } finally {
    await stopDaemon(repo);
  }
});

// ---------------------------------------------------------------------------
// SVC-003: ResidentCodedbClient.close() force-kills hung child process that ignores stdin EOF
// ---------------------------------------------------------------------------
test("SVC-003: ResidentCodedbClient.close() force-kills a child process that ignores stdin EOF", async () => {
  const repo = createSampleRepo();
  const stub = path.join(repo, "stub-codedb.mjs");
  fs.writeFileSync(
    stub,
    [
      'import readline from "node:readline";',
      'process.stdout.write(JSON.stringify({ status: "ready" }) + "\\n");',
      'const rl = readline.createInterface({ input: process.stdin });',
      'rl.on("line", () => {',
      '  process.stdout.write(JSON.stringify({ ok: true, results: [] }) + "\\n");',
      '});',
      'setInterval(() => {}, 10000);',
    ].join("\n"),
    "utf8",
  );
  const client = new ResidentCodedbClient(repo, { file: process.execPath, prefix: [stub], viaCmdShim: false });
  const res = await client.send(["symbol", "x", "--json"]);
  assert.equal(res.ok, true);
  const pid = client.pid;
  assert.ok(pid, "Resident child pid must be known");

  client.close();
  // Wait for 150ms fallback SIGKILL + OS process reap
  let alive = true;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      process.kill(pid!, 0);
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, `Hung child process ${pid} must be force-killed within 1s`);
});

// ---------------------------------------------------------------------------
// SVC-004 + SVC-006: Single SIGTERM exits waymark-mcp cleanly, and piped stdin drains in-flight requests
// ---------------------------------------------------------------------------
test("SVC-004 + SVC-006: waymark-mcp exits on single SIGTERM and drains piped requests before closing", async (t) => {
  const repo = createSampleRepo();
  const child = spawn(process.execPath, [mcpIndexPath], {
    cwd: repo,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, WAYMARK_MCP_WARM: "0" },
  });

  try {
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "sig-test", version: "1.0.0" } },
    }) + "\n");

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP init timeout")), 5000);
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    if (process.platform !== "win32") {
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        new Promise<string>((resolve) => setTimeout(() => resolve("TIMEOUT"), 2000)),
      ]);
      assert.notEqual(result, "TIMEOUT", "waymark-mcp must exit cleanly on a single SIGTERM");
    }
  } finally {
    try { child.kill("SIGKILL"); } catch {}
  }

  // SVC-006: immediate piped request followed by stdin EOF must still emit response before close
  const piped = spawnSync(
    process.execPath,
    [mcpIndexPath],
    {
      cwd: repo,
      input: JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "resources/read",
        params: { uri: "waymark://manifest" },
      }) + "\n",
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, WAYMARK_MCP_WARM: "0" },
    },
  );
  assert.equal(piped.status, 0);
  const reply = JSON.parse(piped.stdout.trim());
  assert.equal(reply.id, 42);
  assert.ok(reply.result?.contents?.[0]?.text);
});

// ---------------------------------------------------------------------------
// DEP-002: Windows ARM64 fallback to bundled codedb-win32-x64.exe
// ---------------------------------------------------------------------------
test("DEP-002: bundledCodedbBinary falls back to codedb-win32-x64.exe on win32-arm64", () => {
  const resolved = bundledCodedbBinary("win32", "arm64");
  assert.ok(resolved, "win32-arm64 must resolve to bundled x64 fallback binary");
  assert.equal(path.basename(resolved!), "codedb-win32-x64.exe");
});

// ---------------------------------------------------------------------------
// DOC-001: docs/library-api.md TypeScript snippets compile cleanly under tsc --noEmit --strict
// ---------------------------------------------------------------------------
test("DOC-001: docs/library-api.md TypeScript code blocks compile cleanly with tsc --noEmit --strict", () => {
  const docText = fs.readFileSync(path.join(repoRootDir, "docs", "library-api.md"), "utf8");
  const blocks = [...docText.matchAll(/```(?:ts|typescript)\r?\n([\s\S]*?)```/gu)].map((m) => m[1] ?? "");
  assert.ok(blocks.length >= 4, `Expected >=4 TS snippets in docs/library-api.md, found ${blocks.length}`);

  const tempDir = mkTrackedTempDir("waymark-doc-tsc-");
  const indexDts = path.join(repoRootDir, "dist", "src", "index.d.ts").replace(/\\/g, "/");
  blocks.forEach((block, i) => {
    const rewritten = block.replace(/from\s+"waymark-engine"/gu, `from "${indexDts.replace(/\.d\.ts$/u, ".js")}"`);
    fs.writeFileSync(path.join(tempDir, `snippet_${i}.mts`), `export {};\n${rewritten}\n`, "utf8");
  });

  const tscBin = path.join(repoRootDir, "node_modules", "typescript", "bin", "tsc");
  const res = spawnSync(
    process.execPath,
    [
      tscBin,
      "--noEmit",
      "--strict",
      "--target", "ES2022",
      "--module", "NodeNext",
      "--moduleResolution", "NodeNext",
      "--skipLibCheck",
      ...blocks.map((_, i) => path.join(tempDir, `snippet_${i}.mts`)),
    ],
    { cwd: repoRootDir, encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  assert.equal(res.status, 0, `docs/library-api.md snippets failed tsc:\n${res.stdout}\n${res.stderr}`);
});

// ---------------------------------------------------------------------------
// Regression tests for Stage 3 review fixes (RUN-001, RUN-005/006/010, DB-001/002, DOC-002, SVC-006/MCP-004)
// ---------------------------------------------------------------------------
test("RUN-001 regression: root-anchored ./ paths fail closed in ask() and live daemon IPC", { skip: skipCodedb() }, async () => {
  const repo = createSampleRepo("waymark-root-anchor-");
  fs.mkdirSync(path.join(repo, "packages", "a", "src", "auth"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages", "a", "src", "auth", "deep.ts"), "export const deep = 1;\n", "utf8");

  // In-process ask() must never extrapolate ./app.ts -> src/app.ts or ./src/auth/deep.ts -> packages/a/src/auth/deep.ts
  const missRootApp = await ask(repo, "capn-cli", "", "./app.ts");
  assert.equal(missRootApp.status, "miss");
  assert.equal((missRootApp as any).missCode, "SYMBOL_NOT_FOUND");

  const missDeep = await ask(repo, "capn-cli", "", "./src/auth/deep.ts");
  assert.equal(missDeep.status, "miss");
  assert.equal((missDeep as any).missCode, "SYMBOL_NOT_FOUND");

  const hitExact = await ask(repo, "capn-cli", "", "./src/app.ts");
  assert.equal(hitExact.status, "hit");
  assert.match(String(hitExact.result), /src\/app\.ts\t\[exact\]/);

  const hitRepeatedDot = await ask(repo, "capn-cli", "", "././src/app.ts");
  assert.equal(hitRepeatedDot.status, "hit");
  assert.match(String(hitRepeatedDot.result), /src\/app\.ts\t\[exact\]/);

  // Same guarantee over live WaymarkDaemon IPC
  const daemon = new WaymarkDaemon(repo, 60_000);
  try {
    const started = await daemon.start();
    assert.equal(started, true);
    const daemonMiss = await ask(repo, "capn-cli", "", "./app.ts", { tier: "path", dev: true });
    assert.equal(daemonMiss.status, "miss");
    assert.equal((daemonMiss as any).dev?.daemonIpcUsed, true);
    const daemonHit = await ask(repo, "capn-cli", "", "./src/app.ts", { tier: "path", dev: true });
    assert.equal(daemonHit.status, "hit");
    assert.equal((daemonHit as any).dev?.daemonIpcUsed, true);
  } finally {
    daemon.stop();
  }
});

test("RUN-005 + RUN-006 + RUN-010 regression: free-text flag-like values, scoped --language mismatch, and --json --version", () => {
  const repo = createSampleRepo("waymark-cli-edge-");
  fs.writeFileSync(path.join(repo, "sample.go"), "package main\nfunc myFunc() {}\n", "utf8");

  // --answer "-h" and --answer "--plain" must be accepted as string values
  for (const val of ["-h", "--plain", "-v"]) {
    const res = spawnSync(
      process.execPath,
      [cliPath, "memory", "chart", "--root", repo, "--question", `Flag value ${val}`, "--answer", val, "--files", "src/app.ts"],
      { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    assert.equal(res.status, 0, `--answer ${val} must succeed: ${res.stdout} ${res.stderr}`);
    assert.equal(JSON.parse(res.stdout).published, true);
  }

  // Scoped path + query + mismatched --language must fail closed with LANGUAGE_EXTENSION_MISMATCH
  const langMismatch = spawnSync(
    process.execPath,
    [cliPath, "ask", "--root", repo, "--path", "sample.go", "--language", "python", "myFunc"],
    { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 15_000 },
  );
  assert.notEqual(langMismatch.status, 0);
  const parsedMismatch = JSON.parse(langMismatch.stdout);
  assert.equal(parsedMismatch.code ?? parsedMismatch.errorCode, "LANGUAGE_EXTENSION_MISMATCH");

  // --json --version must emit structured JSON version envelope
  const jsonVer = spawnSync(
    process.execPath,
    [cliPath, "--json", "--version"],
    { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 10_000 },
  );
  assert.equal(jsonVer.status, 0);
  const verPayload = JSON.parse(jsonVer.stdout);
  assert.equal(verPayload.kind, "version");
  assert.equal(verPayload.ok, true);
});

test("DB-001 + DB-002 regression: cross-process OS contention (chart + ask + list) and dead-PID stale lock recovery", async () => {
  const repo = createSampleRepo("waymark-xproc-lock-");
  const runAsync = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        cwd: repo,
        windowsHide: true,
        env: { ...process.env, CODEDB_ALLOW_TEMP: "1" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });

  const initRes = await runAsync(["memory", "init"]);
  assert.equal(initRes.code, 0, initRes.stdout + initRes.stderr);
  const seedRes = await runAsync(["memory", "chart", "--question", "Stale target", "--answer", "Old", "--files", "src/auth/utils.ts"]);
  assert.equal(seedRes.code, 0, seedRes.stdout + seedRes.stderr);
  // Mutate backing file so concurrent chart/ask/list contend on stale pruning under the store lock
  fs.writeFileSync(path.join(repo, "src", "auth", "utils.ts"), "export function verifyToken(): boolean { return false; }\n", "utf8");

  // 1. 4-way cross-process OS contention (2 concurrent facet charts + ask + list)
  const results = await Promise.all([
    runAsync(["memory", "chart", "--facet", "lifecycle", "--question", "Proc A", "--answer", "Entry A", "--files", "src/app.ts"]),
    runAsync(["memory", "chart", "--facet", "lifecycle", "--question", "Proc B", "--answer", "Entry B", "--files", "src/app.ts"]),
    runAsync(["ask", "--tier", "capn", "Stale target"]),
    runAsync(["memory", "list"]),
  ]);

  assert.equal(results[0]!.code, 0, results[0]!.stdout + results[0]!.stderr);
  assert.equal(results[1]!.code, 0, results[1]!.stdout + results[1]!.stderr);
  assert.equal(results[2]!.code, 0, results[2]!.stdout + results[2]!.stderr);
  assert.equal(results[3]!.code, 0, results[3]!.stdout + results[3]!.stderr);

  const status = getSemanticMapStatus(repo);
  assert.equal(status.activeCount, 1, `Expected 1 surviving lifecycle entry after cross-process race, got ${status.activeCount}`);
  assert.equal(status.facets.lifecycle.status, "active");

  // Stale entry must be cleanly pruned regardless of whether chart, ask, or list acquired the lock first.
  const entriesAfter4Way = readChartedEntries(repo);
  assert.equal(entriesAfter4Way.length, 1, `Expected only the surviving lifecycle entry, got ${entriesAfter4Way.map((e) => e.question).join(", ")}`);
  assert.equal(entriesAfter4Way.some((e) => e.question === "Stale target"), false, "Stale entry must be absent after 4-way contention");
  assert.equal(staleChartedEntries(repo).length, 0, "No stale entries should remain after 4-way contention");

  // Because `capn chart` also calls `prune()` under the store lock, a concurrent `memory chart`
  // winning the lock before ask/list cleanly prunes the stale entry (prunedObservers === 0);
  // otherwise whichever of ask/list acquires the lock first prunes it (prunedObservers === 1).
  // Under serialized locking, ask and list must never both observe & race-prune it (never 2).
  const askParsed = JSON.parse(results[2]!.stdout);
  const listParsed = JSON.parse(results[3]!.stdout);
  assert.equal(askParsed.status, "miss", "Stale entry must never be returned as a hit");
  const prunedObservers = Number(Array.isArray(askParsed.memoryPruned) && askParsed.memoryPruned.length > 0)
    + Number(Array.isArray(listParsed.pruned) && listParsed.pruned.length > 0);
  assert.ok(prunedObservers <= 1, `Stale entry must not be raced by both ask and list (got ${prunedObservers} observers)`);

  // 2. Deterministic 2-way ask + list stale-prune race (no concurrent chart stealing the prune)
  const seed2 = await runAsync(["memory", "chart", "--question", "Stale ask-list target", "--answer", "Old2", "--files", "src/auth/utils.ts"]);
  assert.equal(seed2.code, 0, seed2.stdout + seed2.stderr);
  assert.equal(readChartedEntries(repo).some((e) => e.question === "Stale ask-list target"), true);
  fs.writeFileSync(path.join(repo, "src", "auth", "utils.ts"), "export function verifyToken(): boolean { return Math.random() < 0; }\n", "utf8");
  assert.equal(staleChartedEntries(repo).some((e) => e.question === "Stale ask-list target"), true);

  const [ask2Res, list2Res] = await Promise.all([
    runAsync(["ask", "--tier", "capn", "Stale ask-list target"]),
    runAsync(["memory", "list"]),
  ]);
  assert.equal(ask2Res.code, 0, ask2Res.stdout + ask2Res.stderr);
  assert.equal(list2Res.code, 0, list2Res.stdout + list2Res.stderr);
  const ask2Parsed = JSON.parse(ask2Res.stdout);
  const list2Parsed = JSON.parse(list2Res.stdout);
  assert.equal(ask2Parsed.status, "miss", "Stale entry must never be returned as a hit");
  const ask2Observed = Array.isArray(ask2Parsed.memoryPruned) && ask2Parsed.memoryPruned.some((line: string) => line.includes("Stale ask-list target"));
  const list2Observed = Array.isArray(list2Parsed.pruned) && list2Parsed.pruned.some((line: string) => line.includes("Stale ask-list target"));
  assert.equal(
    Number(ask2Observed) + Number(list2Observed),
    1,
    "Exactly one of concurrent ask/list must observe and prune the stale entry under serialized lock",
  );
  assert.equal(readChartedEntries(repo).some((e) => e.question === "Stale ask-list target"), false);
  assert.equal(staleChartedEntries(repo).length, 0);
  assert.equal(getSemanticMapStatus(repo).activeCount, 1);

  // 3. Stale lock recovery when lockfile owner PID no longer exists
  let deadPid = 999999;
  for (let probe = 0; probe < 100; probe += 1) {
    try {
      process.kill(deadPid, 0);
      deadPid += 1;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") break;
      deadPid += 1;
    }
  }
  const lockPath = path.join(stateDir(repo), "memory.lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, token: "dead-owner", createdAt: Date.now() }), "utf8");
  const afterStale = await runAsync(["memory", "chart", "--facet", "boundaries", "--question", "Boundaries", "--answer", "IPC", "--files", "src/app.ts"]);
  assert.equal(afterStale.code, 0, afterStale.stdout + afterStale.stderr);
  assert.equal(JSON.parse(afterStale.stdout).published, true);
  assert.equal(fs.existsSync(lockPath), false, "Lockfile must be cleaned up after completion");
});

test("DOC-002 regression: interactive REPL executes piped slash commands (/help, /status, /battery, /exit) before closing", { skip: skipCodedb() }, async () => {
  const repo = createSampleRepo("waymark-repl-slash-");
  try {
    const replRes = spawnSync(
      process.execPath,
      [cliPath, "repl", "--root", repo],
      {
        cwd: repo,
        input: "/help\n/status\n/battery\n/exit\n",
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
        env: { ...process.env, CODEDB_ALLOW_TEMP: "1" },
      },
    );
    assert.equal(replRes.status, 0, `REPL failed: ${replRes.stderr}`);
    assert.match(replRes.stdout, /Waymark REPL Commands:/);
    assert.match(replRes.stdout, /\/battery/);
    assert.match(replRes.stdout, /Resident daemon is RUNNING/);
    assert.match(replRes.stdout, /Manifest file not found:/);
    assert.match(replRes.stdout, /Goodbye\./);
  } finally {
    await stopDaemon(repo);
  }
});

test("SVC-006 + MCP-004 regression: waymark-mcp stdio enforces 8 MiB frame cap, rejects non-object params (-32602), and drains burst on EOF", () => {
  const repo = createSampleRepo("waymark-mcp-frame-");
  const oversized = `{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"${"x".repeat(8 * 1024 * 1024 + 64)}"}}`;
  const input = [
    oversized,
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: "not-an-object" }),
    JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "waymark_ask", arguments: { query: "src/app.ts", root: repo } } }),
    JSON.stringify({ jsonrpc: "2.0", id: 5, method: "ping" }),
  ].join("\n") + "\n";

  const res = spawnSync(process.execPath, [mcpIndexPath], {
    cwd: repo,
    input,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, WAYMARK_MCP_WARM: "0", CODEDB_ALLOW_TEMP: "1" },
  });
  assert.equal(res.status, 0, `waymark-mcp exited ${res.status}: ${res.stderr}`);
  const lines = res.stdout.trim().split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 5, `Expected 5 JSON-RPC responses, got ${lines.length}`);
  const parsed = lines.map((l) => JSON.parse(l));
  assert.equal(parsed[0].error.code, -32600);
  assert.match(parsed[0].error.message, /exceeds 8388608 byte limit/);
  assert.equal(parsed[1].id, 2);
  assert.ok(parsed[1].result);
  assert.equal(parsed[2].id, 3);
  assert.equal(parsed[2].error.code, -32602);
  assert.equal(parsed[3].id, 4);
  assert.equal(JSON.parse(parsed[3].result.content[0].text).status, "hit");
  assert.equal(parsed[4].id, 5);
  assert.ok(parsed[4].result);
});
