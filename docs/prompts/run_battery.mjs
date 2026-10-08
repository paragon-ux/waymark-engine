#!/usr/bin/env node
/**
 * Live Operational Prompt Battery Runner
 * Executes standardized prompts across Tier 1 (AST), Tier 2 (Path), Tier 3 (Fuzzy),
 * Multi-Hop, Batch Symbols, and Fail-Closed Adversarial tests.
 */
import fs from "node:fs";
import path from "node:path";
import { ask, queryMultiSymbols } from "../../dist/src/index.js";
import { repoRoot } from "../../dist/src/paths.js";

const root = repoRoot();
const promptsDir = path.join(root, "docs", "prompts");

function readJsonl(filename) {
  const content = fs.readFileSync(path.join(promptsDir, filename), "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function runBattery() {
  console.log(`\n=== Running Live Waymark Prompt Battery against: ${root} ===\n`);
  const manifest = readJsonl("CATALOGUE_MANIFEST.jsonl");
  let total = 0;
  let passed = 0;
  let failed = 0;

  for (const entry of manifest) {
    console.log(`\n[Battery ${entry.battery_id}] ${entry.category} (${entry.count} queries)`);
    const prompts = readJsonl(entry.file);

    for (const p of prompts) {
      total++;
      const startTime = performance.now();
      try {
        if (p.symbols) {
          // Batch symbols test
          const res = await queryMultiSymbols(root, p.symbols);
          const ok = res.hits === p.expected_hits && res.misses === p.expected_misses;
          const elapsed = (performance.now() - startTime).toFixed(1);
          if (ok) {
            console.log(`  ✓ [${p.id}] [${p.symbols.join(", ")}] -> ${res.hits} hits, ${res.misses} misses (${elapsed}ms)`);
            passed++;
          } else {
            console.error(`  ✗ [${p.id}] Expected ${p.expected_hits}h/${p.expected_misses}m, got ${res.hits}h/${res.misses}m`);
            failed++;
          }
        } else {
          // Ask query
          const options = {
            depth: p.depth,
            direction: p.direction,
            excludeTests: p.exclude_tests,
            tier: p.tier,
            autoResolve: p.auto_resolve ?? true,
          };
          let res;
          let thrownError = null;
          try {
            res = await ask(root, "capn-cli", "", p.query, options);
          } catch (err) {
            thrownError = err;
          }

          const elapsed = (performance.now() - startTime).toFixed(1);

          if (p.expected_error) {
            if (thrownError && thrownError.code === p.expected_error) {
              console.log(`  ✓ [${p.id}] "${p.query}" -> Error ${thrownError.code} as expected (${elapsed}ms)`);
              passed++;
            } else {
              console.error(`  ✗ [${p.id}] Expected error ${p.expected_error}, got:`, thrownError || res?.status);
              failed++;
            }
          } else if (res) {
            const statusMatch = !p.expected_status || res.status === p.expected_status;
            const providerMatch = !p.expected_provider || res.provider === p.expected_provider;
            if (statusMatch && providerMatch) {
              console.log(`  ✓ [${p.id}] "${p.query}" -> ${res.provider}/${res.status} (${elapsed}ms)`);
              passed++;
            } else {
              console.error(`  ✗ [${p.id}] Expected ${p.expected_provider}/${p.expected_status}, got ${res.provider}/${res.status}`);
              failed++;
            }
          } else {
            console.error(`  ✗ [${p.id}] Unexpected failure:`, thrownError);
            failed++;
          }
        }
      } catch (err) {
        console.error(`  ✗ [${p.id}] Exception:`, err.message);
        failed++;
      }
    }
  }

  console.log(`\n======================================================`);
  console.log(`Prompt Battery Results: ${passed}/${total} Passed (${failed} Failed)`);
  console.log(`======================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runBattery().catch((err) => {
  console.error("Battery runner crashed:", err);
  process.exit(1);
});
