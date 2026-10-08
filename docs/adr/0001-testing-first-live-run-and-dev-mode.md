# ADR-0001: Testing-First Methodology, Dev Mode (`--dev`), and Live Run Mandates

- **Status:** Accepted
- **Date:** 2026-09-28
- **Invariants:** Fail-Closed Precision, Zero Process Leaks, Sub-millisecond Resident Retrieval
- **Governance:** `docs/governance/regressions-log.jsonl`

---

## 1. Context & Motivation

Waymark Engine serves as the core symbolic and semantic discovery engine for AI coding agents. If the engine hallucinates a symbol, fails to detect an architectural cycle, returns a false-positive path, or leaks resident background processes, the downstream agent wastes thousands of tokens or enters runaway loops.

Prior development cycles relied heavily on offline Node `node:test` unit fixtures. While unit tests verified code paths in isolation, real-world stress testing (e.g. against Apache Arrow and Pydantic) and CI matrix execution uncovered cross-platform path canonicalization bugs and symlink boundary failures that offline unit mocks failed to predict.

Furthermore, external reviews (DeepSeek and Kimi) highlighted that vague performance claims ("milliseconds") and ungrounded fallbacks ("falls through to semantic") erode technical trust unless backed by live verification harnesses and transparent operational diagnostics.

---

## 2. Decision & Mandates

We establish a **Testing-First Operational Methodology** for Waymark Engine, governed by three core pillars:

### Pillar 1: Dev Mode (`--dev`) for Live Introspection & Diagnostics
- Both the CLI (`waymark ask <query> --dev`) and MCP server (`dev: true` on `waymark_ask` / `waymark_daemon_status`) SHALL support an explicit Dev Mode.
- When `--dev` is enabled:
  1. **Sub-millisecond Timing Breakdown:** Emits discrete timings for each evaluated tier (`ast`, `path`, `fuzzy`, `capn`, `junction`).
  2. **Trie & Resident IPC Diagnostics:** Reports whether a path match resolved via exact trie prefix, $O(1)$ basename map, or substring fallback, and whether the query hit the in-memory daemon IPC or fell back to in-process scanning.
  3. **Live Invariant Assertions:** Runtime checks execute unconditionally:
     - Asserts graph visited node count $\le 50$ (caps blowup).
     - Asserts visited node cycle detector prevents duplicate node expansions.
     - Asserts canonical realpaths contain no unnormalized backslashes or null bytes.
     - Asserts test noise suppression filters out test paths when `exclude_tests: true`.

### Pillar 2: Live Run Requirement across Standardized Prompt Batteries
- Every non-trivial pass, refactor, or version release MUST execute a live verification run against standardized test prompt batteries located in `docs/prompts/`.
- The live pass MUST traverse all operational discovery tiers:
  - **Tier 1 (AST):** Exact definition and call-graph queries.
  - **Tier 2 (Path):** Exact and relative filename resolution.
  - **Tier 3 (Fuzzy):** Deterministic Junegunn Choi fzf scoring.
  - **Tier 4 (Consensus Memory):** Lexical BM25 retrieval without vector embeddings.
  - **Multi-Hop:** BFS DAG traversal with cycle defense and tree formatting.
  - **Batch Symbols:** Concurrent multi-component resolution.
  - **Fail-Closed Misses:** Verifying clean miss behavior on ambiguous or nonexistent symbols.

### Pillar 3: Mechanized Regression Ledger (`regressions-log.jsonl`)
- Any contract violation, CI runner defect, cross-platform path bug, or live test failure MUST be recorded in `docs/governance/regressions-log.jsonl` using the standard mechanized schema:
  ```json
  {
    "regression_id": "REG-XXX",
    "timestamp": "ISO-8601",
    "component": "daemon | paths | ast | trie | mcp | capn",
    "severity": "CRITICAL | HIGH | MEDIUM | LOW",
    "contract_clauses_violated": ["..."],
    "causes": [
      {
        "cause_type": "...",
        "problem_statement": "...",
        "type_effect": "...",
        "type_solution": "..."
      }
    ]
  }
  ```
- No release may be tagged or published while open, unmitigated regressions remain in the ledger.

---

## 3. Consequences & Benefits

- **Zero Blind Guessing:** Replaces optimistic unit testing with live operational verification on real repository trees.
- **In-House Project Governance:** Eliminates dependence on external project management tools (Linear/Jira) in favor of lightweight, version-controlled, agent-readable ledgers.
- **Immediate Glama & Agent Transparency:** The diagnostic telemetry surfaces exactly how and why a query resolved, giving agents machine-readable confidence in the retrieved code locations.
