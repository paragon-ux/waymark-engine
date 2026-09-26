# Changelog

All notable changes to `waymark-engine` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.3.0] - 2026-09-26

### Bounded Multi-Hop Call Graph DAGs, Persistent In-Memory PrefixTrie, Multi-Symbol Batch Discovery, and Polyglot Fallbacks

Version 2.3.0 adds bounded multi-hop call graph expansion with cycle detection, in-memory PrefixTrie literal path indexing, batch symbol resolution across CLI and MCP surfaces, store auto-initialization, and polyglot outline fallbacks for non-TS/Python languages.

### Added

- **Bounded Multi-Hop BFS Call Graph (`queryMultiHopCallGraph`)**:
  - Added `--depth 1..5` (default: 1) and `--direction callers | callees | both` parameters to `waymark ask` and MCP `waymark_ask`.
  - Added `--exclude-tests` (MCP: `exclude_tests: boolean`) filter suppressing test files (`tests/`, `*_test.*`, `*.spec.*`) from call graphs, reducing agent context noise by up to 94% on libraries like Apache Arrow.
  - BFS traversal with visited node cycle defense (`Set<string>`) to safely map recursive and circular call chains.
  - Hard cap of 50 nodes per traversal with `truncated: true` and truncated notice in plain text to safeguard agent context limits.
  - Indented visual tree renderer (`renderCallGraph` in `src/renderPlainText.ts`) outputting hierarchical call chains in token-minimal format.
  - Full backward compatibility: single-hop queries without explicit `depth` retain the existing flat format.
- **Persistent In-Memory PrefixTrie & Daemon Reload (`src/prefixTrie.ts`, `src/daemon.ts`)**:
  - Custom in-memory prefix trie with $O(\text{len})$ exact matching and $O(1)$ basename map with collision detection.
  - Resident daemon IPC action `resolve_path`, delivering warm path queries in 7.56ms on 21,144-file codebases.
  - Added `waymark daemon reload` CLI command and `reload: true` parameter on MCP `waymark_daemon_status` (`tryDaemonReload`) to cleanly invalidate resident caches and trie snapshots upon file mutations.
  - Fail-closed collision defense: ambiguous bare filenames occurring in multiple directories fail closed cleanly with `[miss]`, requiring relative paths to disambiguate.
- **Multi-Symbol Batch Discovery**:
  - Added `queryMultiSymbols` function in `src/codedbAdapter.ts` resolving multiple identifiers across the repository with deduplication and line ranges.
  - Added standalone binary `waymark-symbols` and CLI command `waymark symbols <sym1> <sym2>...`.
  - Added `symbols: string[]` parameter to MCP `waymark_ask` / `capn_ask` returning consolidated multi-symbol locations in JSON and plain text.
- **Store Auto-Initialization & Graceful Read-Only Degradation**:
  - Added safe argument escaping (`capnChartArgs`, `capnUnsafeArgs`) in `src/capnAdapter.ts` preventing shell and argument injection vulnerabilities.
  - Read-only tools (`waymark_list`, `waymark_context`) return clean `{ initialized: false, count: 0, items: [] }` rather than throwing errors on uninitialized repositories.
  - Write tool (`waymark_chart`) automatically initializes the deterministic lexical store if uninitialized.
  - Added MCP tool `waymark_init` (`capn_init`) and standalone CLI binary `waymark-init` (`waymark init`) for one-shot lexical store initialization.
- **Polyglot Parser Fallback (`discoverSymbolsInFile`)**:
  - Tree-sitter file outline extraction now transparently falls back to `codedb outline` for non-TypeScript/non-Python files (C++, Rust, Go, Java, C#, etc.).
- **Reusable External Stress Benchmark (`scratch/benchmarks/suites/benchmark_arrow_and_pydantic.mjs`)**:
  - End-to-end automated stress benchmark testing Apache Arrow (5,335 polyglot files) and Pydantic (851 Python/Rust files), exporting structured metrics to `scratch/benchmark_results/arrow_and_pydantic_results.json`.

---

## [2.2.0] - 2026-09-25

### MCP Surface Parity, Discovery Precision Hardening, and Maintenance Tools

Version 2.2.0 establishes 100% feature flag and capability parity between the CLI and MCP server surfaces, introduces strict fail-closed precision routing to eliminate false-positive fuzzy fallthrough on structural queries, and exposes the full lifecycle maintenance tool suite.

### Added

- **Full MCP CLI Flag Parity**:
  - `tier` parameter (`auto | ast | path | fuzzy | capn`) on `waymark_ask` / `capn_ask` to isolate query tiers or bypass junction fallthrough.
  - `plain` parameter for token-minimal output (~14–38 tokens) designed specifically for LLM context delegation.
  - `timing` parameter to surface sub-millisecond per-tier latency instrumentation in tool responses.
  - `daemon` parameter to enable resident background AST acceleration directly from tool calls.
  - `auto_resolve` flag to control automatic multi-stage resolution behavior.
- **Shared Output Formatting (`src/renderPlainText.ts`)**:
  - Extracted `renderPlainText` and `formatTimings` to deliver identical high-density output across both CLI and MCP.
- **MCP Maintenance Tool Surface**:
  - `waymark_unchart` (alias: `capn_unchart`): Invalidate and remove charted repository consensus memory entries by ID.
  - `waymark_bust` (alias: `capn_bust`): Invalidate all consensus memories anchored to a specific file path.
  - `waymark_prune` (alias: `capn_prune`): Cleanly remove all stale memories whose backing files no longer exist.
  - `waymark_list` (alias: `capn_list`): Inspect all charted architectural consensus memories.
  - `waymark_context` (alias: `capn_context`): Retrieve the ask-first charting contract and routing guidelines.
  - `waymark_daemon_status`: Query resident in-memory background daemon health, PID, socket/pipe address, and uptime.
- **Zero-Config Bundled Resolution**:
  - Defaulted `capn_executable` in MCP tools to empty string, enabling transparent auto-resolution to the bundled `@paragon-ux/capn-hook` without requiring manual PATH configuration.

### Fixed

- **Structural AST Fail-Closed Invariant**:
  - When explicit call-graph queries (`astIntent.tool === "trace_path"`, e.g., `"Who calls 'Run'?"`) miss in Tier 1 codedb and Tier 4 memory, the router now fails closed immediately with `SYMBOL_NOT_FOUND` rather than falling through to Stage 3 fuzzy matching on raw query tokens (`"calls"`, `"Run"`).
  - Enforced callable type filtering (`function` or `method`) during candidate evaluation for call-graph queries.
- **Structural Stop Words Expansion**:
  - Added structural code navigation verbs to `STOP_WORDS` (`call`, `calls`, `caller`, `callers`, `callee`, `callees`, `trace`, `tracing`, `hierarchy`, `signature`, `declaration`, `definition`, `implementation`, `entrypoint`, `entrypoints`) to prevent query intent verbs from being treated as symbol search tokens.
- **Test Suite Expansion**:
  - Added comprehensive MCP parity and precision test suite (`test/mcpParityAndPrecision.test.ts`), bringing total verification suite to **47/47 tests passing green**.

---

## [2.1.2] - 2026-09-25

### Dual-Era MCP Compliance, Registry Crawler Compatibility, and Guided Prompts

### Added

- **Dual-Era MCP Handshake (`src/mcp/server.ts`)**:
  - Added support for both modern `2026-07-28` discovery handshake and classic `2024-11-05` initialization protocol.
  - Implemented `server/discover` method exposing capabilities, tools, resources, and prompt catalog in a single payload.
  - Added `instructions` string to `InitializeResult` in the standard `initialize` handshake (`2024-11-05`) for backward-compatible registry inspection.
- **MCP Prompts Catalog**:
  - `explore-subsystem`: Guided 4-tier exploration workflow for decomposing modules and concepts.
  - `architectural-map`: Structured call-graph and consensus memory mapping workflow.
- **MCP Resources**:
  - `waymark://manifest`: Engine metadata, tier capabilities, and supported language specifications.
  - `capn://status`: Memory store status, adapter configuration, and health.
- **Registry Crawler Compatibility**:
  - Added `waymark-engine` entry point to `bin` in `package.json`, permitting headless crawlers and clients (`npx -y waymark-engine`) to execute cleanly.
  - Non-crashing graceful stdio handling for registry inspectors and schema scrapers (Glama, PulseMCP, Smithery) that probe tools without repository contexts.

---

## [2.1.1] - 2026-09-25

### Fixed

- **POSIX Prebuilt Binary Permissions**: Automatic `chmod 0o755` on bundled `codedb` binaries unpacked without executable bits on Linux and macOS environments.
- **POSIX Temporary Root Indexing**: Propagate `CODEDB_ALLOW_TEMP=1` across resident and cold `codedb` execution, permitting seamless indexing of temporary repositories under `/tmp` and `/var` across Linux and macOS CI runners.
- **Cross-Platform Verification**: Validated 100% green test matrix (43/43 tests) across Ubuntu, macOS, and Windows.

## [2.1.0] - 2026-09-25

### Resident Process Bridge, Daemon IPC, and Performance Hardening

Version 2.1.0 introduces in-memory resident AST acceleration, cross-process IPC communication, and automatic MCP persistence while preserving the engine's zero-background-daemon invariant by default.

### Added

- **Resident Codedb Process Bridge (`src/residentCodedb.ts`)**:
  - Implements `ResidentCodedbClient` managing long-running `codedb <root> serve` via stdio with line-buffered JSON-RPC.
  - Strict sequential FIFO queue with request timeouts to prevent command interleaving.
  - Configurable idle timeout with automatic cleanup.
  - Synchronous process `exit`, `SIGINT`, and `SIGTERM` listeners ensuring immediate subprocess termination and zero orphaned binaries.
- **Cross-Process Waymark Daemon & IPC Bridge (`src/daemon.ts`)**:
  - Implements `WaymarkDaemon` communicating over Windows Named Pipes (`\\.\pipe\waymark-<hash>`) and POSIX domain sockets (`/tmp/waymark-<hash>.sock`).
  - System-wide registry tracking active daemons in `os.tmpdir()/waymark-daemons.json`.
  - Added standalone `waymark-daemon` CLI wrapper (`bin/waymark-daemon.mjs`).
  - Management subcommands: `waymark daemon [start|stop|restart|status|list|ping]` with `--path`, `--idle-timeout`, and `--force` options.
- **MCP Server In-Process Persistence (`src/mcp/server.ts`)**:
  - `McpServer` instantiates `WaymarkDaemon` in-process during stdio sessions, warming the AST graph once and serving sub-20ms queries for agent workflows without spawning background processes.
  - Exposes the IPC bridge for concurrent terminal commands during agent sessions.
  - Clean lifecycle teardown on stdio disconnect.
- **CLI Opt-in Acceleration (`src/cli.ts`)**:
  - Added `-d, --daemon` flag to `waymark ask`: allows one-shot CLI commands to opt-in to background resident acceleration.
  - Default CLI remains strictly stateless, preserving the zero-background-daemon invariant.
- **Persistent Path Cache (`src/discoveryRouter.ts`)**:
  - Implemented mtime-backed disk cache (`.capn/paths.cache`) bringing warm CLI path resolution from 758ms down to 41ms (18.4x speedup).
- **Fast-Path Ambiguity Detection (`src/codedbAdapter.ts`)**:
  - Added threshold check ($\ge 25$ candidate definitions) for bare identifiers, bypassing expensive caller graph deduplication and reducing ambiguity resolution time by 86.7% (from 32.2s to 4.2s on common verbs like `New`).
- **Idempotent Uncharting (`src/capnAdapter.ts`)**:
  - Added `--if-exists` flag to `waymark-unchart` (and `ifExists` programmatic option) exiting 0 if an entry was already invalidated or deleted.
- **Interactive Headroom & Lazy WASM Loading**:
  - Thread budgeting (`CODEDB_MAX_THREADS: max(1, cpus - 1)`) prevents 100% CPU lockups during cold scans.
  - Lazy dynamic import of `web-tree-sitter` in CLI so AST extraction modules only load when explicitly invoked.

### Changed

- Updated `@paragon-ux/codedb-core` dependency to `^1.1.0`.
- Normalized repository root paths across Windows NTFS and POSIX in `collectRepoPaths` and `isInside`.
- Preserved compound dotted qualified identifiers (`EventStore.verifyChain`) in `extractCandidateTokens`.
- Full test suite expanded to **43/43 tests passing green** (`npm run verify`).

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
