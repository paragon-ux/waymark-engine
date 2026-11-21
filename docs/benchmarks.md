# Empirical Benchmarks & Evaluation

Waymark Engine is evaluated against recorded empirical artifacts stored in `benchmarks/manifest.json` and `benchmarks/data/`. Every metric below cites its backing data file in this repository.

---

## Aider Repo Map Parity Benchmark (`gpt-oss-120b`)

Recorded in [`benchmarks/data/aider_parity/results.json`](https://github.com/paragon-ux/waymark-engine/blob/main/benchmarks/data/aider_parity/results.json) (`model: "openai/gpt-oss-120b"`, `reasoningEffort: "low"`, timestamp `2026-09-28T14:29:01.161Z`):

| Evaluation Track | Aider Repo Map | Waymark Engine | Recorded Outcome |
| :--- | :--- | :--- | :--- |
| **Track A: Locate & Edit `DaemonOptions`** | 416 prompt tokens, 306 completion tokens, 1 turn (`758 ms`, success) | 367 prompt tokens, 284 completion tokens, 2 turns (`1,292 ms`, success) | **-11.8% prompt tokens** on single-task lookup |
| **Track B: Refactor IPC Bridge with Path Invariants** | 426 prompt tokens, `hallucinatedSemantics: true` (`188 ms`) | 376 prompt tokens, `hallucinatedSemantics: false` (`1,341 ms`) | **Zero semantic hallucination** |
| **10-Turn Multi-Turn Simulation** | 2,700 cumulative tokens (270 tokens/turn) | 196 cumulative tokens (28 tokens on turn 1, amortized via charted recall) | **92.7% cumulative token reduction** |

---

## MCP Tool Schema & Plain-Text Output Footprint

- **Two-Verb Canonical MCP (`tools/list`)**: ~1,500 tokens (~6.1 KB serialized across `waymark_ask` and `waymark_memory`), vs ~2,850 tokens (~11.4 KB serialized across all 12 tools with `WAYMARK_MCP_VERBOSE=1`) — a ~46% schema reduction.
- **Plain-Text Query Responses (`--plain` / `plain: true`)**: Compact single-line/tree outputs instead of full JSON envelopes.
- **Call-Graph Test Exclusion (`--exclude-tests`)**: Suppresses test files (`tests/`, `*_test.*`, `*.spec.*`) from multi-hop caller trees while preserving production call edges.

---

## Grafana Monorepo & Resident Daemon Latency

Recorded in [`benchmarks/manifest.json`](https://github.com/paragon-ux/waymark-engine/blob/main/benchmarks/manifest.json) against `grafana/grafana` (`23,517` total files, `21,144` indexed source files, `347,845` AST symbols) on an **Intel Core i5-5300U @ 2.30 GHz (2 cores / 4 logical processors), 16 GB RAM, Windows 10** (`CODEDB_MAX_THREADS=3`):

| Operation / Benchmark | Pre-Hardening / Cold | Post-Hardening / Resident | Speedup / Reduction |
| :--- | :--- | :--- | :--- |
| **High-Collision AST Verb (`Who calls New?`)** | `30,318.7 ms` | `4,454.4 ms` | **6.8x** (-85.3%) |
| **Literal Path Lookup (`embed.go`)** | `4,594.8 ms` | `41.21 ms` (cold disk) / `229.9 ms` (warm CLI) | **20.0x** (-95.0%) |
| **Non-Existent Path Fail-Closed** | `9,390.7 ms` (junction hijack) | `257.9 ms` (fail-closed Tier 2 miss) | **36.4x** (-97.3%) |
| **Stateless Cold vs Resident Daemon Median** | `95.0 ms` | `3.8 ms` | **25.0x** |

Supporting raw captures live under `benchmarks/data/grafana_pre_hardening/`, `benchmarks/data/grafana_post_hardening/`, and `benchmarks/data/codex_e2e/`.

---

## Automated 105-Prompt Evaluation Battery

The `waymark-engine` source repository includes an automated 105-prompt evaluation manifest at `docs/prompts/CATALOGUE_MANIFEST.jsonl` covering 15 operational categories (exact path normalization, AST call graphs, bounded multi-hop BFS, test exclusion, single-file tree-sitter outlines, fuzzy transposition, batch symbol lookup, fail-closed adversarial misses, path-traversal sandboxing, SHA-256 range anchor integrity, multi-step workflows, forced-tier isolation, concurrency, plain-text compression, and Discovery Junction consensus).

Run it inside a `waymark-engine` source checkout locally or in CI via:

```bash
npm run test:prompts
# or directly:
node docs/prompts/run_battery.mjs
# or interactively inside `waymark repl` (use `/battery --path <manifest.jsonl>` in external projects):
/battery
```
