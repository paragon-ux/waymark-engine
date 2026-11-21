# Getting Started

Get up and running with Waymark Engine as a CLI tool, background daemon, live visual inspector, and programmatic library.

---

## Prerequisites

- **Node.js**: v22.0.0 or higher.
- **Operating Systems & Prebuilt Architectures**:
  - `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `win32-x64` ship prebuilt `@paragon-ux/codedb-core` binaries.
  - `win32-arm64` automatically falls back to the bundled `codedb-win32-x64.exe` binary under Windows x64 emulation.
- **Git** (optional): While Git repositories are auto-detected (`git rev-parse --show-toplevel`), Waymark functions fully on unversioned directories by falling back to `process.cwd()`.

---

## Installation

### Global CLI (Recommended)

Install globally to access the `waymark` binary from any shell:

```bash
npm install -g waymark-engine
```

### Local Project Dependency

Install per-project for direct library access and `npx` execution:

```bash
npm install waymark-engine
```

Waymark ships precompiled JavaScript in `dist/` and prebuilt `@paragon-ux/codedb-core` binaries; no TypeScript build step is needed and `postinstall` never mutates `node_modules/`. Note that Tier 4 consensus memory (`@paragon-ux/capn-hook`) depends on `better-sqlite3`, which downloads prebuilt SQLite binaries for standard Node 22 ABIs (falling back to `node-gyp` C++ compilation only if a host ABI/OS lacks a prebuild, e.g., Alpine musl or preview Node releases).

### Default Root Exclusions (`--include-dir`)

Tier 2 literal path indexing skips tool/scratch folders at the repository root by default (`next`, `nuxt`, `capn`, `waymark`, `qmd`, `claude`, `codex`, `zed`, `eval`, `experiments`, `evidence`, `sandbox`, `scratch`, `tmp`, `vendor`; nested folders like `src/eval` or `src/vendor` remain indexed). To un-exclude project-specific root directories (for example Go/PHP `vendor/` or research `eval/`), pass `--include-dir vendor,eval` on `waymark ask` (MCP: `include_dirs: ["vendor", "eval"]`) or declare `"includeDirs": ["vendor", "eval"]` in `.waymark/config.json`.

---

## Quickstart (The Two Canonical Verbs)

Waymark organizes all operations into two clear verbs: **`waymark ask`** (Read & Discovery) and **`waymark memory`** (Write, Bootstrap & Consensus).

### 1. Initialize Consensus Store
Before using long-term architectural memory, initialize the deterministic lexical BM25 store (`.waymark/memory`):
```bash
waymark memory init
```

The store lives in `.waymark/memory`, and `.waymark/.gitignore` keeps it out of `git status`. See [Memory Store & State Layout](memory-store.md).

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
# Collect source-backed unverified drafts for the 5 architectural facets (read-only)
waymark memory bootstrap

# Check map completion ratio and file drift
waymark memory status

# Chart verified architectural decisions into SQLite
waymark memory chart --facet boundaries --question "IPC Protocol" --answer "Named pipes on Windows, Unix sockets on POSIX" --files "src/daemon.ts"

# Invalidate stale memories when files change
waymark memory bust src/daemon.ts
```

---

## High-Performance Resident Daemon

For sub-millisecond query performance on large repositories (delivering a **21x–100x speedup**), run the resident background daemon:

```bash
# Start the background daemon
waymark daemon start

# Check daemon status, PID, uptime, and IPC address
waymark daemon status

# List all active Waymark daemons for the current user
waymark daemon list

# Reload in-memory AST and trie indices after code edits
waymark daemon reload

# Stop the daemon
waymark daemon stop
```

When the daemon is running, queries routed with `--daemon` execute in **`<10ms`** via IPC (`PrefixTrie` and warm AST call graphs).

---

## Interactive REPL & Live Telemetry Observer

Waymark Engine includes two distinct REPL modes:

```bash
# 1. Interactive diagnostic REPL (supports ask, symbols, /status, /clear, /exit, and /battery --path <manifest.jsonl>)
waymark repl

# 2. Live read-only telemetry observer & browser SSE viewer (default port 4141; keys: q/c/s)
WAYMARK_TELEMETRY=1 waymark repl --live --port 4141
```

In `--live` mode, open the tokenized loopback access URL printed by the observer (pass `--port 0` to disable HTTP and monitor in the terminal only). Keep that URL private; the dashboard and telemetry endpoints reject requests without its per-session token.

The observer binds to `127.0.0.1`, validates Host and Origin headers, and blocks framing. It requires `WAYMARK_TELEMETRY=1` (and exits non-zero without it). Persistent query/session logging is disabled unless the same explicit opt-in is set.

### Key Capabilities:
- **Server-Sent Events (SSE) (`--live`)**: Queries, cache hits, tier execution timings, and latency metrics stream instantaneously to the browser while `q` quits, `c` clears, and `s` prints session stats.
- **Fixed-Viewport App-Shell (`--live`)**: Viewport-locked single internal scroll mechanism (`overflow: hidden` on root, flexbox list layout), eliminating double scrollbars even at scaled zoom levels (125% / 150%).
- **Hardened Prompt Battery (`waymark repl` / `--manifest`)**: Run a custom JSONL prompt evaluation manifest via `/battery --path <manifest.jsonl>` (or `waymark repl --manifest <file.jsonl>`). Inside a `waymark-engine` source checkout, `/battery` with no `--path` (or `npm run test:prompts`) runs the repository's canonical 105-prompt self-evaluation suite (`docs/prompts/CATALOGUE_MANIFEST.jsonl`).

---

## Next Steps

- Explore the [4-Tier Architecture](architecture.md) to understand AST call graphs vs. BM25 consensus.
- Set up the [Model Context Protocol (MCP)](mcp.md) for Google Antigravity, Claude Desktop, or Cursor.
