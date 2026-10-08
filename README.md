# Waymark Engine 🧭

**Sub-millisecond AST structural & lexical BM25 code intelligence for AI coding agents.**

[![npm version](https://img.shields.io/npm/v/waymark-engine)](https://www.npmjs.com/package/waymark-engine)
[![CI](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml/badge.svg)](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml)
[![Docs](https://img.shields.io/badge/docs-Zensical-purple.svg)](https://paragon-ux.github.io/waymark-engine/)
[![tests](https://img.shields.io/badge/tests-74%2F74-brightgreen)](https://github.com/paragon-ux/waymark-engine)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![recall](https://img.shields.io/badge/recall-lexical%20BM25%20(no%20embeddings)-informational)](https://github.com/paragon-ux/capn-hook)

Ask your codebase a question in plain English. Get an exact answer — file, symbol, and line span — in milliseconds, without paying 10,000–50,000 tokens of blind context-window re-reading.

Built for AI coding agents: one-shot discovery, zero required background processes (no daemon required; optional resident daemon for warm `<10ms` lookups), no vector index, and strictly deterministic zero-embedding recall.

---

## Core Principles

- **Deterministic by Construction**: Every query path is zero-randomness. Semantic recall uses pure lexical BM25 (`@paragon-ux/capn-hook`) and hard-refuses embedding stores (`CAPN_NON_DETERMINISTIC_MODE`).
- **Fail-Closed Defense**: When structural or literal tiers miss, the Discovery Junction emits a machine-readable recommendation or clean miss. It **never guesses**.
- **Two-Verb MCP Interface**: Consolidates all discovery and maintenance into `waymark_ask` and `waymark_memory`, slashing tool context overhead to **<450 tokens** (vs. 3,000+ for flat tool catalogs).
- **Sub-Millisecond Speed**: In-memory `PrefixTrie` and warm AST call graphs answer queries in `<10ms` with warm daemon IPC.

---

## Architectural Division of Responsibilities

```text
                               AI Coding Agent
                                      │
                       ┌──────────────┴──────────────┐
                       │                             │
                 waymark_ask                  waymark_memory
               (Read & Discover)             (Write & Consensus)
                       │                             │
       ┌───────────────┼───────────────┐             │
       ▼               ▼               ▼             ▼
    Tier 1          Tier 2          Tier 3        Tier 4
 AST Call Graph   Path Router    Fuzzy Matcher  Lexical BM25
(@paragon/codedb) (PrefixTrie)   (algo.go fzf)  (.capn hook)
       │               │               │             │
       └───────────────┼───────────────┘             │
                       ▼                             ▼
               Discovery Junction           Consensus SQLite
             (deterministic miss)           (5-facet memory)
```

---

## Quickstart

Requires Node.js 22+.

```bash
# 1. Install globally or as a project dependency
npm install -g waymark-engine

# 2. Initialize the deterministic lexical store (.capn)
waymark memory init

# 3. Query the codebase using Verb 1 (waymark ask)
waymark ask "Who calls verifyHop?"            # Tier 1 exact structural call graph
waymark ask "verifyHop" --depth 2 --exclude-tests  # Bounded BFS excluding test files
waymark ask --symbols User,Service,ApiWorker  # Concurrent batch symbol definitions
waymark ask --path src/types.ts               # Single-file structured AST outline
waymark ask "verfyHop"                        # Discovery Junction recommendation
waymark ask "verifyHop" --plain               # Token-minimal LLM output (~16-38 tokens)
```

### Live REPL Observer & Web Viewer

Launch the interactive REPL with real-time SSE telemetry and browser viewer on port 4141:

```bash
waymark repl --live --port 4141
```
Open **`http://localhost:4141`** to observe query executions, tier breakdowns, cache hits, and run prompt evaluation batteries (`/battery`) in a viewport-locked layout.

---

## Comprehensive Documentation

For complete technical references, architectural specifications, and benchmark analyses, visit our **[Zensical Documentation Site](https://paragon-ux.github.io/waymark-engine/)**:

- 📖 **[Getting Started](docs/getting-started.md)**: Installation, CLI flags, background daemon, and the Live REPL Observer.
- 🏗️ **[4-Tier Architecture](docs/architecture.md)**: Deep dive into AST call graphs, literal paths, Junegunn Choi `fzf`, and BM25 consensus.
- 🔌 **[Model Context Protocol (MCP)](docs/mcp.md)**: Two-Verb interface (<450 tokens), setup for Google Antigravity, Claude Desktop, and Cursor.
- 💻 **[CLI & Command Registry](docs/commands.md)**: Full canonical command reference, `waymark memory` action catalog, and exit codes.
- 📊 **[Empirical Benchmarks](docs/benchmarks.md)**: Steelmanned Aider Repo Map parity benchmark (`gpt-oss-120b`) and metrics schema.
- 📦 **[Library API & Integrity](docs/library-api.md)**: TypeScript SDK, `verifyHop`, `anchorForRange`, and fail-closed invariant guards.

---

## Local Documentation Server

Build or preview the documentation locally using **Zensical**:

```bash
# Build static site
py -3.11 -m zensical build

# Serve live preview on localhost:8000
py -3.11 -m zensical serve
```

---

## License

MIT. See [LICENSE](LICENSE) for details.
