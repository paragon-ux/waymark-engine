import fs from "node:fs";
import path from "node:path";
import {
  WAYMARK_ASK,
  WAYMARK_CHART,
  WAYMARK_BUST,
  WAYMARK_LIST,
  WAYMARK_UNCHART,
  WAYMARK_PRUNE,
  OUT_DIR,
  runWaymark,
  runCodedb,
  estimateTokens,
} from "./benchmark_runner.mjs";

const results = {
  phase1: [],
  phase2: [],
  phase3: [],
  phase4: [],
  phase5: {},
  phase6: [],
  phase7: {},
  phase8: [],
};

async function logTest(tier, query, expected, res, extra = {}) {
  const plainText = res.stdout.trim();
  const entry = {
    tier,
    query,
    expected,
    actual: plainText,
    durationMs: res.durationMs,
    exitCode: res.exitCode,
    stdoutBytes: Buffer.byteLength(res.stdout),
    stderr: res.stderr,
    ...extra,
  };
  return entry;
}

async function runBenchmark() {
  console.log("=== PHASE 1: TIER 1 AST STRUCTURAL ===");
  // 6.1 Unique Symbol Definitions (5 symbols)
  const uniqueSymbols = [
    { sym: "SaveDashboardDiff", expectedFile: "public/app/features/dashboard/components/SaveDashboard/SaveDashboardDiff.tsx", expectedLine: 16, kind: "class/component" },
    { sym: "LogGroupClassSelector", expectedFile: "public/app/plugins/datasource/cloudwatch/components/shared/LogGroups/LogGroupClassSelector.tsx", expectedLine: 13, kind: "function/component" },
    { sym: "TimeRangePicker", expectedFile: "packages/grafana-ui/src/components/DateTimePickers/TimeRangePicker.tsx", expectedLine: 19, kind: "component" },
    { sym: "SSOSettingsStore", expectedFile: "pkg/services/ssosettings/database/database.go", expectedLine: 35, kind: "type/interface" },
    { sym: "newCachedProvider", expectedFile: "apps/dashboard/pkg/migration/schemaversion/cache.go", expectedLine: 40, kind: "function" },
    { sym: "PreloadableCache", expectedFile: "apps/dashboard/pkg/migration/schemaversion/cache.go", expectedLine: 24, kind: "interface_def" },
  ];

  for (const s of uniqueSymbols) {
    const q = `Where is ${s.sym} declared?`;
    const res = await runWaymark(WAYMARK_ASK, [q, "--plain"]);
    const pass = res.stdout.includes(s.sym) && res.stdout.includes(s.expectedFile);
    results.phase1.push(await logTest("Tier 1", q, `${s.expectedFile}:${s.expectedLine}`, res, {
      subtest: "6.1 Unique Symbol",
      symbol: s.sym,
      correct: pass,
      pass,
    }));
    console.log(`6.1 ${s.sym}: ${pass ? "PASS" : "FAIL"} (${res.durationMs.toFixed(1)}ms)`);
  }

  // 6.2 Highly Ambiguous Symbols
  const ambiguousQueries = [
    { q: "Where is New declared?", tool: "search_graph", sym: "New" },
    { q: "Who calls New?", tool: "trace_path", sym: "New" },
    { q: "Where is Get declared?", tool: "search_graph", sym: "Get" },
    { q: "Who calls Get?", tool: "trace_path", sym: "Get" },
  ];
  for (const item of ambiguousQueries) {
    const res = await runWaymark(WAYMARK_ASK, [item.q, "--plain"]);
    const ambiguousSurfaced = res.stdout.includes("ambiguous: true") || res.stdout.includes("total:") || res.stdout.includes("candidates");
    results.phase1.push(await logTest("Tier 1", item.q, "ambiguous: true with suppressed / file-scoped edges", res, {
      subtest: "6.2 Highly Ambiguous Symbol",
      symbol: item.sym,
      ambiguousSurfaced,
      correct: ambiguousSurfaced,
    }));
    console.log(`6.2 ${item.q}: ambiguousSurfaced=${ambiguousSurfaced} (${res.durationMs.toFixed(1)}ms)`);
  }
  // Run underlying codedb query directly for New
  const codedbNewCallers = await runCodedb(["callers", "New", "--json"]);
  const codedbNewSymbol = await runCodedb(["symbol", "New", "--json"]);
  results.phase1.push({
    subtest: "6.2 Underlying codedb New",
    codedbNewCallers: {
      durationMs: codedbNewCallers.durationMs,
      stdout: codedbNewCallers.stdout.trim().split("\n").pop(),
    },
    codedbNewSymbol: {
      durationMs: codedbNewSymbol.durationMs,
      stdout: codedbNewSymbol.stdout.trim().split("\n").pop(),
    },
  });

  // 6.3 Callers / Callees
  const callGraphTargets = [
    { sym: "newCachedProvider", q: "Who calls newCachedProvider?", expectedCallers: 10, expectedCallees: 0 },
    { sym: "isFetchError", q: "Who calls isFetchError?", expectedCallers: 65, expectedCallees: 0 },
    { sym: "Preload", q: "Who calls Preload?", expectedCallers: 2, expectedCallees: 1 },
    { sym: "TestCachedProvider_CacheHit", q: "Callees of TestCachedProvider_CacheHit", expectedCallers: 0, expectedCallees: 1 },
  ];
  for (const c of callGraphTargets) {
    const res = await runWaymark(WAYMARK_ASK, [c.q, "--plain"]);
    const hasCallers = c.expectedCallers > 0 ? res.stdout.includes(`callers_total: ${c.expectedCallers}`) : true;
    results.phase1.push(await logTest("Tier 1", c.q, `callers: ${c.expectedCallers}`, res, {
      subtest: "6.3 Callers/Callees",
      symbol: c.sym,
      correct: hasCallers,
    }));
    console.log(`6.3 ${c.q}: ${hasCallers ? "PASS" : "CHECK"} (${res.durationMs.toFixed(1)}ms)`);
  }

  // 6.4 Cross-Language Symbol Extraction
  const crossLangQueries = [
    "Where is DataSource declared?",
    "Where is Plugin declared?",
  ];
  for (const q of crossLangQueries) {
    const res = await runWaymark(WAYMARK_ASK, [q, "--plain"]);
    const hasGo = res.stdout.includes(".go");
    const hasTs = res.stdout.includes(".ts");
    const crossLangOk = hasGo && hasTs;
    results.phase1.push(await logTest("Tier 1", q, "Definitions across both Go and TypeScript", res, {
      subtest: "6.4 Cross-Language",
      crossLangOk,
      correct: crossLangOk,
    }));
    console.log(`6.4 ${q}: crossLangOk=${crossLangOk} (Go=${hasGo}, TS=${hasTs}) (${res.durationMs.toFixed(1)}ms)`);
  }

  // 6.5 Non-src Topology Discovery
  const topologyQueries = [
    { root: "pkg/", q: "Where is DataSource declared?", expect: "pkg/api/dtos/datasource.go" },
    { root: "packages/", q: "Where is TimeRangePicker declared?", expect: "packages/grafana-ui/src/components/DateTimePickers/TimeRangePicker.tsx" },
    { root: "public/", q: "Where is SaveDashboardDiff declared?", expect: "public/app/features/dashboard/components/SaveDashboard/SaveDashboardDiff.tsx" },
    { root: "apps/", q: "Where is newCachedProvider declared?", expect: "apps/dashboard/pkg/migration/schemaversion/cache.go" },
    { root: "e2e-playwright/", q: "Where is DataSource declared?", expect: "e2e-playwright/test-plugins/grafana-test-datasource/datasource.ts" },
  ];
  for (const t of topologyQueries) {
    const res = await runWaymark(WAYMARK_ASK, [t.q, "--plain"]);
    const found = res.stdout.includes(t.expect);
    results.phase1.push(await logTest("Tier 1", t.q, `Discovered in ${t.root} (${t.expect})`, res, {
      subtest: "6.5 Non-src Topology",
      root: t.root,
      correct: found,
    }));
    console.log(`6.5 Non-src [${t.root}]: ${found ? "PASS" : "FAIL"} (${res.durationMs.toFixed(1)}ms)`);
  }

  // 6.6 Tier 1 Cold / Warm Architecture Scan
  console.log("6.6 Running Architecture scan (Cold)...");
  const coldArch = await runWaymark(WAYMARK_ASK, ["Architecture", "--plain"]);
  console.log(`Cold Architecture scan: ${coldArch.durationMs.toFixed(1)}ms (bytes: ${Buffer.byteLength(coldArch.stdout)})`);
  console.log("6.6 Running Architecture scan (Warm)...");
  const warmArch = await runWaymark(WAYMARK_ASK, ["Architecture", "--plain"]);
  console.log(`Warm Architecture scan: ${warmArch.durationMs.toFixed(1)}ms (bytes: ${Buffer.byteLength(warmArch.stdout)})`);
  results.phase1.push({
    subtest: "6.6 Cold/Warm Architecture",
    cold: { durationMs: coldArch.durationMs, bytes: Buffer.byteLength(coldArch.stdout), exitCode: coldArch.exitCode },
    warm: { durationMs: warmArch.durationMs, bytes: Buffer.byteLength(warmArch.stdout), exitCode: warmArch.exitCode },
  });

  fs.writeFileSync(path.join(OUT_DIR, "phase1_results.json"), JSON.stringify(results.phase1, null, 2));
  console.log("Phase 1 complete.\n");
}

runBenchmark().catch(console.error);
