# Waymark Engine Error & Status Registry

**Document Identifier**: `error-codes`  
**Classification**: Authoritative System Specification  
**Version**: 2.0.0  
**Scope**: Status envelopes, error codes, miss codes, exit codes, and retryability semantics.

---

## 1. Top-Level Machine-Readable Status Envelopes

Every query executed through `waymark-ask`, `ask()`, or the MCP server returns an envelope with one of four top-level `status` values:

```typescript
export type AskResult =
  | AskHitResult        // status: "hit"
  | AskJunctionResult   // status: "junction"
  | AskMissResult       // status: "miss"
  | AskErrorResult;     // status: "error"
```

### 1.1 Status Value Definitions

| Status | Envelope Name | Meaning | Fail-Closed Policy | Continuation Strategy |
| :--- | :--- | :--- | :--- | :--- |
| `"hit"` | `AskHitResult` | Exact or highly confident match found in Tier 1 (AST), Tier 2 (Literal Path), Tier 3 (Fuzzy), or Tier 4 (Capn Memory). | Not applicable (successful query). | Consume `result` directly. |
| `"junction"` | `AskJunctionResult` | Structural and literal tiers missed; Discovery Junction evaluated candidate signals and executed the primary recommendation while retaining the unexecuted alternative. | Inspectable fail-closed recommendation. No silent mutation. | Consume `executedOption.result` or force alternative via `alternativeOption.continuation`. |
| `"miss"` | `AskMissResult` | All evaluated tiers exhausted without matching symbols, paths, or memory entries. | **Strict Fail-Closed**: Returns clean miss with `missCode`. Never hallucinates or guesses. | Agent prompted to chart consensus memory (`waymark-chart`) or refine query. |
| `"error"` | `AskErrorResult` | Execution aborted due to system fault, uninitialized store, invariant violation, or configuration error. | Halts execution immediately; reports machine-readable `errorCode` and `retryable` status. | Correct underlying environment fault; retry if `retryable: true`. |

---

## 2. Error Code Registry (`WaymarkErrorCode`)

Errors represent exceptional failures or contract violations rather than discovery misses.

| Error Code | Classification | Severity | Retryable | Exit Code | Triggering Condition | Recommended Remediation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `CAPN_STORE_UNINITIALIZED` | Store State | Fatal | `false` | `1` | Lexical Capn SQLite store does not exist in repo root or is missing tables. | Run `waymark-init` (or `waymark init`) once in the repository root. |
| `CAPN_NON_DETERMINISTIC_MODE` | Invariant Guard | Fatal | `false` | `1` | Capn memory store is configured with embedding models or vector indexes. Refused by design invariant. | Reinitialize the store in strict lexical BM25 mode. Do not use embeddings. |
| `CODEDB_BINARY_MISSING` | Dependency | Fatal | `false` | `1` | `@paragon-ux/codedb-core` native binary cannot be located or executed. | Run `npm ci` to install or build native codedb binary dependencies. |
| `CODEDB_PROCESS_TIMEOUT` | Execution Fault| Transient | `true` | `1` | Codedb AST traversal or resident server exceeded process timeout (30s). | Retry with a more specific target path or query scope. |
| `INVALID_TIER_OVERRIDE` | Caller Error | Permanent | `false` | `1` | Caller passed an unknown tier to `--tier` or `ask({ tier })` (allowed: `auto`, `ast`, `path`, `fuzzy`, `capn`). | Fix tier selector parameter in CLI invocation or tool call. |
| `CALL_GRAPH_DISCONNECTED` | Structural | Warning | `false` | `0` | Function exists in AST, but caller/callee traversal finds no connected edges. | Verify symbol references; function may be an uninvoked leaf or dead code. |
| `AMBIGUOUS_DROPPED_EDGES` | Structural | Warning | `false` | `0` | Multiple definitions share the same name across files; edges dropped to prevent false attribution. | Scope symbol query with file path context (e.g. `path/to/file.ts:symbolName`). |
| `UNKNOWN_COMMAND` | CLI Syntax | Permanent | `false` | `1` | Unrecognized CLI subcommand passed to `waymark`. | Consult `waymark help` for supported commands. |
| `UNKNOWN_OPTION` | CLI Syntax | Permanent | `false` | `1` | Unrecognized CLI flag passed in argv. | Consult `waymark help` for valid flag options. |
| `MISSING_OPTION_VALUE` | CLI Syntax | Permanent | `false` | `1` | Flag expecting a value was provided without an argument. | Provide value following the flag (e.g. `-t ast`). |
| `MISSING_ARGUMENT` | CLI Syntax | Permanent | `false` | `1` | Required argument (such as `--question` or `--path`) was omitted. | Provide the required positional or value parameter. |
| `TEXT_LIMIT` | Input Guard | Permanent | `false` | `1` | Input question exceeds 240 chars or answer exceeds 4000 chars. | Shorten query or answer text to fit bounded input constraints. |
| `UNEXPECTED_ERROR` | Internal Fault | Unknown | `false` | `1` | Unhandled runtime exception encountered during execution. | Inspect stack trace; file issue in repository bug tracker. |

---

## 3. Miss Code Registry (`WaymarkMissCode`)

Miss codes identify why a query did not match, enabling caller agents to distinguish between missing symbols, absent charted consensus, and tier exhaustion.

| Miss Code | Owning Tier / Layer | Meaning | Agent Action |
| :--- | :--- | :--- | :--- |
| `SYMBOL_NOT_FOUND` | Tier 1 (AST) | Target symbol name was not found in the repository's parsed AST symbol table. | Refine symbol spelling or check if symbol is dynamically generated. |
| `NO_CHARTED_MEMORY` | Tier 4 (Capn Memory) | Capn BM25 query returned zero consensus matches above relevance threshold. | Investigate code manually, then chart the answer using `waymark-chart`. |
| `JUNCTION_EXHAUSTED` | Discovery Junction | Both Stage 1 (candidate fuzzy), Stage 2 (Capn memory), and Stage 3 (exhaustive fuzzy) returned no confident matches. | Query represents an unindexed concept or novel question; chart once solved. |
| `TIER_FORCED_MISS` | Router / CLI Flag | Caller explicitly forced a specific tier via `--tier <name>` which did not match, suppressing fallback cascade. | Retry without tier restriction (`--tier auto`) or force a different tier. |

---

## 4. Exit Code Registry

When invoked from the command line (`waymark`, `waymark-ask`, etc.), process exit codes follow strict POSIX-compatible conventions:

| Exit Code | Classification | Meaning | Examples |
| :--- | :--- | :--- | :--- |
| `0` | **Success / Clean Result** | The operation completed successfully. Covers `status: "hit"`, `status: "junction"`, and clean fail-closed `status: "miss"`. In all these cases, valid output was produced. | `waymark-ask "who calls verifyHop?"` (Hit)<br>`waymark-ask "where is refundOrdr declared?"` (Junction)<br>`waymark-ask "unknownConcept"` (Miss) |
| `1` | **Error / Invariant Violation** | Command aborted due to invalid arguments, syntax errors, or invariant failures. | Missing `--question`, uninitialized Capn store, unknown flag `--foo`. |
| `2` | **Fatal Runtime Exception** | Process terminated unexpectedly due to uncaught runtime failure or signal interruption. | Out of memory, broken pipe, unhandled native panic. |
| `3` | **Publication Refused** | Special exit code emitted by `waymark chart` when publication was rejected by adapter profile. | `waymark chart` attempted against `profile: "capn-cli"` with rejected consensus. |

---

## 5. Machine-Readable Schema Examples

### 5.1 Clean Fail-Closed Miss (`status: "miss"`)
```json
{
  "waymark": 1,
  "kind": "ask",
  "status": "miss",
  "provider": "waymark-engine",
  "missCode": "JUNCTION_EXHAUSTED",
  "reason": "Discovery junction exhausted all fuzzy candidates and semantic memory without confident match",
  "matches": []
}
```

### 5.2 Deterministic Error Guard (`status: "error"`)
```json
{
  "waymark": 1,
  "kind": "error",
  "ok": false,
  "code": "CAPN_NON_DETERMINISTIC_MODE",
  "message": "Capn store at /repo/.capn is configured in embedding mode. Waymark Engine requires deterministic lexical BM25 store."
}
```
