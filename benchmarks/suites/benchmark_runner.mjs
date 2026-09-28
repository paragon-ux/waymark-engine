import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const WAYMARK_ASK = path.resolve("./bin/waymark-ask.mjs");
const WAYMARK_CHART = path.resolve("./bin/waymark-chart.mjs");
const WAYMARK_BUST = path.resolve("./bin/waymark-bust.mjs");
const WAYMARK_LIST = path.resolve("./bin/waymark-list.mjs");
const WAYMARK_UNCHART = path.resolve("./bin/waymark-unchart.mjs");
const WAYMARK_PRUNE = path.resolve("./bin/waymark-prune.mjs");
const CODEDB_EXE = path.resolve("./node_modules/@paragon-ux/codedb-core/dist/codedb-win32-x64.exe");

const GRAFANA_ROOT = "C:\\Users\\USER\\Desktop\\Frameworks\\deepseek-playground-2\\test-codedb\\grafana";
const OUT_DIR = process.env.BENCHMARK_OUT_DIR
  ? path.resolve(process.env.BENCHMARK_OUT_DIR)
  : path.resolve("./scratch/benchmark_results");

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function runCmd(file, args, cwd = GRAFANA_ROOT, envExtra = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = execFile(
      file,
      args,
      {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 180_000,
        env: { ...process.env, ...envExtra, CODEDB_QUIET: "1" },
      },
      (err, stdout, stderr) => {
        const t1 = performance.now();
        const duration = t1 - t0;
        resolve({
          exitCode: err ? (err.code ?? 1) : 0,
          error: err ? err.message : null,
          stdout: stdout || "",
          stderr: stderr || "",
          durationMs: duration,
        });
      }
    );
  });
}

function runWaymark(bin, args, cwd = GRAFANA_ROOT, envExtra = {}) {
  return runCmd(process.execPath, [bin, ...args], cwd, envExtra);
}

function runCodedb(args, cwd = GRAFANA_ROOT) {
  return runCmd(CODEDB_EXE, [cwd, ...args], cwd);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Approximate GPT / LLM tokens using cl100k-like rule (avg 3.8 - 4 chars per token for code/json)
function estimateTokens(text) {
  if (!text) return 0;
  // Count words, whitespace, punctuation
  const words = text.match(/\w+|[^\w\s]|\s+/g) || [];
  let tokens = 0;
  for (const w of words) {
    if (w.length <= 4) tokens += 1;
    else tokens += Math.ceil(w.length / 3.8);
  }
  return tokens;
}

export {
  WAYMARK_ASK,
  WAYMARK_CHART,
  WAYMARK_BUST,
  WAYMARK_LIST,
  WAYMARK_UNCHART,
  WAYMARK_PRUNE,
  CODEDB_EXE,
  GRAFANA_ROOT,
  OUT_DIR,
  runCmd,
  runWaymark,
  runCodedb,
  sleep,
  estimateTokens,
};
