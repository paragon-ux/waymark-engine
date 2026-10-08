import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveCodedbCommand } from "../src/codedbAdapter.js";
import {
  getResidentClient,
  closeResidentClient,
  closeAllResidentClients,
  listResidentClients,
  getMaxResidentClients,
} from "../src/residentCodedb.js";
import { queryMultiSymbols } from "../src/codedbAdapter.js";
import { detectAstIntent } from "../src/discoveryRouter.js";
import {
  logSessionEvent,
  logAskTelemetry,
  resolveSessionLogPath,
  type SessionTelemetryEvent,
} from "../src/sessionLogger.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("Resident codedb LRU eviction enforces maximum concurrent clients", async (t) => {
  const command = resolveCodedbCommand();
  const originalMax = process.env.WAYMARK_MAX_RESIDENT_CLIENTS;
  process.env.WAYMARK_MAX_RESIDENT_CLIENTS = "2";

  try {
    closeAllResidentClients();
    assert.equal(listResidentClients().length, 0);

    const client1 = getResidentClient(path.join(repoRoot, "dir1"), command);
    const client2 = getResidentClient(path.join(repoRoot, "dir2"), command);
    assert.equal(listResidentClients().length, 2);

    // Touch client1 so client2 becomes the oldest
    client1.touch();

    // Adding client3 should evict client2
    const client3 = getResidentClient(path.join(repoRoot, "dir3"), command);
    const active = listResidentClients();
    assert.equal(active.length, 2);
    const roots = active.map((c) => c.root.replace(/\\/g, "/"));
    assert.ok(roots.some((r) => r.includes("dir1")));
    assert.ok(roots.some((r) => r.includes("dir3")));
    assert.ok(!roots.some((r) => r.includes("dir2")), "Expected dir2 to be evicted via LRU");

    // Close specific client
    const closed = closeResidentClient(path.join(repoRoot, "dir1"));
    assert.equal(closed, true);
    assert.equal(listResidentClients().length, 1);

    // Close all
    closeAllResidentClients();
    assert.equal(listResidentClients().length, 0);
  } finally {
    if (originalMax) process.env.WAYMARK_MAX_RESIDENT_CLIENTS = originalMax;
    else delete process.env.WAYMARK_MAX_RESIDENT_CLIENTS;
    closeAllResidentClients();
  }
});

test("detectAstIntent allows narrative phrasing for entrypoint discovery", () => {
  const intent1 = detectAstIntent("What is the main entry point?");
  assert.equal(intent1.requiresParser, true);
  assert.equal(intent1.tool, "get_architecture");

  const intent2 = detectAstIntent("what are the entry points?");
  assert.equal(intent2.requiresParser, true);
  assert.equal(intent2.tool, "get_architecture");

  const intent3 = detectAstIntent("show architecture");
  assert.equal(intent3.requiresParser, true);
  assert.equal(intent3.tool, "get_architecture");
});

test("Session telemetry logger writes append-only NDJSON events", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-telemetry-test-"));
  const sessionLog = path.join(tmpDir, ".waymark", "sessions", "active.jsonl");

  try {
    const dummyEvent: SessionTelemetryEvent = {
      timestamp: new Date().toISOString(),
      caller: "mcp",
      repoRoot: tmpDir,
      query: "Who calls verifyHop?",
      category: "ask",
      tierRoute: "Tier 1: AST Structural",
      matchedSymbol: "verifyHop",
      matchedPath: "src/integrity.ts",
      matchedLine: 66,
      payloadTokens: 32,
      fullFileTokensEquivalent: 1420,
      tokensSavedPct: 97.7,
      latencyMs: 14,
      status: "hit",
    };

    logSessionEvent(dummyEvent, sessionLog);

    assert.ok(fs.existsSync(sessionLog), "Expected session log file to be created");
    const content = fs.readFileSync(sessionLog, "utf8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.caller, "mcp");
    assert.equal(parsed.query, "Who calls verifyHop?");
    assert.equal(parsed.matchedSymbol, "verifyHop");
    assert.equal(parsed.tokensSavedPct, 97.7);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Multi-symbol query ranks definitions and canonical paths over test files", async () => {
  // Query symbol on current repository
  const res = await queryMultiSymbols(repoRoot, ["verifyHop", "NonExistentTestSymbolXYZ"]);
  assert.equal(res.waymark, 1);
  assert.equal(res.status, "partial");
  assert.equal(res.hits, 1);
  assert.equal(res.misses, 1);

  const hit = res.symbols["verifyHop"];
  assert.ok(hit);
  assert.equal(hit.status, "hit");
  assert.ok(hit.path?.includes("integrity.ts") || hit.path?.includes("src/"));
  assert.equal(res.symbols["NonExistentTestSymbolXYZ"]?.status, "miss");
});
