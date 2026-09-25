# Waymark Engine

[![npm version](https://img.shields.io/npm/v/waymark-engine)](https://www.npmjs.com/package/waymark-engine)
[![CI](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml/badge.svg)](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml)
[![tests](https://img.shields.io/badge/tests-39%2F39-brightgreen)](https://github.com/paragon-ux/waymark-engine)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![recall](https://img.shields.io/badge/recall-lexical%20BM25%20(no%20embeddings)-informational)](https://github.com/paragon-ux/capn-hook)

Ask your codebase a question in plain English. Get an exact answer — file,
symbol, and line span — in milliseconds, without re-reading thousands of tokens.

Built for AI coding agents: one-shot discovery, no plugin choice, no index to
build, no embeddings, no daemon.

| You ask | You get |
| :--- | :--- |
| *"Who calls `verifyToken`?"* | Every caller, exact line numbers, 100% precision |
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
#   <name> must be an exact identifier (case-sensitive). If no codedb hit, the
#   query falls through to semantic. Run `waymark-context` to see this contract.
waymark-ask "Who calls verifyHop?"
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

## Commands

| Wrapper | Umbrella CLI | Action |
| :--- | :--- | :--- |
| `waymark` | — | umbrella CLI (all subcommands) |
| `waymark-init` | `waymark init` | initialize the lexical Capn store |
| `waymark-ask` | `waymark ask "<q>"` | two-phase question router |
| `waymark-discover` | `waymark discover-symbols --path <f>` | AST symbol discovery |
| `waymark-chart` | `waymark chart --question <q> --answer <a> --files <f>` | chart into Capn memory (prunes stale siblings first) |
| `waymark-unchart` | `waymark unchart <id>` | delete one entry |
| `waymark-bust` | `waymark bust <path>` | delete entries backed by one file |
| `waymark-prune` | `waymark prune` | delete stale entries |
| `waymark-list` | `waymark list` | list charted entries (prunes stale first) |
| `waymark-context` | `waymark context` | print the ask-first contract |
| `waymark-mcp` | `waymark mcp` | start the stdio MCP server |

Env: `WAYMARK_CAPN_PROFILE` (`capn-cli` | `none`, default `capn-cli`),
`WAYMARK_CAPN_EXECUTABLE` (optional override; default: the bundled
`@paragon-ux/capn-hook` CLI run in-process). Works with or without a Git repository —
`repoRoot()` resolves `git rev-parse --show-toplevel` and falls back to the process cwd.

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

## Integrity primitives

Retained standalone from the continuity layer, because they are the cheapest
tamper-evidence primitives for later integration:

- `verifyHop(root, hop, maxWindows)` — hash-pinned span verification
  (FRESH / MOVED / STALE) with bounded relocation windows.
- `anchorForRange(root, path, range)` — full-file hash + normalized span hash +
  structural signature. Pin "this span said X" to a later integrity check.

## MCP (stdio)

```json
{
  "mcpServers": {
    "waymark": { "command": "waymark-mcp" }
  }
}
```

Tools: `capn_ask`, `capn_chart`, `waymark_discover_symbols`. Resource: `capn://status`.

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
