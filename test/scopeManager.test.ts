import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyPath,
  matchesPattern,
  isPathInScope,
  analyzeScope,
  setScopeFence,
  getScopeFence,
  clearScopeFence,
  exportScopeIgnore,
  handleScopeAction,
} from "../src/scopeManager.js";
import { waymarkScopeTool, waymarkAskTool } from "../src/mcp/capnTools.js";
import { McpServer } from "../src/mcp/server.js";

function createMockRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-scope-test-"));
  // 1. Core Source
  fs.mkdirSync(path.join(repo, "src", "engine"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "engine", "protocol.ts"), "export const PROTOCOL = 'v2';\n");
  fs.writeFileSync(path.join(repo, "src", "index.ts"), "export * from './engine/protocol';\n");

  // 2. Test Harness
  fs.mkdirSync(path.join(repo, "test"), { recursive: true });
  fs.writeFileSync(path.join(repo, "test", "protocol.test.ts"), "import test from 'node:test';\n");

  // 3. Recorded Workspaces (e.g. agent execution traces, eval runs)
  fs.mkdirSync(path.join(repo, "agent-runs", "run-101", "session"), { recursive: true });
  fs.writeFileSync(path.join(repo, "agent-runs", "run-101", "session", "transcript.jsonl"), '{"step":1}\n');

  // 4. Docs
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "docs", "ARCHITECTURE.md"), "# Architecture Guide\n");

  // 5. Config
  fs.writeFileSync(path.join(repo, "package.json"), '{"name":"mock-repo"}\n');

  return repo;
}

test("classifyPath categorizes repository paths into universal architectural dimensions", () => {
  assert.equal(classifyPath("src/engine/protocol.ts"), "CORE_SOURCE");
  assert.equal(classifyPath("pkg/api/access.go"), "CORE_SOURCE");
  assert.equal(classifyPath("test/protocol.test.ts"), "TEST_HARNESS");
  assert.equal(classifyPath("e2e/login.spec.ts"), "TEST_HARNESS");
  assert.equal(classifyPath("agent-runs/run-101/transcript.jsonl"), "RECORDED_WORKSPACES");
  assert.equal(classifyPath("runs/eval-2026/evidence.json"), "RECORDED_WORKSPACES");
  assert.equal(classifyPath("docs/ARCHITECTURE.md"), "DOCS_METADATA");
  assert.equal(classifyPath("README.md"), "DOCS_METADATA");
  assert.equal(classifyPath("package.json"), "CONFIG_INFRA");
  assert.equal(classifyPath("tsconfig.json"), "CONFIG_INFRA");
  assert.equal(classifyPath("dist/bundle.js"), "BUILD_ARTIFACTS");
  assert.equal(classifyPath("node_modules/express/index.js"), "VENDOR_DEPENDENCIES");
});

test("matchesPattern matches prefix globs, directory globs, and suffix globs accurately", () => {
  assert.ok(matchesPattern("agent-runs/run-101/data.json", "*runs/**"));
  assert.ok(matchesPattern("agent-runs/run-101/data.json", "agent-runs/**"));
  assert.ok(matchesPattern("test/foo.test.ts", "test/**"));
  assert.ok(matchesPattern("src/foo.test.ts", "**/*.test.ts"));
  assert.ok(matchesPattern("src/index.ts", "src/**"));
  assert.ok(!matchesPattern("src/index.ts", "*runs/**"));
  assert.ok(!matchesPattern("src/index.ts", "test/**"));
});

test("analyzeScope produces category breakdown, token gravity, and interactive presets", () => {
  const repo = createMockRepo();
  const analysis = analyzeScope(repo);

  assert.equal(analysis.root, repo);
  assert.ok(analysis.totalFiles >= 5);
  assert.ok(analysis.totalEstimatedTokens > 0);

  // Categories present
  assert.equal(analysis.categories.CORE_SOURCE.fileCount, 2);
  assert.equal(analysis.categories.TEST_HARNESS.fileCount, 1);
  assert.equal(analysis.categories.RECORDED_WORKSPACES.fileCount, 1);
  assert.equal(analysis.categories.DOCS_METADATA.fileCount, 1);
  assert.equal(analysis.categories.CONFIG_INFRA.fileCount, 1);

  // Presets
  assert.ok(analysis.presets.wide);
  assert.ok(analysis.presets.medium);
  assert.ok(analysis.presets.narrow);
  assert.equal(analysis.presets.medium.recommended, true);

  // Interactive Prompt
  assert.ok(analysis.interactivePrompt.question.includes("Which scoping boundary"));
  assert.equal(analysis.interactivePrompt.options.length, 3);
  assert.equal(analysis.interactivePrompt.options[0]?.level, "medium");
  assert.equal(analysis.interactivePrompt.options[0]?.recommended, true);
});

test("setScopeFence enforces session isolation and evaluates path inclusion", () => {
  const repo = createMockRepo();
  clearScopeFence("session-worker-A");
  clearScopeFence("session-worker-B");

  // Worker A: Medium scope
  const fenceA = setScopeFence(repo, "medium", { sessionId: "session-worker-A" });
  assert.equal(fenceA.level, "medium");
  assert.equal(fenceA.sessionId, "session-worker-A");

  // Worker B: Wide scope
  const fenceB = setScopeFence(repo, "wide", { sessionId: "session-worker-B" });
  assert.equal(fenceB.level, "wide");
  assert.equal(fenceB.sessionId, "session-worker-B");

  // Verify Worker A fence filters out tests and agent-runs
  assert.equal(isPathInScope("src/index.ts", fenceA), true);
  assert.equal(isPathInScope("test/protocol.test.ts", fenceA), false);
  assert.equal(isPathInScope("agent-runs/run-101/session/transcript.jsonl", fenceA), false);

  // Verify Worker B (wide) allows tests but excludes agent-runs
  assert.equal(isPathInScope("src/index.ts", fenceB), true);
  assert.equal(isPathInScope("test/protocol.test.ts", fenceB), true);
  assert.equal(isPathInScope("agent-runs/run-101/session/transcript.jsonl", fenceB), false);

  // Retrieval
  assert.equal(getScopeFence(repo, "session-worker-A")?.level, "medium");
  assert.equal(getScopeFence(repo, "session-worker-B")?.level, "wide");

  // Clear
  assert.equal(clearScopeFence("session-worker-A"), true);
  assert.equal(getScopeFence(repo, "session-worker-A"), null);
});

test("exportScopeIgnore generates standard .waymarkignore rule syntax", () => {
  const repo = createMockRepo();
  const fence = setScopeFence(repo, "medium");
  const exported = exportScopeIgnore(repo, fence);

  assert.ok(exported.includes(".waymarkignore - Generated by Waymark Scope Engine"));
  assert.ok(exported.includes("agent-runs/**") || exported.includes("*runs/**"));
  assert.ok(exported.includes("test/**"));
});

test("waymarkScopeTool MCP handler: analyze, set, get, export, clear roundtrip", async () => {
  const repo = createMockRepo();
  const sessionId = "mcp-test-session";

  // 1. Analyze
  const analyzeRes = await waymarkScopeTool.handler({
    action: "analyze",
    root: repo,
  });
  assert.equal(analyzeRes.isError, false);
  const analyzePayload = JSON.parse(analyzeRes.content[0]!.text as string);
  assert.equal(analyzePayload.action, "analyze");
  assert.equal(analyzePayload.analysis.categories.RECORDED_WORKSPACES.fileCount, 1);

  // 2. Set (medium)
  const setRes = await waymarkScopeTool.handler({
    action: "set",
    level: "medium",
    session_id: sessionId,
    root: repo,
  });
  assert.equal(setRes.isError, false);
  const setPayload = JSON.parse(setRes.content[0]!.text as string);
  assert.equal(setPayload.fence.level, "medium");

  // 3. Get
  const getRes = await waymarkScopeTool.handler({
    action: "get",
    session_id: sessionId,
    root: repo,
  });
  assert.equal(getRes.isError, false);
  const getPayload = JSON.parse(getRes.content[0]!.text as string);
  assert.equal(getPayload.fence.level, "medium");

  // 4. Plain export
  const exportRes = await waymarkScopeTool.handler({
    action: "export",
    session_id: sessionId,
    root: repo,
    plain: true,
  });
  assert.equal(exportRes.isError, false);
  assert.ok((exportRes.content[0]!.text as string).includes(".waymarkignore"));

  // 5. Clear
  const clearRes = await waymarkScopeTool.handler({
    action: "clear",
    session_id: sessionId,
    root: repo,
  });
  assert.equal(clearRes.isError, false);
});

test("waymark_ask enforces active scope fence and fails closed with out_of_scope", async () => {
  const repo = createMockRepo();
  const sessionId = "fence-enforcement-session";

  // Establish medium scope fence
  setScopeFence(repo, "medium", { sessionId });

  // Out of scope path query
  const outRes = await waymarkAskTool.handler({
    path: "agent-runs/run-101/session/transcript.jsonl",
    root: repo,
    session_id: sessionId,
  });
  const outPayload = JSON.parse(outRes.content[0]!.text as string);
  assert.equal(outPayload.status, "out_of_scope");
  assert.equal(outPayload.missCode, "OUT_OF_SCOPE");
  assert.ok(outPayload.reason.includes("excluded by active 'medium' scope fence"));

  // In scope path query
  const inRes = await waymarkAskTool.handler({
    path: "src/engine/protocol.ts",
    root: repo,
    session_id: sessionId,
  });
  const inPayload = JSON.parse(inRes.content[0]!.text as string);
  assert.equal(inPayload.ok, true);
  assert.equal(inPayload.path, "src/engine/protocol.ts");
});

test("McpServer registers waymark_scope as a canonical MCP tool", () => {
  const server = new McpServer({ canonicalOnly: true });
  const toolDefs = server.getToolDefinitions();
  const toolNames = toolDefs.map((t) => t.name);

  assert.ok(toolNames.includes("waymark_ask"));
  assert.ok(toolNames.includes("waymark_memory"));
  assert.ok(toolNames.includes("waymark_scope"));
  assert.equal(toolDefs.length, 3);
});
