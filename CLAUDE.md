# CLAUDE.md — Waymark Engine

Waymark Engine is a four-tier symbolic and semantic discovery engine for one-shot code questions:
1. **Tier 1: AST Structural** — deterministic codedb call graph (`@paragon-ux/codedb-core` v1.1.0, resolved and fail-closed).
2. **Tier 2: Literal Path Router** — exact and substring path resolution with zero-hallucination fail-closed defense.
3. **Tier 3: Deterministic Fuzzy Matcher** — embedded Junegunn Choi `fzf` (`algo.go`) two-pass scoring.
4. **Tier 4: Charted Memory** — lexical BM25 repository consensus memory via `@paragon-ux/capn-hook`.
5. **Single-File Structured AST** — precise tree-sitter class, method, function, and type extraction for TypeScript and Python.

When structural and literal tiers miss, the **Discovery Junction** evaluates syntactic candidate signals and emits an inspectable recommendation (`status: "junction"`) with machine-readable continuation instructions. Misses fall through cleanly; the router never guesses.

---

## Developer Loop

```bash
npm ci
npm run verify   # build + 43-test suite (covers success AND fail-closed paths)
```

---

## Critical Invariants

- **Deterministic recall only**: `assertLexicalStore` fails closed on uninitialized or embedding-mode stores. Never weaken the guard.
- **Fail-closed routing**: The router must miss cleanly (`status: "miss"`) rather than fabricate an answer or speculate.
- **Explicit invocation**: External tools run via explicit argv arrays (no shell), bounded output, hard timeouts.
- **Bundled dependencies**: The bundled `@paragon-ux/capn-hook` and `@paragon-ux/codedb-core` are the default tested executables.
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
  "question": "Who calls handle_message?",
  "root": "C:/path/to/target/project"
}
```

### Available MCP Tools & Capabilities
* `waymark_ask` (alias: `capn_ask`): Answers questions using the 4-tier discovery pipeline. Supports full CLI flag parity: `tier` (`"auto"|"ast"|"path"|"fuzzy"|"capn"`), `auto_resolve`, `timing`, `plain` (~16 tokens), and `daemon`.
* `waymark_discover_symbols`: Discovers structured AST symbols (classes, functions, methods, types) in a single TypeScript or Python file.
* `waymark_chart` (alias: `capn_chart`): Publishes architectural findings and consensus summaries with backing file paths into long-term repository memory.
* `waymark_unchart` (alias: `capn_unchart`): Deletes charted memory entry by ID.
* `waymark_bust` (alias: `capn_bust`): Deletes every charted entry backed by a specific file.
* `waymark_prune` (alias: `capn_prune`): Deletes every charted entry whose backing files changed or vanished.
* `waymark_list` (alias: `capn_list`): Lists all charted consensus memory entries.
* `waymark_context` (alias: `capn_context`): Prints the ask-first charting contract and query syntax rules.
* `waymark_daemon_status`: Inspects resident in-memory background daemon health, PID, address, and uptime.
* Prompts: `explore-subsystem`, `architectural-map`.
* Resources: `capn://status`, `waymark://manifest`.

---

## CLI Usage

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
waymark-daemon [start|stop|restart|status|list|ping]
```

## Library

```typescript
import { ask, discoverSymbolsInFile, detectAstIntent, scoreFzf, rankFzf, verifyHop, anchorForRange } from "waymark-engine";
```
