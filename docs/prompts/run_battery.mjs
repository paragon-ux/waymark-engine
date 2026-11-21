#!/usr/bin/env node
/**
 * Live Operational Prompt Battery Runner
 * Executes the canonical 105-prompt evaluation manifest (CATALOGUE_MANIFEST.jsonl)
 * via the compiled evaluator and exits non-zero if any prompt fails.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManifestEvaluation } from "../../dist/src/evaluator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const manifestPath = path.join(__dirname, "CATALOGUE_MANIFEST.jsonl");

function parseFlag(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function runBattery() {
  const category = parseFlag("--category");
  const id = parseFlag("--id");

  console.log(`\n=== Running Live Waymark Prompt Battery against: ${root} ===\n`);

  const scoreboard = await runManifestEvaluation({
    manifestPath,
    category,
    id,
    rootDir: root,
    onProgress: (rep) => {
      const mark = rep.passed ? "✓" : "✗";
      console.log(`  ${mark} [${rep.id}] ${rep.name} (${rep.duration_ms}ms) -> ${rep.actual_status}`);
    },
  });

  const passPct = scoreboard.total > 0 ? Math.round((scoreboard.passed / scoreboard.total) * 100) : 0;
  console.log(`\n======================================================`);
  console.log(`Prompt Battery Results: ${scoreboard.passed}/${scoreboard.total} Passed (${passPct}%, ${scoreboard.failed} Failed)`);
  console.log(`Average Latency: ${scoreboard.average_duration_ms}ms`);
  console.log(`======================================================\n`);

  if (scoreboard.failed > 0) {
    process.exit(1);
  }
}

runBattery().catch((err) => {
  console.error("Battery runner crashed:", err);
  process.exit(1);
});
