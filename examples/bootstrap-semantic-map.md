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

> Build the repository-wide Semantic Repo Map (subsystem-scoped maps are unsupported).
> 1. Inspect it: waymark_memory(action: "status", plain: true) lists each facet as active, missing, drifted, or not_applicable.
> 2. Collect drafts: waymark_memory(action: "bootstrap", plain: true) returns unverified source excerpts for every missing or drifted facet. It never publishes. If facets are drifted, waymark_memory(action: "heal", plain: true) also uncharts their stale entries.
> 3. Verify each draft against its cited lines (waymark_ask(path: "&lt;file&gt;", outline: true, plain: true)); a draft is not a claim.
> 4. Chart each supported facet: waymark_memory(action: "chart", facet: "&lt;id&gt;", question: "&lt;question&gt;", answer: "&lt;verified answer&gt;", files: ["&lt;backing file&gt;", ...]), where &lt;id&gt; is one of "lifecycle", "data_state", "boundaries", "invariants", "failure". A facet with nothing to describe is charted with an answer starting "not_applicable" and the file that shows it.
> 5. Confirm: waymark_memory(action: "status", plain: true).

## 1. Status

This run came after the other two examples. Those had already charted the `boundaries` and `lifecycle` facets, so the map starts at 2/5.

`waymark_memory`:

```json
{ "action": "status", "plain": true }
```

```text
[semantic-map: 2/5 facets active (40%)]
- lifecycle: active (src/codedbAdapter.ts, src/daemon.ts, src/residentCodedb.ts)
- data_state: missing
- boundaries: active (src/capnAdapter.ts, src/stateDir.ts)
- invariants: missing
- failure: missing
Recommendation: Run 'waymark memory bootstrap' (MCP: waymark_memory(action: "bootstrap")) to collect unverified drafts, verify them, then chart supported claims with 'waymark memory chart' (MCP: waymark_memory(action: "chart", facet: "<id>")).
```

## 2. Drafts

```json
{ "action": "bootstrap", "plain": true }
```

```text
[bootstrap] Status: OK
Unverified drafts (3); verify each against its cited lines before charting:
## data_state: [FACET:DATA_STATE] How is data, state, or cache stored, synchronized, and persisted on disk?
files: src/repl.ts, src/discoveryRouter.ts, src/codedbAdapter.ts
  src/repl.ts:477: export async function runReplScript(scriptPath: string, rootDir?: string): Promise<void> {
  src/repl.ts:604: fs.mkdirSync(dir, { recursive: true });
  src/discoveryRouter.ts:228: export function isSkippedDir(name: string, depth: number): boolean {
  src/discoveryRouter.ts:239: export function invalidatePathsCache(): void {
  src/codedbAdapter.ts:742: export function pruneFuzzyCandidateCache(now = Date.now()): void {
  src/codedbAdapter.ts:751: export function fuzzyCandidateCacheSize(): number {
## invariants: [FACET:INVARIANTS] What non-obvious security, path normalization, or OS-specific invariants must not be violated?
files: src/paths.ts, src/evaluator.ts, src/daemon.ts
  src/paths.ts:62: export function normalizeRelativePath(input: string, root?: string): string {
  src/paths.ts:88: export function resolveRepositoryFile(root: string, storedPath: string): { lexical: string; real: string } {
  src/evaluator.ts:64: const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  src/evaluator.ts:65: const relative = path.relative(root, absolute);
  src/daemon.ts:17: export function canonicalRoot(root: string, platform = process.platform): string {
  src/daemon.ts:279: export async function tryDaemonResolvePath(
## failure: [FACET:FAILURE] How does the system fail closed on misses and recover from uninitialized, corrupted, or degraded states?
files: src/codedbAdapter.ts, src/daemon.ts, src/residentCodedb.ts
  src/codedbAdapter.ts:23: throw new WaymarkError("CODEDB_UNSUPPORTED_SHIM", "Windows .cmd/.bat codedb shims are unsupported; configure WAYMARK_CODEDB_EXECUTABLE with a native .exe to avoid shell argument expansion.", 2);
  src/codedbAdapter.ts:141: } catch (error) {
  src/daemon.ts:335: export async function stopDaemon(root: string, options?: { force?: boolean; timeoutMs?: number }): Promise<boolean> {
  src/daemon.ts:399: export async function autoStartDaemon(root: string, timeoutMs = 20_000, idleTimeoutMs?: number): Promise<boolean> {
  src/residentCodedb.ts:35: reject: (err: any) => void;
  src/residentCodedb.ts:123: throw new WaymarkError("CODEDB_UNSUPPORTED_SHIM", "Windows .cmd/.bat codedb shims are unsupported; configure WAYMARK_CODEDB_EXECUTABLE with a native .exe to avoid shell argument expansion.", 2);
Next: chart each verified facet with waymark_memory(action: "chart", facet: "<id>", question, answer, files) (CLI: waymark memory chart --facet <id> --question <q> --answer <a> --files <a,b>).
[semantic-map: 2/5 facets active (40%)]
- lifecycle: active (src/codedbAdapter.ts, src/daemon.ts, src/residentCodedb.ts)
- data_state: missing
- boundaries: active (src/capnAdapter.ts, src/stateDir.ts)
- invariants: missing
- failure: missing
```

Bootstrap drafts each missing or drifted facet from the repository's own files: manifest entries, then source files ranked by how many code lines name the facet's keywords. Keywords inside strings and patterns don't count, and a file named for the facet ranks higher.

The drafts are a useful start, but they don't answer the questions. `invariants` lands on the right file, `src/paths.ts`. `data_state` cites scattered cache and directory helpers, while the on-disk layout lives in `src/stateDir.ts`. `failure` cites individual throws, not the policy that turns a store problem into a miss. So the answers come from reading the source.

## 3. Verify each draft

| Facet | What the source shows | Backing files charted |
| :--- | :--- | :--- |
| `data_state` | `stateDir` is the only in-repo location. The memory store, path cache (`src/discoveryRouter.ts:260`) and telemetry (`src/sessionLogger.ts:37-38`) are all under it. The daemon socket, PID record and registry use `os.tmpdir()` (`src/daemon.ts:36-50`). | `src/stateDir.ts`, `src/discoveryRouter.ts`, `src/sessionLogger.ts`, `src/daemon.ts` |
| `invariants` | `resolveRepositoryFile` (`src/paths.ts:88-103`) rejects escaping, missing, symlink-escaping and non-file paths. Its callers include `publish`, `verifyHop` and the Semantic Repo Map. | `src/paths.ts`, `src/capnAdapter.ts`, `src/integrity.ts` |
| `failure` | `assertLexicalStore` (`src/capnAdapter.ts:192`) throws on charting. `queryCapnMemory` (`:311`) returns a reason on recall, and `routeDiscoveryCore` turns that into a `miss` (`src/discoveryRouter.ts:934-948`). | `src/capnAdapter.ts`, `src/discoveryRouter.ts` |

None of the draft's `failure` files is charted: they hold individual throws, not the fail-closed path.

## 4. Chart the verified facets

`waymark_memory`, three calls in turn:

```json
{
  "action": "chart",
  "facet": "data_state",
  "question": "Where does Waymark store its state, cache, and memory on disk?",
  "answer": "Only under .waymark/ (stateDir): the lexical memory store in .waymark/memory (memoryStoreDir), the Tier 2 path cache in .waymark/paths.v3.cache, and opt-in telemetry in .waymark/sessions/active.jsonl. ensureStateDir writes .waymark/.gitignore as *. The daemon socket, PID record and waymark-daemons.json registry live in os.tmpdir(), never in the repository.",
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

Each returned `{ "waymark": 1, "kind": "chart", "published": true, ... }`, with `charted a9adac45`, `charted 0c6e5d32` and `charted edc52b04`.

## 5. Status after

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

## 6. The finished map

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
> Only under .waymark/ (stateDir): the lexical memory store in .waymark/memory (memoryStoreDir), the Tier 2 path cache in .waymark/paths.v3.cache, and opt-in telemetry in .waymark/sessions/active.jsonl. ensureStateDir writes .waymark/.gitignore as *. The daemon socket, PID record and waymark-daemons.json registry live in os.tmpdir(), never in the repository.
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

When a backing file changes, `status` reports the facet as `drifted` with `[changed: <file>]`, and a deleted one shows `[missing: <file>]`. capn deletes the entry on the next recall or `list`, and the result names it. `waymark_memory(action: "heal")` uncharts drifted entries and collects replacement drafts. Pass `dry_run: true` to see what it would remove first.
