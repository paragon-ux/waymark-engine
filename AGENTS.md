# Waymark Discovery Lab

Waymark is a two-phase discovery engine for one-shot code questions: an in-process
Tree-sitter WASM AST for structural queries, Capn (SQLite FTS5, no embeddings) for
semantic recall, and a clean miss when neither can answer.

## Primary Interface

### 1. Check Existing Knowledge (`capn_ask`)
- Call `capn_ask({ question: "<question>" })` before re-reading the codebase.
- If `status: "hit"`, reuse the charted answer without redundant exploration.
- A clean `miss` means "not charted yet" — investigate, then chart.

### 2. Structural Questions Are Free (`capn_ask` routes them automatically)
Questions like "who calls X", "where is Y declared", or "what are the entrypoints" are
answered in-process by the WASM AST — no external process, no index build, exact
1-indexed line spans.

### 3. Chart Findings (`capn_chart`)
After concluding an investigation:
- Call `capn_chart({ question: "<q>", answer: "<a>", files: ["<paths>"] })`
  to seed Capn memory so future agents reuse the answer.

### 4. One-Shot Symbol Discovery (`waymark_discover_symbols`)
- Call `waymark_discover_symbols({ path: "<repository-relative-file>", language: "typescript|python" })`
  for exact symbols (name, kind, line span) without changing any state.
