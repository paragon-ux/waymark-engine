import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const OUT_DIR = process.env.BENCHMARK_OUT_DIR
  ? path.resolve(process.env.BENCHMARK_OUT_DIR)
  : path.join(REPO_ROOT, "scratch", "benchmark_results_post_hardening");
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    console.log(`\n================================================================`);
    console.log(`>>> LAUNCHING: ${scriptPath}`);
    console.log(`>>> TARGET DIR: ${OUT_DIR}`);
    console.log(`================================================================\n`);
    const t0 = performance.now();
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: {
        ...process.env,
        BENCHMARK_OUT_DIR: OUT_DIR,
      },
    });

    child.on("close", (code) => {
      const elapsed = (performance.now() - t0).toFixed(1);
      console.log(`\n>>> FINISHED: ${scriptPath} in ${elapsed}ms (exit code: ${code})\n`);
      if (code === 0) resolve();
      else reject(new Error(`Script ${scriptPath} exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

async function main() {
  const tTotal = performance.now();

  console.log("Starting full post-hardening parity benchmark run...");
  console.log(`Destination directory: ${OUT_DIR}`);

  // 1. Run Phase 1
  await runScript(path.join(__dirname, "run_all_phases.mjs"));

  // 2. Run Phases 2 to 5
  await runScript(path.join(__dirname, "run_phases_2_to_5.mjs"));

  // 3. Run Phases 6 to 8
  await runScript(path.join(__dirname, "run_phases_6_to_8.mjs"));

  const totalElapsed = ((performance.now() - tTotal) / 1000).toFixed(2);
  console.log(`\n================================================================`);
  console.log(`ALL BENCHMARK PHASES COMPLETED in ${totalElapsed}s`);
  console.log(`Results saved to: ${OUT_DIR}`);
  console.log(`================================================================\n`);
}

main().catch((err) => {
  console.error("Benchmark suite failed:", err);
  process.exit(1);
});
