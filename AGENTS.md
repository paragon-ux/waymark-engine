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

### Exposed MCP Surface: The Two-Verb Model & Subcommands

Waymark Engine defaults to a high-efficiency **Two-Verb MCP Interface** that minimizes prompt token overhead (**<450 tokens default** vs 3,000+ tokens for flat tool sprawl) while maintaining 100% feature parity across CLI, MCP, and library APIs.

Zero configuration is required to benefit from the lean Two-Verb surface. *(Optional: to expose all 11 legacy granular tools in `tools/list`, set `"WAYMARK_MCP_VERBOSE": "1"`)*.

---

#### 1. Verb 1: `waymark_ask` (Read & Discovery)
Consolidates all code intelligence, 4-tier queries, call graphs, AST symbol discovery, and Semantic Repo Map lookups into a single query tool:

* **Natural Language / 4-Tier Query:**
  ```json
  {
    "name": "waymark_ask",
    "arguments": {
      "question": "Who calls verifyHop?",
      "plain": true
    }
  }
  ```

* **Multi-Hop Call Graph (`depth: 1..5`, `direction: "callers"|"callees"|"both"`):**
  ```json
  {
    "name": "waymark_ask",
    "arguments": {
      "question": "verifyHop",
      "depth": 2,
      "direction": "callers",
      "plain": true
    }
  }
  ```

* **Batch Symbol Resolution (`symbols: [...]`):**
  ```json
  {
    "name": "waymark_ask",
    "arguments": {
      "symbols": ["McpServer", "DiscoveryRouter", "FuzzyMatcher"],
      "plain": true
    }
  }
  ```

* **Single-File Structured AST Outline (`path: "..."`):**
  ```json
  {
    "name": "waymark_ask",
    "arguments": {
      "path": "src/types.ts",
      "plain": true
    }
  }
  ```

* **Semantic Repo Map Facet Query (`facet: "lifecycle"|"data_state"|"boundaries"|"invariants"|"failure"`):**
  ```json
  {
    "name": "waymark_ask",
    "arguments": {
      "facet": "invariants",
      "question": "path normalization rules",
      "plain": true
    }
  }
  ```

* **Inspect Semantic Repo Map Health Directly:**
  ```json
  {
    "name": "waymark_ask",
    "arguments": {
      "facet": "status",
      "plain": true
    }
  }
  ```

---

#### 2. Verb 2: `waymark_memory` (Write, Bootstrap & Lifecycle Maintenance)
Consolidates all stateful operations, consensus memory management, and map maintenance through the **`action`** parameter:

* **Subcommand `bootstrap`** (Two-Pass Semantic Repo Map generation into SQLite):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "bootstrap",
      "dry_run": false
    }
  }
  ```

* **Subcommand `status`** (Inspect Semantic Repo Map health, active facet ratio, and drift):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "status",
      "plain": true
    }
  }
  ```

* **Subcommand `chart`** (Record architectural knowledge into consensus SQLite memory):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "chart",
      "facet": "boundaries",
      "question": "IPC Protocol Architecture",
      "answer": "what: JSON-RPC over Named Pipes on Windows, Unix domain sockets on POSIX.\nwhere: src/daemon.ts\ninvariants: Daemon IPC is isolated per workspace root.",
      "files": ["src/daemon.ts"]
    }
  }
  ```

* **Subcommand `bust`** (Invalidate all consensus memories backed by a changed file):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "bust",
      "file": "src/daemon.ts"
    }
  }
  ```

* **Subcommand `prune`** (Cleanly remove stale memory entries whose backing files vanished):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "prune"
    }
  }
  ```

* **Subcommand `list`** (List all charted repository consensus memories):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "list"
    }
  }
  ```

* **Subcommand `unchart`** (Delete a specific charted consensus memory entry by hex ID):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "unchart",
      "id": "3a8f1b2c",
      "if_exists": true
    }
  }
  ```

* **Subcommand `init`** (One-time deterministic lexical store initialization):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "init"
    }
  }
  ```

* **Subcommand `context`** (Retrieve the ask-first charting contract and routing guidelines):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "context"
    }
  }
  ```

* **Subcommand `heal`** (Reconcile Semantic Repo Map anchors and update SQLite consensus ledger):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "heal"
    }
  }
  ```

* **Subcommand `export`** (Export charted architectural consensus map as Markdown or JSON):
  ```json
  {
    "name": "waymark_memory",
    "arguments": {
      "action": "export",
      "format": "md"
    }
  }
  ```

---

#### 3. Granular Backward-Compatible Tools
When running with `WAYMARK_MCP_VERBOSE=1` (or via direct invocation in `tools/call`), all 11 granular tools remain registered and fully functional for backward compatibility:
* `waymark_chart`: Alias for `waymark_memory(action="chart")`
* `waymark_bust`: Alias for `waymark_memory(action="bust")`
* `waymark_prune`: Alias for `waymark_memory(action="prune")`
* `waymark_list`: Alias for `waymark_memory(action="list")`
* `waymark_unchart`: Alias for `waymark_memory(action="unchart")`
* `waymark_init`: Alias for `waymark_memory(action="init")`
* `waymark_context`: Alias for `waymark_memory(action="context")`
* `waymark_map_status`: Alias for `waymark_memory(action="status")`
* `waymark_discover_symbols`: Single-file tree-sitter or repo-wide symbol query
* `waymark_daemon_status`: Background daemon telemetry and cache invalidation (`reload: true`)

---

#### 4. Resources & Prompts
* **Resources**:
  * `capn://status`: Memory store configuration and adapter status.
  * `waymark://manifest`: Engine capabilities, tier metadata, and versioning.
* **Prompts**:
  * `explore-subsystem`: Guided 4-tier exploration workflow for a concept or module.
  * `architectural-map`: Structured call-graph and consensus memory mapping workflow.
  * `bootstrap-semantic-map`: Two-pass bootstrap agent prompt for repository onboarding.

---

## Consolidated CLI Usage

```bash
npm install -g waymark-engine

# --- Verb 1: Read & Discovery (waymark ask) ---
waymark ask "Who calls verifyHop?"               # Tier 1 AST answer, no external process
waymark ask "refundOrdr"                         # Discovery Junction (fuzzy recommended, ~92% match)
waymark ask "refundOrdr" -t fuzzy -b             # Isolate Tier 3 with high-resolution timings
waymark ask "refundOrdr" --plain                 # Token-minimal plain text for agents (~16 tokens)
waymark ask --depth 2 --direction callers "hop"  # Bounded multi-hop BFS call graph
waymark ask --symbols User,Service,ApiWorker     # Concurrent multi-symbol resolution
waymark ask --path src/types.ts                  # Single-file structured Tree-Sitter AST outline
waymark ask --facet invariants "path rules"      # Scope query to architectural domain in Semantic Map
waymark ask --facet status                       # Inspect Semantic Repo Map completion & drift

# --- Verb 2: Write & Maintenance (waymark memory) ---
waymark memory bootstrap                         # Two-pass Semantic Repo Map discovery into SQLite
waymark memory status                            # Inspect 5-facet map health and completion ratio
waymark memory chart --question "<q>" --answer "<a>" --files "<a,b>"
waymark memory heal                              # Reconcile code changes and refresh map anchors
waymark memory export --format md                # Export consensus architecture map
waymark memory bust <path>                       # Invalidate entries citing a changed file
waymark memory prune                             # Cleanly remove stale entries whose files vanished
waymark memory list                              # List all consensus memories
waymark memory unchart <id> [--if-exists]        # Delete entry by hex ID

# --- Daemons, REPL & MCP ---
waymark daemon [start|stop|restart|status|ping]  # Persistent background server for <10ms queries
waymark repl                                     # Interactive diagnostic shell with live daemon IPC
waymark mcp                                      # Stdio Model Context Protocol server
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

`import { ask, queryMultiSymbols, discoverSymbolsInFile, discoverSymbolsInRepo, detectAstIntent, scoreFzf, rankFzf, verifyHop, anchorForRange } from "waymark-engine";`
