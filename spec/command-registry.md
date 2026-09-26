# Waymark Engine Command & Interface Registry

**Document Identifier**: `command-registry`  
**Classification**: Authoritative System Specification  
**Version**: 2.0.0  
**Scope**: Public CLI binaries, CLI flags, MCP server tools, programmatic library exports, and internal discovery operations.

---

## 1. Registry Overview & Stability Lifecycle

Interfaces across the Waymark Engine are categorized into three stability tiers:

| Tier | Lifecycle Guarantee | Breaking Change Policy |
| :--- | :--- | :--- |
| **Public / Stable** | Fully supported for external CLI callers, agents, and library consumers. | Subject to semantic versioning (major bump only). Backwards-compatible within v2.x. |
| **Experimental** | Subject to change based on benchmark evaluation and community feedback. | May change or be deprecated in minor releases with deprecation warnings. |
| **Internal** | Implementation details for internal subsystems and adapters. | No stability guarantee; private to repository boundaries. |

---

## 2. CLI Command Registry

Waymark Engine provides both a unified binary (`waymark <command>`) and explicit single-purpose wrappers (`waymark-<command>`). The explicit wrappers avoid subcommand dispatch overhead and provide clean process boundaries for agent automation.

### 2.1 Unified CLI & Explicit Executables

| Command / Wrapper | Status | Owning Module | Input Shape / Syntax | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| `waymark ask <question>`<br>`waymark-ask <question>` | **Stable** | [`src/cli.ts`](../src/cli.ts) | Positional string query ($\le 240$ chars), flags (`--tier`, `--depth`, `--direction`, `--plain`, `--timing`, `--daemon`) | Primary discovery entrypoint. Cascades across structural, path, and junction tiers. Supports multi-hop bounded graph traversal. |
| `waymark symbols <sym1> [sym2 ...]`<br>`waymark-symbols <sym1> [sym2 ...]` | **Stable** | [`src/codedbAdapter.ts`](../src/codedbAdapter.ts) | Positional symbol names or `--symbols <a,b>`, `[--plain]` | Batch queries symbol definitions, file locations, and line spans concurrently across the repository without natural language heuristics. |
| `waymark init`<br>`waymark-init` | **Stable** | [`src/capnAdapter.ts`](../src/capnAdapter.ts) | Optional `--capn-executable <path>` | Initializes the deterministic BM25 lexical store in the current repository root. Refuses embeddings. |
| `waymark discover-symbols`<br>`waymark-discover` | **Stable** | [`src/astExtractor.ts`](../src/astExtractor.ts) | `[--path <file>]`<br>`[--query <q>]`<br>`[--language <lang>]`<br>`[--plain]` | Bimodal discovery: single-file structured AST extraction (with codedb outline fallback for non-TS/Py) or repo-wide symbol search. |
| `waymark chart`<br>`waymark-chart` | **Stable** | [`src/capnAdapter.ts`](../src/capnAdapter.ts) | `--question <q>`<br>`--answer <a>`<br>`--files <paths>` | Records consensus ground truth into lexical long-term memory. Decoupled from syntactic query routing. |
| `waymark unchart <id>`<br>`waymark-unchart <id>` | **Stable** | [`src/capnAdapter.ts`](../src/capnAdapter.ts) | Positional entry ID<br>`[--if-exists]` | Removes a specific charted consensus entry from memory. Supports idempotent removal. |
| `waymark bust <path>`<br>`waymark-bust <path>` | **Stable** | [`src/capnAdapter.ts`](../src/capnAdapter.ts) | Positional repository-relative path | Evicts or invalidates charted memory entries referencing a modified or deleted source file. |
| `waymark prune`<br>`waymark-prune` | **Stable** | [`src/capnAdapter.ts`](../src/capnAdapter.ts) | None | Cleans stale entries, defragments SQLite FTS5 indexes, and verifies integrity. |
| `waymark list`<br>`waymark-list` | **Stable** | [`src/capnAdapter.ts`](../src/capnAdapter.ts) | None | Lists all active charted consensus memory entries. |
| `waymark context`<br>`waymark-context` | **Stable** | [`src/capnAdapter.ts`](../src/capnAdapter.ts) | None | Summarizes repository memory state, entry counts, and configuration profile. |
| `waymark mcp`<br>`waymark-mcp` | **Stable** | [`src/mcp/server.ts`](../src/mcp/server.ts) | None (runs over `stdio`) | Launches the standard Model Context Protocol (MCP) server for IDE and agent integration. |
| `waymark daemon [start\|stop\|restart\|reload\|status\|list\|ping\|run]`<br>`waymark-daemon [start\|stop\|restart\|reload\|status\|list\|ping]` | **Stable** | [`src/daemon.ts`](../src/daemon.ts) | Subcommand (`start`, `stop`, `restart`, `reload`, `status`, `list`, `ping`, `run`), `[--path <root>]` | Manages background resident codedb server (`serve --stdio`) and IPC socket/pipe bridge for sub-10ms warm query execution. Supports cache reloading via `reload`. |
| `waymark help` / `-h` / `--help` | **Stable** | [`src/cli.ts`](../src/cli.ts) | None | Outputs brief command options, flags, and environment variable configuration. |

---

## 3. CLI Option & Flag Registry

Options and flags modify discovery routing, execution format, performance instrumentation, and environment overrides.

| Option / Flag | Short | Type | Permitted Values | Default | Target Commands | Stability | Purpose & Behavioral Contract |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `--tier` | `-t` | Value | `auto`, `ast`, `path`, `fuzzy`, `capn` | `auto` | `ask` | **Stable** | Forces execution of a specific discovery tier, bypassing the normal cascade and junction recommendation logic. Enables latency isolation. |
| `--timing` | `-b` | Flag | Boolean | `false` | `ask` | **Stable** | Enables nanosecond-precision execution timing instrumentation across AST, Path, Fuzzy, Capn, and Total elapsed milliseconds. |
| `--plain` | `-p` | Flag | Boolean | `false` | All | **Stable** | Emits compact token-minimal plain text formatted for direct LLM agent ingestion (~16–38 tokens) instead of JSON. |
| `--json` | `-j` | Flag | Boolean | `true` (CLI default) | All | **Stable** | Forces structured JSON payload serialization to stdout. |
| `--auto-resolve` | — | Flag | Boolean | `false` | `ask` | **Stable** | Automatically flattens an inspectable `junction` status into a synthetic `hit` by resolving directly to the top recommendation's result. |
| `--profile` | — | Value | `capn-cli`, `none` | `capn-cli` | `ask`, `chart` | **Stable** | Configures semantic memory backend adapter. `none` disables memory queries without failing. |
| `--capn-executable`| — | Value | Filesystem path | Bundled fork / PATH | `ask`, `chart`, `init`, etc. | **Stable** | Explicit escape hatch to specify an external `capn` binary location. Bundled fork is tested default. |
| `--path` | — | Value | Repository path | None | `discover-symbols`, `daemon` | **Stable** | Target repository-relative (or absolute within root) source file to parse into AST symbols, or target repository root for daemon management. |
| `--query` | `-q` | Value | Symbol name/substring | None | `discover-symbols` | **Stable** | Symbol name filter (for single-file Mode A) or repo-wide symbol discovery search (Mode B). |
| `--symbol` | `-s` | Value | Symbol name/substring | None | `discover-symbols` | **Stable** | Alias for `--query`. |
| `--symbols` | — | Value | Comma-delimited list | None | `symbols`, `ask` | **Stable** | Explicit list of symbol identifiers to query concurrently across the repository. |
| `--language` | — | Value | `typescript`, `python` | Auto from file ext | `discover-symbols` | **Stable** | Explicit parser grammar override when file extension is ambiguous or non-standard. |
| `--question` | — | Value | String ($\le 240$ chars) | None (Required) | `chart` | **Stable** | The ground-truth question being charted. |
| `--answer` | — | Value | String ($\le 4000$ chars) | None (Required) | `chart` | **Stable** | Verified, conclusive architectural answer to commit to memory. |
| `--files` | — | Value | Comma-delimited list | `""` | `chart` | **Stable** | Source file paths associated with the charted answer for cache invalidation tracking. |
| `--if-exists` | — | Flag | Boolean | `false` | `unchart` | **Stable** | Allows idempotent removal of charted entries. If the entry ID was already removed or invalidated by `bust`, exits 0 with a notice instead of failing with exit code 1. |
| `--daemon` | `-d` | Flag | Boolean | `false` | `ask` | **Stable** | Opts in to resident in-memory daemon acceleration. Connects to existing daemon/MCP or starts background daemon if not running. |
| `--exclude-tests` | — | Flag | Boolean | `false` | `ask` | **Stable** | Filter out test files (`*_test.*`, `test/*`, `__tests__/*`, `*.spec.*`) from call graph results to reduce token noise. |
| `--idle-timeout` | — | Value | Integer seconds | `600` | `daemon` | **Stable** | Configures inactivity duration before the resident daemon automatically terminates to free system memory. |
| `--force` | — | Flag | Boolean | `false` | `daemon` | **Stable** | Forces immediate termination of resident daemon via PID kill if graceful IPC shutdown is unresponsive. |

---

## 4. MCP Tool Registry

The resident stdio MCP server (`waymark-mcp`) exposes high-leverage tools for agentic discovery and consensus memory maintenance with full precision parity matching the CLI:

### 4.1 `waymark_ask`
- **Identifier**: `waymark_ask`
- **Stability**: **Stable**
- **Description**: Query repository memory and tiered discovery (AST structural, literal path, deterministic fuzzy, charted consensus) or multi-symbol batches without hallucination.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "question": { "type": "string", "description": "The question to look up." },
      "symbols": { "type": "array", "items": { "type": "string" }, "description": "Optional list of multiple symbol identifiers to inspect concurrently across the AST call graph." },
      "tier": { "type": "string", "enum": ["auto", "ast", "path", "fuzzy", "capn"], "description": "Optional forced discovery tier: auto | ast | path | fuzzy | capn. Defaults to auto." },
      "depth": { "type": "integer", "description": "Call graph traversal depth (1-5) for structural AST queries. Defaults to 1." },
      "direction": { "type": "string", "enum": ["callers", "callees", "both"], "description": "Call graph traversal direction: callers | callees | both. Defaults to both." },
      "exclude_tests": { "type": "boolean", "description": "Optional. Filter out test files (e.g. tests/, *_test.*, *.spec.*) from call graph results to reduce token noise." },
      "auto_resolve": { "type": "boolean", "description": "Collapse junction responses directly to top recommendation. Defaults to true in MCP for agent workflows." },
      "timing": { "type": "boolean", "description": "Collect high-resolution tier execution timing metrics." },
      "plain": { "type": "boolean", "description": "Emit token-minimal plain text formatted result for LLM context efficiency (~16-38 tokens)." },
      "daemon": { "type": "boolean", "description": "Accelerate query via persistent in-memory background daemon IPC." },
      "capn_executable": { "type": "string", "description": "Optional custom path to the Capn executable." },
      "profile": { "type": "string", "enum": ["capn-cli", "none"], "description": "Optional adapter profile; defaults to capn-cli." },
      "root": { "type": "string", "description": "Optional repository root path. Defaults to current working directory." }
    }
  }
  ```
- **Output Shape**:
  - `plain: true`: Token-minimal plain text formatted result (`[hit: ...]`, `[multi-symbol]`, `[call-graph: depth N]`, `[junction]`, or `[miss]`).
  - `symbols` mode: `{ waymark: 1, kind: "multi-symbol", status: "hit" | "partial" | "miss", total: number, hits: number, misses: number, symbols: Record<string, { status: "hit" | "miss", path?: string, line?: number, kind?: string }> }`
  - Multi-hop Call Graph mode (when `depth` is specified): `{ tool: "call_graph", function: string, path?: string, line?: number, kind?: string, depth: number, direction: "callers" | "callees" | "both", totalNodes: number, truncated: boolean, callers?: CallGraphHopNode[], callees?: CallGraphHopNode[] }`. Formatted as clean indented tree when `plain: true`.
  - `status: "hit"`: `{ waymark: 1, kind: "ask", status: "hit", provider: "...", confidence: "...", result: ..., timings?: ... }`
  - `status: "junction"`: Full inspectable recommendation payload with executed option, alternative option, and continuation instructions.
  - `status: "miss"`: Fail-closed miss with `missCode: WaymarkMissCode` (clean miss, never guesses).
  - `status: "error"`: Error object with `code` and `message`.

### 4.2 `waymark_chart`
- **Identifier**: `waymark_chart`
- **Stability**: **Stable**
- **Description**: Commit verified question, answer, and referenced file set to long-term lexical BM25 consensus memory. Pre-validates backing files exist and are regular files. Auto-initializes store if uninitialized.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "question": { "type": "string", "description": "The question or topic charted." },
      "answer": { "type": "string", "description": "The conclusive charted answer." },
      "files": { "type": "array", "items": { "type": "string" }, "description": "Array of repository-relative file paths." },
      "capn_executable": { "type": "string", "description": "Optional custom path to the Capn executable." },
      "profile": { "type": "string", "enum": ["capn-cli", "none"], "description": "Optional adapter profile." },
      "root": { "type": "string", "description": "Optional repository root path." }
    },
    "required": ["question", "answer"]
  }
  ```
- **Output Shape**: `{ waymark: 1, kind: "chart", published: boolean, adapter: string, output: string, error?: string }`

### 4.3 `waymark_discover_symbols`
- **Identifier**: `waymark_discover_symbols`
- **Stability**: **Stable**
- **Description**: Discover syntax symbols in a repository file (Mode A: single-file tree-sitter AST with codedb outline fallback; Mode A-Filtered: file + query), or search across the repository when path is omitted (Mode B: repo-wide codedb symbol search).
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Repository-relative or absolute source file path. If provided alone or with query, performs file AST extraction." },
      "query": { "type": "string", "description": "Symbol name or substring to search. If path is omitted, searches repository-wide. If path is provided, filters symbols in that file." },
      "symbol": { "type": "string", "description": "Alias for query." },
      "language": { "type": "string", "enum": ["typescript", "python"], "description": "Optional grammar override." },
      "plain": { "type": "boolean", "description": "Emit token-minimal plain text formatted result for LLM context efficiency (~16-40 tokens)." },
      "root": { "type": "string", "description": "Optional repository root path." }
    }
  }
  ```
- **Output Shape**:
  - `plain: true`: Token-minimal plain text formatted result (`[symbols: <path>]` or `[symbols: '<query>']`).
  - Mode A: Structured `SymbolDiscoveryResult` with symbols array containing symbol name, kind, line numbers, and byte ranges.
  - Mode B: Structured `RepoSymbolDiscoveryResult` with results array containing matched symbol names, paths, lines, and kinds.

### 4.4 `waymark_unchart`
- **Identifier**: `waymark_unchart`
- **Stability**: **Stable**
- **Description**: Delete one charted consensus memory entry by ID from Capn repository memory.
- **Input Schema**: `{ "id": string, "if_exists"?: boolean, "capn_executable"?: string, "root"?: string }`

### 4.5 `waymark_bust`
- **Identifier**: `waymark_bust`
- **Stability**: **Stable**
- **Description**: Invalidate and delete every charted memory entry backed by a specific repository file.
- **Input Schema**: `{ "file": string, "capn_executable"?: string, "root"?: string }`

### 4.6 `waymark_prune`
- **Identifier**: `waymark_prune`
- **Stability**: **Stable**
- **Description**: Delete every charted memory entry whose backing files have changed or vanished.
- **Input Schema**: `{ "capn_executable"?: string, "root"?: string }`

### 4.7 `waymark_list`
- **Identifier**: `waymark_list`
- **Stability**: **Stable**
- **Description**: List all charted consensus memory entries in the repository. Degrades gracefully with empty list on uninitialized stores without throwing.
- **Input Schema**: `{ "capn_executable"?: string, "root"?: string }`

### 4.8 `waymark_context`
- **Identifier**: `waymark_context`
- **Stability**: **Stable**
- **Description**: Retrieve the ask-first charting contract and syntax guidelines for Waymark Engine. Degrades gracefully on uninitialized stores without throwing.
- **Input Schema**: `{ "capn_executable"?: string, "root"?: string }`

### 4.9 `waymark_daemon_status`
- **Identifier**: `waymark_daemon_status`
- **Stability**: **Stable**
- **Description**: Check resident in-memory background daemon status, active IPC address, uptime, and PID. Supports in-memory cache invalidation via `reload: true`.
- **Input Schema**: `{ "root"?: string, "reload"?: boolean }`

### 4.10 `waymark_init`
- **Identifier**: `waymark_init`
- **Stability**: **Stable**
- **Description**: Initialize the repository's deterministic lexical store (`.capn`) with embedding mode disabled.
- **Input Schema**: `{ "capn_executable"?: string, "root"?: string }`

### 4.11 MCP Prompts Registry
The server registers standard prompts to orchestrate complex agentic discovery workflows:
- **`explore-subsystem`**: Guides a structured 4-tier exploration of a subsystem or symbol in the codebase (`arguments: [{ name: "query", required: true }, { name: "root", required: false }]`).
- **`architectural-map`**: Generates an architectural call-graph map and consensus memory summary for a feature (`arguments: [{ name: "topic", required: true }]`).

### 4.12 MCP Resources Registry
The server exposes resident resources for configuration inspection and capability negotiation:
- **`capn://status`**: Returns current Capn adapter profile, executable path, and memory store initialization status (`application/json`).
- **`waymark://manifest`**: Returns engine capabilities, tier configuration, and versioning manifest (`application/json`).

---

## 5. Public Library API Registry

Programmatic TypeScript / JavaScript consumers import directly from `"waymark-engine"`:

| Exported Symbol | Type | Classification | Stability | Description |
| :--- | :--- | :--- | :--- | :--- |
| `ask(root, profile, bin, question, opts)` | `Function` | Discovery Engine | **Stable** | Programmatic entrypoint for the full tiered discovery engine. |
| `initCapn(root, bin)` | `Function` | Semantic Memory | **Stable** | Programmatic initialization of deterministic BM25 lexical store. |
| `publish(root, profile, bin, q, a, files)` | `Function` | Semantic Memory | **Stable** | Charts consensus memory programmatically. |
| `discoverSymbolsInFile(root, path, lang)` | `Function` | AST Extractor | **Stable** | Parses source files into structured symbol records using tree-sitter. |
| `verifyHop(root, hop)` | `Function` | Hop Integrity | **Stable** | Verifies structural hash integrity of saved hop records across file revisions. |
| `detectAstIntent(question)` | `Function` | Intent Classifier | **Stable** | Classifies questions into AST structural categories (`callers`, `callees`, etc.). |
| `detectLiteralIntent(question)` | `Function` | Intent Classifier | **Stable** | Classifies path/filename targets from natural language queries. |
| `scoreFzf(pattern, target)` | `Function` | Fuzzy Matching | **Stable** | Embedded two-pass Smith-Waterman scoring algorithm returning raw score and match matrix. |
| `rankFzf(candidates, query, opts)` | `Function` | Fuzzy Matching | **Stable** | Ranks list of symbol candidates with path-proximity and boundary bonuses. |
| `classifyTokenShape(token)` | `Function` | Signal Classifier | **Stable** | Determines whether a token is `identifier-like` or `plain`. |
| `extractCandidateTokens(question)` | `Function` | Signal Classifier | **Stable** | Partitions query into stop-word filtered candidate and plain tokens. |
| `anchorForRange(root, file, range)` | `Function` | Hop Integrity | **Stable** | Computes cryptographic and structural signatures for line ranges. |
| `WaymarkError` | `Class` | Error Handling | **Stable** | Typed domain error class with code and exit code properties. |

---

## 6. Internal / Non-Guaranteed Operations

These functions are internal implementation details subject to refactoring:

| Function / Operation | Module | Visibility | Note |
| :--- | :--- | :--- | :--- |
| `queryStructural` | `src/codedbAdapter.ts` | Internal | Low-level IPC wrapper executing `@paragon-ux/codedb-core`. |
| `queryFuzzyCandidates` | `src/codedbAdapter.ts` | Internal | Extracts symbol candidate pool from codedb trigram index. |
| `collectRepoPaths` | `src/discoveryRouter.ts` | Internal | Filesystem crawler gathering candidate filenames for Tier 2 path resolution. |
| `tracebackFzf` | `src/fuzzyMatcher.ts` | Internal | Reconstructs character match spans from dynamic programming matrix. |
| `normalizeScore` | `src/fuzzyMatcher.ts` | Internal | Calibrates raw alignment scores into 0.0–1.0 normalized confidence ratio. |
