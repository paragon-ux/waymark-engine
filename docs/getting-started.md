# Getting Started

Get up and running with Waymark Engine as a CLI tool, background daemon, live visual inspector, and programmatic library.

---

## Prerequisites

- **Node.js**: v22.0.0 or higher.
- **Operating Systems**: macOS, Linux, and Windows (PowerShell or Bash).
- **Git** (optional): While Git repositories are auto-detected (`git rev-parse --show-toplevel`), Waymark functions fully on unversioned directories by falling back to `process.cwd()`.

---

## Installation

=== "Global CLI (Recommended)"
    Install globally to access the `waymark` binary from any shell:
    ```bash
    npm install -g waymark-engine
    ```

=== "Local Project Dependency"
    Install per-project for direct library access and `npx` execution:
    ```bash
    npm install waymark-engine
    ```

Waymark ships with prebuilt artifacts in `dist/` — no TypeScript build steps or native compiler dependencies required for end users.

---

## Quickstart (The Two Canonical Verbs)

Waymark organizes all operations into two clear verbs: **`waymark ask`** (Read & Discovery) and **`waymark memory`** (Write, Bootstrap & Consensus).

### 1. Initialize Consensus Store
Before using long-term architectural memory, initialize the deterministic lexical BM25 store (`.capn`):
```bash
waymark memory init
```

### 2. Discover Symbols & Call Graphs (`waymark ask`)

Run one-shot queries against your repository:

```bash
# Tier 1 AST exact structural caller trace
waymark ask "Who calls verifyHop?"

# Bounded BFS multi-hop caller graph (excluding test noise for 94% token reduction)
waymark ask "verifyHop" --depth 2 --direction callers --exclude-tests

# Concurrent batch symbol definitions
waymark ask --symbols User,Service,ApiWorker

# Single-file structured Tree-Sitter AST outline
waymark ask --path src/types.ts

# Discovery Junction recommendation (handles typos deterministically)
waymark ask "verfyHop"

# Token-minimal plain text formatted for LLM context injection (~16-38 tokens)
waymark ask "verifyHop" --plain
```

### 3. Maintain Architectural Consensus (`waymark memory`)

```bash
# Bootstrap 5-facet architectural consensus into SQLite
waymark memory bootstrap

# Check map completion ratio and file drift
waymark memory status

# Chart architectural decisions
waymark memory chart --question "IPC Protocol" --answer "Named pipes on Windows, Unix sockets on POSIX" --files "src/daemon.ts"

# Invalidate stale memories when files change
waymark memory bust src/daemon.ts
```

---

## High-Performance Resident Daemon

For sub-millisecond query performance on large repositories (delivering a **21x–100x speedup**), run the resident background daemon:

```bash
# Start the background daemon
waymark daemon start

# Check daemon health, resident memory, and cached files
waymark daemon status

# Reload in-memory AST and trie indices after code edits
waymark daemon reload

# Stop the daemon
waymark daemon stop
```

When the daemon is running, queries routed with `--daemon` execute in **`<10ms`** via IPC (`PrefixTrie` and warm AST call graphs).

---

## Live REPL Observer & Web Viewer

Waymark Engine includes a built-in terminal REPL paired with a real-time Web Viewer for visual query inspection and telemetry:

```bash
# Launch interactive REPL with live browser viewer on port 4141
waymark repl --live --port 4141
```

Once launched, open **`http://localhost:4141`** in any web browser.

### Key Capabilities of the Live Viewer:
- **Server-Sent Events (SSE)**: Queries, cache hits, tier execution timings, and latency metrics stream instantaneously to the browser.
- **Fixed-Viewport App-Shell**: Viewport-locked single internal scroll mechanism (`overflow: hidden` on root, flexbox list layout), eliminating double scrollbars even at scaled zoom levels (125% / 150%).
- **Hardened Test Battery**: Run canonical prompt batteries (`/battery`) directly from the REPL to measure Tier 1 through Tier 4 recall fidelity.

---

## Next Steps

- Explore the [4-Tier Architecture](architecture.md) to understand AST call graphs vs. BM25 consensus.
- Set up the [Model Context Protocol (MCP)](mcp.md) for Google Antigravity, Claude Desktop, or Cursor.
