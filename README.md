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
(@paragon/codedb) (PrefixTrie)   (algo.go fzf)  (capn-hook)
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

# 2. Initialize the deterministic lexical store (.waymark/memory)
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
Open the access URL printed by the REPL to observe query executions, tier breakdowns, and cache hits in a viewport-locked layout. Run `/battery` in the REPL to execute prompt evaluations. The URL contains a random session token; keep it private.

The live observer binds to `127.0.0.1`, requires explicit telemetry opt-in with `WAYMARK_TELEMETRY=1`, and checks the session token on the dashboard and telemetry endpoints. It rejects mismatched Host or Origin headers and blocks framing. Persistent query/session logs are disabled by default. Do not expose the local viewer through a public interface.

### Semantic Repo Map and Platform Limits

`waymark memory bootstrap` collects source excerpts as **unverified drafts**; it does not publish architectural claims or initialize a Capn store. Verify each claim against its cited code, then publish it explicitly with `waymark memory chart`. Subsystem-scoped discovery and maps are not supported; requests that include `--subsystem` or `subsystem` return `UNSUPPORTED_SUBSYSTEM`.

On Windows, `WAYMARK_CODEDB_EXECUTABLE` must name a native executable. `.cmd` and `.bat` shims are rejected with `CODEDB_UNSUPPORTED_SHIM` because Waymark never invokes external tools through a shell.

### Language Support & Tier Fallbacks

- **Single-File AST Outlines (`waymark ask --outline --path <file>`)**:
  - **In-Process `web-tree-sitter` (Exact line + column spans)**: TypeScript (`.ts`, `.tsx`, `.mts`, `.cts`), JavaScript (`.js`, `.jsx`, `.mjs`, `.cjs`), Python (`.py`), JSON (`.json`), TOML (`.toml`), YAML (`.yaml`, `.yml`), Bash (`.sh`, `.bash`, `.zsh`), C# (`.cs`), Scala (`.scala`), Lua (`.lua`), Zig (`.zig`), Elixir (`.ex`, `.exs`), Solidity (`.sol`), Rust (`.rs`), Go (`.go`), Java (`.java`), C (`.c`, `.h`), C++ (`.cpp`, `.hpp`, `.cc`, `.cxx`), Ruby (`.rb`), Swift (`.swift`), Kotlin (`.kt`), and PHP (`.php`).
  - **Native Markdown Parser (`markdown-it`)**: Markdown (`.md`, `.markdown`, `.mdx`) document structure (sections, headings, code blocks).
  - **Polyglot `codedb outline` Fallback**: Secondary fail-safe for supported compiled languages (`.rs`, `.go`, `.java`, `.c`, `.cpp`, `.rb`, `.swift`, `.kt`, `.php`) if WASM grammar is unavailable in host environment.
  - **Fail-Closed Boundary**: Unsupported extensions (e.g. `.dart` due to ABI 15 incompatibility, `.sql`) and dialect extensions (`.jsonc`, `.json5`) fail closed with `UNSUPPORTED_LANGUAGE`.
- **Repo-Wide Call Graph & Symbol Search (`waymark ask "<symbol>"`)**:
  - Indexed via `@paragon-ux/codedb-core` across `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.rb`, `.swift`, `.kt` (plus partial `.c`/`.cpp`/`.php`). Note: `.mjs`, `.cjs`, `.mts`, and `.cts` are supported via Single-File Tree-Sitter AST (`--path`) and Tiers 2–4.
- **Language-Agnostic Tiers (Tiers 2, 3, and 4)**:
  - **Tier 2 (`PrefixTrie` Path Router)**, **Tier 3 (`fzf` Fuzzy Matcher)**, and **Tier 4 (`.waymark/memory` BM25 Consensus Memory & 5-Facet Semantic Repo Map)** operate across **all** repository files regardless of language.

---

## Comprehensive Documentation

For complete technical references, architectural specifications, and benchmark analyses, visit our **[Zensical Documentation Site](https://paragon-ux.github.io/waymark-engine/)**:

- 📖 **[Getting Started](docs/getting-started.md)**: Installation, CLI flags, background daemon, and the Live REPL Observer.
- 🏗️ **[4-Tier Architecture](docs/architecture.md)**: Deep dive into AST call graphs, literal paths, Junegunn Choi `fzf`, and BM25 consensus.
- 🔌 **[Model Context Protocol (MCP)](docs/mcp.md)**: Two-Verb interface (<450 tokens), setup for Google Antigravity, Claude Desktop, and Cursor.
- 💻 **[CLI & Command Registry](docs/commands.md)**: Full canonical command reference, `waymark memory` action catalog, and exit codes.
- 🧭 **[Examples](examples/README.md)**: Recorded runs of the `architectural-map`, `explore-subsystem`, and `bootstrap-semantic-map` MCP prompts against this repository.
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
