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
import {
  formatLiveEvent,
  computeSessionStats,
  formatSessionSummary,
  getLiveDashboardHtml,
} from "../src/repl.js";

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

test("Live REPL Observer: formatLiveEvent formats hit, junction, and miss events with ANSI metrics", () => {
  const hitEvent: SessionTelemetryEvent = {
    timestamp: "2026-10-08T03:30:00.000Z",
    caller: "cli",
    repoRoot: "/test/repo",
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
    timingBreakdown: { ast_ms: 10, total_ms: 14 },
  };

  const hitStr = formatLiveEvent(hitEvent);
  assert.ok(hitStr.includes("AGENT QUERY:"));
  assert.ok(hitStr.includes("Who calls verifyHop?"));
  assert.ok(hitStr.includes("Source:"));
  assert.ok(hitStr.includes("CLI"));
  assert.ok(hitStr.includes("Status:"));
  assert.ok(hitStr.includes("HIT"));
  assert.ok(hitStr.includes("Tier Traversal:"));
  assert.ok(hitStr.includes("Tier 1: AST Structural"));
  assert.ok(hitStr.includes("verifyHop -> src/integrity.ts:66"));
  assert.ok(hitStr.includes("Token Savings: 97.7%"));
  assert.ok(hitStr.includes("Latency:"));
  assert.ok(hitStr.includes("14ms"));

  const junctionEvent: SessionTelemetryEvent = {
    timestamp: "2026-10-08T03:31:00.000Z",
    caller: "mcp",
    repoRoot: "/test/repo",
    query: "execute_command",
    category: "ask",
    tierRoute: "Discovery Junction",
    matchedSymbol: "execute_user_shell_command",
    matchedPath: "src/tasks.rs",
    matchedLine: 104,
    score: 81,
    payloadTokens: 450,
    fullFileTokensEquivalent: 1420,
    tokensSavedPct: 68.3,
    latencyMs: 25,
    status: "junction",
  };

  const juncStr = formatLiveEvent(junctionEvent);
  assert.ok(juncStr.includes("MCP"));
  assert.ok(juncStr.includes("JUNCTION"));
  assert.ok(juncStr.includes("Discovery Junction"));
  assert.ok(juncStr.includes("(score: 81)"));

  const missEvent: SessionTelemetryEvent = {
    timestamp: "2026-10-08T03:32:00.000Z",
    caller: "daemon",
    repoRoot: "/test/repo",
    query: "UnknownSymbolXYZ",
    category: "ask",
    tierRoute: "Miss",
    payloadTokens: 20,
    fullFileTokensEquivalent: 1420,
    tokensSavedPct: 98.6,
    latencyMs: 5,
    status: "miss",
  };

  const missStr = formatLiveEvent(missEvent);
  assert.ok(missStr.includes("DAEMON"));
  assert.ok(missStr.includes("MISS"));
  assert.ok(missStr.includes("Miss"));
});

test("Live REPL Observer: computeSessionStats and formatSessionSummary aggregate metrics accurately", () => {
  const events: SessionTelemetryEvent[] = [
    {
      timestamp: "2026-10-08T03:30:00.000Z",
      caller: "cli",
      repoRoot: "/test/repo",
      query: "q1",
      category: "ask",
      tierRoute: "Tier 1",
      payloadTokens: 50,
      fullFileTokensEquivalent: 1420,
      latencyMs: 10,
      status: "hit",
    },
    {
      timestamp: "2026-10-08T03:31:00.000Z",
      caller: "mcp",
      repoRoot: "/test/repo",
      query: "q2",
      category: "ask",
      tierRoute: "Tier 3",
      payloadTokens: 70,
      fullFileTokensEquivalent: 1420,
      latencyMs: 20,
      status: "junction",
    },
    {
      timestamp: "2026-10-08T03:32:00.000Z",
      caller: "cli",
      repoRoot: "/test/repo",
      query: "q3",
      category: "ask",
      tierRoute: "Miss",
      payloadTokens: 20,
      fullFileTokensEquivalent: 1420,
      latencyMs: 30,
      status: "miss",
    },
  ];

  const stats = computeSessionStats(events);
  assert.equal(stats.total, 3);
  assert.equal(stats.hits, 1);
  assert.equal(stats.junctions, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.hitRatePct, 33.3);
  assert.equal(stats.avgLatencyMs, 20);
  assert.equal(stats.totalTokens, 140);

  const summary = formatSessionSummary(stats);
  assert.ok(summary.includes("LIVE SESSION TELEMETRY SUMMARY"));
  assert.ok(summary.includes("Total Queries:     3 (Hits: 1, Junctions: 1, Misses: 1)"));
  assert.ok(summary.includes("Hit Rate:          33.3%"));
  assert.ok(summary.includes("Avg Query Latency: 20ms"));
  assert.ok(summary.includes("Prompt Tokens:     140 tokens consumed"));
});

test("Live REPL Observer: getLiveDashboardHtml loads standalone viewer.html", () => {
  const html = getLiveDashboardHtml();
  assert.ok(html.includes("WAYMARK ENGINE LIVE MONITOR"));
  assert.ok(html.includes("/events"));
  assert.ok(html.includes("event-list"));
});
