# Model Context Protocol (MCP) Integration

Waymark Engine implements the Model Context Protocol (MCP) dual-era specification (`2026-07-28` modern discovery + `2024-11-05` standard handshake) over stdio.

- **Supported revisions**: `2026-07-28`, `2025-11-25`, `2024-11-05` (advertised by `server/discover`).
- **`2026-07-28` results**: every result carries `resultType` and `_meta["io.modelcontextprotocol/serverInfo"]`; list and read results carry `ttlMs` and `cacheScope`. A request whose `_meta` protocol version is unsupported fails with `-32022`.
- **Startup**: the server answers the handshake immediately and indexes nothing. The first tool call on a repository (its `root` argument, else the server's working directory, resolved to the Git top level) warms a resident daemon for it in the background; that call and any made during warm-up take the cold path. A repository with more than 50,000 files, or whose file walk takes over 10 seconds, is never warmed. At most two repositories stay warm; the least recently used is stopped. See [Warm-up](#resident-daemon-warm-up).

---

## The Two-Verb Interface (<450 Tokens)

Traditional MCP servers register dozens of granular tools, bloating the agent's context window by 3,000+ tokens before the user even types a prompt. 

Waymark Engine consolidates all capabilities into **two canonical verbs**, reducing tool definition overhead to **<450 tokens**:

1. **`waymark_ask`**: Read & Discovery (AST structural graphs, literal paths, fuzzy matching, BM25 memory, batch symbols, file outlines).
2. **`waymark_memory`**: Write, Bootstrap & Lifecycle Maintenance (consensus SQLite memory, anchor healing, cache busting, pruning).

---

## Tool 1: `waymark_ask` (Read & Discovery)

Consolidates all discovery operations into a unified query interface:

### 1. Natural Language / 4-Tier Discovery
```json
{
  "name": "waymark_ask",
  "arguments": {
    "question": "Who calls verifyHop?",
    "plain": true
  }
}
```

### 2. Multi-Hop BFS Call Graph
```json
{
  "name": "waymark_ask",
  "arguments": {
    "question": "verifyHop",
    "depth": 2,
    "direction": "callers",
    "exclude_tests": true,
    "plain": true
  }
}
```

### 3. Batch Symbol Resolution
```json
{
  "name": "waymark_ask",
  "arguments": {
    "symbols": ["McpServer", "DiscoveryRouter", "FuzzyMatcher"],
    "plain": true
  }
}
```

### 4. Single-File AST Outline
```json
{
  "name": "waymark_ask",
  "arguments": {
    "path": "src/types.ts",
    "outline": true,
    "plain": true
  }
}
```

### 5. Semantic Repo Map Architectural Facet Query
```json
{
  "name": "waymark_ask",
  "arguments": {
    "facet": "invariants",
    "question": "path normalization rules",
    "plain": true
  }
}
```

---

## Tool 2: `waymark_memory` (Write & Maintenance)

Dispatches consensus memory and lifecycle operations using the **`action`** parameter:

| Action | Example Arguments | Description |
| :--- | :--- | :--- |
| **`bootstrap`** | `{"action": "bootstrap", "plain": true}` | Collect source excerpts as unverified drafts for every missing or drifted facet, from the repository's own entry and source files. Each excerpt is a line that names the facet's keywords, or an exported declaration when the file has none; imports and comments are skipped. It does not initialize the memory store or publish claims; verify and chart supported conclusions explicitly. |
| **`status`** | `{"action": "status", "plain": true}` | Inspect Semantic Repo Map completion ratio, active facets, and file drift. |
| **`chart`** | `{"action": "chart", "facet": "boundaries", "question": "IPC Protocol", "answer": "Named pipes on Windows...", "files": ["src/daemon.ts"]}` | Record architectural knowledge into consensus memory. Same bounds and facet rules as the CLI: question 1-240 characters, answer 1-4000, a facet from the five ids (also accepted as a `[FACET:<ID>]` tag in any case) with at least one backing file; charting a facet replaces its earlier entry. Returns `{ waymark: 1, kind: "chart", published, ... }`. |
| **`heal`** | `{"action": "heal", "dry_run": true}` | Unchart drifted facet entries (backing file vanished or changed) and collect replacement drafts; `dry_run: true` only reports what it would unchart. Active entries are unchanged. |
| **`export`** | `{"action": "export", "format": "md"}` | Export consensus architecture map as Markdown or JSON. |
| **`bust`** | `{"action": "bust", "file": "src/daemon.ts"}` | Invalidate all consensus memories backed by a changed file. |
| **`prune`** | `{"action": "prune"}` | Cleanly remove stale entries whose backing files vanished. |
| **`list`** | `{"action": "list"}` | List all charted repository consensus memories. |
| **`unchart`** | `{"action": "unchart", "id": "3a8f1b2c", "if_exists": true}` | Delete a specific memory entry by hex ID. |
| **`init`** | `{"action": "init"}` | One-time deterministic lexical store initialization (`.waymark/memory`). |
| **`context`** | `{"action": "context"}` | Retrieve ask-first routing contract and syntax guidelines. |
| **`evict`** / **`close`** | `{"action": "close", "all": false}` | Release the root's resident codedb instance and the server's warm daemon for it (`all: true`: every root). Never starts a daemon. |

With `plain: true`, every action returns plain text; `export` with `format: "json"` still returns JSON.

---

## Configuration Snippets

### 1. Google Antigravity (`~/.gemini/config/mcp_config.json`)
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

### 2. Claude Code and the Claude Desktop Code tab (`~/.claude.json`)
```bash
claude mcp add waymark-engine --scope user -e CODEDB_ALLOW_TEMP=1 -- npx -y waymark-engine
claude mcp get waymark-engine   # expect: Connected
```
Claude Code starts the server in the current project directory, so `root` defaults to that project.

### 3. Claude Desktop chat (`claude_desktop_config.json`)
Edit this file only while Claude Desktop is fully quit; the running app rewrites it. On Windows Store (MSIX) installs, the file lives under `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\`.
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

### 4. Cursor / Zed / Continue
- **Command**: `npx -y waymark-engine`
- **Transport**: `stdio`
- **Environment**: `CODEDB_ALLOW_TEMP=1`

---

## Target Repository Path (`root` Argument)

When an agent runs `waymark-engine` via stdio, the server defaults to its current working directory. When querying a target repository located elsewhere on disk, **always pass the `root` argument** in tool calls:

```json
{
  "name": "waymark_ask",
  "arguments": {
    "question": "Who calls execute_command?",
    "root": "/path/to/target/repository"
  }
}
```

To start the server against a repository when the host cannot set a working directory (Claude Desktop chat), pass `--root`: `"args": ["-y", "waymark-engine", "--root", "/path/to/target/repository"]`. Tool calls without `root` then default to it.

---

## Resident Daemon Warm-Up

| Variable | Default | Effect |
|---|---|---|
| `WAYMARK_MCP_WARM` | on | `0` disables warm-up; every call takes the cold path. `WAYMARK_DISABLE_RESIDENT=1` disables it too. |
| `WAYMARK_MCP_WARM_MAX_FILES` | `50000` | Repositories with more files than this are not warmed. |
| `WAYMARK_MCP_WARM_TIMEOUT_MS` | `10000` | A file walk that runs longer than this is abandoned and the repository is not warmed. |
| `WAYMARK_MCP_WARM_MAX_ROOTS` | `2` | Most repositories kept warm at once. |

The file walk is asynchronous and skips the same directories as the literal path router (`node_modules`, `dist`, `.git`, …). A repository over budget is remembered for the session and stays on the cold path; the walk is abandoned rather than kept as a partial path list, because a partial list could make an ambiguous file name look unique.

---

## Backward Compatibility & Verbose Mode

If your agent framework requires flat, single-purpose tools, enable **Verbose Mode** by setting `"WAYMARK_MCP_VERBOSE": "1"` in the environment. This exposes all 11 legacy granular tools in `tools/list`:
- `waymark_chart`
- `waymark_bust`
- `waymark_prune`
- `waymark_list`
- `waymark_unchart`
- `waymark_init`
- `waymark_context`
- `waymark_map_status`
- `waymark_discover_symbols`
- `waymark_daemon_status`

*(Note: In default mode, direct invocations of legacy tool names still succeed seamlessly without error).*

---

## Resources & Prompts

### Resources
- `waymark://manifest`: Engine capabilities, tier metadata, and versioning.
- `capn://status`: Memory store configuration and adapter status.

### Prompts
| Prompt | Arguments | Workflow |
| :--- | :--- | :--- |
| `explore-subsystem` | `query` (required, non-empty; missing → JSON-RPC `-32602`), `root` | Guided repository-wide exploration of a concept or module; scoped subsystem indexes are unsupported. |
| `architectural-map` | `topic` (required, non-empty; missing → JSON-RPC `-32602`), `root` | Structured call-graph and consensus memory mapping. |
| `bootstrap-semantic-map` | `root` | Collects unverified source-backed drafts; a human must verify and explicitly chart any supported claim. |

`root` is optional on every prompt. When it is set, the prompt tells the agent to pass `root: "<value>"` on every `waymark_ask` and `waymark_memory` call, so a host whose working directory isn't the repository still targets it.

[`examples/`](https://github.com/paragon-ux/waymark-engine/tree/main/examples) has a recorded run of each prompt against this repository.

Subsystem values supplied to discovery or memory tools fail with `UNSUPPORTED_SUBSYSTEM`. Tool requests do not silently widen to repository-root results.
