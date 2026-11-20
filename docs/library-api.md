# Library API & Integrity Primitives

Waymark Engine can be embedded directly into TypeScript and Node.js applications as an in-process library, bypassing CLI spawn overhead for `<10ms` execution.

---

## Installation

```bash
npm install waymark-engine
```

---

## Core Discovery Exports

```ts
import {
  ask,
  renderPlainText,
  queryMultiSymbols,
  discoverSymbolsInFile,
  discoverSymbolsInRepo,
  detectAstIntent,
  scoreFzf,
  rankFzf,
  repoRoot,
} from "waymark-engine";

// 1. Unified 4-Tier Query
const root = repoRoot();
const result = await ask(root, "capn-cli", "", "Who calls verifyHop?", {
  depth: 2,
  direction: "callers",
  excludeTests: true,
});
console.log(renderPlainText(result));

// 2. Concurrent Batch Symbol Extraction
const symbols = await queryMultiSymbols(root, ["McpServer", "WaymarkDaemon", "PrefixTrie"]);
console.log(symbols);

// 3. Single-File Structured Tree-Sitter Outline
const fileOutline = await discoverSymbolsInFile(root, "src/types.ts");
console.log(fileOutline.symbols);

// 4. In-Memory Junegunn Choi FZF Scoring
const score = scoreFzf("vrfyHp", "verifyHop");
console.log(`Match score: ${score}`);
```

---

## Consensus Memory Management Exports

```ts
import {
  initCapn,
  publish,
  unchart,
  bust,
  prune,
  listEntries,
  context,
  assertLexicalStore,
  repoRoot,
} from "waymark-engine";

const root = repoRoot();

// Initialize the deterministic lexical store (.waymark/memory) once per repository (idempotent)
await initCapn(root);

// Enforce fail-closed determinism check on SQLite store (synchronous guard;
// throws CAPN_STORE_UNINITIALIZED before init or CAPN_NON_DETERMINISTIC_MODE if embeddings are enabled)
assertLexicalStore(root);

// Publish architectural consensus memory entry
const published = await publish(
  root,
  "capn-cli",
  "",
  "[FACET:BOUNDARIES] IPC Architecture",
  "Windows Named Pipes, Unix domain sockets on POSIX",
  ["src/daemon.ts"],
);
console.log(published.published);

// Invalidate memories backed by a changed file ("" = bundled capn-hook)
await bust(root, "", "src/daemon.ts");

// Cleanly prune orphaned entries
await prune(root);
```

---

## Tamper-Evidence & Integrity Primitives

Waymark provides cryptographic primitives to ensure retrieved code spans have not been tampered with or drifted out of sync:

### 1. `anchorForRange(root, path, range)`
Generates a structured tripartite integrity anchor (`fileSha256`, `normalizedSpanHash`, `normalizedSpanLen`, `spanLineCount`, `structuralSignature`) for a 1-based inclusive `LineRange` (`{ start, end }`):
1. **File SHA-256 (`fileSha256`)**: Pins the entire file state.
2. **Normalized Span Hash (`normalizedSpanHash`)**: SHA-256 of the whitespace-normalized code span.
3. **Structural Signature (`structuralSignature`)**: Token-prefix and boundary hashes pinning syntax integrity.

```ts
import { anchorForRange, repoRoot } from "waymark-engine";

const root = repoRoot();
const anchor = anchorForRange(root, "src/daemon.ts", { start: 1, end: 50 });
console.log("Integrity Anchor:", anchor.fileSha256, anchor.normalizedSpanHash);
```

### 2. `verifyHop(root, hop, maxWindows)`
Validates that a recorded `HopRecord` still exists at its expected location:
- Returns **`FRESH`**: Content hash and line numbers match exactly.
- Returns **`MOVED`**: Content hash matches within bounded relocation windows (`maxWindows`), returning updated `resolvedRange`.
- Returns **`STALE`**: Content has been modified or deleted.

```ts
import { anchorForRange, verifyHop, repoRoot, type HopRecord } from "waymark-engine";

const root = repoRoot();
const range = { start: 12, end: 45 };
const anchor = anchorForRange(root, "src/repl.ts", range);
const hop: HopRecord = {
  index: 0,
  path: "src/repl.ts",
  label: "startRepl",
  inference: "Entrypoint dispatches live observer or interactive REPL",
  range,
  ...anchor,
};

const check = verifyHop(root, hop, 200);
if (check.status === "FRESH") {
  console.log("Span is verified tamper-free.");
}
```

---

## Error Handling

Lookup misses in `ask()` resolve cleanly to a structured `{ status: "miss", missCode }` envelope rather than throwing. Boundary, validation, and guard violations (such as path traversal, symlink escapes, invalid traversal options, or uninitialized/non-deterministic stores) throw `WaymarkError` with deterministic `code` and `exitCode` fields:

```ts
import { anchorForRange, repoRoot, WaymarkError } from "waymark-engine";

const root = repoRoot();
try {
  anchorForRange(root, "../etc/passwd", { start: 1, end: 5 });
} catch (err) {
  if (err instanceof WaymarkError) {
    console.error(`Code: ${err.code}, Exit: ${err.exitCode}, Message: ${err.message}`);
  }
}
```
