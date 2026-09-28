# Waymark Engine

[![npm version](https://img.shields.io/npm/v/waymark-engine)](https://www.npmjs.com/package/waymark-engine)
[![CI](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml/badge.svg)](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml)
[![tests](https://img.shields.io/badge/tests-60%2F60-brightgreen)](https://github.com/paragon-ux/waymark-engine)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![recall](https://img.shields.io/badge/recall-lexical%20BM25%20(no%20embeddings)-informational)](https://github.com/paragon-ux/capn-hook)

Ask your codebase a question in plain English. Get an exact answer — file,
symbol, and line span — in milliseconds, without re-reading thousands of tokens.

Built for AI coding agents: one-shot discovery, zero required background
processes (no daemon required; optional resident daemon for warm
sub-millisecond lookups), no vector index, no embeddings.

| You ask | You get |
| :--- | :--- |
| *"Who calls `verifyToken`?"* | Every caller, exact line numbers, zero false positives (fail-closed on ambiguity) |
| *"Where is `PaymentService` declared?"* | File path, line span, structural signature |
| *"How does authentication work?"* | The files that answer it — charted, staleness-checked |
| *"Entrypoints"* | The architecture's front doors |

Questions route through deterministic tiers: structural questions hit the
deterministic codedb structural index + resolved call graph (fail-closed, exact
match); literal filename/path queries (`sample.ts`, `src/api/webhooks.ts`,
`.gitignore`) short-circuit a zero-dependency in-memory matcher; and when both
miss, the engine enters the **Discovery Junction** (Tier 3 Junegunn Choi `fzf`
Smith-Waterman fuzzy lexical match ⇄ Capn BM25 charted semantic memory). Misses
fall through cleanly — the engine says "I don't know" rather than hallucinating.

## Why the symbolic tier uses a forked structural engine

The structural phase previously used an in-process Tree-sitter WASM walker. A
code review exposed three defects that produced silent misses and
confidently-wrong answers:

- **`src/`-only scanning** — code in `lib/`, `crates/*/src/`, or the repo root was missed.
- **Bare-name call-graph collisions** — `Builder.build()` from unrelated classes merged into one bucket.
- **Node-type string-matching gaps** — Rust `function_item` and Go `method_declaration` were never extracted.

The fix is a fork of codedb (`@paragon-ux/codedb-core`), stripped to its
deterministic structural core (the same play as the capn-hook fork). It scans the
repo root, resolves the call graph fail-closed, and surfaces file-scoped
candidates on a name collision instead of merging or guessing.
`discoverSymbolsInFile` keeps `web-tree-sitter` for precise single-file symbol
discovery (classes / methods / interfaces / types).

## Why this exists

The engine is the extracted discovery half of the original Waymark project (the in-flight
continuity ledger was removed). Its design goal: an agent should never pay 10,000–50,000
tokens of blind re-reading when a sub-second deterministic scan answers the question with
exact file, symbol, and line spans — and it should say "miss" rather than guess.

The semantic phase is **deterministic by construction**: it invokes the bundled
BM25 store as a runtime dependency and refuses any store configured for
embedding mode (`CAPN_STORE_UNINITIALIZED` / `CAPN_NON_DETERMINISTIC_MODE`,
fail-closed).

## Performance & Latency Model

Waymark Engine is architected around transparent latency boundaries:
- **Cold CLI Queries (Stateless):** ~1.5s–4s on 20,000+ file codebases (e.g. Grafana). Pays initial filesystem discovery and node process initialization.
- **Warm Resident Daemon Queries:** `<10ms` for literal paths via `PrefixTrie`, `~150–250ms` for structural AST queries (delivering a **21x–100x speedup** on large repositories).
- **In-Process Library API:** Direct execution in `<10ms` without process overhead.

## Install

Requires Node.js 22+.

```bash
# Global CLI + explicit wrapper commands
npm install -g waymark-engine

# Per-project (library + npx access)
npm install waymark-engine
```

The engine ships prebuilt (`dist/`) — no build step for consumers.

## Quick start

```bash
# Initialize the lexical Capn store once per repository (bundled fork)
waymark-init                          # or: waymark init

# One-shot symbol discovery (repository-relative file)
waymark-discover --path src/index.ts [--language typescript|python]

# Three-tier question router (codedb, literal filename/path, then BM25 memory)
# Use exact phrasing for the symbolic (codedb) phase:
#
#   Symbolic (exact codedb match, resolved call graph):
#     "Who calls <name>?" / "Callers of <name>" / "Callees of <name>" / "Trace <name>"
#     "What calls <name>?" / "Which functions call <name>?" / "Call hierarchy for <name>"
#     "Where is <name> declared?" / "Where is <name> defined?" / "Where is <name> implemented?"
#     "Definition of <name>" / "Declaration of <name>" / "Implementation of <name>"
#     "Find method <name>" / "Find function <name>" / "Find symbol <name>"
#     "Line numbers of <name>" / "Method signature of <name>" / "Locate symbol <name>"
#     "Entrypoints" / "Architecture" / "Overview of the repo" / "Hotspots"
#
#   Literal (filename/path, exact match):
#     "sample.ts" / "src/api/webhooks.ts" / ".gitignore"
#
#   Semantic (BM25, charted memory):
#     Any conceptual question, e.g. "How does authentication work?"
#
#   <name> must be an exact identifier (case-sensitive). If codedb misses, the
#   engine fails closed or enters the Discovery Junction — it never silently guesses.
waymark-ask "Who calls verifyHop?"            # Tier 1 exact structural call graph
waymark-ask "Who calls verifyHop?" --depth 2 --exclude-tests  # Bounded multi-hop BFS
waymark-ask "verifyHop" --dev                 # Dev Mode: timing breakdown + invariant telemetry
waymark-symbols verifyHop ask PrefixTrie      # Concurrent multi-symbol batch discovery
waymark-ask "refundOrdr"                      # Discovery Junction: fuzzy-lexical recommended (~92% match)
waymark-ask "refundOrdr" -t fuzzy -b          # isolate fuzzy tier with high-resolution timings
waymark-ask "refundOrdr" --plain              # token-minimal plain text for agents (~16 tokens)
waymark-ask "How does authentication work in this project?"

# Chart an answer so the next session skips the search
waymark-chart --question "Where are payment webhooks handled?" \
  --answer "src/api/webhooks.ts; Stripe handler owns signature checks." \
  --files "src/api/webhooks.ts,src/billing/handlers/stripe.ts"

waymark-list                          # charted entries
waymark-unchart <id>                  # delete one entry
waymark-bust src/api/webhooks.ts      # delete entries backed by a file
waymark-prune                         # explicit prune (also runs automatically on list/chart/ask)
waymark-context                       # print the ask-first contract
```

Without a global install, prefix any wrapper with `npx --package waymark-engine`
(e.g. `npx --package waymark-engine waymark-ask "..."`), or use the umbrella CLI:
`waymark <command>`.

Run `waymark help` (or bare `waymark`) for the full command list, or
`waymark-context` for the routing contract showing which phrasing patterns
route to the symbolic vs semantic phase.

## Commands & Subcommand Registry

Waymark Engine provides a consolidated **Two-Verb Architecture** ensuring 100% parity across CLI, MCP, and programmatic APIs.

### 1. Canonical Verbs

| Command | Category | Description |
| :--- | :--- | :--- |
| `waymark ask "<q>"` | **Read & Discovery** | 4-tier discovery (AST structural call graph, literal path, deterministic fuzzy, BM25 memory, multi-symbol, file outlines). |
| `waymark memory <action>` | **Write & Lifecycle** | Consensus memory manager: bootstrap, status, chart, heal, export, bust, prune, list, unchart, init, context. |
| `waymark daemon [cmd]` | **Daemon Operations** | Background resident codedb server (`start`, `stop`, `restart`, `reload`, `status`, `list`, `ping`). |
| `waymark repl` | **Diagnostic REPL** | Interactive diagnostic shell and hardened test battery runner with live daemon IPC. |
| `waymark mcp` | **MCP Server** | Launches standard stdio MCP discovery server. |
| `waymark init` | **Store Init** | One-time deterministic lexical store initialization (`.capn`). |

*(Legacy discrete wrappers `waymark-ask`, `waymark-chart`, `waymark-bootstrap`, `waymark-map`, `waymark-symbols`, `waymark-discover`, etc. remain available as aliases).*

---

### 2. Subcommand Registry (`waymark memory`)

All stateful operations and repository consensus memory lifecycle actions are consolidated under `waymark memory` (CLI) and `waymark_memory` (MCP):

| Action | CLI Command | MCP Tool Call (`waymark_memory`) | Purpose |
| :--- | :--- | :--- | :--- |
| **`bootstrap`** | `waymark memory bootstrap [--dry-run]` | `{"action": "bootstrap", "dry_run": false}` | Two-pass Semantic Repo Map discovery and SQLite storage. |
| **`status`** | `waymark memory status [--plain]` | `{"action": "status", "plain": true}` | Inspect Semantic Repo Map health, completion ratio, and drift. |
| **`chart`** | `waymark memory chart --question <q> --answer <a> --files <f>` | `{"action": "chart", "question": "...", "answer": "...", "files": [...]}` | Publish architectural knowledge into long-term consensus memory. |
| **`heal`** | `waymark memory heal` | `{"action": "heal"}` | Reconcile code changes, verify anchors, and refresh SQLite ledger. |
| **`export`** | `waymark memory export [--format md\|json]` | `{"action": "export", "format": "md"}` | Export consensus architecture map as Markdown or JSON. |
| **`bust`** | `waymark memory bust <path>` | `{"action": "bust", "file": "src/daemon.ts"}` | Invalidate all consensus memories citing a changed file. |
| **`prune`** | `waymark memory prune` | `{"action": "prune"}` | Cleanly remove stale entries whose backing files vanished. |
| **`list`** | `waymark memory list` | `{"action": "list"}` | List all charted consensus memory entries. |
| **`unchart`** | `waymark memory unchart <id> [--if-exists]` | `{"action": "unchart", "id": "<hex>", "if_exists": true}` | Delete a specific memory entry by hex ID. |
| **`init`** | `waymark memory init` | `{"action": "init"}` | Initialize deterministic lexical store (`.capn`). |
| **`context`** | `waymark memory context` | `{"action": "context"}` | Retrieve ask-first routing contract and syntax guidelines. |

---

### Query Flags & Options (`waymark ask`)
- `--depth <1..5>`: Bounded BFS call graph traversal depth (default: 1).
- `--direction <callers|callees|both>`: Traversal directionality (default: both).
- `--exclude-tests`: Suppress test files (`tests/`, `*_test.*`, `*.spec.*`) from call graphs (up to 94% token savings).
- `--path <file>`: Extract structured tree-sitter AST outline for a single file.
- `--symbols <a,b>`: Inspect batch symbol definitions concurrently across the codebase.
- `--facet <f>`: Scope query to an architectural domain (`lifecycle`, `data_state`, `boundaries`, `invariants`, `failure`, or `status`).
- `--plain` (`-p`): Emit token-minimal plain text formatted for LLM context preservation (~16-38 tokens).
- `--tier <auto|ast|path|fuzzy|capn>` (`-t`): Force a specific discovery tier or bypass junction fallthrough.
- `--timing` (`-b`): Surface high-resolution sub-millisecond per-tier execution timings.
- `--daemon` (`-d`): Route queries through the resident in-memory background daemon IPC.
- `--dev`: Enable Dev Mode with per-tier timing breakdown and runtime invariant assertions.

Env: `WAYMARK_CAPN_PROFILE` (`capn-cli` | `none`, default `capn-cli`),
`WAYMARK_CAPN_EXECUTABLE` (optional override; default: bundled lexical-only `@paragon-ux/capn-hook` CLI). Works with or without a Git repository — `repoRoot()` resolves `git rev-parse --show-toplevel` and falls back to process cwd.

## Library API

```ts
import {
  ask,                  // two-phase router (codedb -> lexical charted memory)
  discoverSymbolsInFile,// one-file AST symbol discovery
  detectAstIntent,      // structural vs semantic intent
  publish, unchart, bust, prune, listEntries, context, // wrapped capn surface
  verifyHop,            // hash-pinned span verification (FRESH/MOVED/STALE)
  anchorForRange,       // tamper-evidence primitive for a file range
  assertLexicalStore,   // fail-closed determinism guard
  WaymarkError,
} from "waymark-engine";

const hit = await ask(repoRoot(), "capn-cli", "", "Who calls verifyHop?");
// { provider: "codedb", status: "hit", result: "function: verifyHop\ncallers: ..." }
```

## Tamper-Evidence & Integrity Primitives

Retained standalone from the continuity layer for tamper-evidence verification:
- `verifyHop(root, hop, maxWindows)` — hash-pinned span verification (FRESH / MOVED / STALE) with bounded relocation windows.
- `anchorForRange(root, path, range)` — full-file SHA-256 + normalized span hash + structural signature to pin "this span said X" against code modifications.

## Language Support & Polyglot Fallback Matrix

| Language | Primary Engine | Extracted Symbols |
| :--- | :--- | :--- |
| **TypeScript / JavaScript** | Native Tree-Sitter (`web-tree-sitter`) | Classes, methods, functions, interfaces, type aliases |
| **Python** | Native Tree-Sitter (`web-tree-sitter`) | Classes, methods, functions, decorated definitions |
| **Rust, Go, C++, Java, C#** | Polyglot Codedb Outline Fallback | Functions, methods, structs, traits, interfaces |

Non-TypeScript and non-Python files automatically fall back to `codedb outline` rather than throwing errors.

## Model Context Protocol (MCP) Integration

Waymark Engine provides first-class stdio integration for AI coding agents (Claude Desktop, Google Antigravity, Cursor, Zed, Continue, and Glama).

### Configuration (`mcp_config.json` / `claude_desktop_config.json`)

By default, Waymark exposes the ultra-lean **Two-Verb Surface** (`waymark_ask` + `waymark_memory`), consuming **<450 tokens** of tool overhead in agent context (compared to 3,000+ tokens for flat tool sprawl):

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
*(Optional: set `"WAYMARK_MCP_VERBOSE": "1"` only if you wish to expose the 11 legacy granular tools in `tools/list`).*

### Exposed MCP Surface

1. **`waymark_ask` (Read & Discovery)**:
   * **General 4-Tier Discovery**: `{"question": "Who calls verifyHop?", "plain": true}`
   * **Multi-Hop Call Graph**: `{"question": "verifyHop", "depth": 2, "direction": "callers", "plain": true}`
   * **Single-File Structured AST**: `{"path": "src/types.ts", "plain": true}`
   * **Batch Symbol Resolution**: `{"symbols": ["McpServer", "DiscoveryRouter"], "plain": true}`
   * **Semantic Repo Map Domain Query**: `{"facet": "invariants", "question": "path rules", "plain": true}`
   * **Inspect Semantic Repo Map Health**: `{"facet": "status", "plain": true}`

2. **`waymark_memory` (Consensus Memory & Subcommands)**:
   Dispatches maintenance and lifecycle subcommands via the **`action`** argument:
   * **`bootstrap`**: Two-pass semantic map onboarding into SQLite (`{"action": "bootstrap", "dry_run": false}`)
   * **`status`**: Health and drift inspect (`{"action": "status", "plain": true}`)
   * **`chart`**: Publish architectural consensus (`{"action": "chart", "facet": "boundaries", "question": "...", "answer": "...", "files": ["..."]}`)
   * **`heal`**: Reconcile Semantic Repo Map anchors (`{"action": "heal"}`)
   * **`export`**: Export map as Markdown or JSON (`{"action": "export", "format": "md"}`)
   * **`bust`**: Invalidate memories for changed file (`{"action": "bust", "file": "src/daemon.ts"}`)
   * **`prune`**: Cleanly remove stale entries (`{"action": "prune"}`)
   * **`list`**: List all consensus memories (`{"action": "list"}`)
   * **`unchart`**: Delete entry by ID (`{"action": "unchart", "id": "3a8f1b2c", "if_exists": true}`)
   * **`init`**: Initialize lexical store (`{"action": "init"}`)
   * **`context`**: Retrieve charting contract (`{"action": "context"}`)

*(All legacy tool calls such as `waymark_chart` and `waymark_bust` remain fully supported at runtime if invoked directly).*

* **Resources:**
  * `waymark://manifest`: Engine capabilities, tier metadata, and versioning.
  * `capn://status`: Memory store configuration and adapter status.
* **Prompts:**
  * `explore-subsystem`: Guided 4-tier exploration workflow for a concept or module.
  * `architectural-map`: Structured call-graph and consensus memory mapping workflow.
  * `bootstrap-semantic-map`: Two-pass bootstrap agent prompt for repository onboarding.

## Routing

Four deterministic tiers coordinated by the Discovery Junction:

1. **Tier 1: AST Structural (`codedb`)** — exact identifier, definition, and call-graph queries hit the deterministic codedb structural index + resolved, fail-closed call graph ([`@paragon-ux/codedb-core`](https://github.com/paragon-ux/codedb-core) v1.0.2). Ambiguity surfaces file-scoped candidates rather than guessing.
2. **Tier 2: Literal Path Router** — bare filenames and paths (`sample.ts`, `src/api/webhooks.ts`, `.gitignore`, `Dockerfile`) resolve against an in-memory path index, fail-closed on ambiguity.
3. **Tier 3: Deterministic Fuzzy Matcher** — embedded Junegunn Choi `fzf` (`algo.go`) two-pass Smith-Waterman scoring with boundary bonuses, camelCase detection, and path-proximity boosts. Zero external dependencies.
4. **Tier 4: Charted Memory (Capn BM25)** — conceptual and narrative questions hit long-term lexical consensus memory ([`@paragon-ux/capn-hook`](https://github.com/paragon-ux/capn-hook)).

When structural and literal tiers miss, the **Discovery Junction** evaluates syntactic candidate signals and emits an inspectable recommendation (`status: "junction"`) with machine-readable continuation instructions (`tool: "waymark_ask"` and `cliCommand`), allowing agents to force alternative paths without guessing.

A clean miss is a miss — the engine never guesses.

## Specifications & Documentation

The canonical technical specifications, contracts, and benchmark metrics for Waymark Engine are maintained under [`/spec`](spec/):

- [`spec/README.md`](spec/README.md) — Architectural map, tier index, and core design invariants
- [`spec/tier-1-ast.md`](spec/tier-1-ast.md) — Tier 1 AST structural call graphs and definitions
- [`spec/tier-2-path.md`](spec/tier-2-path.md) — Tier 2 literal filename and path router
- [`spec/tier-3-fuzzy.md`](spec/tier-3-fuzzy.md) — Tier 3 deterministic Junegunn Choi `fzf` matcher
- [`spec/tier-4-semantic.md`](spec/tier-4-semantic.md) — Tier 4 Capn lexical BM25 consensus memory
- [`spec/discovery-junction.md`](spec/discovery-junction.md) — Discovery Junction recommendation state machine
- [`spec/command-registry.md`](spec/command-registry.md) — Canonical CLI commands, flags, Discovery options, and MCP tools
- [`spec/error-codes.md`](spec/error-codes.md) — Status envelopes, error codes, miss codes, and exit codes
- [`spec/metrics.md`](spec/metrics.md) — Measurable operational metrics schema and comparative benchmarks
- [`CHANGELOG.md`](CHANGELOG.md) — Release history and breaking changes across versions

## Related

- [`@paragon-ux/capn-hook`](https://github.com/paragon-ux/capn-hook) — the lexical-only
  fork of [CyrusNuevoDia/capn-hook](https://github.com/CyrusNuevoDia/capn-hook) that
  powers the semantic phase (BM25 recall, no embeddings, no hooks).
- [`@paragon-ux/codedb-core`](https://github.com/paragon-ux/codedb-core) — the
  deterministic structural fork of [justrach/codedb](https://github.com/justrach/codedb)
  that powers the symbolic phase (resolved call graph, no embeddings, no telemetry,
  no daemon). `discoverSymbolsInFile` retains `web-tree-sitter` for precise
  single-file structured symbol discovery.

## License

MIT. See [LICENSE](LICENSE) for the full text and attribution to the Waymark and
capn-hook projects.
