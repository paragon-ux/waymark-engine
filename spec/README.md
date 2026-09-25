# Waymark Engine Technical Specifications (`/spec`)

This directory is the canonical, authoritative home for the technical specifications of the **Waymark Engine** tiered discovery architecture. It defines the formal contracts, invariants, performance boundaries, error registries, and measurable operational metrics governing all discovery components.

---

## 1. Architectural Map

```
Query Input
    │
    ├──► [Tier 1: AST Structural] ──(Hit: 100% exact)─────────────► AskHitResult (codedb)
    │        │
    │      (Miss)
    │        ▼
    ├──► [Tier 2: Literal Path] ───(Hit: 100% exact)─────────────► AskHitResult (literal-path)
    │        │
    │      (Miss)
    │        ▼
    └──► [Discovery Junction]
             │
             ├──► Signal Analysis (classifyTokenShape, extractCandidateTokens)
             │
             ├──► Stage 1: Identifier-shaped? ──(Fuzzy Score >= 60%)──► AskJunctionResult (fuzzy recommended)
             │        │
             │      (Miss / Below Threshold)
             │        ▼
             ├──► Stage 2: Capn Memory Query ──(BM25 Charted Hit)───► AskJunctionResult (capn recommended)
             │        │
             │      (Miss)
             │        ▼
             └──► Stage 3: Exhaustive Fuzzy ───(Plain Token Match)────► AskJunctionResult (typo resolved)
                      │
                    (Miss)
                      ▼
                  AskMissResult (JUNCTION_EXHAUSTED)
```

---

## 2. Specification Index

| Document | Component / Layer | Responsibility | Status |
| :--- | :--- | :--- | :--- |
| [**`tier-1-ast.md`**](./tier-1-ast.md) | Tier 1: Codedb Structural | Ground truth AST indexing, symbol locations, and fail-closed resolved call graphs via `@paragon-ux/codedb-core`. | **Stable** |
| [**`tier-2-path.md`**](./tier-2-path.md) | Tier 2: Literal Path Router | In-memory zero-dependency path cascade resolving exact filenames, basenames, suffixes, and substrings. | **Stable** |
| [**`tier-3-fuzzy.md`**](./tier-3-fuzzy.md) | Tier 3: Deterministic Fuzzy Matcher | Embedded Junegunn Choi `fzf` (`algo.go`) Smith-Waterman two-pass scoring and path proximity ranking. | **Stable** |
| [**`tier-4-semantic.md`**](./tier-4-semantic.md) | Tier 4: Charted Memory | Lexical BM25 long-term repository consensus memory via `@paragon-ux/capn-hook`. | **Stable** |
| [**`discovery-junction.md`**](./discovery-junction.md) | Discovery Junction | Recommendation state machine coordinating fuzzy lexical and semantic memory paths. | **Stable** |
| [**`command-registry.md`**](./command-registry.md) | Command & Interface Registry | Canonical registry of CLI commands, flags, Discovery tiers, and MCP tools. | **Authoritative** |
| [**`error-codes.md`**](./error-codes.md) | Error & Status Registry | Machine-readable status values, error codes, miss codes, and exit code semantics. | **Authoritative** |
| [**`metrics.md`**](./metrics.md) | Measurable Tier Metrics | Standardized metrics schema (tokens, latency, limits, resources) and benchmarks across all tiers. | **Authoritative** |
| [**`adversarial-benchmark-grafana.md`**](./adversarial-benchmark-grafana.md) | Adversarial Benchmark | Empirical stress test on `grafana/grafana` (23,517 files, Go + TypeScript polyglot monorepo). | **Empirical** |

---

## 3. Core Architectural Invariants

Every component and tier within Waymark Engine MUST adhere to the following invariants:

1. **Zero Hallucination / Fail-Closed Posture**:
   A clean miss is a miss — never a fabricated edge, approximate symbol attribution, or speculative call. If an identifier is ambiguous across multiple files, the engine returns `"ambiguous": true` with file-scoped candidates rather than guessing.
2. **Deterministic Recall Only**:
   The engine refrains from non-deterministic embeddings or vector indexes. Semantic recall relies strictly on lexical BM25 (`capn init` / `@paragon-ux/capn-hook`). Any uninitialized or embedding-configured store immediately triggers `CAPN_STORE_UNINITIALIZED` or `CAPN_NON_DETERMINISTIC_MODE` exceptions.
3. **Inspectable Junction Recommendations**:
   When structural and literal tiers miss, the engine returns an inspectable recommendation junction (`status: "junction"`), presenting the executed recommendation alongside the unexecuted alternative with machine-readable continuation instructions (`tool: "waymark_ask"` and `cliCommand`).
4. **Decoupling of Query Routing and Charting**:
   The syntactic token classifier (`classifyTokenShape`) governs query routing recommendations only. It holds ZERO authority over `waymark-chart`. Chart-worthiness is a judgment of retention value made by the agent, never conditioned on syntax.
5. **CLI-First Token Economy**:
   The terminal CLI defaults to compact plain text output (~16–38 tokens) to preserve the caller's context window. Machine-readable JSON is emitted explicitly via `--json` or programmatic MCP bindings.
