# Model Context Protocol (MCP) Integration

Waymark Engine implements the Model Context Protocol (MCP) dual-era specification (`2026-07-28` modern discovery + `2024-11-05` standard handshake) over stdio.

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
| **`bootstrap`** | `{"action": "bootstrap", "dry_run": false}` | Run two-pass architectural discovery and populate SQLite ledger. |
| **`status`** | `{"action": "status", "plain": true}` | Inspect Semantic Repo Map completion ratio, active facets, and file drift. |
| **`chart`** | `{"action": "chart", "facet": "boundaries", "question": "IPC Protocol", "answer": "Named pipes on Windows...", "files": ["src/daemon.ts"]}` | Record architectural knowledge into consensus memory. |
| **`heal`** | `{"action": "heal"}` | Reconcile code changes, verify anchors, and refresh SQLite ledger. |
| **`export`** | `{"action": "export", "format": "md"}` | Export consensus architecture map as Markdown or JSON. |
| **`bust`** | `{"action": "bust", "file": "src/daemon.ts"}` | Invalidate all consensus memories backed by a changed file. |
| **`prune`** | `{"action": "prune"}` | Cleanly remove stale entries whose backing files vanished. |
| **`list`** | `{"action": "list"}` | List all charted repository consensus memories. |
| **`unchart`** | `{"action": "unchart", "id": "3a8f1b2c", "if_exists": true}` | Delete a specific memory entry by hex ID. |
| **`init`** | `{"action": "init"}` | One-time deterministic lexical store initialization (`.capn`). |
| **`context`** | `{"action": "context"}` | Retrieve ask-first routing contract and syntax guidelines. |

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

### 2. Claude Desktop (`claude_desktop_config.json`)
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

### 3. Cursor / Zed / Continue
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
- `explore-subsystem`: Guided 4-tier exploration workflow for a concept or module.
- `architectural-map`: Structured call-graph and consensus memory mapping workflow.
- `bootstrap-semantic-map`: Two-pass bootstrap agent prompt for repository onboarding.
