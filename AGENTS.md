# Waymark Engine — agent guide

Waymark Engine is a four-tier discovery engine for one-shot code questions:
1. **Tier 1: AST Structural** — deterministic codedb call graph (`@paragon-ux/codedb-core` v1.0.2, resolved and fail-closed).
2. **Tier 2: Literal Path Router** — exact and substring path resolution.
3. **Tier 3: Deterministic Fuzzy Matcher** — embedded Junegunn Choi `fzf` (`algo.go`) two-pass scoring.
4. **Tier 4: Charted Memory** — lexical BM25 repository consensus memory via `@paragon-ux/capn-hook`.

When structural and literal tiers miss, the **Discovery Junction** evaluates syntactic candidate signals and emits an inspectable recommendation (`status: "junction"`) with machine-readable continuation instructions. A clean miss is a miss — never a guess.

## Working on this repo

```bash
npm ci          # install (bundled capn fork included)
npm run verify  # build + full node test suite (39/39 passing)
```

Invariants:

- Semantic recall must stay deterministic: the adapter refuses any store that is
  uninitialized (`CAPN_STORE_UNINITIALIZED`) or in embedding mode
  (`CAPN_NON_DETERMINISTIC_MODE`). Do not weaken that guard.
- The router must miss cleanly rather than fabricate an answer.
- External tools are invoked with explicit argv arrays (never a shell) and bounded
  output. Keep `WAYMARK_CAPN_EXECUTABLE` as an escape hatch, but the bundled fork is
  the default and the only tested path.
- Fuzzy matching is zero-dependency and strictly deterministic.
- Tests cover both success and fail-closed paths. `npm run verify` must stay green.

## Using the engine

```bash
npm install -g waymark-engine
waymark-init                                     # one-time lexical store init per repo (or: waymark init)

waymark-ask "Who calls verifyHop?"               # Tier 1 AST answer, no external process
waymark-ask "refundOrdr"                         # Discovery Junction (fuzzy recommended, ~92% match)
waymark-ask "refundOrdr" -t fuzzy -b             # Isolate Tier 3 with high-resolution timings
waymark-ask "refundOrdr" --plain                 # Token-minimal plain text for agents (~16 tokens)
waymark-ask "How does authentication work?"      # Tier 4 charted-memory answer or miss
waymark-discover --path src/index.ts
waymark-chart --question "<q>" --answer "<a>" --files "<a,b>"
waymark-unchart <id>   waymark-bust <path>   waymark-prune
waymark-list           waymark-context      waymark-mcp
```

## Documentation & Specifications

The canonical specifications, contracts, and registries are maintained under [`/spec`](spec/):
- [`spec/README.md`](spec/README.md) — Architectural overview & invariants
- [`spec/command-registry.md`](spec/command-registry.md) — Canonical CLI commands, flags, Discovery options, and MCP tools
- [`spec/error-codes.md`](spec/error-codes.md) — Status envelopes, error codes, miss codes, and exit codes
- [`spec/metrics.md`](spec/metrics.md) — Standardized tier metrics schema and benchmarks
- [`CHANGELOG.md`](CHANGELOG.md) — Release notes and migration guide

## Library

`import { ask, discoverSymbolsInFile, detectAstIntent, scoreFzf, rankFzf, verifyHop, anchorForRange } from "waymark-engine";`

