# Changelog

All notable changes to `waymark-engine` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.0.0] - 2026-09-25

### Major Architectural Upgrade: Discovery Junction & Tier 3 Fuzzy Lexical Matching

Version 2.0.0 upgrades Waymark Engine from a hard two-phase waterfall into a multi-tiered discovery system governed by a **Discovery Junction**. Instead of silently gating queries behind rigid heuristic boundaries or using semantic memory as a catch-all crutch for syntactic queries, queries route through deterministic structural and literal tiers, escalating to an inspectable recommendation junction (fuzzy lexical ⇄ charted semantic memory).

### Added

- **Embedded Tier 3 Deterministic Fuzzy Matcher (`src/fuzzyMatcher.ts`)**:
  - Implements Junegunn Choi's `fzf` (`algo.go`) empirical scoring algorithm in pure TypeScript without external npm dependencies.
  - Exact `algo.go` constants: `SCORE_MATCH = 16`, `SCORE_GAP_START = -3`, `SCORE_GAP_EXTENSION = -1`, `BONUS_BOUNDARY = 8`, `BONUS_CAMEL_123 = 7`, `BONUS_CONSECUTIVE = 4`, `BONUS_FIRST_CHAR_MULTIPLIER = 2`.
  - Two-pass lazy traceback architecture:
    - **Pass 1 (Score-only)**: Rolling 1D scalar buffers, subsequence verification guard, zero heap allocations per evaluated candidate during DP alignment.
    - **Pass 2 (Lazy Traceback)**: Full Smith-Waterman traceback matrix executed exclusively on the top-$K$ surviving candidates (default: 5) to compute exact contiguous `matchRanges`.
  - Repository path proximity bonus (+20 points for same directory, +10 points for same parent crate/module).
  - Deterministic tie-breaking order (confidence desc $\to$ name length asc $\to$ repository path asc $\to$ line asc), verified across 1,000 candidate array shuffles.
  - Orthographic token shape classifier (`classifyTokenShape`): syntactically identifies camelCase, `snake_case`, and dotted qualified names as `"identifier-like"`, treating lowercase typos and English prose as `"plain"`.

- **Discovery Junction Routing Layer (`src/discoveryRouter.ts`)**:
  - Replaces the hard gate with an inspectable recommendation junction (`status: "junction"`).
  - **Stage 1 (Identifier-shaped tokens)**: Runs eager fuzzy matching first. If confidence $\ge 60\%$, returns `fuzzy-lexical` as recommended and executed, while leaving `capn-cli` unqueried (`executed: false`, preserving cost and avoiding memory pollution).
  - **Stage 2 (Narrative queries)**: Runs Capn charted memory eagerly when no identifier-shaped tokens are present or when fuzzy confidence is below threshold.
  - **Stage 3 (Exhaustive fuzzy fallback)**: If both Stage 1 and Stage 2 miss, an exhaustive fuzzy pass scores remaining plain tokens, automatically recovering lowercase typos (e.g., `flattenconfig` resolving to `flattenConfig`).
  - Signal reporting: Emits `{ shape: "identifier-like" | "narrative" | "mixed", candidateTokens: string[] }`.
  - Continuation tip: Returns machine-readable continuation tool calls and exact CLI commands for the non-recommended tier.

- **CLI-First Token Economy & Tier Control Flags (`src/cli.ts`)**:
  - `-t, --tier <auto|ast|path|fuzzy|capn>`: Explicitly forces a specific discovery tier or selects auto-routing. Enables granular bottleneck isolation.
  - `-b, --timing`: Collects high-resolution tier execution metrics (`ast_ms`, `path_ms`, `fuzzy_ms`, `capn_ms`, `total_ms`).
  - `-p, --plain`: Renders token-minimal plain text output formatted specifically for AI agent context consumption (~16 tokens for flat hits, ~38 tokens for junction tips vs. ~250 tokens for MCP JSON).
  - `-j, --json`: Forces raw machine-readable JSON output for programmatic consumers.
  - `--auto-resolve`: Collapses junction responses directly into flat hit/miss payloads for backwards-compatible consumers.

- **Formal Specification Directory (`/spec/`)**:
  - Added dedicated root `/spec` directory containing canonical tier specifications, operational metrics schemas, command registries, and error code catalogs.

- **Test Coverage**:
  - Added unit test suite `test/fuzzyMatcher.test.ts` (7 tests: `algo.go` constants, subsequence enforcement, camelCase/boundary bonuses, traceback ranges, 1,000-shuffle determinism).
  - Added integration test suite `test/discoveryJunction.test.ts` (9 tests: signal partitioning, Stage 1 eager fuzzy, Stage 2 narrative Capn, Stage 3 typo recovery, `forceTier`, `autoResolve`, timing metrics, chart decoupling).
  - Full test suite verified at **39/39 tests passing (100% green)**.

### Changed

- **`ask()` Public Signature & Contract (`src/capnAdapter.ts`, `src/index.ts`, `src/types.ts`)**:
  - Signature updated to `ask(root, profile, executable, question, options?: AskOptions): Promise<AskResult | Record<string, unknown>>`.
  - Default response when structural and literal tiers miss is now `status: "junction"` containing `executedOption`, `alternativeOption`, and `chartHint`. Callers desiring legacy flat responses can pass `{ autoResolve: true }`.
  - Added `options: JunctionOption[]`, `recommendation?: string`, and `tip?: string` directly to `AskJunctionResult`.

- **Codedb Integration (`src/codedbAdapter.ts`)**:
  - Leverages `@paragon-ux/codedb-core` v1.0.2 single-pass `neighbors` command for unified caller/callee traversal and ambiguity detection.
  - Added `queryFuzzyCandidates` helper utilizing codedb's symbol index for fast top-100 candidate retrieval.

### Fixed

- **Capn Chart Decoupling (Invariant §8)**:
  - Audited `publish()` / `waymark-chart` to guarantee zero coupling with `classifyTokenShape`. Pure code queries (e.g. `refundOrder`) chart cleanly into Capn memory without syntactic rejection.
- **Strict Indexed Access**:
  - Resolved `noUncheckedIndexedAccess` type safety warnings in rolling DP alignment and flat 1D traceback matrix loops.

---

## [1.3.1] - 2026-09-24

### Added
- Literal filename and repository path short-circuit router (`src/discoveryRouter.ts`).
- Fail-closed literal path resolution: exact matches, unique basenames, unique suffixes, and unique substrings.
- In-memory 30-second TTL repository path cache (`collectRepoPaths`).

---

## [1.2.0] - 2026-09-21

### Added
- Multi-language AST symbol discovery supporting TypeScript and Python (`src/astExtractor.ts`).
- Structural hop integrity verification with rolling hash spans (`src/integrity.ts`, `src/paths.ts`).

---

## [1.0.0] - 2026-09-12

### Added
- Initial public release of Waymark Engine discovery core.
- Bundled `@paragon-ux/capn-hook` lexical-only BM25 charted memory adapter.
- Fail-closed deterministic store guards (`assertLexicalStore`).
- Zero-daemon CLI tools: `waymark-ask`, `waymark-chart`, `waymark-init`, `waymark-list`, `waymark-context`, `waymark-mcp`.
