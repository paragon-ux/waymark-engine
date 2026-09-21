# Waymark Engine — agent guide

Waymark Engine is a two-phase discovery engine for one-shot code questions: an in-process
Tree-sitter WASM AST for structural queries, and Capn charted memory (lexical BM25, no
embeddings, via the bundled `@paragon-ux/capn-hook` fork) for semantic recall. A clean
miss is a miss — never a guess.

## Working on this repo

```bash
npm ci          # install (bundled capn fork included)
npm run verify  # build + full node test suite
```

Invariants:

- Semantic recall must stay deterministic: the adapter refuses any store that is
  uninitialized (`CAPN_STORE_UNINITIALIZED`) or in embedding mode
  (`CAPN_NON_DETERMINISTIC_MODE`). Do not weaken that guard.
- The router must miss cleanly rather than fabricate an answer.
- External tools are invoked with explicit argv arrays (never a shell) and bounded
  output. Keep `WAYMARK_CAPN_EXECUTABLE` as an escape hatch, but the bundled fork is
  the default and the only tested path.
- Tests cover both success and fail-closed paths. `npm run verify` must stay green.

## Using the engine

```bash
npm install -g waymark-engine
waymark-init                                     # one-time lexical store init per repo (or: waymark init)

waymark-ask "Who calls verifyHop?"               # AST answer, no external process
waymark-ask "How does authentication work?"      # charted-memory answer or miss
waymark-discover --path src/index.ts
waymark-chart --question "<q>" --answer "<a>" --files "<a,b>"
waymark-unchart <id>   waymark-bust <path>   waymark-prune
waymark-list           waymark-context      waymark-mcp
```

## Library

`import { ask, discoverSymbolsInFile, detectAstIntent, verifyHop, anchorForRange } from "waymark-engine";`
