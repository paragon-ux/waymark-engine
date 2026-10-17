# Changelog

All notable changes to `waymark-engine` are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`root` Argument on `architectural-map` (`src/mcp/server.ts`)**: All three prompts now declare an optional `root`.
- **Qualified and module call-graph nodes (`src/codedbAdapter.ts`, `src/discoveryRouter.ts`, `src/renderPlainText.ts`)**: These need a codedb-core that emits `qualified` and `kind`.
  - Root questions keep their qualifier: `Who calls WaymarkDaemon.start?` queries `WaymarkDaemon.start`. Waymark falls back to the last segment only when codedb reports that the qualified name doesn't exist (`symbol_exists: false`), so `Who calls path.join?` still answers for `join`, and so does any dotted question on an older codedb. A qualified name that exists is never widened to its bare name. If it is ambiguous, such as a getter and setter both named `Shapes.size`, the answer lists those candidates only.
  - Ambiguity answers name each candidate by its qualified name.
  - Hop nodes are named by their qualified name, such as `WaymarkDaemon.start` or `waymarkMemoryTool.handler`, and the next hop queries that name. Traversal now continues past methods whose bare names collide.
  - `<module>` nodes are a TS/JS file's top-level code, with kind `module` at line 1. They appear as callers and are never expanded, and `exclude_tests` drops test-file modules.
  - Plain-text trees tag `[method]` and `[module]` nodes, and the depth-less caller list shows `<module> (path)`.

### Fixed
- **Prompts Pass `root` to the Agent (`src/mcp/server.ts`)**: `explore-subsystem` and `bootstrap-semantic-map` declared `root` but left it out of the prompt text, so a root given by the user never reached the agent. When `root` is set, every prompt now ends with `Pass root: "<value>" on every waymark_ask, waymark_memory, and waymark_chart call.`
- **Bootstrap Draft Evidence (`src/semanticMap.ts`)**: Drafts cited each candidate file's first lines, usually imports. Evidence is now the lines that name the facet's keywords (new `evidenceKeywords` on each `SEMANTIC_FACETS` entry), ranked by keyword count with exported declarations first among equals. A file with no keyword line falls back to its exported declarations. Imports, multi-line import lists, and comments are never evidence, and a candidate file with no evidence is no longer cited. Drafts stay unverified and bootstrap still never charts.
- **Path Discovery Skips `.claude/` (`src/discoveryRouter.ts`, `src/baselineSearch.ts`)**: Claude Code keeps whole checkouts in `.claude/worktrees/`, so every basename lookup (`package.json`, `AGENTS.md`) failed with `AMBIGUOUS_PATH_COLLISION` in a repository that had one.
- **Stale Prompt-Battery Anchor (`docs/prompts/CATALOGUE_MANIFEST.jsonl`)**: `[10-04]` hashed `package.json` lines 1–10, which include `"version"`, so it failed after every release. It now anchors lines 5–10 and is renamed `anchor_package_entrypoints`.

### Removed
- **`migrateMemoryStore` Export (`src/index.ts`)**: Store migration is an internal maintainer command, not public API. `waymark memory migrate` still runs but is no longer listed in help or the docs.

## [4.0.0] - 2026-10-17

### Changed (Breaking)
- **Memory Store Moved to `.waymark/memory` (`src/stateDir.ts`, `src/capnAdapter.ts`, `src/semanticMap.ts`)**: `.capn/` is upstream capn's folder, and `@paragon-ux/capn-hook` is a different implementation that shared its name. In repositories where upstream capn also ran, the two read and wrote each other's store. Waymark no longer reads or writes `.capn/`. `memoryStoreDir(root)` is the single store location.
- **Tier 4 Requires capn Store-Dir Support (`src/capnAdapter.ts`)**: Every capn invocation now passes `--root <repo> --store-dir <repo>/.waymark/memory` before the subcommand. The bundled `@paragon-ux/capn-hook` 2.0.0 honors them. A capn without the flags, such as capn-hook 1.x set through `WAYMARK_CAPN_EXECUTABLE`, prints usage and exits before it touches disk; Waymark refuses it with `CAPN_STORE_DIR_UNSUPPORTED` (exit code 2) and Tier 4 stays off for it. The contract is in `docs/memory-store.md`. Tiers 1–3 are unaffected.
- **Path Cache Always in `.waymark/` (`src/discoveryRouter.ts`)**: `paths.v2.cache` used to go to `.capn/` whenever that folder existed.
- **Daemon PID Record Always in the OS Temp Directory (`src/daemon.ts`)**: `daemon.pid` used to go to `.capn/` whenever that folder existed. It is still informational only and never used to choose a process to kill (F-01).

### Changed
- **Bundled Fork Upgrades (`package.json`)**: `@paragon-ux/capn-hook` ^2.0.0 adds `--root`/`--store-dir` and moves its own default store to `.capn-hook/`. `@paragon-ux/codedb-core` ^2.0.2 no longer creates upstream codedb's `~/.codedb/projects/<hash>` folder, no longer truncates its `data.log` on every run, and reads `.codedb-corerc` instead of `.codedbrc`. Its macOS and Linux binaries are executable, and `codedb --version` reports the package version.
- **Path Discovery Skips Fork State (`src/discoveryRouter.ts`, `src/baselineSearch.ts`)**: `.codedb/`, `.codedb-core/` and `.capn-hook/` never appear in path results or baseline search.
- **Lazy Per-Root MCP Warm-Up (`src/mcp/server.ts`)**: The stdio server no longer warms the resident daemon at startup or checks for `.git`/`.capn` markers. Each `tools/call` starts a background warm-up for the repository it targets (`root` argument, else the server root, resolved to the Git top level), memoized per repository. The call itself never waits; it takes the cold path. At most two repositories stay warm (`WAYMARK_MCP_WARM_MAX_ROOTS`); the least recently used daemon is stopped. `close()` stops every warm daemon, including one whose warm-up finishes after stdin closes. `shouldWarmResidentDaemon` and `startResidentDaemon` are removed.
- **Warm-Up Budget (`src/discoveryRouter.ts`)**: New `collectRepoPathsBounded` walks the tree asynchronously with the `collectRepoPaths` skip rules and path order, and gives up past a file cap (`WAYMARK_MCP_WARM_MAX_FILES`, default 50,000) or time cap (`WAYMARK_MCP_WARM_TIMEOUT_MS`, default 10,000). An over-budget repository is never warmed and is not re-walked during the session. A complete walk seeds the daemon's prefix trie, so the synchronous walk no longer runs during warm-up.
- **`WaymarkDaemon.start()` (`src/daemon.ts`)**: Accepts `{ paths, signal }` and resolves `true` only when it started serving; it resolves `false` when another daemon already answers for the root or the signal aborts before it listens. `stop()` only removes the registry entry and PID file the instance wrote, and it removes its process signal listeners.

### Added
- **`.waymark/.gitignore` (`src/stateDir.ts`)**: Written with `*` whenever Waymark creates `.waymark/`, so its state never shows up as untracked. An existing file is kept.
- **Script Entries for `WAYMARK_CAPN_EXECUTABLE` (`src/capnAdapter.ts`)**: A `.js`/`.mjs`/`.cjs` path, such as a local capn-hook checkout's `dist/capn.js`, runs with the current Node.
- **Library Exports (`src/index.ts`)**: `memoryStoreDir`, `stateDir`, `ensureStateDir`, `capnStoreArgs`.
- **`WAYMARK_MCP_WARM=0`**: Disables warm-up. `WAYMARK_DISABLE_RESIDENT=1` and `McpServer({ enableDaemon: false })` also disable it. `McpServer({ warmup })` sets the budget programmatically; warm-up is on under `runStdio()` and off for direct `handleMessage()` use.
- **`--root <path>` (`src/mcp/capnIndex.ts`)**: Sets the default tool root for hosts that cannot set a working directory. `waymark mcp --root` now moves the working directory too, so tool calls without `root` use it.

### Fixed
- **Charting Through Symlinked Paths (`src/capnAdapter.ts`)**: capn resolves charted files against its working directory and compares them with `--root`. macOS reports the working directory with symlinks resolved (`/var` → `/private/var`), so an unresolved `--root` made every file look outside the project, and `chart` failed. Waymark now passes the symlink-resolved root both as `--root` and as capn's working directory. It also sends capn repository-relative file paths, including for `bust`.
- **Init Exit Code (`src/cli.ts`)**: `waymark init` and `waymark memory init` exited 0 when initialization failed.
- **Hidden Auto-Init Failure (`src/capnAdapter.ts`)**: `publish()` threw `CAPN_STORE_UNINITIALIZED` when its automatic init failed. It now returns the init error.
- **MCP Multi-Symbol Queries Ran capn as codedb (`src/mcp/capnTools.ts`)**: `waymark_ask` with `symbols` passed `capn_executable` / `WAYMARK_CAPN_EXECUTABLE` to codedb, so setting either broke multi-symbol queries (`spawn EFTYPE`).

### Tests
- `test/stateDir.test.ts`: a foreign `.capn` store stays byte-identical across init, chart, ask, list, context, bust, prune, unchart, path cache, and telemetry; `.capn` is never created; the bundled fork honors `--store-dir`; a capn without the flags is refused before it touches disk; `.waymark/.gitignore` is written once.
- Removed the unused `test/capnHarness.mjs`.
- `test/auditRemediation.test.ts`: path discovery skips `.codedb/`, `.codedb-core/` and `.capn-hook/`.
- `test/mcpStdioStartup.test.ts`: no indexing at startup, tool call answered while its root's warm-up never finishes, late warm-up stopped after EOF, `--root`, per-root memoization, file budget, opt-out, root cap and `close()`.
- `test/discoveryRouter.test.ts`: bounded walk matches `collectRepoPaths` and stops on file, time, and abort limits.

---

## [3.1.0] - 2026-10-16

### Added
- **MCP `2026-07-28` Result Compliance (`src/mcp/server.ts`)**: Every result now carries `resultType: "complete"` and identifies the server in `_meta["io.modelcontextprotocol/serverInfo"]`. `CacheableResult` methods (`server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/read`) carry `ttlMs` and `cacheScope`. Earlier-revision clients ignore the extra fields.
- **Per-Request Protocol Version Guard (`src/mcp/server.ts`)**: Requests whose `_meta["io.modelcontextprotocol/protocolVersion"]` is unsupported fail with `UnsupportedProtocolVersionError` (`-32022`, `data: { supported, requested }`). `server/discover` and `initialize` still answer so clients can renegotiate.

### Fixed
- **MCP Clients Rejected `tools/list` (`src/mcp/server.ts`)**: `server/discover` advertised `2026-07-28`, so clients such as Claude Code negotiated that revision and then rejected `tools/list` for missing `resultType`. The server connected with no tools.
- **Stdio Handshake Blocked on Daemon Warm-Up (`src/mcp/server.ts`)**: `runStdio` awaited resident-daemon warm-up (codedb `tree` plus prefix-trie walk over the working directory) before reading stdin. Launched from a large folder such as the home directory, the server never answered `initialize`. Stdin is now wired first and warm-up runs in the background.
- **Implicit Warm-Up Scope (`src/mcp/server.ts`)**: The MCP server only warms the resident daemon in project roots (`.git` or `.capn`), never the home directory or a filesystem root. A daemon whose warm-up finishes after stdin closes is stopped so the process exits.
- **Stale `serverInfo.version` (`src/mcp/server.ts`, `src/mcp/capnIndex.ts`)**: Reported `2.7.3`; now read from `package.json`.

### Tests
- `test/mcpStdioStartup.test.ts`: handshake while warm-up never finishes, late warm-up after EOF, project-root gate, reported version.
- `test/mcpProtocol.test.ts`: `resultType` and `serverInfo` on every result, cache hints on cacheable results only, `-32022` for unsupported versions.

---

## [3.0.0] - 2026-10-14

### Changed (Breaking Architecture Milestone)
- **Tier 1 Native In-Process WASM AST Engine (`src/astExtractor.ts`)**: Migrated single-file structural outline extraction from child-process `codedb outline` execution to sub-millisecond in-process `web-tree-sitter` WASM evaluation across 9 major compiled and scripting languages:
  - Rust (`.rs` via `tree-sitter-rust.wasm`)
  - Go (`.go` via `tree-sitter-go.wasm`)
  - Java (`.java` via `tree-sitter-java.wasm`)
  - C (`.c`, `.h` via `tree-sitter-c.wasm`)
  - C++ (`.cpp`, `.hpp`, `.cc`, `.cxx` via `tree-sitter-cpp.wasm`)
  - Ruby (`.rb` via `tree-sitter-ruby.wasm`)
  - Swift (`.swift` via `tree-sitter-swift.wasm`)
  - Kotlin (`.kt` via `tree-sitter-kotlin.wasm`)
  - PHP (`.php` via `tree-sitter-php.wasm`)
  - *Zero Child Process Overhead*: Single-file outline queries (`waymark ask --outline --path <file>`) now resolve in `<3ms` with exact line and column coordinates, reserving `codedb` child-process invocation strictly for multi-hop repo-wide call graphs (`waymark ask "<symbol>"`).
  - *Fail-Safe Secondary Guard*: Retains `codedb outline` fallback if an in-process WASM grammar fails to load in a host environment.

### Added
- **Modern Systems & Enterprise Language Support (`src/astExtractor.ts`)**:
  - **C# (`.cs` via `tree-sitter-c_sharp.wasm`)**: Full .NET single-file intelligence extracting classes, records, interfaces, structs, enums, methods, constructors, properties, and namespaces.
  - **Scala (`.scala` via `tree-sitter-scala.wasm`)**: Extracts classes, objects, traits, and method definitions.
  - **Lua (`.lua` via `tree-sitter-lua.wasm`)**: Extracts global, local, and table/method functions.
  - **Zig (`.zig` via `tree-sitter-zig.wasm`)**: Extracts functions (`fn_proto`/`fn_decl`), structs, and enums.
  - **Elixir (`.ex`, `.exs` via `tree-sitter-elixir.wasm`)**: Extracts modules (`defmodule`/`defimpl`), functions (`def`/`defp`), and protocols (`defprotocol`).
  - **Solidity (`.sol` via `tree-sitter-solidity.wasm`)**: Extracts smart contracts, interfaces, libraries, constructors, functions, and modifiers.
- **Expanded Symbol Taxonomy (`src/types.ts`, `src/astExtractor.ts`)**: Added `record`, `constructor`, `property`, and `contract` symbol kinds to represent rich object-oriented and smart-contract constructs accurately.

### Fixed
- **Dart ABI Incompatibility Isolation (`src/astExtractor.ts`, `test/symbolDiscovery.test.ts`)**: Detected and cleanly isolated Tree-sitter ABI version 15 incompatibility in `tree-sitter-dart.wasm` with `web-tree-sitter@0.24.0` (range 13–14), failing closed with typed `UNSUPPORTED_LANGUAGE` rather than crashing the Node runtime.
- **Windows CRLF Test Fixture Warning Suppression (`test/symbolDiscovery.test.ts`)**: Enforced `git config core.safecrlf false` across all temporary test repositories, eliminating noisy line-ending conversion notices on Windows.

---

## [2.8.0] - 2026-10-14

### Added
- **Grammar Dispatcher Router (`src/astExtractor.ts`)**: Implemented a multi-engine structured discovery router with dedicated parsers for programming languages, structured configuration formats, shell scripts, and documentation files.
- **Native Markdown AST Extraction via `markdown-it` (`src/astExtractor.ts`)**: Supported `.md`, `.markdown`, and `.mdx` single-file outline extraction using a monotonic AST stack to emit section, heading, and code block coordinates without raw whole-file reads.
- **Expanded Tree-Sitter WASM Grammars (`src/astExtractor.ts`)**: Added bundled WASM support for JSON (`.json`), TOML (`.toml`), YAML (`.yaml`, `.yml`), and Bash (`.sh`, `.bash`, `.zsh`).
  - *JSON*: Decodes escaped and unicode property keys for high-fidelity coordinate matching.
  - *TOML*: Emits distinct coordinates for array-of-tables (`[[plugins]]`) headers and nested key-value pairs.
  - *YAML*: Handles multi-document streams, flow mappings, and scalar structures with a recursion depth guard.
  - *Bash*: Extracts functions, exported routines, and command structures.
- **Cross-Platform Tree-Sitter WASM Patch (`scripts/patch-web-tree-sitter.cjs`)**: Added automated postinstall patching for `web-tree-sitter` allocator symbols (`_Znwm`, `_ZdlPv`) to resolve cross-platform C++ scanner panics on Windows, macOS, and Linux.
- **Outline Query Mode in CLI & MCP (`src/cli.ts`, `src/mcp/capnTools.ts`, `src/renderPlainText.ts`)**: Added `--outline` flag and MCP tool support to discover file structural outlines with optional query filtering and plain-text table rendering.

### Fixed
- **Dialect Boundary Clean Rejection (`src/astExtractor.ts`, `test/symbolDiscovery.test.ts`)**: Rejects unsupported dialects such as JSONC and JSON5 cleanly with typed `UNSUPPORTED_LANGUAGE` rather than misinterpreting comment syntax or failing silently.
- **Parser Cleanup & Resource Safety (`src/astExtractor.ts`)**: Explicitly invokes `parser.delete()` and tree deletion in discovery error/completion lifecycle to prevent WASM heap leaks during long-running agent workflows.

---

## [2.7.3] - 2026-10-12

### Added
- **In-Process Tree-Sitter JavaScript & TypeScript Module AST Extraction (`src/astExtractor.ts`)**: Enabled bundled `tree-sitter-javascript.wasm` for `.js`, `.jsx`, `.mjs`, and `.cjs` files and `tree-sitter-typescript.wasm` for `.mts` and `.cts` files in `STRUCTURED_EXTENSIONS`. Extracts classes, methods, functions, and arrow/function expressions with exact line/column spans while filtering out local variable/constant noise.
- **Polyglot Language Support & Tier Fallback Documentation (`docs/architecture.md`, `README.md`)**: Documented the exact language boundaries across Tier 1A (`web-tree-sitter`), Tier 1B (`@paragon-ux/codedb-core`), and language-agnostic Tiers 2–4 (`PrefixTrie`, `fzf`, and `.capn` BM25 consensus memory).

### Fixed
- **Fail-Closed Unsupported Language Boundary (`src/astExtractor.ts`, `test/symbolDiscovery.test.ts`)**: Removed unsupported `.cs` and `.scala` extensions from `CODEDB_OUTLINE_EXTENSIONS` and enforced a fail-closed `UNSUPPORTED_LANGUAGE` guard when `codedb outline` reports `language: "unknown"`, preventing silent `0 symbols` false positives.

---

## [2.7.2] - 2026-10-12

### Process Safety, Discovery Correctness, and Repository Integrity

Version 2.7.2 hardens daemon shutdown and dashboard safety, improves discovery and semantic-memory accuracy, and makes repository boundaries, evaluation, and query telemetry more reliable.

### Fixed
- **Daemon Process Safety (`src/daemon.ts`)**:
  - Forced shutdown no longer signals a process based only on PID-file contents; it uses the root-specific daemon IPC endpoint and fails safely when daemon identity cannot be established.
- **Semantic Memory Relevance (`src/capnAdapter.ts`, `src/discoveryRouter.ts`)**:
  - Lexical matches without topical evidence are not returned as successful answers, while relevant memory results remain available.
- **Evidence-Backed Map Bootstrap (`src/semanticMap.ts`)**:
  - Bootstrap returns source-grounded excerpts as unverified drafts; it does not publish unsupported architectural claims as validated facts.
- **Semantic Map Guidance (`src/semanticMap.ts`, `src/discoveryRouter.ts`)**:
  - Uninitialized stores now direct users to `waymark memory init`; bootstrap is described as draft collection that requires verification and explicit charting.
- **Live Dashboard Exposure (`src/repl.ts`)**:
  - The observer requires telemetry opt-in, binds to loopback, and requires a random per-session token on the dashboard and telemetry endpoints. Host and Origin checks reject cross-origin access, and CSP blocks framing; no remote mode is supported.
- **Dashboard HTML Injection (`src/viewer.html`)**:
  - Untrusted telemetry values are rendered as text and cannot inject markup or alter the dashboard structure.
- **Anchor Integrity (`src/integrity.ts`)**:
  - Stored ranges and span contents are validated before an anchor is considered fresh, even when the whole-file hash matches.
- **Semantic Map Path Containment (`src/paths.ts`, `src/semanticMap.ts`, `src/capnAdapter.ts`)**:
  - Facet backing files are constrained to the selected repository, including traversal and symlink cases, across validation, status, publishing, bootstrap, CLI, MCP, and public API paths.
- **Prompt Evaluator Contracts (`src/evaluator.ts`)**:
  - Declared steps and expectations are executed and checked; unsupported operations fail explicitly, and results and exit status reflect actual execution.
- **Windows Codedb Executable Contract (`src/executable.ts`, `src/codedbAdapter.ts`, `src/residentCodedb.ts`)**:
  - Configure `WAYMARK_CODEDB_EXECUTABLE` with a native `.exe`; Windows `.cmd` and `.bat` shims are rejected with typed errors in cold and resident paths, with no shell interpolation.
- **Codedb Infrastructure Errors (`src/codedbAdapter.ts`, `src/astExtractor.ts`, `src/discoveryRouter.ts`)**:
  - Missing executables, timeouts, and process failures remain infrastructure errors instead of being reported as symbol misses.
- **Subsystem Scope Contract (`src/semanticMap.ts`, `src/capnAdapter.ts`, `src/discoveryRouter.ts`, `src/cli.ts`, `src/mcp/capnTools.ts`)**:
  - Unsupported filesystem-scoped subsystem operations return explicit errors instead of silently returning repository-wide results.
- **Hidden-Directory Discovery (`src/paths.ts`)**:
  - Legitimate hidden project directories such as `.github` and `.vscode` are discoverable while internal metadata and runtime directories remain excluded.
- **Filename Validation (`src/paths.ts`)**:
  - Valid names beginning with `..`, including `..valid.ts`, are accepted while actual path escapes are rejected.
- **Fuzzy Matching (`src/fuzzyMatcher.ts`)**:
  - Scoring and traceback now agree on highlighted match positions and preserve deterministic ordering across repeated characters, gaps, and boundaries.
- **Repository Root Identity (`src/daemon.ts`, `src/discoveryRouter.ts`, `src/residentCodedb.ts`)**:
  - Case-distinct repository roots remain distinct on case-sensitive filesystems across daemon addresses, registry keys, and resident-client keys.
- **Candidate Cache Bounds (`src/codedbAdapter.ts`)**:
  - Expired entries are evicted and cache size is capped to bound memory use under many distinct query keys.
- **Multi-Symbol Accounting (`src/codedbAdapter.ts`)**:
  - Duplicate and empty symbol names produce consistent result maps, hit/miss counts, status, and totals while preserving empty-input behavior.
- **Prompt Catalogue Fixture (`docs/prompts/CATALOGUE_MANIFEST.jsonl`, `src/evaluator.ts`)**:
  - The `10-04` package-header case checks its intended anchor freshness behavior, and declared route, file, and anchor expectations are evaluated.

### Changed
- **Query Telemetry Privacy (`src/sessionLogger.ts`, `src/repl.ts`)**:
  - Persistent query and session logging is disabled by default and requires `WAYMARK_TELEMETRY=1`; the live observer follows the same opt-in policy.
- **Request-Scoped Daemon Selection (`src/capnAdapter.ts`, `src/discoveryRouter.ts`, `src/codedbAdapter.ts`)**:
  - Daemon selection is passed through request-scoped options rather than mutating process-wide environment variables.
- **Query Latency Telemetry (`src/discoveryRouter.ts`, `src/sessionLogger.ts`)**:
  - Ordinary queries record elapsed time even when diagnostic timing is disabled; persisted logging remains subject to telemetry opt-in.


## [2.7.1] - 2026-10-11

### Process Eviction Cleanup, Ambiguous Basename Collision Diagnostics, Read-Only Guard, and Lexical Consensus Recall

Version 2.7.1 is a hotfix release resolving background daemon process eviction, multi-path basename collision diagnostics, read-only cache guards, and deterministic lexical recall.

### Fixed
- **Resident Process Eviction Race (`src/residentCodedb.ts`)**:
  - Replaced asynchronous close with atomic synchronous `closeSync()` on LRU eviction to prevent process overlap and file lock race conditions on Windows.
  - Tuned default idle timeout from 120s to 60s for faster resource recovery.
- **Ambiguous Basename Collision Diagnostics (`src/discoveryRouter.ts`, `src/types.ts`)**:
  - When queries target bare basenames shared by multiple distinct files in the repository, returns structured `AMBIGUOUS_PATH_COLLISION` diagnostic listing candidates and prompting explicit relative paths.
- **Read-Only Invariant Enforcement (`src/discoveryRouter.ts`)**:
  - Guarded path crawler cache writing with `if (process.env.WAYMARK_READ_ONLY !== "1")` to guarantee zero disk mutations in read-only analysis sessions.
- **Deterministic Lexical Consensus Recall (`src/capnAdapter.ts`)**:
  - Added exact normalized H1 question matching against `.capn/entries/*.md` before BM25 fallback, ensuring deterministic 100-score recall for previously charted questions.

## [2.7.0] - 2026-10-08

### Zensical Documentation Portal, GitHub Pages Workflow, Executive README Alignment, and Glama Registry Schema

Version 2.7.0 launches the official **Zensical Documentation Site** with GitHub Pages automated deployment, declutters and aligns `README.md` and npm package metadata, and adds first-class Glama MCP registry discovery.

### Added
- **Zensical Documentation Portal (`zensical.toml`, `docs/`)**:
  - Structured static doc portal configured with Material theme, instant navigation, dark/light palette toggle, search index, and Mermaid diagrams.
  - Comprehensive documentation suite: Overview (`docs/index.md`), Getting Started (`docs/getting-started.md`), 4-Tier Architecture (`docs/architecture.md`), Model Context Protocol (`docs/mcp.md`), CLI & Command Registry (`docs/commands.md`), Empirical Benchmarks (`docs/benchmarks.md`), and Library API & Integrity Primitives (`docs/library-api.md`).
- **GitHub Pages CI/CD Workflow (`.github/workflows/docs.yml`)**:
  - Automated deployment workflow building Zensical docs and deploying to GitHub Pages (`https://paragon-ux.github.io/waymark-engine/`).
- **Glama MCP Schema (`glama.json`)**:
  - Root `glama.json` schema declaring `https://glama.ai/mcp/schemas/server.json` and `maintainers: ["paragon-ux"]` for discovery on Glama.
  - Added `glama.json` to npm package `files` manifest.
- **Executive README & Metadata Refresh (`README.md`, `package.json`)**:
  - Streamlined `README.md` from 293 to 112 lines, adding purple Zensical docs badge and live REPL observer guide.
  - Aligned `package.json` description with the primary code intelligence thesis.

## [2.6.0] - 2026-10-08

### Standalone Web Live Viewer, SSE Telemetry Streaming, and Decoupled Viewport-Locked UI

Version 2.6.0 introduces the **Standalone Web Live Viewer** (`waymark repl --live --port <port>`), real-time Server-Sent Events (SSE) telemetry streaming, a decoupled HTML dashboard template, and a principled viewport-locked flexbox layout with single internal scrollbar and default 125% zoom.

### Added
- **Web Live Monitor & SSE Telemetry Stream (`src/repl.ts`, `src/viewer.html`)**:
  - Embedded zero-dependency HTTP server via `node:http` on configurable port (`--port <num>`, default `4141`, or `WAYMARK_LIVE_PORT`).
  - Real-time Server-Sent Events (SSE) `/events` broadcast streaming query events (`event: query`) and live session metrics (`event: stats`).
  - Programmatic session telemetry summary endpoint `GET /api/stats`.
- **Decoupled Standalone UI Template (`src/viewer.html`)**:
  - Extracted UI template into standalone [`src/viewer.html`](src/viewer.html) with automated build asset synchronization to `dist/src/viewer.html`.
  - Implemented viewport-locked flexbox app-shell with `html, body { overflow: hidden; }` and flex item height constraints, ensuring zero dual/nested scrollbars across any viewport dimensions.
  - Default $125\%$ zoom scaling paired with root typography scaling (`html { font-size: 125%; }` and `body { zoom: 125%; }`) for crisp readability on high-DPI displays.
- **Exported Telemetry Aggregators (`src/repl.ts`)**:
  - Exported `formatLiveEvent`, `computeSessionStats`, `formatSessionSummary`, and `getLiveDashboardHtml` for modular programmatic and testing consumption.

## [2.5.0] - 2026-09-29

### Live REPL Observer, Process LRU Pooling, Monorepo Hardening, and Polyglot AST Outline

Version 2.5.0 delivers the **Live REPL Agent Observer (`waymark repl --live`)**, real-time persistent telemetry logging, resident codedb child-process LRU pooling with automatic cleanup, monorepo cold-start deadline protection, disambiguated multi-symbol ranking, and expanded polyglot AST kinds.

### Added
- **PDLt-Style Live Agent Monitor (`waymark repl --live`, `src/repl.ts`, `src/sessionLogger.ts`)**:
  - Live ANSI observer dashboard tailing agent tool executions from an append-only persistent NDJSON telemetry log (`.waymark/sessions/active.jsonl`).
  - Displays query, caller source (`MCP` or `CLI`), tier traversal, matched symbols/paths with fzf score, prompt payload tokens vs. full-file equivalent, and token savings percentage (consistently 92–96% token savings).
  - Interactive terminal controls: `q` to quit, `c` to clear screen, and `s` for cumulative session telemetry metrics (hit rate, query latency average, tokens consumed vs. saved).
- **LRU Resident Codedb Pool & Process Lifecycle Defense (`src/residentCodedb.ts`)**:
  - Enforces strict concurrent resident client limits (`MAX_RESIDENT_CLIENTS`, default 2, configurable via `WAYMARK_MAX_RESIDENT_CLIENTS`), preventing lingering background `codedb-win32-x64.exe` processes across multiple workspaces.
  - Strict total-order monotonic LRU eviction sequencing and synchronous hard-kill cleanup (`SIGKILL` + Windows `taskkill /pid <pid> /f /t`).
  - Added `evict` and `close` actions to `waymark_memory` (and CLI `waymark memory evict [root] [--all]`).
- **Universal CLI `--root` and `--session` Flags (`src/cli.ts`)**:
  - Added `--root <path>` flag across all CLI commands (`ask`, `memory`, `symbols`, `daemon`, etc.) ensuring full parity with the MCP `root` argument when querying external workspaces.
  - Added `--session <path>` flag to point the live REPL observer to arbitrary session logs.

### Fixed & Improved
- **Monorepo Cold-Start Deadline Protection (`src/codedbAdapter.ts`, `src/residentCodedb.ts`)**:
  - Lowered default codedb execution timeout from 180s to 45s and idle inactivity timeout from 300s to 120s (`WAYMARK_IDLE_TIMEOUT`), with immediate fail-closed protection to prevent compounding 3-minute MCP client transport deadlines on massive monorepos like Grafana.
- **Disambiguated Multi-Symbol Definition Ranking (`src/codedbAdapter.ts`)**:
  - Upgraded `queryMultiSymbols` candidate selection to prioritize canonical non-test definitions (`src/`, `lib/`, exact case matching, definition kinds) over test/benchmark suites, correctly resolving `BaseModel` in Pydantic to `pydantic/main.py:136` instead of `benchmarks/test_complex.py`.
- **Polyglot AST Outline Kinds & Windows Line Endings (`src/astExtractor.ts`)**:
  - Expanded `StructuredSymbolKind` to include `struct`, `enum`, `trait`, `import`, `constant`, and `variable` for Rust, Go, and C/C++ fallback paths.
  - Stripped trailing CRLF `\r` line endings from symbol names and details across Windows.
- **Fail-Closed Conceptual Routing & Narrative Entrypoints (`src/discoveryRouter.ts`)**:
  - Upgraded AST intent detection to recognize narrative entrypoint queries (`"What is the main entry point?"`) and route directly to repository topology.
  - Added fail-closed guardrail for broad narrative/conceptual questions (`"How does the sandbox work?"`), returning clean `NO_CHARTED_MEMORY` guidance with instructions to chart consensus memory, rather than hallucinating random fuzzy matches.

---

## [2.4.1] - 2026-09-28

### Developer Experience Polish, MCP Tool Parity, and Standalone Wrapper Binaries

Version 2.4.1 delivers Developer Experience (DX) hardening, standalone binary wrappers, granular MCP tool parity, and cross-platform path normalization.

### Added
- **Empirical Parity Benchmark Suite vs. Aider Repo Map (`spec/aider-parity-benchmark.md`, `benchmarks/suites/run_aider_parity_benchmark.mjs`)**:
  - Executed a live empirical benchmark against `openai/gpt-oss-120b` (`reasoning: low`, temperature: 0.0) via OpenRouter to evaluate context retrieval efficiency without cherrypicking.
  - **Track A (Syntactic Locate & Edit)**: Steelmanned Aider advantage verified (1 turn, 758ms, 416 tok vs 2 turns, 1,292ms, 367 tok). Aider's passive repo map enabled a 1-shot edit on `DaemonOptions` without an initial tool call.
  - **Track B (Architectural Refactor & Invariants)**: Waymark advantage verified. Aider's naked AST signatures caused the model to hallucinate an imaginary *"per-process bust token with `crypto.randomBytes`"*. Waymark's `[FACET:INVARIANTS]` consensus retrieval grounded the model in actual path normalization and fail-closed error contracts with **0% semantic hallucination**.
  - **Multi-Turn Economy (10-Turn Task)**: Waymark reduced prompt token consumption from 2,700 tokens (Aider's continuous passive re-injection) down to 196 tokens (Waymark's on-demand plain-text retrieval) — a **92.7% token reduction**.
- **Standalone Binary Wrappers (`waymark-bootstrap`, `waymark-map`)**:
  - Added dedicated CLI wrapper stubs `bin/waymark-bootstrap.mjs` and `bin/waymark-map.mjs` mapped into `package.json["bin"]`, enabling direct invocation via terminal or `npx` alongside the unified `waymark` CLI.
- **Granular MCP Tool `waymark_map_status` (`src/mcp/capnTools.ts`)**:
  - Implemented and registered `waymarkMapStatusTool` in `WAYMARK_TOOLS` (12 tools total in granular mode), providing direct backward-compatible map health inspection.

### Fixed
- **Cross-Platform Path Normalization (`src/capnAdapter.ts`)**:
  - Normalized all file citations and cache-busting lookups to forward slashes across POSIX and Windows, preventing backslash mismatches during `bust` and anchor verification.
- **Two-Verb MCP Default Alignment**:
  - Aligned MCP server default behavior and `spec/command-registry.md` documentation: Two-Verb Canonical Interface is active by default (<450 tokens prompt load), while flat Granular Interface is opt-in via `WAYMARK_MCP_VERBOSE=1`.
- **Repo-Native Quickstart Examples**:
  - Replaced fictional fuzzy matching targets with repository-native identifier `"verfyHop"` across `README.md` and `AGENTS.md`, providing live demonstration of the Discovery Junction matching `verifyHop in src/integrity.ts:66 (score: 87)`.

---

## [2.4.0] - 2026-09-28

### Semantic Repo Map, Frontloaded Consensus Bootstrap, and Two-Verb Canonical Model

Version 2.4.0 introduces the **Semantic Repo Map**, establishing frontloaded architectural consensus memory for repositories with zero passive prompt token overhead. Solves the cold-start defect of Tier 4 consensus memory, introduces the consolidated **Two-Verb Canonical Model** (`waymark_ask` for universal read discovery, `waymark_memory` for universal consensus writing), guarantees 100% preservation of all existing commands and tier isolation, and reduces MCP prompt token load by up to ~87% (<450 tokens).

### Added

- **Semantic Repo Map ("The Waymark 5") (`src/semanticMap.ts`)**:
  - Categorizes repository architecture into 5 canonical facets:
    1. `FACET_LIFECYCLE` (`lifecycle`): Executable entrypoints, daemon lifecycles, and bootstrapping sequences.
    2. `FACET_DATA_STATE` (`data_state`): Data flow, persistence models, disk sync, and caches.
    3. `FACET_BOUNDARIES` (`boundaries`): Inter-process boundary protocols (Named Pipes, Unix Sockets), RPC, and external bridges.
    4. `FACET_INVARIANTS` (`invariants`): Chesterton's fences, path normalizers, and security/OS execution constraints.
    5. `FACET_FAILURE` (`failure`): Fail-closed miss policy, error registries, and degraded mode recovery.
  - **Single SQLite Consensus Ledger Parity**: Facets live directly inside the existing `.capn` FTS5 SQLite store with zero auxiliary JSON/markdown manifest files. Agents interact purely via API, CLI, or MCP tools without reading internal engine documents.
  - **Two-Pass Bootstrapping (`bootstrapSemanticMap`, `waymark memory bootstrap`, `waymark bootstrap`)**: Harvests project layout and metadata, queries AST to verify symbols, formulates bounded answers ($\le 100$ tokens), and charts them directly into SQLite consensus memory.
  - **Health & Drift Inspection (`getSemanticMapStatus`, `renderSemanticMapStatus`)**: Instant inspection of map completion (e.g. `5/5 Facets Active`), missing facets, and backing file drift in token-minimal plain text (~25 tokens) or full JSON.
  - **Anti-Hallucination Guardrail #1**: Enforces that every active facet cites $\ge 1$ repository files verified to exist on disk via `fs.existsSync`. Pure descriptive essays without code citations are strictly rejected with typed `INVALID_BACKING_FILES` errors. Supports `status: not_applicable` protocol for irrelevant architectural domains.
- **Two-Verb Canonical Model (`waymark_ask` & `waymark_memory`)**:
  - **Read Surface (`waymark_ask` / `waymark ask`)**:
    - Universal discovery query supporting `question` / `query`, `symbols` (batch), `path` (single-file AST outline discovery), and `facet` (`lifecycle` | `data_state` | `boundaries` | `invariants` | `failure` | `status`).
    - Querying `--facet status` emits the Semantic Repo Map health report.
    - Querying `--facet <name>` routes and prioritizes lexical BM25 retrieval to documents tagged with `[FACET:<NAME>]`.
    - Querying `--path <file>` without a question extracts structured Tree-Sitter AST symbols (Mode A) in ~120 tokens.
  - **Write Surface (`waymark_memory` / `waymark memory`)**:
    - Universal consensus ledger manager consolidating actions: `bootstrap`, `status`, `chart`, `heal`, `export`, `bust`, `prune`, `list`, `unchart`, `init`, `context`.
    - Added `action: "heal"` to reconcile Semantic Repo Map anchors against modified source lines.
    - Added `action: "export"` to serialize SQLite consensus memory to Markdown or JSON.
    - Auto-tags architectural facets (`[FACET:<NAME>]`) and enforces the Anti-Hallucination Guard.
- **Two-Verb MCP Default (<450 Tokens)**:
  - `McpServer` now defaults to `canonicalOnly: true`, advertising strictly the 2 canonical tools (`waymark_ask` and `waymark_memory`) out of the box. Eliminates ~3,000 tokens of tool schema bloat from every agent prompt turn.
  - Zero client configuration required; optional `"WAYMARK_MCP_VERBOSE": "1"` available if users explicitly require the legacy 11 granular tools in `tools/list`.
  - Registered new `bootstrap-semantic-map` prompt in `CAPN_PROMPTS` for guided repository onboarding.
  - Full backwards compatibility: all 11 tools remain registered in the dispatch table, ensuring legacy MCP tool calls succeed seamlessly.
- **Cross-Platform Path Normalization (`src/capnAdapter.ts`)**:
  - Normalized all file citations and cache-busting lookups to forward slashes across POSIX and Windows, preventing backslash mismatches during `bust` and anchor verification.
- **CLI Commands & Extensions (`src/cli.ts`)**:
  - Added `waymark memory <action>` with full subcommand options (`--question`, `--answer`, `--facet`, `--files`, `--file`, `--id`, `--if-exists`, `--dry-run`, `--subsystem`).
  - Added `waymark bootstrap [--dry-run] [--subsystem <name>]`.
  - Added `waymark map [status|show|heal|export] [--format md|json]`.
  - Enhanced `waymark ask` with `--facet <name>` and `--path <file>`.
  - Upstream structural engine updated to `@paragon-ux/codedb-core` `v1.1.0`.
- **Comprehensive Integration Test Suite (`test/semanticRepoMap.test.ts`)**:
  - Expanded test battery to 67 unit/integration tests with full coverage for anti-hallucination backing file verification, two-pass bootstrapping, MCP `waymark_memory` actions (including `heal`, `export`, `bust`), MCP `waymark_ask` facet addressing and path outline extraction, and tier isolation invariance.

### Invariants Maintained

- **100% Command Functionality & Tier Isolation Preserved**: Every CLI command, subcommand, flag, and explicit wrapper remains functional. Forcing individual tiers (`-t ast`, `-t path`, `-t fuzzy`, `-t capn`) remains fully operational across CLI, MCP, and API.
- **Zero Passive Token Overhead**: 0 tokens injected into agent prompt contexts until queried on demand.

---

## [2.3.1] - 2026-09-28

### Testing-First Architecture, Dev Mode, Repository Standardization, and Glama Registry Discovery

Version 2.3.1 introduces an in-house Testing-First operational framework featuring a dedicated Dev Mode (`--dev`), internal mechanized regression tracking (`docs/governance/regressions-log.jsonl`), standardized operational prompt batteries, repository benchmark directory standardization, and complete Glama-AI MCP discovery alignment.

### Added

- **Waymark Dev Mode (`--dev`)**:
  - Added `--dev` CLI flag and `dev: boolean` parameter to MCP `waymark_ask` and `waymark_daemon_status`.
  - Surfaces deep diagnostic telemetry: per-tier execution timing breakdown, PrefixTrie hit type (`exact`, `basename`, `suffix`), and daemon IPC roundtrip vs in-process scanning.
  - Live runtime invariant assertions: asserts multi-hop visited node cap $\le 50$, path containment, and test noise suppression.
- **Interactive REPL Shell & Live Diagnostic Driver (`src/repl.ts`, `bin/waymark-repl.mjs`)**:
  - Implemented `waymark repl` (binary: `waymark-repl`) with live resident daemon connectivity, auto-launching background daemon if offline.
  - Interactive Node readline interface supporting `ask`, `symbols`, `discover`, `anchor`, `verify-anchor`, `baseline`, `compare`, `manifest`, `daemon`, `dev`, `plain`, and scripted driver execution (`--file <script>`).
  - Added comparative searcher (`src/baselineSearch.ts`) providing zero-dependency lexical regex search and `git grep` benchmarking, computing speedup factor, noise reduction ratio, and token compression metrics.
- **Hardened Live Prompt Evaluation Battery (`docs/prompts/CATALOGUE_MANIFEST.jsonl`, `src/evaluator.ts`)**:
  - Authored a comprehensive 15-category, 105-prompt evaluation suite with live validation across AST traversal, PrefixTrie, multi-symbol batching, fail-closed boundaries, line drift tracking ($\Delta$ offset), tamper evidence (`anchorForRange` SHA-256 span verification), token pressure, and Discovery Junction consensus.
  - Added mechanized operator classification (`SUCCESS`, `ENGINE_FAIL_CLOSED_MISS`, `ENGINE_MISROUTING`, `SYNTAX_ERROR`, `TIMEOUT`).
- **Internal Testing & Governance Infrastructure (`docs/`)**:
  - Added gitignored internal documentation framework inspired by PDLt governance.
  - Initialized mechanized failure ledger (`docs/governance/regressions-log.jsonl`) recording failure types, problem statements, and type solutions.
  - Published ADR-0001 (Testing-First Live Run Requirements & Dev Mode), ADR-0002 (System 1 Determinism vs System 2 Consensus Disciplines), and ADR-0003 (Interactive REPL & Hardened Live Battery Execution).
- **Benchmark Directory Standardization (`benchmarks/`)**:
  - Promoted benchmark suites from disposable `scratch/benchmarks/` into a first-class, Git-tracked top-level `benchmarks/` directory.
- **Glama-AI Registry Discovery**:
  - Added `"modelcontextprotocol"` to `package.json` keywords.
  - Overhauled `README.md` MCP snippet with standard `npx -y waymark-engine` container configuration and `CODEDB_ALLOW_TEMP=1`.
  - Documented all 10 canonical MCP tools (`waymark_*`), 2 resources, and 2 prompts.

### Changed

- Updated `README.md` tagline to emphasize optional resident daemon for sub-millisecond warm lookups.
- Updated `README.md` test badge to `60/60 passing`.
- Clarified routing contract: removed false claim that queries silently fall through to semantic memory on codedb misses; documented fail-closed Discovery Junction behavior.
- Added Polyglot Parser Fallback matrix and demarcated tamper-evidence integrity primitives (`verifyHop`, `anchorForRange`).

---

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
- **Reusable External Stress Benchmark (`benchmarks/suites/benchmark_arrow_and_pydantic.mjs`)**:
  - End-to-end automated stress benchmark testing Apache Arrow (5,335 polyglot files) and Pydantic (851 Python/Rust files), exporting structured metrics to `benchmarks/benchmark_results/arrow_and_pydantic_results.json`.

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
