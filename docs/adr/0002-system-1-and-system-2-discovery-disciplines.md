# ADR-0002: System 1 (Fast Deterministic) and System 2 (Deliberate Consensus) Disciplines

- **Status:** Accepted
- **Date:** 2026-09-28
- **Invariants:** Deterministic by Construction, No Vector Embeddings, Fail-Closed Ambiguity Defense

---

## 1. Context & Motivation

Waymark Engine integrates two distinct problem-solving modalities:
1. **Deterministic Structural & Lexical Analysis** (Tree-sitter AST, codedb call graphs, PrefixTrie, Junegunn Choi fzf fuzzy matching).
2. **Charted Repository Consensus Memory** (`capn-hook` BM25 store).

Historically, projects that attempt to unify code intelligence and semantic memory succumb to a dangerous anti-pattern: using semantic search as a crutch for poor structural indexing. When structural parsing fails or symbol lookups are noisy, engines blindly "fall through" to vector embeddings or bag-of-words retrieval, emitting plausible-sounding hallucinations that mislead developers and agents.

The archiving of the legacy `waymark-docs` directory reflects this realization: **treating BM25 or embedding search as a glorified search engine across codebases is fundamentally flawed**. Semantic memory must be reserved strictly for architectural consensus that deterministic tools cannot compute.

---

## 2. Decision & Disciplines

We formalize the cognitive division between **System 1 (Reactive Determinism)** and **System 2 (Deliberate Architectural Synthesis)**:

### System 1: Fast, Deterministic, Sub-Millisecond Discovery
- **Scope:** Exact identifiers, definitions, call hierarchies, literal file paths, and syntax-aware fuzzy matching.
- **Components:**
  - **Tier 1 (AST Structural):** Deterministic `@paragon-ux/codedb-core` call graph + Tree-sitter AST extraction. Fail-closed on ambiguity (surfaces file-scoped candidates; never merges).
  - **Tier 2 (Literal Path):** $O(\text{len})$ in-memory `PrefixTrie` + $O(1)$ basename map. Resolves in `< 10ms`.
  - **Tier 3 (Deterministic Fuzzy):** Zero-dependency Junegunn Choi `fzf` algorithm (`algo.go`) two-pass Smith-Waterman scoring.
- **Invariant:** **Zero Hallucination / Zero Fallthrough.** A symbolic miss is an immediate miss or an inspectable Junction recommendation. System 1 NEVER falls through to System 2 memory.

### System 2: Deliberate, Multi-Turn Architectural Consensus
- **Scope:** Narrative questions, multi-hop dependency tracing, architectural decisions, and cross-cutting subsystems.
- **Components:**
  - **Bounded Multi-Hop DAGs (`queryMultiHopCallGraph`):** Breadth-first search traversing invocation chains up to depth 5 with cycle defense (`Set<string>`) and a 50-node safety cap.
  - **Discovery Junction (`status: "junction"`):** Machine-readable recommendation state machine evaluating candidate signals when System 1 tiers miss cleanly.
  - **Charted Consensus Memory (`waymark_chart` / Tier 4):** Curated repository memory backed by verified regular files (`files` preflight). Strictly deterministic BM25 lexical ranking (`embedding: false`).
- **Discipline:** Charting into consensus memory is deliberate. An agent or developer charts verified architectural answers so subsequent sessions skip discovery overhead. Memory entries are subject to staleness checks (`waymark_prune`, `waymark_bust`, `waymark_unchart`).

---

## 3. Practical Guardrails

1. **No Vector Embeddings:** The store refuses any configuration with embedding modes (`CAPN_NON_DETERMINISTIC_MODE`), enforcing deterministic, hash-pinned reproducibility across all runs.
2. **No Silent Demotion:** A query like `"Who calls verifyHop?"` or `"Definition of UserService"` will NEVER return a Tier 4 memory answer if the symbol is missing from the AST. It returns `[miss]` or a junction.
3. **Explicit Agent Directives:** Agents querying code structures should pass `tier: "ast"` or `symbols: [...]` to lock execution into System 1.
