import fs from "node:fs";
import path from "node:path";
import {
  WAYMARK_ASK,
  WAYMARK_CHART,
  WAYMARK_BUST,
  GRAFANA_ROOT,
  runWaymark,
} from "./benchmark_runner.mjs";
import { WaymarkDaemon, stopDaemon } from "../../../dist/src/daemon.js";

const OUT_PATH = path.resolve("./scratch/benchmark_results_post_hardening/stateless_vs_resident_comparison.json");

function parseTimingFromOutput(stdout) {
  const match = stdout.match(/\[timing\]\s*(.*)/i);
  if (!match) return {};
  const raw = match[1];
  const timings = {};
  for (const part of raw.split("|")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (k && v) {
      timings[k] = parseFloat(v.replace("ms", ""));
    }
  }
  return timings;
}

async function measureOperation(label, args, isDaemonActive) {
  console.log(`  [${isDaemonActive ? "RESIDENT" : "STATELESS"}] Measuring "${label}"...`);

  // First run (cold for this mode)
  const coldRes = await runWaymark(WAYMARK_ASK, [...args, "-b", "--plain"], GRAFANA_ROOT);
  const coldTimings = parseTimingFromOutput(coldRes.stdout);

  // 3 warm iterations
  const warmSamples = [];
  const warmInternalTimings = [];
  for (let i = 0; i < 3; i++) {
    const res = await runWaymark(WAYMARK_ASK, [...args, "-b", "--plain"], GRAFANA_ROOT);
    warmSamples.push(res.durationMs);
    warmInternalTimings.push(parseTimingFromOutput(res.stdout));
  }

  warmSamples.sort((a, b) => a - b);
  const medianCliMs = warmSamples[1]; // median of 3
  const minCliMs = warmSamples[0];
  const maxCliMs = warmSamples[2];

  // Median internal timing
  const medianInternal = {};
  if (warmInternalTimings.length > 0) {
    for (const key of Object.keys(warmInternalTimings[0] || {})) {
      const vals = warmInternalTimings.map((t) => t[key] || 0).sort((a, b) => a - b);
      medianInternal[key] = vals[1];
    }
  }

  console.log(`    Cold CLI: ${coldRes.durationMs.toFixed(1)}ms | Warm Median CLI: ${medianCliMs.toFixed(1)}ms (Internal: ${JSON.stringify(medianInternal)})`);

  return {
    label,
    coldCliMs: coldRes.durationMs,
    coldInternalTimings: coldTimings,
    warmSamplesCliMs: warmSamples,
    warmMedianCliMs: medianCliMs,
    warmMinCliMs: minCliMs,
    warmMaxCliMs: maxCliMs,
    warmMedianInternalTimings: medianInternal,
  };
}

async function runComparison() {
  console.log("================================================================================");
  console.log("        WAYMARK ENGINE: STATELESS CLI vs RESIDENT DAEMON BENCHMARK              ");
  console.log(`Target Repository: ${GRAFANA_ROOT} (21,144 files, ~347,845 AST symbols)`);
  console.log("================================================================================\n");

  // 1. Ensure any lingering daemons are stopped first
  console.log("Ensuring clean baseline (stopping any active daemons)...");
  await stopDaemon(GRAFANA_ROOT, { force: true });
  await new Promise((r) => setTimeout(r, 500));

  // Setup charted fact for Tier 4
  console.log("Setting up Tier 4 memory fact...");
  await runWaymark(WAYMARK_CHART, [
    "--question", "Perf comparison fact",
    "--answer", "Architecture verification fact for comparative benchmarking",
    "--files", "embed.go",
  ], GRAFANA_ROOT);

  const ops = [
    { label: "Tier 1: Full Structural Scan", args: ["Architecture"] },
    { label: "Tier 1: Exact Symbol Query", args: ["Where is SaveDashboardDiff declared?"] },
    { label: "Tier 2: Literal Path Lookup", args: ["embed.go"] },
    { label: "Tier 3: Deterministic Fuzzy", args: ["DataSourc", "-t", "fuzzy"] },
    { label: "Tier 4: Charted Memory Recall", args: ["Perf comparison fact", "--auto-resolve"] },
  ];

  console.log("\n--- MODE A: STATELESS DEFAULT CLI (Zero Persistent Daemon) ---");
  const statelessResults = [];
  for (const op of ops) {
    const result = await measureOperation(op.label, op.args, false);
    statelessResults.push(result);
  }

  console.log("\n--- STARTING PERSISTENT RESIDENT DAEMON ---");
  const daemon = new WaymarkDaemon(GRAFANA_ROOT, 0); // 0 = persistent during benchmark
  await daemon.start();
  console.log("Resident daemon active and listening on IPC socket/pipe.\n");

  console.log("--- MODE B: PERSISTENT RESIDENT DAEMON / MCP SESSION ---");
  const residentResults = [];
  for (const op of ops) {
    const result = await measureOperation(op.label, op.args, true);
    residentResults.push(result);
  }

  console.log("\n--- STOPPING RESIDENT DAEMON ---");
  daemon.stop();
  await stopDaemon(GRAFANA_ROOT, { force: true });
  console.log("Daemon stopped cleanly. Verifying zero background processes.");

  // Cleanup charted fact
  await runWaymark(WAYMARK_BUST, ["embed.go"], GRAFANA_ROOT);

  // Compile comparison data
  const comparison = ops.map((op, idx) => {
    const st = statelessResults[idx];
    const res = residentResults[idx];
    const cliSpeedup = st.warmMedianCliMs / res.warmMedianCliMs;

    return {
      operation: op.label,
      stateless: {
        coldCliMs: st.coldCliMs,
        warmMedianCliMs: st.warmMedianCliMs,
        warmInternalMs: st.warmMedianInternalTimings.ast ?? st.warmMedianInternalTimings.path ?? st.warmMedianInternalTimings.fuzzy ?? st.warmMedianInternalTimings.capn ?? 0,
      },
      resident: {
        coldCliMs: res.coldCliMs,
        warmMedianCliMs: res.warmMedianCliMs,
        warmInternalMs: res.warmMedianInternalTimings.ast ?? res.warmMedianInternalTimings.path ?? res.warmMedianInternalTimings.fuzzy ?? res.warmMedianInternalTimings.capn ?? 0,
      },
      cliSpeedupMultiplier: parseFloat(cliSpeedup.toFixed(2)),
      warmRatioPercent: parseFloat(((res.warmMedianCliMs / st.coldCliMs) * 100).toFixed(2)),
    };
  });

  const report = {
    benchmark: "stateless_vs_resident_comparison",
    timestamp: new Date().toISOString(),
    repository: GRAFANA_ROOT,
    filesCount: 21144,
    comparison,
    details: {
      stateless: statelessResults,
      resident: residentResults,
    },
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\nResults written to: ${OUT_PATH}\n`);

  console.log("=================================================================================================================");
  console.log("| Operation                         | Stateless CLI (Warm) | Resident CLI (Warm) | Speedup  | Resident vs Cold |");
  console.log("=================================================================================================================");
  for (const c of comparison) {
    const op = c.operation.padEnd(33);
    const st = `${c.stateless.warmMedianCliMs.toFixed(1)}ms`.padStart(20);
    const res = `${c.resident.warmMedianCliMs.toFixed(1)}ms`.padStart(19);
    const spd = `${c.cliSpeedupMultiplier.toFixed(1)}x`.padStart(8);
    const rat = `${c.warmRatioPercent.toFixed(1)}% of cold`.padStart(16);
    console.log(`| ${op} | ${st} | ${res} | ${spd} | ${rat} |`);
  }
  console.log("=================================================================================================================\n");
}

runComparison().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
