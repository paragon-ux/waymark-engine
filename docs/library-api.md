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
  plain: true,
});
console.log(result);

// 2. Concurrent Batch Symbol Extraction
const symbols = await queryMultiSymbols(root, ["McpServer", "DiscoveryRouter", "FuzzyMatcher"]);
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
  publish,
  unchart,
  bust,
  prune,
  listEntries,
  context,
  assertLexicalStore,
} from "waymark-engine";

// Enforce fail-closed determinism check on SQLite store
await assertLexicalStore(root);

// Publish architectural consensus memory entry
const result = await publish(
  root,
  "capn-cli",
  "",
  "[FACET:BOUNDARIES] IPC Architecture",
  "Windows Named Pipes, Unix domain sockets on POSIX",
  ["src/daemon.ts"],
);

// Invalidate memories backed by a changed file
await bust(root, "src/daemon.ts");

// Cleanly prune orphaned entries
await prune(root);
```

---

## Tamper-Evidence & Integrity Primitives

Waymark provides cryptographic primitives to ensure retrieved code spans have not been tampered with or drifted out of sync:

### 1. `verifyHop(root, hop, maxWindows)`
Validates that a recorded code span still exists at the expected location:
- Returns **`FRESH`**: Content hash and line numbers match exactly.
- Returns **`MOVED`**: Content hash matches within bounded relocation windows (`maxWindows`), returning updated line numbers.
- Returns **`STALE`**: Content has been modified or deleted.

```ts
import { anchorForRange, verifyHop } from "waymark-engine";

const anchor = anchorForRange(root, "src/repl.ts", [12, 45]);
const check = verifyHop(root, {
  from: "startRepl",
  to: "runReplScript",
  file: "src/repl.ts",
  lines: [12, 45],
  anchor,
});

if (check.status === "FRESH") {
  console.log("Span is verified tamper-free.");
}
```

### 2. `anchorForRange(root, path, range)`
Generates a tripartite integrity anchor (`sha256:...;span:...;sig:...`) for any range of lines:
1. **File SHA-256**: Pins the entire file state.
2. **Normalized Span Hash**: SHA-256 of the whitespace-normalized code span.
3. **Structural Signature**: AST structural signature pinning syntax integrity.

```ts
import { anchorForRange } from "waymark-engine";

const anchor = anchorForRange(root, "src/daemon.ts", { start: 1, end: 50 });
console.log("Integrity Anchor:", anchor);
```

---

## Error Handling

Waymark exports typed errors with deterministic status codes:

```ts
import { WaymarkError } from "waymark-engine";

try {
  await ask(root, "capn-cli", "", "nonExistentSymbol");
} catch (err) {
  if (err instanceof WaymarkError) {
    console.error(`Code: ${err.code}, Exit: ${err.exitCode}, Message: ${err.message}`);
  }
}
```
