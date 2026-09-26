import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { McpServer } from "../src/mcp/server.js";
import { routeDiscovery } from "../src/discoveryRouter.js";
import { AskMissResult, FuzzyCandidate } from "../src/types.js";

const require = createRequire(import.meta.url);

function forkEntry(): string {
  const pkg = require.resolve("@paragon-ux/capn-hook/package.json");
  return path.join(path.dirname(pkg), "dist", "capn.js");
}

function setupRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-mcp-parity-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "service.ts"),
    "export function executeCommand(): string { return 'done'; }\nexport const resultNone = null;\n",
    "utf8"
  );
  execFileSync(process.execPath, [forkEntry(), "init"], { cwd: repo });
  return repo;
}

test("Precision Parity: 'Who calls Run?' fails closed without matching non-callable or plain substring", async () => {
  const repo = setupRepo();

  // Mock candidates including a variable named resultNone in a test fixture
  const mockCandidates: FuzzyCandidate[] = [
    { name: "resultNone", path: "test/fixture.test.ts", line: 254, kind: "const" },
    { name: "roundTripCounter", path: "src/service.ts", line: 10, kind: "variable" },
  ];

  const res = await routeDiscovery({
    root: repo,
    question: "Who calls 'Run'?",
    overrideCandidates: mockCandidates,
    queryCapnMemory: async () => ({ hit: false, result: null }),
  });

  // Must be a clean structural miss, NEVER falling through to Stage 3 to recommend resultNone!
  assert.equal(res.status, "miss");
  const miss = res as AskMissResult;
  assert.equal(miss.provider, "codedb");
  assert.equal(miss.missCode, "SYMBOL_NOT_FOUND");
  assert.match(miss.reason, /No structural symbol or call graph match found/);
});

test("MCP waymark_ask supports tier isolation (tier: 'ast')", async () => {
  const repo = setupRepo();
  const server = new McpServer({ root: repo });

  // Call waymark_ask with tier: ast on a nonexistent symbol
  const response = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls NonExistentSymbol?",
          tier: "ast",
          root: repo,
        },
      },
    })
  );

  const parsed = JSON.parse(response ?? "{}");
  assert.equal(parsed.result?.isError, false);
  const body = JSON.parse(parsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(body.status, "miss");
  assert.equal(body.provider, "codedb");
  assert.equal(body.missCode, "SYMBOL_NOT_FOUND");
});

test("MCP waymark_ask supports plain text output mode (plain: true) for token efficiency", async () => {
  const repo = setupRepo();
  const server = new McpServer({ root: repo });

  const response = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls NonExistentSymbol?",
          tier: "ast",
          plain: true,
          root: repo,
        },
      },
    })
  );

  const parsed = JSON.parse(response ?? "{}");
  assert.equal(parsed.result?.isError, false);
  const text = parsed.result?.content?.[0]?.text ?? "";
  assert.ok(text.startsWith("[miss]"), `Expected plain text [miss], got: ${text}`);
  assert.match(text, /No structural symbol or call graph match found/);
});

test("MCP maintenance tools: chart -> list -> context -> bust -> unchart -> prune", async () => {
  const repo = setupRepo();
  const server = new McpServer({ root: repo });

  // 1. Chart an entry
  const chartRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "waymark_chart",
        arguments: {
          question: "How does executeCommand work?",
          answer: "It executes commands and returns done.",
          files: ["src/service.ts"],
          root: repo,
        },
      },
    })
  );
  const chartBody = JSON.parse(JSON.parse(chartRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(chartBody.published, true);

  // 2. List entries via waymark_list
  const listRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "waymark_list",
        arguments: { root: repo },
      },
    })
  );
  const listBody = JSON.parse(JSON.parse(listRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(listBody.ok, true);
  assert.match(String(listBody.output), /executeCommand/);

  // Extract ID
  const idMatch = String(listBody.output).match(/^([0-9a-f]{8})$/m);
  const chartId = idMatch?.[1];
  assert.ok(chartId, "Charted ID should be present in list output");

  // 3. Query context via waymark_context
  const ctxRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "waymark_context",
        arguments: { root: repo },
      },
    })
  );
  const ctxBody = JSON.parse(JSON.parse(ctxRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(ctxBody.ok, true);
  assert.match(String(ctxBody.output), /waymark-ask routes questions/);

  // 4. Test unchart with if_exists: true
  const unchartRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "waymark_unchart",
        arguments: { id: chartId, root: repo },
      },
    })
  );
  const unchartBody = JSON.parse(JSON.parse(unchartRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(unchartBody.ok, true);

  // 5. Test unchart idempotent with if_exists
  const unchartMissingRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "waymark_unchart",
        arguments: { id: "deadbeef", if_exists: true, root: repo },
      },
    })
  );
  const unchartMissingBody = JSON.parse(JSON.parse(unchartMissingRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(unchartMissingBody.ok, true);

  // 6. Test prune
  const pruneRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "waymark_prune",
        arguments: { root: repo },
      },
    })
  );
  const pruneBody = JSON.parse(JSON.parse(pruneRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(pruneBody.ok, true);

  // 7. Test daemon status
  const daemonRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "waymark_daemon_status",
        arguments: { root: repo },
      },
    })
  );
  const daemonBody = JSON.parse(JSON.parse(daemonRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(daemonBody.waymark, 1);
  assert.equal(daemonBody.kind, "daemon");
});

test("MCP waymark_init and uninitialized repo graceful degradation", async () => {
  const uninitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-uninit-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: uninitRepo });
  fs.mkdirSync(path.join(uninitRepo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(uninitRepo, "src", "index.ts"),
    "export function main(): void {}\n",
    "utf8"
  );
  const server = new McpServer({ root: uninitRepo });

  // 1. waymark_list degrades gracefully
  const listRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "waymark_list",
        arguments: { root: uninitRepo },
      },
    })
  );
  const listBody = JSON.parse(JSON.parse(listRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(listBody.ok, true);
  assert.equal(listBody.count, 0);

  // 2. waymark_context degrades gracefully
  const contextRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "waymark_context",
        arguments: { root: uninitRepo },
      },
    })
  );
  const contextBody = JSON.parse(JSON.parse(contextRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(contextBody.ok, true);
  assert.equal(contextBody.store, "uninitialized");

  // 3. waymark_chart rejects non-existent file
  const badChartRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "waymark_chart",
        arguments: {
          question: "Test question?",
          answer: "Test answer.",
          files: ["nonexistent.ts"],
          root: uninitRepo,
        },
      },
    })
  );
  const badChartBody = JSON.parse(JSON.parse(badChartRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(badChartBody.ok, false);
  assert.match(badChartBody.message, /Chart backing file not found/);

  // 4. waymark_chart rejects directory path
  const dirChartRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "waymark_chart",
        arguments: {
          question: "Test question?",
          answer: "Test answer.",
          files: ["src"],
          root: uninitRepo,
        },
      },
    })
  );
  const dirChartBody = JSON.parse(JSON.parse(dirChartRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(dirChartBody.ok, false);
  assert.match(dirChartBody.message, /is directory/);

  // 5. waymark_chart auto-initializes store and charts successfully
  const chartRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "waymark_chart",
        arguments: {
          question: "What is entry point?",
          answer: "main in src/index.ts",
          files: ["src/index.ts"],
          root: uninitRepo,
        },
      },
    })
  );
  const chartBody = JSON.parse(JSON.parse(chartRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(chartBody.published, true);
});

test("MCP waymark_ask defaults auto_resolve to true", async () => {
  const repo = setupRepo();
  const server = new McpServer({ root: repo });

  // Query with fuzzy candidate that triggers junction recommendation
  const res = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 30,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "executeCmd",
          root: repo,
        },
      },
    })
  );
  const body = JSON.parse(JSON.parse(res ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(body.status, "hit");
  assert.equal(body.provider, "fuzzy-lexical");
});

test("MCP waymark_ask supports explicit multi-symbol querying (JSON & plain: true)", async () => {
  const repo = setupRepo();
  const server = new McpServer({ root: repo });

  // 1. JSON mode
  const res = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          symbols: ["executeCommand", "nonExistentFoo"],
          root: repo,
        },
      },
    })
  );
  const body = JSON.parse(JSON.parse(res ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(body.kind, "multi-symbol");
  assert.equal(body.status, "partial");
  assert.equal(body.total, 2);
  assert.equal(body.hits, 1);
  assert.equal(body.misses, 1);
  assert.equal(body.symbols.executeCommand.status, "hit");
  assert.equal(body.symbols.nonExistentFoo.status, "miss");

  // 2. Plain mode
  const plainRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          symbols: ["executeCommand", "nonExistentFoo"],
          plain: true,
          root: repo,
        },
      },
    })
  );
  const text = JSON.parse(plainRes ?? "{}").result?.content?.[0]?.text ?? "";
  assert.match(text, /\[multi-symbol\] \(1 hit, 1 miss\)/);
  assert.match(text, /executeCommand: .*src[\\/]service\.ts:1/);
  assert.match(text, /nonExistentFoo: \[miss\] \(not found\)/);
});

test("CLI symbols and waymark-symbols commands return consolidated results", async () => {
  const repo = setupRepo();
  const cli = path.resolve("dist/src/cli.js");

  // Run 'waymark symbols executeCommand'
  const stdout = execFileSync(process.execPath, [cli, "symbols", "executeCommand", "--plain"], {
    cwd: repo,
    windowsHide: true,
    encoding: "utf8",
  });
  assert.match(stdout, /\[multi-symbol\] \(1 hit, 0 misses\)/);
  assert.match(stdout, /executeCommand: .*src[\\/]service\.ts:1/);

  // Run 'waymark symbols' with JSON output
  const jsonStdout = execFileSync(process.execPath, [cli, "symbols", "executeCommand"], {
    cwd: repo,
    windowsHide: true,
    encoding: "utf8",
  });
  const parsed = JSON.parse(jsonStdout);
  assert.equal(parsed.kind, "multi-symbol");
  assert.equal(parsed.hits, 1);
  assert.equal(parsed.symbols.executeCommand.status, "hit");
});

test("Edge Cases: multi-symbol 0-hits, empty symbols array fallback, and special identifier names", async () => {
  const repo = setupRepo();
  const server = new McpServer({ root: repo });

  // 1. All misses
  const allMissRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          symbols: ["fakeSym1", "fakeSym2"],
          plain: true,
          root: repo,
        },
      },
    })
  );
  const text = JSON.parse(allMissRes ?? "{}").result?.content?.[0]?.text ?? "";
  assert.match(text, /\[multi-symbol\] \(0 hits, 2 misses\)/);
  assert.match(text, /fakeSym1: \[miss\] \(not found\)/);
  assert.match(text, /fakeSym2: \[miss\] \(not found\)/);

  // 2. Empty symbols array without question throws MISSING_ARGUMENT
  const emptyRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          symbols: [],
          root: repo,
        },
      },
    })
  );
  const body = JSON.parse(JSON.parse(emptyRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(body.ok, false);
  assert.equal(body.code, "MISSING_ARGUMENT");

  // 3. Array with empty/whitespace strings ignored
  const wsRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          symbols: ["   ", "", "executeCommand"],
          root: repo,
        },
      },
    })
  );
  const wsBody = JSON.parse(JSON.parse(wsRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(wsBody.total, 1);
  assert.equal(wsBody.hits, 1);
  assert.equal(wsBody.symbols.executeCommand.status, "hit");
});

test("Bounded Multi-Hop BFS Call Graph: depth, directionality, cycle prevention, and indented tree plain text (LEDGER-08 / DOD-11)", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-callgraph-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });

  // Chain: entry -> middle -> leaf
  // Cycle: cycleA <-> cycleB
  fs.writeFileSync(
    path.join(repo, "src", "pipeline.ts"),
    [
      "export function leaf(): string { return 'leaf'; }",
      "export function middle(): string { return leaf(); }",
      "export function entry(): string { return middle(); }",
      "export function cycleA(): string { return cycleB(); }",
      "export function cycleB(): string { return cycleA(); }",
    ].join("\n"),
    "utf8"
  );
  execFileSync(process.execPath, [forkEntry(), "init"], { cwd: repo });
  const server = new McpServer({ root: repo });

  // 1. depth: 1 callers
  const d1Res = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 60,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls leaf?",
          depth: 1,
          direction: "callers",
          root: repo,
        },
      },
    })
  );
  const d1Body = JSON.parse(JSON.parse(d1Res ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(d1Body.status, "hit");
  assert.equal(d1Body.result.tool, "call_graph");
  assert.equal(d1Body.result.function, "leaf");
  assert.equal(d1Body.result.depth, 1);
  assert.equal(d1Body.result.direction, "callers");
  assert.ok(Array.isArray(d1Body.result.callers));
  assert.equal(d1Body.result.callers.length, 1);
  assert.equal(d1Body.result.callers[0].name, "middle");
  assert.equal(d1Body.result.callers[0].callers, undefined);

  // 2. depth: 2 callers (multi-hop traversal)
  const d2Res = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls leaf?",
          depth: 2,
          direction: "callers",
          root: repo,
        },
      },
    })
  );
  const d2Body = JSON.parse(JSON.parse(d2Res ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(d2Body.status, "hit");
  assert.equal(d2Body.result.depth, 2);
  assert.equal(d2Body.result.callers[0].name, "middle");
  assert.ok(d2Body.result.callers[0].callers);
  assert.equal(d2Body.result.callers[0].callers[0].name, "entry");

  // 3. direction: 'callees' on entry
  const calleesRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "What does entry call?",
          depth: 2,
          direction: "callees",
          root: repo,
        },
      },
    })
  );
  const calleesBody = JSON.parse(JSON.parse(calleesRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(calleesBody.status, "hit");
  assert.equal(calleesBody.result.direction, "callees");
  assert.equal(calleesBody.result.callers, undefined);
  assert.ok(calleesBody.result.callees);
  assert.equal(calleesBody.result.callees[0].name, "middle");
  assert.ok(calleesBody.result.callees[0].callees);
  assert.equal(calleesBody.result.callees[0].callees[0].name, "leaf");

  // 4. Cycle prevention on recursive cycles
  const cycleRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 63,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls cycleA?",
          depth: 4,
          direction: "both",
          root: repo,
        },
      },
    })
  );
  const cycleBody = JSON.parse(JSON.parse(cycleRes ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(cycleBody.status, "hit");
  assert.ok(cycleBody.result.totalNodes <= 3);

  // 5. Plain text indented tree formatting (plain: true)
  const plainRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 64,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls leaf?",
          depth: 2,
          direction: "callers",
          plain: true,
          root: repo,
        },
      },
    })
  );
  const plainText = JSON.parse(plainRes ?? "{}").result?.content?.[0]?.text ?? "";
  assert.match(plainText, /\[call-graph: depth 2\]/);
  assert.match(plainText, /leaf/);
  assert.match(plainText, /↳ callers:/);
  assert.match(plainText, /- middle/);
  assert.match(plainText, /- entry/);
});

test("Persistent In-Memory Prefix Trie & Resident Daemon Path Resolution (LEDGER-09 / DOD-12)", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-prefixtrie-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src", "pkg_a"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "pkg_b"), { recursive: true });

  fs.writeFileSync(path.join(repo, "src", "pkg_a", "worker.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "pkg_b", "worker.ts"), "export const b = 2;\n");
  fs.writeFileSync(path.join(repo, "src", "unique_handler.ts"), "export const h = 3;\n");

  const { PrefixTrie } = await import("../src/prefixTrie.js");
  const { collectRepoPaths, getRepoPrefixTrie, invalidatePathsCache } = await import("../src/discoveryRouter.js");
  const { WaymarkDaemon, tryDaemonResolvePath, stopDaemon } = await import("../src/daemon.js");

  const paths = collectRepoPaths(repo);
  const trie = new PrefixTrie(paths);

  // 1. Exact match via trie
  const exact = trie.match("src/unique_handler.ts");
  assert.equal(exact.length, 1);
  assert.ok(exact[0]);
  assert.equal(exact[0]!.kind, "exact");
  assert.equal(exact[0]!.file, "src/unique_handler.ts");

  // 2. Basename collision guard (ambiguous worker.ts refused)
  const collision = trie.match("worker.ts");
  assert.equal(collision.length, 0);

  // 3. Basename single hit
  const singleBase = trie.match("unique_handler.ts");
  assert.equal(singleBase.length, 1);
  assert.ok(singleBase[0]);
  assert.equal(singleBase[0]!.kind, "basename");
  assert.equal(singleBase[0]!.file, "src/unique_handler.ts");

  // 4. Invalidation
  invalidatePathsCache();
  const trie2 = getRepoPrefixTrie(repo);
  assert.ok(trie2.size >= 3);

  // 5. Resident daemon IPC resolution
  const daemon = new WaymarkDaemon(repo, 30_000);
  await daemon.start();
  try {
    const daemonMatches = await tryDaemonResolvePath(repo, "unique_handler.ts");
    assert.ok(daemonMatches);
    assert.equal(daemonMatches.length, 1);
    assert.equal(daemonMatches[0]!.file, "src/unique_handler.ts");
  } finally {
    await stopDaemon(repo, { force: true });
  }
});

test("Call Graph test exclusion (exclude_tests) and Resident Daemon reload", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-excludetests-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });

  fs.writeFileSync(
    path.join(repo, "src", "service.ts"),
    [
      "export function computePayload(): string { return 'data'; }",
      "export function handler(): string { return computePayload(); }",
    ].join("\n") + "\n"
  );

  fs.writeFileSync(
    path.join(repo, "tests", "service.test.ts"),
    [
      "import { computePayload } from '../src/service.js';",
      "export function testCompute(): void { computePayload(); }",
    ].join("\n") + "\n"
  );

  const { isTestFile } = await import("../src/codedbAdapter.js");
  assert.equal(isTestFile("tests/service.test.ts"), true);
  assert.equal(isTestFile("src/service.ts"), false);

  const server = new McpServer({ root: repo });

  // 1. Without exclude_tests: both handler and testCompute appear
  const resAll = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 70,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls computePayload?",
          depth: 1,
          direction: "callers",
          root: repo,
        },
      },
    })
  );
  const bodyAll = JSON.parse(JSON.parse(resAll ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(bodyAll.status, "hit");
  const callersAll = (bodyAll.result.callers ?? []).map((c: any) => c.name);
  assert.ok(callersAll.includes("handler") || callersAll.includes("testCompute"));

  // 2. With exclude_tests: true: testCompute is filtered out
  const resFiltered = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 71,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          question: "Who calls computePayload?",
          depth: 1,
          direction: "callers",
          exclude_tests: true,
          root: repo,
        },
      },
    })
  );
  const bodyFiltered = JSON.parse(JSON.parse(resFiltered ?? "{}").result?.content?.[0]?.text ?? "{}");
  assert.equal(bodyFiltered.status, "hit");
  const callersFiltered = (bodyFiltered.result.callers ?? []).map((c: any) => c.name);
  assert.ok(!callersFiltered.includes("testCompute"));

  // 3. Test daemon reload via MCP waymark_daemon_status with reload: true
  const { WaymarkDaemon, stopDaemon } = await import("../src/daemon.js");
  const daemon = new WaymarkDaemon(repo, 30_000);
  await daemon.start();
  try {
    const reloadRes = await server.handleMessage(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 72,
        method: "tools/call",
        params: {
          name: "waymark_daemon_status",
          arguments: {
            root: repo,
            reload: true,
          },
        },
      })
    );
    const reloadBody = JSON.parse(JSON.parse(reloadRes ?? "{}").result?.content?.[0]?.text ?? "{}");
    assert.equal(reloadBody.waymark, 1);
    assert.equal(reloadBody.action, "reload");
    assert.equal(reloadBody.ok, true);
    assert.equal(reloadBody.status, "reloaded");
  } finally {
    await stopDaemon(repo, { force: true });
  }
});



