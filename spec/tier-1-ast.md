# Specification: Tier 1 — AST Structural & Call Graph Intelligence

**Tier Identifier**: `ast` / `codedb`  
**Owning Module**: [`src/codedbAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/codedbAdapter.ts)  
**Upstream Engine**: [`@paragon-ux/codedb-core`](https://github.com/paragon-ux/codedb-core) (v1.0.2)  
**Status**: Stable

---

## 1. Purpose & Responsibility

Tier 1 serves as the ground-truth deterministic structural layer of Waymark Engine. It resolves code questions requiring syntactic understanding:
- Function and method caller hierarchies (`callers`).
- Direct callee invocations (`callees`).
- Unified bidirectional neighbors (`neighbors`).
- Exact symbol declarations, definitions, and line spans (`symbol`).
- High-level repository architecture, entrypoints, and file topology (`tree`).

Tier 1 never guesses or approximates: if an edge cannot be resolved with certainty, it is excluded; if a symbol query is ambiguous across multiple files, all candidates are returned with `"ambiguous": true`.

---

## 2. Entry Conditions & Intent Routing

Queries enter Tier 1 when `detectAstIntent(question)` classifies the query as structural, or when the caller forces `--tier ast`.

```typescript
export interface AstIntent {
  requiresParser: boolean;
  tool: "trace_path" | "search_graph" | "get_architecture";
  functionName?: string;
  query?: string;
}
```

### Classification Patterns
- **Architecture / Entrypoints** (`get_architecture`): Contains "entrypoint", "architecture", "hotspots", "high-level structure", "project topology", "overview of the repo".
- **Call-Graph Tracing** (`trace_path`): Contains "who calls", "callers of", "callees of", "trace path", "what calls", "which functions call", "call hierarchy".
- **Symbol / Definition** (`search_graph`): Contains "where is method", "where is function", "where is class", "definition of", "declaration of", "implementation of", "where is <symbol> declared/defined", or matches bare identifier syntax `^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?(?:\(\))?\??$`.

---

## 3. Implementation Contracts & Invariants

1. **Single-Pass Bidirectional Extraction**:
   Uses `codedb neighbors <functionName> --json` to extract callers, callees, and ambiguity status in a single AST traversal, halving query time over separate `callers` + `callees` passes.
2. **Fail-Closed Resolution Cascade**:
   - Tier A: Same-file helper resolution (resolves unambiguously to local definition).
   - Tier B: Globally unique symbol name.
   - Ambiguity: If multiple definitions share the same name across files, the edge is dropped and reported in `dropped_ambiguous_callers` / `dropped_ambiguous_callees`.
3. **Language-Family Boundary**:
   Callees resolve exclusively within the same language family (JS/TS grouped), preventing TypeScript function calls from linking to same-named C/Rust symbols.
4. **Execution Supervision**:
   Invoked via direct `execFile` argv arrays (never a shell) with 30s bounded timeout. In resident mode (`serve --stdio`), supervised via Windows Job Objects for clean teardown.

---

## 4. Measurable Operational Metrics

| Metric | Specification / Observed Value | Notes |
| :--- | :--- | :--- |
| **Token cost** | 20–60 tokens (plain text); ~120 tokens (JSON) | Highly compact tabular or indented caller/callee summary. |
| **Latency (cold one-shot)** | ~70ms–190ms (medium repo); ~5.6s (cold 8,500 files) | Dominated by one-time AST build during cold load. |
| **Latency (resident stdio)**| **0.26ms – 0.75ms** | Benchmarked on `openai/codex` (8,590 files) resident server. |
| **Candidate count** | Up to repo symbol count (e.g. 50,000+ symbols) | Screened via trigram index and AST tree. |
| **Result count** | 1 architecture tree; 1 resolved neighbor set; $\le 50$ symbol hits | Bounded output prevents buffer overflows. |
| **Confidence** | `exact` (100% ground truth) | Fail-closed; zero heuristic guessing. |
| **Fallback behavior** | On miss (`hit: false`), falls through to Tier 2 (Literal Path) | Never fabricates approximate edges. |
| **Failure mode** | Fail-closed (`SYMBOL_NOT_FOUND` or `CODEDB_BINARY_MISSING`) | Exits with error code; does not fall through on process failure. |
| **Resource cost** | $\sim 45\text{MB}$ memory resident | Pure Zig native binary; zero garbage collection pauses. |
| **Verification** | `test/discoveryRouter.test.ts`, `test/codedb.ts` | Verified across single-pass, ambiguity, and definition queries. |
