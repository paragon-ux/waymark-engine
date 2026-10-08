# CLI & Command Registry

Waymark Engine provides a unified Two-Verb command surface ensuring 100% parity across CLI execution, MCP stdio invocations, and TypeScript programmatic APIs.

---

## Command Overview

| Command | Category | Description |
| :--- | :--- | :--- |
| `waymark ask "<q>"` | **Read & Discovery** | 4-tier discovery (AST structural call graph, literal path, deterministic fuzzy, BM25 memory, batch symbols, file outlines). |
| `waymark memory <action>` | **Write & Lifecycle** | Consensus memory manager: bootstrap, status, chart, heal, export, bust, prune, list, unchart, init, context. |
| `waymark daemon [cmd]` | **Daemon Operations** | Background resident codedb server (`start`, `stop`, `restart`, `reload`, `status`, `list`, `ping`). |
| `waymark repl` | **Diagnostic REPL** | Interactive diagnostic shell and hardened test battery runner with live browser SSE viewer. |
| `waymark mcp` | **MCP Server** | Launches standard stdio MCP discovery server. |
| `waymark init` | **Store Init** | One-time deterministic lexical store initialization (`.capn`). |

*(Legacy discrete commands `waymark-ask`, `waymark-chart`, `waymark-bootstrap`, `waymark-map`, `waymark-symbols`, `waymark-discover` remain available as aliases).*

---

## Verb 1: `waymark ask`

```bash
waymark ask [options] [question]
```

### Options & Flags

| Flag | Shorthand | Type | Description |
| :--- | :--- | :--- | :--- |
| `--depth <n>` | | `1..5` | Bounded BFS call graph traversal depth (default: 1). |
| `--direction <d>` | | `string` | Traversal directionality (`callers`, `callees`, or `both`, default: `both`). |
| `--exclude-tests` | | `boolean` | Suppress test files (`tests/`, `*_test.*`, `*.spec.*`) from call graphs for 94% token savings. |
| `--path <file>` | | `string` | Extract structured tree-sitter AST outline for a single file. |
| `--symbols <list>` | | `string` | Comma-separated list of symbols to inspect concurrently across the codebase. |
| `--facet <facet>` | | `string` | Scope query to an architectural domain (`lifecycle`, `data_state`, `boundaries`, `invariants`, `failure`, or `status`). |
| `--plain` | `-p` | `boolean` | Emit token-minimal plain text formatted for LLM context injection (~16-38 tokens). |
| `--tier <tier>` | `-t` | `string` | Force a specific discovery tier (`auto`, `ast`, `path`, `fuzzy`, `capn`) or bypass junction fallthrough. |
| `--timing` | `-b` | `boolean` | Surface high-resolution sub-millisecond per-tier execution timings. |
| `--daemon` | `-d` | `boolean` | Route query through the resident in-memory background daemon IPC. |
| `--dev` | | `boolean` | Enable Dev Mode with per-tier timing breakdown and runtime invariant assertions. |

### Examples

```bash
# Multi-hop caller tree excluding test files
waymark ask "verifyHop" --depth 2 --direction callers --exclude-tests

# Concurrent multi-symbol batch query
waymark ask --symbols User,Service,ApiWorker

# Single-file structured Tree-Sitter AST outline
waymark ask --path src/types.ts

# Architectural consensus query scoped to invariants
waymark ask --facet invariants "path normalization rules"
```

---

## Verb 2: `waymark memory`

```bash
waymark memory <action> [options]
```

### Action Catalog

| Action | CLI Syntax | Description |
| :--- | :--- | :--- |
| **`bootstrap`** | `waymark memory bootstrap [--dry-run]` | Run two-pass architectural discovery and populate SQLite ledger. |
| **`status`** | `waymark memory status [--plain]` | Inspect Semantic Repo Map completion ratio, active facets, and file drift. |
| **`chart`** | `waymark memory chart --question <q> --answer <a> --files <f> [--facet <facet>]` | Publish architectural knowledge into consensus SQLite memory. |
| **`heal`** | `waymark memory heal` | Reconcile code changes, verify anchors, and refresh SQLite ledger. |
| **`export`** | `waymark memory export [--format md\|json]` | Export consensus architecture map as Markdown or JSON. |
| **`bust`** | `waymark memory bust <path>` | Invalidate all consensus memories citing a changed file. |
| **`prune`** | `waymark memory prune` | Cleanly remove stale entries whose backing files vanished. |
| **`list`** | `waymark memory list` | List all charted consensus memory entries. |
| **`unchart`** | `waymark memory unchart <id> [--if-exists]` | Delete a specific memory entry by hex ID. |
| **`init`** | `waymark memory init` | Initialize deterministic lexical store (`.capn`). |
| **`context`** | `waymark memory context` | Retrieve ask-first routing contract and syntax guidelines. |

---

## Daemon Operations (`waymark daemon`)

```bash
waymark daemon [command]
```

- **`start`**: Spawns resident codedb daemon with warm AST and trie cache.
- **`stop`**: Gracefully terminates background daemon.
- **`restart`**: Cycles the resident background process.
- **`reload`**: Invalidates in-memory AST and trie indices after file changes.
- **`status`**: Displays daemon PID, uptime, memory consumption, and cached entry count.
- **`ping`**: Validates IPC responsiveness over Named Pipes (Windows) or Unix Sockets (POSIX).

---

## Interactive REPL & Live Viewer (`waymark repl`)

```bash
waymark repl [--live] [--port <port>]
```

- **`--live`**: Launches the real-time Server-Sent Events (SSE) Web Viewer.
- **`--port <port>`**: Port for Web Viewer (default: `4141`).

### REPL Commands
- `/battery`: Run the full 6-category hardened evaluation test battery.
- `/clear`: Clear terminal history.
- `/status`: Show daemon IPC connection and cache health.
- `/exit`: Terminate REPL session.

---

## Exit Codes & Status Envelopes

Waymark guarantees consistent process exit codes:

| Code | Meaning | Context |
| :--- | :--- | :--- |
| `0` | **Success / Hit** | Valid AST match, path resolution, fuzzy score, or memory hit. |
| `1` | **Clean Miss** | No matching symbol or file found (zero false positives). |
| `2` | **Usage / Configuration Error** | Invalid flags, missing required arguments, or uninitialized store. |
| `3` | **Deterministic Guard Violation** | Attempted to use embedding mode or non-deterministic vector store. |
