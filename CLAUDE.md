# CLAUDE.md — Waymark Engine

Two-phase discovery engine for one-shot code questions: the deterministic codedb call
graph (`@paragon-ux/codedb-core`, resolved and fail-closed) for structural queries, Capn
charted memory (lexical BM25, no embeddings — the bundled `@paragon-ux/capn-hook` fork)
for semantic recall. Misses fall through cleanly; the router never guesses.

## Dev loop

```bash
npm ci
npm run verify   # build + 17-test suite (success AND fail-closed paths)
```

## Invariants

- Deterministic recall only: `assertLexicalStore` fails closed on uninitialized or
  embedding-mode stores. Never weaken the guard.
- External tools run via explicit argv arrays (no shell), bounded output, hard timeouts.
- The bundled fork is the default executable; `WAYMARK_CAPN_EXECUTABLE` is an override,
  not a supported drift path.

## Usage (npm-first)

```bash
npm install -g waymark-engine
waymark-init                                    # one-time lexical store init per repo (or: waymark init)

waymark-ask "Who calls verifyHop?"
waymark-discover --path src/index.ts
waymark-chart --question "<q>" --answer "<a>" --files "<a,b>"
waymark-unchart <id> | waymark-bust <path> | waymark-prune | waymark-list | waymark-context
waymark-mcp   # stdio MCP server
```

Library: `import { ask, discoverSymbolsInFile, verifyHop, anchorForRange } from "waymark-engine";`
