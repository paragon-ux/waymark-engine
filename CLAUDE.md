# CLAUDE.md — Waymark Engine

Waymark Engine is a four-tier symbolic and semantic discovery engine for one-shot code questions:
1. **Tier 1: AST Structural** — deterministic codedb call graph (`@paragon-ux/codedb-core` ^2.1.1, resolved and fail-closed) supplemented by in-process `web-tree-sitter` indexing for `.mjs`/`.cjs`/`.mts`/`.cts`/`.toml`.
2. **Tier 2: Literal Path Router** — exact and substring path resolution with zero-hallucination fail-closed defense.
3. **Tier 3: Deterministic Fuzzy Matcher** — embedded Junegunn Choi `fzf` (`algo.go`) two-pass scoring.
4. **Tier 4: Charted Memory** — lexical BM25 repository consensus memory via `@paragon-ux/capn-hook`, stored in `.waymark/memory`.
5. **Single-File Structured AST** — precise in-process `web-tree-sitter` and `markdown-it` outline extraction across 23 languages and formats.

When structural and literal tiers miss, the **Discovery Junction** evaluates syntactic candidate signals and emits an inspectable recommendation (`status: "junction"`) with machine-readable continuation instructions. Misses fall through cleanly; the router never guesses.

---

## Developer Loop

```bash
npm ci
npm run verify   # build + full test suite (covers success AND fail-closed paths)
```

---

## Critical Invariants

- **Deterministic recall only**: `assertLexicalStore` fails closed on uninitialized or embedding-mode stores. Never weaken the guard.
- **Fail-closed routing**: The router must miss cleanly (`status: "miss"`) rather than fabricate an answer or speculate.
- **Explicit invocation**: External tools run via explicit argv arrays (no shell), bounded output, hard timeouts.
- **Bundled dependencies**: The bundled `@paragon-ux/capn-hook` and `@paragon-ux/codedb-core` are the default tested executables.
- **Waymark-owned state only**: Everything Waymark writes in a repository goes under `.waymark/` (with `.waymark/.gitignore` = `*`); daemon socket and PID record go to the OS temp dir. Never read or write `.capn/`, which belongs to upstream capn. `memoryStoreDir(root)` (`src/stateDir.ts`) is the only store location, and every capn call passes `--root`/`--store-dir` (`capnStoreArgs`). A capn without those flags is refused with `CAPN_STORE_DIR_UNSUPPORTED`. See `docs/memory-store.md`.
- **CPU & Resource Protection**: `CODEDB_MAX_THREADS` automatically defaults to `max(1, cpus - 1)` so 1 logical core remains free for host responsiveness.

---

## Claude Desktop & Local Stdio MCP Integration

Waymark Engine is fully compliant with the MCP specification (`2026-07-28` modern discovery + `2024-11-05` standard handshake) and supports direct stdio connectivity.

### Configuration for Claude Desktop (`claude_desktop_config.json`)

Add to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

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

*(For local source development, replace `"command": "npx"` with `"command": "node"`, and `"args": ["/path/to/waymark-engine/dist/src/mcp/capnIndex.js"]`).*

### Important: Passing the Target Repository (`root`)
When Claude Desktop runs the MCP server via stdio, the server defaults its working directory to the user's home or workspace. When investigating a repository located elsewhere on disk, always provide the optional `root` parameter in tool calls:

```json
{
  "query": "Who calls handle_message?",
  "root": "C:/path/to/target/project"
}
```

### Available MCP Tools & Capabilities (Two-Verb Interface)
* `waymark_ask` (alias: `capn_ask`): Consolidates 4-tier discovery, bounded call graphs (`depth`, `direction`, `exclude_tests`), batch symbol resolution (`symbols`), single-file AST outlines (`path`, `outline`, `language`), and Semantic Repo Map facet lookups (`facet`). Supports `tier` (`"auto"|"ast"|"path"|"fuzzy"|"capn"`), `auto_resolve`, `timing`, `plain`, and `daemon`.
* `waymark_memory`: Consolidates consensus memory and Semantic Repo Map operations via `action` (`"bootstrap"`, `"status"`, `"chart"`, `"heal"`, `"export"`, `"bust"`, `"prune"`, `"list"`, `"unchart"`, `"init"`, `"context"`, `"evict"`, `"close"`). Supports `plain: true` across all actions.
* *(Legacy verbose tools `waymark_discover_symbols`, `waymark_chart`, `waymark_unchart`, `waymark_bust`, `waymark_prune`, `waymark_list`, `waymark_context`, `waymark_init`, `waymark_map_status`, and `waymark_daemon_status` remain callable and can be listed via `WAYMARK_MCP_VERBOSE=1`)*.
* Prompts: `explore-subsystem` (`query`, `root`), `architectural-map` (`topic`, `root`), `bootstrap-semantic-map` (`root`).
* Resources: `capn://status`, `waymark://manifest`.

---

## CLI Usage

```bash
npm install -g waymark-engine
waymark memory init                              # one-time lexical store init in .waymark/memory

waymark ask "Who calls verifyHop?"               # Tier 1 AST answer
waymark ask "refundOrdr"                         # Discovery Junction (fuzzy recommended, ~92% match)
waymark ask "refundOrdr" -t fuzzy -b             # Isolate Tier 3 with high-resolution timings
waymark ask "refundOrdr" --plain                 # Token-minimal plain text for agents (~16 tokens)
waymark ask "How does authentication work?"      # Tier 4 charted-memory answer or miss
waymark ask --outline --path src/index.ts        # Single-file structured AST outline
waymark memory chart --facet boundaries --question "<q>" --answer "<a>" --files "<a,b>"
waymark memory unchart <id>   waymark memory bust <path>   waymark memory prune
waymark memory list           waymark memory context       waymark mcp
waymark daemon [start|stop|restart|reload|status|list|ping]
```

## Library

```typescript
import { ask, discoverSymbolsInFile, detectAstIntent, scoreFzf, rankFzf, verifyHop, anchorForRange } from "waymark-engine";
```
