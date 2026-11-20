# Contributing to Waymark Engine

Waymark Engine is intentionally small and local-first, with five direct runtime
dependencies declared in `package.json`: `@paragon-ux/codedb-core` (prebuilt native AST
binary), `@paragon-ux/capn-hook` (lexical BM25 store using SQLite / `better-sqlite3`),
`web-tree-sitter` + `tree-sitter-wasms` (WASM single-file outlines), and `markdown-it`.

## Development

Use Node.js 22 or newer and run:

```text
npm ci
npm run verify
```

`npm run verify` compiles the TypeScript and runs the Node test suite. Do not commit
`dist/`, `node_modules/`, `.capn/`, `.waymark/`, or runtime evidence.

Keep CLI arguments explicit and use `execFile`-style argv boundaries for external
tools (the Capn adapter never goes through a shell). The router must miss cleanly
rather than guess: a question that neither the AST nor Capn memory can answer is a
`miss`, never a fabricated hit. New behavior needs deterministic tests for both its
success and fail-closed paths.

## Changes and review

Use a focused branch and describe the behavioral change in the pull request.
Any change to the router's intent detection, the adapter's command surface, or the
integrity primitives needs a regression test.
