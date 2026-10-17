# `explore-subsystem`

Explores one concept or symbol across the tiers: definition, call graph, fuzzy junction, file outline, then a charted finding.

## Invoke

```text
/waymark-engine:explore-subsystem getResidentClient
```

| Argument | Required | Value |
| :--- | :--- | :--- |
| `query` | yes | `getResidentClient` |
| `root` | no | not set |

Without `query`, the prompt fails with JSON-RPC `-32602` instead of exploring a placeholder.

## What the prompt sends

> Explore the repository with the waymark-engine MCP tools for: "getResidentClient".
> 1. Locate it: waymark_ask(question: "getResidentClient", plain: true). Tier 1 answers symbol definitions and call graphs, Tier 2 file paths, Tier 3 fuzzy symbol matches, Tier 4 charted memory. Pass auto_resolve: false to see the Discovery Junction options instead of the auto-resolved top answer.
> 2. Outline each relevant file: waymark_ask(path: "&lt;file&gt;", outline: true, plain: true); add query: "&lt;name&gt;" to filter its symbols.
> 3. Trace relationships: waymark_ask(query: "&lt;symbol&gt;", depth: 2, direction: "callers", plain: true) (direction: "callees" | "both").
> 4. Chart only verified findings: waymark_memory(action: "chart", question: "&lt;focused question&gt;", answer: "&lt;what the files show&gt;", files: ["&lt;backing file&gt;", ...]).

## 1. Tier 1: definition

`waymark_ask`:

```json
{ "question": "getResidentClient", "plain": true }
```

```text
[hit: codedb] (confidence: exact)
total: 1
results: 1 (cols: qn label file lines)
  getResidentClient function src/residentCodedb.ts 404
```

## 2. Tier 1: call graph

```json
{ "query": "getResidentClient", "depth": 2, "direction": "both", "exclude_tests": true, "plain": true }
```

```text
[call-graph: depth 2]
getResidentClient (src/residentCodedb.ts:404)
  ↳ callers:
      - runJson (src/codedbAdapter.ts:148)
      ↳ callers:
          - lookupSymbolDefinitions (src/codedbAdapter.ts:264)
          - queryMultiHopCallGraph (src/codedbAdapter.ts:353)
          - queryStructural (src/codedbAdapter.ts:579)
          - queryFuzzyCandidates (src/codedbAdapter.ts:770)
          - discoverSymbolsViaCodedbOutline (src/astExtractor.ts:752)
      - WaymarkDaemon.start [method] (src/daemon.ts:483)
      ↳ callers:
          - runCommand (src/cli.ts:150)
          - McpServer.runWarmup [method] (src/mcp/server.ts:622)
          - <module> [module] (src/daemon.ts:1)
  ↳ callees:
      - normalizeKeyRoot (src/residentCodedb.ts:382)
      - ResidentCodedbClient.touch [method] (src/residentCodedb.ts:73)
      - getMaxResidentClients (src/residentCodedb.ts:396)
      - ResidentCodedbClient.closeSync [method] (src/residentCodedb.ts:358)
      ↳ callees:
          - ResidentCodedbClient.clearIdleTimer [method] (src/residentCodedb.ts:112)
          - unregisterResidentClient (src/residentCodedb.ts:387)
```

`[method]` marks a class or object method, named after its class, such as `WaymarkDaemon.start`. `<module> [module]` is a file's top-level code. Symbol lookups (`queryMultiSymbols`, `discoverSymbolsInRepo`) reach `runJson` one hop further out, through `lookupSymbolDefinitions`.

## 3. Tier 3: Discovery Junction

The same symbol, misspelled, with `auto_resolve` off so the junction is visible:

```json
{ "question": "getResidntClient", "auto_resolve": false, "plain": true }
```

```text
[junction] Recommended: fuzzy-lexical
Signal: identifier-like (getResidntClient)
Result: getResidentClient in src/residentCodedb.ts:404 (score: 100)
Tip: To query charted semantic memory instead: waymark-ask "getResidntClient" --tier capn
```

## 4. File outline

```json
{ "path": "src/residentCodedb.ts", "outline": true, "plain": true }
```

```text
[symbols: src/residentCodedb.ts] (26 symbols)
CodedbJson: interface L8-L24
CodedbRun: interface L26-L30
QueuedRequest: interface L32-L37
formatArg: function L39-L44
ResidentCodedbClient: class L48-L378
constructor: method L64-L71
touch: method L73-L76
pid: method L78-L80
unrefPipes: method L82-L91
refPipes: method L93-L102
resetIdleTimer: method L104-L110
clearIdleTimer: method L112-L117
ensureStarted: method L119-L219
cleanupState: method L221-L240
processQueue: method L242-L259
handleResponseLine: method L261-L284
send: method L286-L313
close: method L315-L356
closeSync: method L358-L377
normalizeKeyRoot: function L382-L385
unregisterResidentClient: function L387-L394
getMaxResidentClients: function L396-L402
getResidentClient: function L404-L436
closeResidentClient: function L438-L449
closeAllResidentClients: function L451-L456
listResidentClients: function L458-L464
```

The outline points to the ranges worth reading: `getResidentClient` (L404–L436), the constructor (L64–L71), `resetIdleTimer` (L104–L110) and the process hooks after L464. Adding `query: "close"` would narrow it to the symbols whose names contain `close`, and a path with no matching symbol returns a `SYMBOL_NOT_FOUND` miss.

## 5. Verify against the source

| Claim | Source | Result |
| :--- | :--- | :--- |
| One client per lower-cased root and executable | `src/residentCodedb.ts:406` | Confirmed |
| At most `WAYMARK_MAX_RESIDENT_CLIENTS` clients (default 2), least recently used evicted | `src/residentCodedb.ts:396-436` | Confirmed |
| A client closes after 60 s idle (`WAYMARK_IDLE_TIMEOUT`) | `src/residentCodedb.ts:67-70`, `:104-110` | Confirmed |
| Every client closes on `exit`, `SIGINT` and `SIGTERM` | `src/residentCodedb.ts:466-474` | Confirmed |
| `runJson` tries the daemon socket before the resident client | `src/codedbAdapter.ts:155-185` | Confirmed |
| `WaymarkDaemon.start` shares the same resident client | `src/daemon.ts:498` | Confirmed |

## 6. Chart the finding

`waymark_memory`:

```json
{
  "action": "chart",
  "question": "How many resident codedb processes does Waymark keep, and when do they exit?",
  "answer": "getResidentClient keeps one codedb per (lower-cased root, executable) in a per-process registry. It caps the registry at WAYMARK_MAX_RESIDENT_CLIENTS (default 2) and evicts the least recently used. runJson uses it after trying the daemon socket, and WaymarkDaemon.start shares the same client. A client closes after 60 s idle (WAYMARK_IDLE_TIMEOUT), or on exit, SIGINT or SIGTERM. WAYMARK_DISABLE_RESIDENT=1 forces one-shot runs.",
  "files": ["src/residentCodedb.ts", "src/codedbAdapter.ts", "src/daemon.ts"],
  "facet": "lifecycle"
}
```

```json
{
  "waymark": 1,
  "kind": "chart",
  "published": true,
  "adapter": "capn-cli",
  "output": "charted acf462ce\n",
  "question": "[FACET:LIFECYCLE] How many resident codedb processes does Waymark keep, and when do they exit?",
  "facet": "lifecycle"
}
```
