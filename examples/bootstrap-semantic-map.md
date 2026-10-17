# `bootstrap-semantic-map`

Fills the five facets of the repository's Semantic Repo Map. Bootstrap collects unverified drafts. The agent reads the cited source, rewrites each draft, and charts only what the source supports.

## Invoke

```text
/waymark-engine:bootstrap-semantic-map
```

| Argument | Required | Value |
| :--- | :--- | :--- |
| `root` | no | not set |

## What the prompt sends

> Inspect the repository-wide Semantic Repo Map with waymark_memory(action="status"). Bootstrap may collect source excerpts as unverified drafts but never publishes claims. Verify each claim against its cited source and publish only supported conclusions with waymark_memory(action="chart"). Subsystem-scoped maps are unsupported.

## 1. Status and drafts

This run came after the other two examples. Those had already charted the `boundaries` and `lifecycle` facets, so the map starts at 2/5.

`waymark_memory`:

```json
{ "action": "bootstrap", "dry_run": true }
```

The status part of the output:

```text
status: incomplete, 2/5 facets active
  lifecycle   active   acf462ce  (from explore-subsystem)
  boundaries  active   3ca79ca8  (from architectural-map)
  data_state  missing
  invariants  missing
  failure     missing
```

It scaffolds one draft per missing facet. This is the `data_state` draft:

```json
{
  "id": "data_state",
  "question": "[FACET:DATA_STATE] How is data, state, or cache stored, synchronized, and persisted on disk?",
  "answer": "Unverified draft. Review the cited source excerpts and replace this note before charting.",
  "files": [
    "src/capnAdapter.ts"
  ],
  "status": "draft",
  "evidence": [
    {"file": "src/capnAdapter.ts", "line": 100, "excerpt": "export function capnStoreArgs(root: string): string[] {"},
    {"file": "src/capnAdapter.ts", "line": 102, "excerpt": "return [\"--root\", resolved, \"--store-dir\", memoryStoreDir(resolved)];"},
    {"file": "src/capnAdapter.ts", "line": 127, "excerpt": "`The capn executable does not accept --root/--store-dir, so it could only use the shared ${LEGACY_STORE_DIR_NAME} folder. Waymark refuses to run it; its memory store lives in ${MEMORY_STORE_LABEL}. Upgrade @paragon-ux/capn-hook to a release"},
    {"file": "src/capnAdapter.ts", "line": 165, "excerpt": "return path.join(memoryStoreDir(root), \"config.json\");"},
    {"file": "src/capnAdapter.ts", "line": 191, "excerpt": "export function assertLexicalStore(root: string): void {"},
    {"file": "src/capnAdapter.ts", "line": 571, "excerpt": "export async function migrateMemoryStore(root: string, executable: string, from = LEGACY_STORE_DIR_NAME): Promise<Record<string, unknown>> {"}
  ]
}
```

| Facet | Draft files | Draft evidence |
| :--- | :--- | :--- |
| `data_state` | `src/capnAdapter.ts` | `capnAdapter.ts:100`, `capnAdapter.ts:102`, `capnAdapter.ts:127`, `capnAdapter.ts:165`, `capnAdapter.ts:191`, `capnAdapter.ts:571` |
| `invariants` | `src/paths.ts`, `src/integrity.ts` | `paths.ts:62`, `paths.ts:88`, `paths.ts:99`, `integrity.ts:20`, `integrity.ts:27`, `integrity.ts:66` |
| `failure` | `src/types.ts` | `types.ts:50`, `types.ts:53`, `types.ts:100`, `types.ts:113`, `types.ts:181`, `types.ts:194` |

The evidence lines name each facet's keywords, so they're a useful start, but they don't answer the question. The `data_state` draft cites only `src/capnAdapter.ts`, while the state layout lives in `src/stateDir.ts`. The `failure` draft cites type declarations, not the code that fails closed. So the answers come from reading the source.

## 2. Verify each draft

| Facet | What the source shows | Backing files charted |
| :--- | :--- | :--- |
| `data_state` | `stateDir` is the only in-repo location. The memory store, path cache (`src/discoveryRouter.ts:237`) and telemetry (`src/sessionLogger.ts:37`) are all under it. The daemon socket, PID record and registry use `os.tmpdir()` (`src/daemon.ts:36-50`). | `src/stateDir.ts`, `src/discoveryRouter.ts`, `src/sessionLogger.ts`, `src/daemon.ts` |
| `invariants` | `resolveRepositoryFile` (`src/paths.ts:88-103`) rejects escaping, missing, symlink-escaping and non-file paths. Its callers include `publish`, `verifyHop` and the Semantic Repo Map. | `src/paths.ts`, `src/capnAdapter.ts`, `src/integrity.ts` |
| `failure` | `assertLexicalStore` (`src/capnAdapter.ts:191`) throws on charting. `queryCapnMemory` (`:329`) returns a reason on recall, and `routeDiscoveryCore` turns that into a `miss` (`src/discoveryRouter.ts:809-825`). | `src/capnAdapter.ts`, `src/discoveryRouter.ts` |

`src/types.ts`, from the `failure` draft, only declares types (the error codes among them), so it isn't charted.

## 3. Chart the verified facets

`waymark_memory`, three calls in turn:

```json
{
  "action": "chart",
  "facet": "data_state",
  "question": "Where does Waymark store its state, cache, and memory on disk?",
  "answer": "Only under .waymark/ (stateDir): the lexical memory store in .waymark/memory (memoryStoreDir), the Tier 2 path cache in .waymark/paths.v2.cache, and opt-in telemetry in .waymark/sessions/active.jsonl. ensureStateDir writes .waymark/.gitignore as *. The daemon socket, PID record and waymark-daemons.json registry live in os.tmpdir(), never in the repository.",
  "files": ["src/stateDir.ts", "src/discoveryRouter.ts", "src/sessionLogger.ts", "src/daemon.ts"]
}
```

```json
{
  "action": "chart",
  "facet": "invariants",
  "question": "How does Waymark stop a chart or hop from citing a file outside the repository?",
  "answer": "resolveRepositoryFile normalizes the path against the root and throws INVALID_PATH if it escapes, FILE_MISSING if absent, SYMLINK_ESCAPE if its realpath leaves the real root, and NOT_REGULAR_FILE for anything but a file. publish, verifyHop, readFileBytes and the Semantic Repo Map status and bootstrap all call it, so charts can only cite real files inside the repository.",
  "files": ["src/paths.ts", "src/capnAdapter.ts", "src/integrity.ts"]
}
```

```json
{
  "action": "chart",
  "facet": "failure",
  "question": "How does Tier 4 memory fail closed when the store is missing or not lexical?",
  "answer": "publish runs init when config.json is missing, then assertLexicalStore throws CAPN_STORE_UNINITIALIZED or CAPN_NON_DETERMINISTIC_MODE (embedding store). Recall never throws: queryCapnMemory returns STORE_UNINITIALIZED or CAPN_NON_DETERMINISTIC_MODE, and routeDiscoveryCore turns that into status \"miss\" with that missCode, otherwise NO_CHARTED_MEMORY. A capn without --store-dir is refused with CAPN_STORE_DIR_UNSUPPORTED.",
  "files": ["src/capnAdapter.ts", "src/discoveryRouter.ts"]
}
```

They returned `charted a9adac45`, `charted 0c6e5d32` and `charted edc52b04`.

## 4. Status after

```json
{ "action": "status", "plain": true }
```

```text
[semantic-map: 5/5 facets active (100%)]
- lifecycle: active (src/codedbAdapter.ts, src/daemon.ts, src/residentCodedb.ts)
- data_state: active (src/daemon.ts, src/discoveryRouter.ts, src/sessionLogger.ts, src/stateDir.ts)
- boundaries: active (src/capnAdapter.ts, src/stateDir.ts)
- invariants: active (src/capnAdapter.ts, src/integrity.ts, src/paths.ts)
- failure: active (src/capnAdapter.ts, src/discoveryRouter.ts)
```

## 5. The finished map

```json
{ "action": "export", "format": "md" }
```

> # Architecture Consensus Map
> **Generated by Waymark Engine** | Status: healthy (5/5 facets active)
>
> ## Facet: Entrypoints & Runtime Lifecycle (`lifecycle`)
> - **Status**: active
> - **Files**: src/codedbAdapter.ts, src/daemon.ts, src/residentCodedb.ts
>
> getResidentClient keeps one codedb per (lower-cased root, executable) in a per-process registry. It caps the registry at WAYMARK_MAX_RESIDENT_CLIENTS (default 2) and evicts the least recently used. runJson uses it after trying the daemon socket, and WaymarkDaemon.start shares the same client. A client closes after 60 s idle (WAYMARK_IDLE_TIMEOUT), or on exit, SIGINT or SIGTERM. WAYMARK_DISABLE_RESIDENT=1 forces one-shot runs.
>
> ## Facet: Data Flow & Storage (`data_state`)
> - **Status**: active
> - **Files**: src/daemon.ts, src/discoveryRouter.ts, src/sessionLogger.ts, src/stateDir.ts
>
> Only under .waymark/ (stateDir): the lexical memory store in .waymark/memory (memoryStoreDir), the Tier 2 path cache in .waymark/paths.v2.cache, and opt-in telemetry in .waymark/sessions/active.jsonl. ensureStateDir writes .waymark/.gitignore as *. The daemon socket, PID record and waymark-daemons.json registry live in os.tmpdir(), never in the repository.
>
> ## Facet: Cross-Boundary Glue (`boundaries`)
> - **Status**: active
> - **Files**: src/capnAdapter.ts, src/stateDir.ts
>
> capnStoreArgs(root) returns ["--root", realpath(root), "--store-dir", memoryStoreDir(realpath)]. Its only caller, execute(), puts them before the subcommand and spawns capn with that realpath as cwd. All capn traffic goes through execute: publish (chart), queryCapnMemory (Tier 4 recall), runCapnSimple (init, list, context, bust, prune, unchart). A "Usage:" reply becomes CAPN_STORE_DIR_UNSUPPORTED.
>
> ## Facet: Chesterton's Fences & Non-Obvious Rules (`invariants`)
> - **Status**: active
> - **Files**: src/capnAdapter.ts, src/integrity.ts, src/paths.ts
>
> resolveRepositoryFile normalizes the path against the root and throws INVALID_PATH if it escapes, FILE_MISSING if absent, SYMLINK_ESCAPE if its realpath leaves the real root, and NOT_REGULAR_FILE for anything but a file. publish, verifyHop, readFileBytes and the Semantic Repo Map status and bootstrap all call it, so charts can only cite real files inside the repository.
>
> ## Facet: Fail-Closed & Error Recovery (`failure`)
> - **Status**: active
> - **Files**: src/capnAdapter.ts, src/discoveryRouter.ts
>
> publish runs init when config.json is missing, then assertLexicalStore throws CAPN_STORE_UNINITIALIZED or CAPN_NON_DETERMINISTIC_MODE (embedding store). Recall never throws: queryCapnMemory returns STORE_UNINITIALIZED or CAPN_NON_DETERMINISTIC_MODE, and routeDiscoveryCore turns that into status "miss" with that missCode, otherwise NO_CHARTED_MEMORY. A capn without --store-dir is refused with CAPN_STORE_DIR_UNSUPPORTED.

When a backing file changes, capn deletes the entry on the next recall or `prune`, and the facet goes back to `missing` for the next bootstrap. If a backing file is deleted, `status` reports the facet as `drifted`.
