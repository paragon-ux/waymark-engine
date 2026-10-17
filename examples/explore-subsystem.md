# `explore-subsystem`

Explores one concept or symbol across all four tiers: call graph, fuzzy junction, file outline, then a charted finding.

## Invoke

```text
/waymark-engine:explore-subsystem getResidentClient
```

| Argument | Required | Value |
| :--- | :--- | :--- |
| `query` | yes | `getResidentClient` |
| `root` | no | not set |

## What the prompt sends

> Please explore the codebase using waymark-engine MCP tools for: "getResidentClient". First use waymark_ask to check Tier 1 AST call graphs or Tier 3 Discovery Junction recommendations, inspect relevant file AST outlines with waymark_ask (argument: path), and chart architectural findings into consensus memory via waymark_memory (action: "chart", or waymark_chart).

## 1. Tier 1: call graph

`waymark_ask`:

```json
{ "question": "Who calls getResidentClient?", "depth": 2, "direction": "both", "exclude_tests": true, "plain": true }
```

```text
[call-graph: depth 2]
getResidentClient (src/residentCodedb.ts:404)
  ↳ callers:
      - runJson (src/codedbAdapter.ts:131)
      ↳ callers:
          - queryMultiHopCallGraph (src/codedbAdapter.ts:222)
          - queryStructural (src/codedbAdapter.ts:433)
          - queryFuzzyCandidates (src/codedbAdapter.ts:596)
          - queryMultiSymbols (src/codedbAdapter.ts:686)
          - discoverSymbolsViaCodedbOutline (src/astExtractor.ts:752)
          - discoverSymbolsInRepo (src/astExtractor.ts:822)
  ↳ callees:
      - normalizeKeyRoot (src/residentCodedb.ts:382)
      - getMaxResidentClients (src/residentCodedb.ts:396)
```

## 2. Tier 3: Discovery Junction

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

## 3. File outline

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

The outline points to the ranges worth reading: `getResidentClient` (L404–L436), the constructor (L64–L71), `resetIdleTimer` (L104–L110) and the process hooks after L464.

## 4. Verify against the source

| Claim | Source | Result |
| :--- | :--- | :--- |
| One client per lower-cased root and executable | `src/residentCodedb.ts:406` | Confirmed |
| At most `WAYMARK_MAX_RESIDENT_CLIENTS` clients (default 2), least recently used evicted | `src/residentCodedb.ts:396-436` | Confirmed |
| A client closes after 60 s idle (`WAYMARK_IDLE_TIMEOUT`) | `src/residentCodedb.ts:67-70`, `:104-110` | Confirmed |
| Every client closes on `exit`, `SIGINT` and `SIGTERM` | `src/residentCodedb.ts:466-474` | Confirmed |
| `runJson` tries the daemon socket before the resident client | `src/codedbAdapter.ts:138-168` | Confirmed |
| `runJson` is the only caller | `src/daemon.ts:498` (`WaymarkDaemon.start`) | **Missed by the graph** |

`WaymarkDaemon.start` is a class method. The AST tier didn't report it as a caller, but it creates and shares the same resident client.

## 5. Chart the finding

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
{ "published": true, "adapter": "capn-cli", "output": "charted acf462ce\n" }
```
