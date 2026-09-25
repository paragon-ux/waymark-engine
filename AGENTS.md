# Waymark Engine — Agent & Integration Guide

Waymark Engine is a four-tier symbolic and semantic discovery engine for one-shot code questions:
1. **Tier 1: AST Structural** — deterministic codedb call graph (`@paragon-ux/codedb-core` v1.1.0, resolved and fail-closed).
2. **Tier 2: Literal Path Router** — exact and substring path resolution with zero-hallucination fail-closed defense.
3. **Tier 3: Deterministic Fuzzy Matcher** — embedded Junegunn Choi `fzf` (`algo.go`) two-pass scoring.
4. **Tier 4: Charted Memory** — lexical BM25 repository consensus memory via `@paragon-ux/capn-hook`.
5. **Single-File Structured AST** — precise tree-sitter class, method, function, and type extraction for TypeScript and Python.

When structural and literal tiers miss, the **Discovery Junction** evaluates syntactic candidate signals and emits an inspectable recommendation (`status: "junction"`) with machine-readable continuation instructions. A clean miss is a miss — never a guess.

---

## Working on this repo

```bash
npm ci          # install dependencies (bundled capn fork included)
npm run verify  # build + full node test suite (43/43 passing green)
```

Invariants:
- Semantic recall must stay deterministic: the adapter refuses any store that is uninitialized (`CAPN_STORE_UNINITIALIZED`) or in embedding mode (`CAPN_NON_DETERMINISTIC_MODE`). Do not weaken that guard.
- The router must miss cleanly rather than fabricate an answer.
- External tools are invoked with explicit argv arrays (never a shell) and bounded output. Keep `WAYMARK_CAPN_EXECUTABLE` as an escape hatch, but the bundled fork is the default and the only tested path.
- Fuzzy matching is zero-dependency and strictly deterministic.
- Host CPU responsiveness is protected: `CODEDB_MAX_THREADS` defaults to `max(1, cpus - 1)` so 1 logical core remains free.
- Tests cover both success and fail-closed paths. `npm run verify` must stay green.

---

## MCP Server Setup (Stdio Integration)

Waymark Engine implements the Model Context Protocol (MCP) dual-era specification (`2026-07-28` modern discovery + `2024-11-05` standard handshake).

### Autonomous Agent Architecture & Context Delegation
Waymark Engine serves as the symbolic and semantic discovery layer for coding agents. Rather than bloating context windows with large directory dumps or full-file reads, agents delegate exploration to `waymark-engine` to obtain exact symbols, call graphs, and line spans in milliseconds. Trajectory tracking and session compaction are handled externally (e.g., via `codex-agents-compact-reload` / AGENTS.md Compact Reload), keeping this engine focused purely on high-performance code intelligence.

### Target Repository Path (`root` Argument)
When an agent or client editor launches `waymark-engine` via stdio, the server defaults to its current working directory. When querying a target repository located elsewhere on disk, **always pass the `root` argument** in tool calls:
```json
{
  "question": "Who calls execute_command?",
  "root": "/path/to/target/repository"
}
```

### Configuration Snippets

#### 1. Google Antigravity / Gemini CLI (`~/.gemini/config/mcp_config.json`)
```json
{
  "mcpServers": {
    "waymark-engine": {
      "command": "npx",
      "args": ["-y", "waymark-engine"],
      "env": {
        "CODEDB_ALLOW_TEMP": "1"
      }
    }
  }
}
```
*(For local source development, replace `"command": "npx"` with `"command": "node"`, and `"args": ["/path/to/waymark-engine/dist/src/mcp/capnIndex.js"]`).*

#### 2. Claude Desktop (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "waymark-engine": {
      "command": "npx",
      "args": ["-y", "waymark-engine"],
      "env": {
        "CODEDB_ALLOW_TEMP": "1"
      }
    }
  }
}
```

#### 3. Cursor / Zed / Continue
* **Command**: `npx -y waymark-engine`
* **Transport**: `stdio`
* **Environment**: `CODEDB_ALLOW_TEMP=1`

### Exposed MCP Surface
* **Tools**:
  * `waymark_ask` (alias: `capn_ask`): 4-tier discovery question query with full CLI flag parity (`tier: "auto"|"ast"|"path"|"fuzzy"|"capn"`, `auto_resolve`, `timing`, `plain`, `daemon`).
  * `waymark_chart` (alias: `capn_chart`): Publish architectural consensus memory with backing files.
  * `waymark_discover_symbols`: Extract classes, methods, functions, and types from TS/Python files.
  * `waymark_unchart` (alias: `capn_unchart`): Invalidate and delete charted consensus memory entry by ID.
  * `waymark_bust` (alias: `capn_bust`): Invalidate every charted memory entry backed by a specific repository file.
  * `waymark_prune` (alias: `capn_prune`): Cleanly remove all stale charted memory entries whose backing files vanished.
  * `waymark_list` (alias: `capn_list`): List all charted repository consensus memories.
  * `waymark_context` (alias: `capn_context`): Retrieve the ask-first charting contract and routing guidelines.
  * `waymark_daemon_status`: Inspect resident in-memory background daemon health, PID, address, and uptime.
* **Resources**:
  * `capn://status`: Memory store configuration and adapter status.
  * `waymark://manifest`: Engine capabilities, tier metadata, and versioning.
* **Prompts**:
  * `explore-subsystem`: Guided 4-tier exploration workflow for a concept or module.
  * `architectural-map`: Structured call-graph and consensus memory mapping workflow.

---

## CLI Usage

```bash
npm install -g waymark-engine
waymark-init                                     # one-time lexical store init per repo (or: waymark init)

waymark-ask "Who calls verifyHop?"               # Tier 1 AST answer, no external process
waymark-ask "refundOrdr"                         # Discovery Junction (fuzzy recommended, ~92% match)
waymark-ask "refundOrdr" -t fuzzy -b             # Isolate Tier 3 with high-resolution timings
waymark-ask "refundOrdr" --plain                 # Token-minimal plain text for agents (~16 tokens)
waymark-ask "How does authentication work?"      # Tier 4 charted-memory answer or miss
waymark-discover --path src/index.ts
waymark-chart --question "<q>" --answer "<a>" --files "<a,b>"
waymark-unchart <id>   waymark-bust <path>   waymark-prune
waymark-list           waymark-context      waymark-mcp
waymark-daemon [start|stop|restart|status|list|ping]
```

---

## Documentation & Specifications

The canonical specifications, contracts, and registries are maintained under [`/spec`](spec/):
- [`spec/README.md`](spec/README.md) — Architectural overview & invariants
- [`spec/command-registry.md`](spec/command-registry.md) — Canonical CLI commands, flags, Discovery options, and MCP tools
- [`spec/error-codes.md`](spec/error-codes.md) — Status envelopes, error codes, miss codes, and exit codes
- [`spec/metrics.md`](spec/metrics.md) — Standardized tier metrics schema and benchmarks
- [`CHANGELOG.md`](CHANGELOG.md) — Release notes and migration guide

## Library

`import { ask, discoverSymbolsInFile, detectAstIntent, scoreFzf, rankFzf, verifyHop, anchorForRange } from "waymark-engine";`
