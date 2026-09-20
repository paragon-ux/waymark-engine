# Waymark Discovery Engine

A single-process, zero-daemon discovery engine that answers one-shot code questions
through a **two-phase router** — no plugin choice, no index to build, no embeddings:

| Phase | Engine | Answers | Properties |
| :--- | :--- | :--- | :--- |
| **Symbolic** | In-process Tree-sitter WASM AST (30+ grammars) | *Who calls `verifySignature`? Where is it declared? What are the entrypoints?* | 100% precision, millisecond-range parses, exact 1-indexed line spans |
| **Semantic** | Capn charted memory (SQLite FTS5 lexical recall, no embedding model) | *How does authentication work here?* | Charted answers with backing file references |

The router decides intent from the question: structural queries (`who calls`, `entrypoints`,
`trace X`) go to the AST; conceptual questions go to charted memory; **misses fall through
cleanly instead of hallucinating**.

## Why this exists

The engine is the extracted discovery half of the original Waymark project (the in-flight
continuity ledger was removed). Its design goal: an agent should never pay 10,000–50,000
tokens of blind re-reading when a sub-second in-process scan answers the question with
exact file, symbol, and line spans — and it should say "miss" rather than guess.

Also retained standalone from the continuity layer, because it is the cheapest
tamper-evidence primitive for later integration:

- `src/integrity.ts` — `verifyHop(root, hop, maxWindows)`: hash-pinned span verification
  (FRESH / MOVED / STALE) with bounded relocation windows.
- `src/paths.ts` — `anchorForRange(root, path, range)`: full-file hash + normalized span
  hash + structural signature. Pin "this span said X" to a later integrity check.

## Quick start

Requires Node.js 22+. No build steps beyond `npm ci && npm run build`.

### CLI

```bash
# One-shot symbol discovery (repository-relative file)
node dist/src/cli.js discover-symbols --path src/example.ts [--language typescript|python]

# Two-phase question router
node dist/src/cli.js ask "Who calls capnChartArgs?"
node dist/src/cli.js ask "Where is function publish declared?"
node dist/src/cli.js ask --profile none "anything"   # deterministic miss (no external calls)

# Chart an answer into Capn memory (profile none = no-op)
node dist/src/cli.js chart --question "<q>" --answer "<a>" --files "a.ts,b.ts"
```

Env: `WAYMARK_CAPN_PROFILE` (`capn-cli` | `none`, default `capn-cli`),
`WAYMARK_CAPN_EXECUTABLE` (default `capn`). The library and CLI work with or without a
Git repository — `repoRoot()` resolves `git rev-parse --show-toplevel` and falls back to
the process cwd.

### MCP (stdio)

```json
{
  "mcpServers": {
    "waymark": {
      "command": "node",
      "args": ["<path-to-waymark>/dist/src/mcp/capnIndex.js"]
    }
  }
}
```

Exposed tools: `capn_ask`, `capn_chart`, `waymark_discover_symbols`.
Resource: `capn://status`.

### Library

```ts
import { detectAstIntent, queryWasmAst } from "./src/discoveryRouter.js";
import { ask } from "./src/capnAdapter.js";
import { discoverSymbolsInFile } from "./src/astExtractor.js";
import { anchorForRange } from "./src/paths.js";
import { verifyHop } from "./src/integrity.js";
```

## Build & verify

```bash
npm ci
npm run verify   # tsc build + node --test dist/test/**/*.test.js
```

## Operating posture

- **Zero runtime dependencies, zero daemons.** AST runs in-process (pure WASM); Capn is
  an external CLI invoked per call (lexical FTS5 recall, `capn init --no-embedding`
  recommended: deterministic, no embedding model, no GPU).
- **Fail closed on integrity, fail open on infrastructure.** `verifyHop` quarantines
  (STALE) spans it cannot prove; a missing Capn chart returns a clean `miss` rather than
  a guess.
- **Real-adapter testing.** The suite exercises the actual capn-hook CLI surface, not a
  protocol fake.
