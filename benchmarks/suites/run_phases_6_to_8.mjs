import fs from "node:fs";
import path from "node:path";
import {
  WAYMARK_ASK,
  WAYMARK_CHART,
  WAYMARK_BUST,
  OUT_DIR,
  GRAFANA_ROOT,
  runWaymark,
  estimateTokens,
} from "./benchmark_runner.mjs";
import { WaymarkDaemon } from "../dist/src/daemon.js";

const results = {
  phase6: [],
  phase7: {},
  phase8: [],
};

async function runPhases6to8() {
  console.log("Starting resident WaymarkDaemon for Grafana...");
  const daemon = new WaymarkDaemon(GRAFANA_ROOT);
  await daemon.start();
  console.log("Resident WaymarkDaemon active and ready.\n");

  console.log("=== PHASE 6: CROSS-TIER ROUTING CORPUS (30 QUERIES) ===");

  const corpus = [
    // 5 Structural
    { id: "S1", q: "Where is SaveDashboardDiff declared?", expectedTier: "Tier 1 (AST)", expectedProvider: "codedb" },
    { id: "S2", q: "Where is LogGroupClassSelector declared?", expectedTier: "Tier 1 (AST)", expectedProvider: "codedb" },
    { id: "S3", q: "Who calls newCachedProvider?", expectedTier: "Tier 1 (AST)", expectedProvider: "codedb" },
    { id: "S4", q: "Architecture", expectedTier: "Tier 1 (AST)", expectedProvider: "codedb" },
    { id: "S5", q: "Where is TimeRangePicker declared?", expectedTier: "Tier 1 (AST)", expectedProvider: "codedb" },

    // 5 Literal Path
    { id: "P1", q: "embed.go", expectedTier: "Tier 2 (Path)", expectedProvider: "literal-path" },
    { id: "P2", q: "pkg/api/dtos/datasource.go", expectedTier: "Tier 2 (Path)", expectedProvider: "literal-path" },
    { id: "P3", q: "package.json", expectedTier: "Tier 2 (Path)", expectedProvider: "literal-path" },
    { id: "P4", q: ".gitignore", expectedTier: "Tier 2 (Path)", expectedProvider: "literal-path" },
    { id: "P5", q: "Dockerfile", expectedTier: "Tier 2 (Path)", expectedProvider: "literal-path" },

    // 5 Fuzzy (queries with typos/abbreviations)
    { id: "F1", q: "DataSourc", expectedTier: "Tier 3 (Fuzzy)", expectedProvider: "fuzzy-lexical" },
    { id: "F2", q: "queryrunnr", expectedTier: "Tier 3 (Fuzzy)", expectedProvider: "fuzzy-lexical" },
    { id: "F3", q: "dashbrd", expectedTier: "Tier 3 (Fuzzy)", expectedProvider: "fuzzy-lexical" },
    { id: "F4", q: "backEndSrv", expectedTier: "Tier 3 (Fuzzy)", expectedProvider: "fuzzy-lexical" },
    { id: "F5", q: "timeRangePickr", expectedTier: "Tier 3 (Fuzzy)", expectedProvider: "fuzzy-lexical" },

    // 5 Conceptual (prose queries)
    { id: "C1", q: "How does authentication work?", expectedTier: "Tier 4 (Capn)", expectedProvider: "capn-cli" },
    { id: "C2", q: "How does dashboard rendering work?", expectedTier: "Tier 4 (Capn)", expectedProvider: "capn-cli" },
    { id: "C3", q: "How does datasource routing work?", expectedTier: "Tier 4 (Capn)", expectedProvider: "capn-cli" },
    { id: "C4", q: "Explain plugin architecture", expectedTier: "Tier 4 (Capn)", expectedProvider: "capn-cli" },
    { id: "C5", q: "What is the caching strategy for schema version?", expectedTier: "Tier 4 (Capn)", expectedProvider: "capn-cli" },

    // 5 Intentionally Ambiguous
    { id: "A1", q: "Where is New declared?", expectedTier: "Tier 1 (AST Ambiguous)", expectedProvider: "codedb" },
    { id: "A2", q: "Who calls New?", expectedTier: "Tier 1 (AST Ambiguous)", expectedProvider: "codedb" },
    { id: "A3", q: "Where is Get declared?", expectedTier: "Tier 1 (AST Ambiguous)", expectedProvider: "codedb" },
    { id: "A4", q: "index.ts", expectedTier: "Tier 2 / Junction (Ambiguous)", expectedProvider: "junction" },
    { id: "A5", q: "types.ts", expectedTier: "Tier 2 / Junction (Ambiguous)", expectedProvider: "junction" },

    // 5 Negative Queries
    { id: "N1", q: "xyzzyqwerty123", expectedTier: "Negative / Junction Miss", expectedProvider: "miss" },
    { id: "N2", q: "nonExistentFunctionFooBarBaz999", expectedTier: "Negative / Junction Miss", expectedProvider: "miss" },
    { id: "N3", q: "Where is completelyFakeSymbolDeclared?", expectedTier: "Tier 1 Miss", expectedProvider: "miss" },
    { id: "N4", q: "some/path/that/does/not/exist/at/all.ts", expectedTier: "Tier 2 Miss", expectedProvider: "miss" },
    { id: "N5", q: "fakeFileNeverExisted12345.go", expectedTier: "Tier 2 Miss", expectedProvider: "miss" },
  ];

  let routeCorrectCount = 0;

  for (const item of corpus) {
    const res = await runWaymark(WAYMARK_ASK, [item.q, "--json"]);
    let json = {};
    try {
      json = JSON.parse(res.stdout.trim());
    } catch {
      // Plain fallback
    }

    const status = json.status;
    const provider = json.provider || (json.executedOption ? json.executedOption.tool : null) || (json.options?.[0]?.tool) || status;
    const junctionStage = json.stage;

    // Check routing correctness
    let routingCorrect = false;
    if (item.expectedProvider === "codedb") {
      routingCorrect = json.provider === "codedb" || (status === "hit" && json.provider === "codedb");
    } else if (item.expectedProvider === "literal-path") {
      routingCorrect = json.provider === "literal-path";
    } else if (item.expectedProvider === "fuzzy-lexical") {
      routingCorrect = (status === "junction" && (json.executedOption?.tool === "fuzzy-lexical" || json.options?.[0]?.tool === "fuzzy-lexical")) || json.provider === "fuzzy-lexical";
    } else if (item.expectedProvider === "capn-cli") {
      routingCorrect = (status === "junction" && (json.executedOption?.tool === "capn-cli" || json.options?.[0]?.tool === "capn-cli")) || json.provider === "capn-cli";
    } else if (item.expectedProvider === "junction") {
      routingCorrect = status === "junction" || json.provider === "literal-path";
    } else if (item.expectedProvider === "miss") {
      routingCorrect = status === "miss" || (status === "junction" && json.executedOption === null);
    }

    if (routingCorrect) routeCorrectCount++;

    results.phase6.push({
      id: item.id,
      query: item.q,
      expectedTier: item.expectedTier,
      expectedProvider: item.expectedProvider,
      actualStatus: status,
      actualProvider: provider,
      junctionStage: junctionStage || "N/A",
      routingCorrect,
      durationMs: res.durationMs,
    });

    console.log(`6. [${item.id}] ${item.q.slice(0, 30)} -> status=${status}, prov=${provider}, correct=${routingCorrect} (${res.durationMs.toFixed(1)}ms)`);
  }

  const routingAccuracy = (routeCorrectCount / corpus.length) * 100;
  console.log(`Phase 6 Routing Accuracy: ${routingAccuracy.toFixed(1)}% (${routeCorrectCount}/${corpus.length})\n`);
  fs.writeFileSync(path.join(OUT_DIR, "phase6_results.json"), JSON.stringify(results.phase6, null, 2));

  console.log("=== PHASE 7: PERFORMANCE AND SCALABILITY BENCHMARKS ===");
  // We measure cold & warm operations across tiers with 5 warm iterations
  async function benchmarkOp(name, tier, fn) {
    console.log(`Measuring ${name}...`);
    // Cold run
    const coldRes = await fn(true);
    const warmDurations = [];
    let stdoutBytes = 0;
    for (let i = 0; i < 5; i++) {
      const warmRes = await fn(false);
      warmDurations.push(warmRes.durationMs);
      stdoutBytes = Buffer.byteLength(warmRes.stdout);
    }
    warmDurations.sort((a, b) => a - b);
    const min = warmDurations[0];
    const max = warmDurations[warmDurations.length - 1];
    const median = warmDurations[Math.floor(warmDurations.length / 2)];
    const p95 = warmDurations[Math.floor(warmDurations.length * 0.95)];

    const entry = {
      operation: name,
      tier,
      coldDurationMs: coldRes.durationMs,
      warmMinMs: min,
      warmMedianMs: median,
      warmP95Ms: p95,
      warmMaxMs: max,
      stdoutBytes,
      samples: warmDurations,
    };
    console.log(`  Cold: ${coldRes.durationMs.toFixed(1)}ms | Warm Median: ${median.toFixed(1)}ms | p95: ${p95.toFixed(1)}ms | bytes: ${stdoutBytes}`);
    return entry;
  }

  // 1. Full structural scan (Architecture)
  const perfArch = await benchmarkOp("Full Structural Scan (Architecture)", "Tier 1", async (isCold) => {
    return await runWaymark(
      WAYMARK_ASK,
      ["Architecture", "--plain"],
      GRAFANA_ROOT,
      isCold ? { WAYMARK_DISABLE_RESIDENT: "1" } : {}
    );
  });

  // 2. Symbol query (Where is SaveDashboardDiff declared?)
  const perfSym = await benchmarkOp("Exact Symbol Query (SaveDashboardDiff)", "Tier 1", async (isCold) => {
    return await runWaymark(
      WAYMARK_ASK,
      ["Where is SaveDashboardDiff declared?", "--plain"],
      GRAFANA_ROOT,
      isCold ? { WAYMARK_DISABLE_RESIDENT: "1" } : {}
    );
  });

  // 3. Path lookup (embed.go)
  const perfPath = await benchmarkOp("Literal Path Lookup (embed.go)", "Tier 2", async (isCold) => {
    if (isCold) {
      const cacheFile = path.join(GRAFANA_ROOT, ".capn", "paths.cache");
      if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
    }
    return await runWaymark(WAYMARK_ASK, ["embed.go", "--plain"], GRAFANA_ROOT);
  });

  // 4. Fuzzy lookup (DataSourc -t fuzzy)
  const perfFuzzy = await benchmarkOp("Deterministic Fuzzy (DataSourc)", "Tier 3", async (isCold) => {
    return await runWaymark(
      WAYMARK_ASK,
      ["DataSourc", "-t", "fuzzy", "--plain"],
      GRAFANA_ROOT,
      isCold ? { WAYMARK_DISABLE_RESIDENT: "1" } : {}
    );
  });

  // 5. Tier 4 recall (charting an entry first to measure recall)
  await runWaymark(WAYMARK_CHART, [
    "--question", "Perf test fact",
    "--answer", "Perf test answer fact for benchmarking",
    "--files", "embed.go",
  ]);
  const perfTier4 = await benchmarkOp("Tier 4 Charted Recall", "Tier 4", async () => {
    return await runWaymark(WAYMARK_ASK, ["Perf test fact", "--auto-resolve", "--plain"]);
  });
  // Clean up
  await runWaymark(WAYMARK_BUST, ["embed.go"]);

  results.phase7 = {
    perfArch,
    perfSym,
    perfPath,
    perfFuzzy,
    perfTier4,
  };
  fs.writeFileSync(path.join(OUT_DIR, "phase7_results.json"), JSON.stringify(results.phase7, null, 2));

  console.log("\n=== PHASE 8: TOKEN ECONOMICS BENCHMARK ===");
  const tokenQueries = [
    { type: "Tier 1 Exact", q: "Where is SaveDashboardDiff declared?" },
    { type: "Tier 1 Ambiguous", q: "Where is New declared?" },
    { type: "Tier 2 Path", q: "embed.go" },
    { type: "Tier 3 Fuzzy", q: "DataSourc -t fuzzy" },
    { type: "Discovery Junction", q: "datasourc" },
  ];

  // Re-chart for Tier 4 token measurement
  await runWaymark(WAYMARK_CHART, [
    "--question", "How does a datasource request move from frontend to backend in Grafana?",
    "--answer", "Frontend QueryRunner constructs the request and dispatches via DataSourceApi; backend Go proxy in pkg/api/pluginproxy routes it to the tsdb implementation.",
    "--files", "embed.go",
  ]);
  tokenQueries.push({ type: "Tier 4 Charted Memory", q: "How does a datasource request move from frontend to backend in Grafana? --auto-resolve" });

  for (const tq of tokenQueries) {
    const plainArgs = tq.q.split(" ");
    const jsonArgs = tq.q.split(" ");
    plainArgs.push("--plain");
    jsonArgs.push("--json");

    const plainRes = await runWaymark(WAYMARK_ASK, plainArgs);
    const jsonRes = await runWaymark(WAYMARK_ASK, jsonArgs);

    const plainBytes = Buffer.byteLength(plainRes.stdout);
    const jsonBytes = Buffer.byteLength(jsonRes.stdout);
    const plainTokens = estimateTokens(plainRes.stdout);
    const jsonTokens = estimateTokens(jsonRes.stdout);
    const ratio = jsonBytes > 0 ? (plainBytes / jsonBytes).toFixed(3) : "1.000";
    const tokenReductionPct = jsonTokens > 0 ? (((jsonTokens - plainTokens) / jsonTokens) * 100).toFixed(1) : 0;

    results.phase8.push({
      type: tq.type,
      query: tq.q,
      plainBytes,
      jsonBytes,
      plainTokens,
      jsonTokens,
      byteRatio: ratio,
      tokenReductionPct: `${tokenReductionPct}%`,
      plainSample: plainRes.stdout.trim().slice(0, 150),
    });

    console.log(`8. [${tq.type}] Plain: ${plainBytes}B (${plainTokens} tok) vs JSON: ${jsonBytes}B (${jsonTokens} tok) -> -${tokenReductionPct}%`);
  }

  // Cleanup chart
  await runWaymark(WAYMARK_BUST, ["embed.go"]);

  daemon.stop();

  fs.writeFileSync(path.join(OUT_DIR, "phase8_results.json"), JSON.stringify(results.phase8, null, 2));
  console.log("Phases 6-8 complete.\n");
}

runPhases6to8().catch(console.error);
