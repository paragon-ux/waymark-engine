# ADR-0003: Waymark REPL Diagnostic Shell, Live Agentic Evaluation, and Hardened Prompt Manifest

- **Status:** Accepted
- **Date:** 2026-09-28
- **Invariants:** 100% Determinism, Zero Hallucination, Fail-Closed Precision, Sub-millisecond Resident IPC
- **Supersedes/Extends:** Extends ADR-0001 (Testing-First & Dev Mode) and ADR-0002 (System 1 vs System 2 Discovery Disciplines)
- **Governance:** `docs/governance/regressions-log.jsonl`

---

## 1. Context & Motivation

In ADR-0001, we established a Testing-First methodology requiring live prompt battery runs prior to release. However, the initial 36-query battery tested only mechanical plumbing under ideal conditions. Furthermore, synthetic offline benchmarks fail to assess **agentic discovery dynamics**:
1. Agents chain sequential queries (`symbols` $\rightarrow$ `ask` $\rightarrow$ `verify`), where errors compound across turns.
2. Codebases drift over time, causing stale line anchors and displaced symbols that simple substring checks overlook.
3. Benchmarks lacked direct comparisons against naive baseline search (regex/ripgrep), obscuring Waymark's precision and token-reduction value.
4. Developers and evaluators lacked an interactive, resident-connected shell to rapidly test fuzzy queries, inspect multi-hop call graphs, and debug Discovery Junction routing.

---

## 2. Decision & Architecture

We establish three core capabilities:

### A. Dedicated Diagnostic REPL (`waymark repl` / `bin/waymark-repl.mjs`)
- Expose an interactive Read-Eval-Print Loop attached directly to the resident background daemon (`WaymarkDaemon`).
- **Daemon Requirement:** The REPL strictly requires the resident daemon. If offline, it auto-launches the background daemon before initiating the session, ensuring all queries exercise resident IPC.
- **Execution Modes:**
  1. *Interactive TTY Shell:* Ad-hoc query testing (`ask`, `symbols`, `discover`, `anchor`, `baseline`, `manifest`, `status`, `exit`).
  2. *Scripted & Manifest Evaluation:* Run test manifests (`waymark repl --manifest <path>`) or piped session scripts to evaluate agent discovery workflows and report live line drift and tier diagnostics.

### B. Validation Primitives: Tree-Sitter AST & Cryptographic Anchors Over Regex
- **Discovery Layer:** Uses native Tree-Sitter AST parsing (`web-tree-sitter`) for TS/JS and Python, and `codedb outline` for polyglot files. Regex is strictly forbidden for code/symbol discovery.
- **Line Drift & Integrity:** Uses SHA-256 cryptographic range hashing via `anchorForRange` (`src/integrity.ts`). When testing live drift, the exact line slice is hashed on disk. If the hash matches but line offsets differ, we calculate the exact $\Delta$ line drift without guesswork.
- **Manifest & Input Validation:** Runtime validation via Zod schemas and TypeScript discriminated unions.
- **Search Baseline:** Regex is used *strictly* as the naive baseline comparator to measure noise reduction and token savings against Waymark AST hits.

### C. 15-Category ~105-Prompt Hardened Live Evaluation Suite (`CATALOGUE_MANIFEST.jsonl`)
- Standardized manifest in `docs/prompts/CATALOGUE_MANIFEST.jsonl` containing 105 test cases across 15 categories (7 prompts each):
  1. `01_exact_literal_and_path_normalization`
  2. `02_deep_ast_declarations_and_scope`
  3. `03_bounded_multihop_dag_traversal`
  4. `04_test_file_noise_suppression`
  5. `05_polyglot_fallback_and_boundaries`
  6. `06_pathological_fuzzy_collisions`
  7. `07_batch_symbol_pressure`
  8. `08_negative_and_honest_fail_closed`
  9. `09_adversarial_security_and_sandboxing`
  10. `10_integrity_and_tamper_evidence`
  11. `11_cross_domain_compositional_tasks` (multi-turn agent sequences)
  12. `12_degraded_state_and_error_recovery`
  13. `13_high_concurrency_and_daemon_stress`
  14. `14_token_budget_and_compression_pressure`
  15. `15_discovery_junction_consensus`
- Multi-turn compositional workflows in Category 11 define sequential `steps: [...]`, validating context passing and state consistency.

---

## 3. Diagnostic Metrics Suite

Every query or test evaluated through the REPL/runner calculates:
1. **Line Drift ($\Delta$ Lines & Hash Stability):** Compares returned range against ground truth on disk; verifies SHA-256 anchor via `anchorForRange`.
2. **Operator Error Taxonomy:** Distinguishes caller errors (`OPERATOR_INVALID_SYNTAX`, `OPERATOR_WRONG_TIER`, `OPERATOR_PATH_ESCAPED`, `OPERATOR_STALE_ANCHOR`) from engine failures (`ENGINE_MISROUTING`) and true negative refusals (`ENGINE_FAIL_CLOSED_MISS`).
3. **Baseline Comparison:** Scans repository with naive regex search; calculates latency delta, total candidate noise count vs 1 precise AST hit, noise reduction ratio (%), and token savings (`--plain` vs JSON vs regex).
