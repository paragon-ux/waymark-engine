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
| `waymark ask <question>`<br>`waymark-ask <question>` | **Stable** | [`src/cli.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/cli.ts) | Positional string query ($\le 240$ chars), flags | Primary discovery entrypoint. Cascades across structural, path, and junction tiers. |
| `waymark init`<br>`waymark-init` | **Stable** | [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts) | Optional `--capn-executable <path>` | Initializes the deterministic BM25 lexical store in the current repository root. Refuses embeddings. |
| `waymark discover-symbols`<br>`waymark-discover` | **Stable** | [`src/astExtractor.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/astExtractor.ts) | `--path <file>`<br>`[--language <lang>]` | Extracts structured AST symbols (functions, classes, interfaces, methods) with byte spans and signatures. |
| `waymark chart`<br>`waymark-chart` | **Stable** | [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts) | `--question <q>`<br>`--answer <a>`<br>`--files <paths>` | Records consensus ground truth into lexical long-term memory. Decoupled from syntactic query routing. |
| `waymark unchart <id>`<br>`waymark-unchart <id>` | **Stable** | [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts) | Positional string entry ID | Removes a specific charted consensus entry from memory. |
| `waymark bust <path>`<br>`waymark-bust <path>` | **Stable** | [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts) | Positional repository-relative path | Evicts or invalidates charted memory entries referencing a modified or deleted source file. |
| `waymark prune`<br>`waymark-prune` | **Stable** | [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts) | None | Cleans stale entries, defragments SQLite FTS5 indexes, and verifies integrity. |
| `waymark list`<br>`waymark-list` | **Stable** | [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts) | None | Lists all active charted consensus memory entries. |
| `waymark context`<br>`waymark-context` | **Stable** | [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts) | None | Summarizes repository memory state, entry counts, and configuration profile. |
| `waymark mcp`<br>`waymark-mcp` | **Stable** | [`src/mcp/server.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/mcp/server.ts) | None (runs over `stdio`) | Launches the standard Model Context Protocol (MCP) server for IDE and agent integration. |
| `waymark help` / `-h` / `--help` | **Stable** | [`src/cli.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/cli.ts) | None | Outputs brief command options, flags, and environment variable configuration. |

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
| `--path` | — | Value | Repository path | None (Required) | `discover-symbols` | **Stable** | Target repository-relative source file to parse into AST symbols. |
| `--language` | — | Value | `typescript`, `python` | Auto from file ext | `discover-symbols` | **Stable** | Explicit parser grammar override when file extension is ambiguous or non-standard. |
| `--question` | — | Value | String ($\le 240$ chars) | None (Required) | `chart` | **Stable** | The ground-truth question being charted. |
| `--answer` | — | Value | String ($\le 4000$ chars) | None (Required) | `chart` | **Stable** | Verified, conclusive architectural answer to commit to memory. |
| `--files` | — | Value | Comma-delimited list | `""` | `chart` | **Stable** | Source file paths associated with the charted answer for cache invalidation tracking. |

---

## 4. MCP Tool Registry

The resident stdio MCP server (`waymark-mcp`) exposes three high-leverage tools for agentic discovery:

### 4.1 `capn_ask`
- **Identifier**: `capn_ask`
- **Stability**: **Stable**
- **Description**: Query repository memory and tiered discovery to answer code questions without hallucination.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "question": { "type": "string", "description": "The question to look up." },
      "capn_executable": { "type": "string", "description": "Optional custom path to the Capn executable." },
      "profile": { "type": "string", "enum": ["capn-cli", "none"], "description": "Optional adapter profile; defaults to capn-cli." },
      "root": { "type": "string", "description": "Optional repository root path." }
    },
    "required": ["question"]
  }
  ```
- **Output Shape**:
  - `status: "hit"`: `{ waymark: 1, kind: "ask", status: "hit", provider: "...", confidence: "...", result: ... }`
  - `status: "junction"`: Full inspectable recommendation payload with executed option, alternative option, and continuation instructions.
  - `status: "miss"`: Fail-closed miss with `missCode: WaymarkMissCode`.
  - `status: "error"`: Error object with `code` and `message`.

### 4.2 `capn_chart`
- **Identifier**: `capn_chart`
- **Stability**: **Stable**
- **Description**: Commit verified question, answer, and referenced file set to long-term lexical BM25 consensus memory.
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
- **Description**: Discover syntax symbols in a repository-relative source file without mutating state.
- **Input Schema**:
  ```json
  {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Repository-relative source file path." },
      "language": { "type": "string", "enum": ["typescript", "python"], "description": "Optional grammar override." },
      "root": { "type": "string", "description": "Optional repository root path." }
    },
    "required": ["path"]
  }
  ```
- **Output Shape**: Structured list of `SymbolRecord` objects containing symbol name, kind, line numbers, and byte ranges.

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
