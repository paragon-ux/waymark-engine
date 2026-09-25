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

test("MCP capn_ask and waymark_ask support tier isolation (tier: 'ast')", async () => {
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

test("MCP capn_ask supports plain text output mode (plain: true) for token efficiency", async () => {
  const repo = setupRepo();
  const server = new McpServer({ root: repo });

  const response = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "capn_ask",
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
