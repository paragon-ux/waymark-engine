# Targeted Structural Discovery Extension & Benchmark Verification Report

**Date:** 2026-10-26  
**Scope:** Waymark Engine (`src/astExtractor.ts`, `test/symbolDiscovery.test.ts`, `README.md`, `docs/architecture.md`, `docs/targeted-structural-discovery-report.md`)  
**Waymark Base Commit:** `eb7db8e` (`v4.0.2`)  
**Benchmark Provenance:** `Editing-Toolbench/10-26-26` (`run_all_benchmarks.py` / `waymark_runner.mjs`; 20-scope / 45-target hard suite across 5 fixtures: `matrix_kernel.py` [261 lines], `validator_engine.py` [271 lines], `schema_defs.py` [242 lines], `routing_manifest.json` [270 lines], `MIGRATION_RUNBOOK.md` [252 lines])

---

## 1. Executive Summary

To evaluate whether Waymark Engine or an external structural discovery alternative (`ast-grep`, `@colbymchenry/codegraph`, `@probelabs/probe`, `semgrep`, `ripgrep`) best serves as the structural discovery substrate for targeted editing workflows, we executed a 20-scope / 45-target empirical benchmark across the five multi-hundred-line fixtures above.

> **Important Scope Qualification (`WM-D1`):** The `20 / 20` check column below measures **scoped-slice simulation / final-workspace checks** in the external benchmark harness (`lines[s_line - 1 : e_line]` followed by Python `.replace(old_val, new_val, 1)`), **not** an end-to-end integration with Patch-DIFF's guarded transactional admission gate, observation-receipt verification, audit/manifest ledger (backed by PostgreSQL in the current Patch-DIFF implementation and targeted for file-authoritative storage in the intended design), `SAVE`, or replay. Waymark Engine owns **structural discovery**; Patch-DIFF separately owns exact selection, staleness validation, and atomic edit authorization.

### Comparative Benchmark Results (20 Scopes / 45 Edit Targets)

| Tool / Engine | Version | Zero-Hint Outline? | Scopes Resolved (`/20`) | Edit Targets Resolved (`/45`) | Scoped-Slice Simulation / Final-Workspace Checks (`/20`) | Discovery Time (5 files) & Execution Mode | Why Targets Were Missed / Operational Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`waymark-engine` (Stock v4.0.2)** | `4.0.2` (`eb7db8e`) | **Yes** | `11 / 20` (55.0%) | `26 / 45` (57.8%) | `11 / 20` | `75.5 ms` *(warm in-process after WASM init)* | Missed 2 Python module-level assignments (`FRAME_SYNC_STREAM`, `VALID_SCOPES`), 3 JSON array-object scopes (`tenants[ten_*]`), and 4 Markdown table-row / code-fence scopes (`row:CHK-14-C`, `row:canary-v3`, `fence:L241`). |
| **`waymark-engine` (Extended — This PR)** | `4.0.2+ext` | **Yes** | **`20 / 20` (100.0%)** | **`45 / 45` (100.0%)** | **`20 / 20` (100.0%)** | **`60.1 ms`** *(warm in-process after WASM init)* | **Zero misses.** Extending `src/astExtractor.ts` across Python module-level assignments, JSON array-object items, and Markdown table rows + code fences resolves all 20 scopes and 45 edit targets in a single zero-hint outline pass. |
| **`ast-grep-py` (Pattern: Naive Identifier)** | `0.51.0` | No (requires pattern) | `1 / 20` (5.0%) | `3 / 45` (6.7%) | `1 / 20` | `19.6 ms` *(warm in-process Python binding)* | Passing bare symbol names matches only self-contained leaf nodes; returns the signature line instead of the enclosing block for classes/functions, and fails on JSON/Markdown. |
| **`ast-grep-py` (Pattern: Typed Declaration)** | `0.51.0` | No (requires syntax template) | `11 / 20` (55.0%) | `25 / 45` (55.6%) | `11 / 20` | `20.2 ms` *(warm in-process Python binding)* | Adding `def $F($$$): $$$` resolves top-level functions, but cannot disambiguate `LegacyValidator.validate_payload` vs `StrictValidator.validate_payload` without relational rules. Note: `ast-grep-py` (`Lang` enum) ships built-in grammars only for Python/JS/TS/HTML/CSS (`0/6` Markdown scopes natively); the standalone `ast-grep` CLI (`sg`) can load external custom Tree-sitter grammars via `sgconfig.yml` (`customLanguages`), but still requires caller-supplied structural rules rather than zero-hint outlines. |
| **`ast-grep-py` (Relational Rule Dict: `inside` + `has`)** | `0.51.0` | No (requires per-edit rule) | `20 / 20` (`14` AST + `6` MD fallback) | `45 / 45` (`34` AST + `11` MD fallback) | `20 / 20` | `23.5 ms` *(warm in-process Python binding)* | Reaches `14/14` on Python + JSON only when the caller constructs a custom YAML/JSON relational rule (`kind` + `inside` + `has` + `stopBy: end`) per target, and required a separate Markdown parser for the 6 Markdown scopes (`0/6` native in `ast-grep-py`). |
| **`@colbymchenry/codegraph`** | `1.6.2` | Yes (JS/TS/Py only) | `11 / 20` (55.0%) | `25 / 45` (55.6%) | `11 / 20` | `101.2 ms` *(in-process index + query)* | Indexes Python classes, functions, and methods (`11/13` Python scopes), but does not index Python module-level assignments (`0/2`) and does **not** index `.json` or `.md` files (`0 nodes`). |
| **`@probelabs/probe` (`extract` / `search`)** | `0.6.0` | No (requires query/line) | `10 / 20` (50.0%) | `24 / 45` (53.3%) | `10 / 20` | `1,636.3 ms` *(cold per-target CLI subprocess)* | Resolves Python classes/functions (`File#Symbol`), but fails on `Class.method` disambiguation (picks first class's method), Python module-level constants, JSON array elements (returns entire 270-line root object), and Markdown rows/fences. |
| **`semgrep` (`--json`)** | `1.182.1` | No (requires `-e` pattern) | `11 / 20` (55.0%) | `26 / 45` (57.8%) | `11 / 20` | `19,356.2 ms` *(cold per-file CLI subprocess)* | **6.1–9.9 seconds per cold CLI invocation** on Windows (`19.4s` across 3 Python files), `0` matches on JSON (`--lang json -e "\"ten_006\""`), and no structural Markdown table-row or section-scope support. |
| **`ripgrep` (`rg --json`)** | `15.2.0` | No (lexical regex) | `5 / 20` (25.0%) | `8 / 45` (17.8%) | `5 / 20` | `116.5 ms` *(cold per-target CLI subprocess)* | Returns single match lines (`s_line == e_line`) rather than enclosing syntactic blocks; multi-line scopes fail whenever target values lie on subsequent lines. |

---

## 2. Pre-Implementation & PR Review Remediations Applied

Both the initial pre-implementation gaps (`WM-1`..`WM-4`) and the PR #4 review findings (`WM-R1`..`WM-R3`, `WM-T1`, `WM-D1`, `WM-D2`) have been remediated in this branch:

1. **Markdown `<thead>` vs `<tbody>` Row Filtering & Full-Line Coordinates (`WM-3`, `WM-4`, `WM-R3`):**
   - Production `extractMarkdownSymbols()` tracks `tbody_open` / `tbody_close` and extracts only `<tbody>` data rows (`108` clean symbols in `MIGRATION_RUNBOOK.md` vs `129` in the PoC).
   - Every Markdown symbol (`section`, `table`, `table_row`, `code_block`) now emits `start: { line: startLine, column: 0 }` and `end: { line: endLine, column: lines[endLine - 1].length }`, eliminating zero-width (`column: 0` → `column: 0`) spans on non-empty lines while documenting that Markdown coordinates represent inclusive full-line bounds (`WM-R3`). Note that `lineEndCol()` measures JavaScript `string.length` (UTF-16 code units, where a surrogate-pair emoji such as `🚀` has length `2` vs `1` Unicode code point vs `4` UTF-8 bytes); downstream consumers (such as Patch-DIFF) must treat Markdown symbols as 1-based line-scoped observations rather than cross-runtime byte/code-point character offsets.
   - Repeated `tbody` first-cell identifiers across rows, as well as literal first-cell values that match fallback/disambiguation patterns (`/^L\d+$/` or `/\(L\d+\)$/`), are disambiguated with ` (L<startLine>)`. Empty first cells fall back to `row:L<startLine>`.
2. **Strict Python Module-Level Guard (`WM-2`):**
   - Python `assignment` extraction in `collectStructuredSymbols()` is guarded by `language === "python" && !currentClass && isPythonModuleLevelAssignment(node)`, verifying the exact AST parent chain (`assignment` → `expression_statement` → `module`) and supporting `identifier`, `pattern_list`, and `tuple_pattern` targets while excluding class-local, function-local, comprehension, control-flow-nested, and attribute/subscript assignments.
3. **Disjoint JSON Array-Object Identity Namespaces, Path-Segment Escaping & 500-Item Fail-Closed Guard (`WM-1`, `WM-R1`, `WM-R2`):**
   - **Fail-Closed Array Limit (`WM-R2`):** Exported `MAX_JSON_ARRAY_ITEMS = 500`. When a JSON array containing object elements has `> 500` items (e.g., `501`), `extractJsonArrayObjects()` throws `WaymarkError("OUTLINE_LIMIT_EXCEEDED", ...)` rather than failing open with an incomplete outline that omits `config_item` symbols.
   - **Unambiguous Path-Segment Encoding & File-Wide Uniqueness Guard (`WM-R1`):**
     - `encodeJsonPathSegment(key)` escapes `\`, `.`, `[`, and `]` with a backslash before joining nested JSON property keys or array prefixes, so `{"a": {"b": [{"id": "x"}]}, "a.b": [{"id": "x"}]}` emits distinct symbols (`a.b` / `a.b[x]` vs `a\.b` / `a\.b[x]`).
     - A single file-wide `emittedInFile` set in `collectJsonSymbols()` guards all `config_block` and `config_item` emissions across the entire JSON document and fails closed with `WaymarkError("AMBIGUOUS_SYMBOL_IDENTITY", ...)` if duplicate JSON object keys ever produce identical symbol names.
     - Within each array, all distinct candidate string values across all identifying keys (`id`, `name`, `key`, `*_id`) on every object (including multi-key conflicted objects) are counted in `idCounts`, and bracket labels in `${prefix}[${label}]` are partitioned into three pairwise-disjoint sets:
       1. **Unnamed index fallback (`/^\d+$/`):** Emitted *only* for unnamed objects (`candId === null`) as `${prefix}[${index}]`.
       2. **Disambiguated `#<index>` suffix (`/#\d+$/`):** Emitted as `${prefix}[${candId}#${index}]` whenever `candId` is duplicated across array elements (`idCounts.get(candId) > 1`), the object has multiple conflicting or non-string/empty identifying keys, `candId` is purely numeric (`/^\d+$/`, preventing collision with unnamed index fallbacks like `items[1]`), or `candId` ends with `#<digits>` (`/#\d+$/`, preventing collision with `#<index>` suffixes like `[x#0]`).
       3. **Unambiguous literal IDs (neither `/^\d+$/` nor `/#\d+$/`):** Emitted as `${prefix}[${candId}]` only when unique across the array and unconflicted.
4. **Type Contract & Two-Verb MCP Preservation:**
   - Extended `StructuredSymbolKind` with `"config_item" | "table_row" | "code_block"`. The public result envelope and two-verb MCP surface (`waymark_ask`, `waymark_memory`) remain unchanged.

---

## 3. File-by-File Implementation Summary (`WM-D2`)

All **5 changed files** in this PR are accounted for below:

| File | Workstream | Summary of Changes |
| :--- | :--- | :--- |
| `src/astExtractor.ts` | Workstream A | Added `"config_item" \| "table_row" \| "code_block"` to `StructuredSymbolKind`; added `isPythonModuleLevelAssignment()` and Python module-level `assignment` extraction in `collectStructuredSymbols()`; extended `extractMarkdownSymbols()` with `tbody`-scoped `table_row` extraction, pattern-safe `(L<line>)` disambiguation, `fence:L<startLine>` extraction, and full-line `end.column` coordinates (`WM-R3`); extended `collectJsonSymbols()` with `MAX_JSON_ARRAY_ITEMS = 500` fail-closed `OUTLINE_LIMIT_EXCEEDED` guard (`WM-R2`) and pairwise-disjoint `extractJsonArrayObjects()` naming (`WM-R1`). |
| `test/symbolDiscovery.test.ts` | Workstream B | Updated `doc.md` snapshot for `row:val1`; added 4 regression subtests (`A1`, `A2`, `A3`, `B5/B6/B7`) including `WM-R1` collision cases (`[{"id":"1"},{"other":"unnamed"}]`, `[{"id":"x","name":"y"},{"id":"x#0"}]`, `[{"id":"x","name":"y"},{"id":"x"}]`), `WM-R2` `500`/`501`-item boundary tests, and `WM-R3` non-zero `end.column` and Markdown row collision assertions (`WM-T1`). |
| `README.md` | Workstream C | Documented Python module-level `variable` assignments, JSON `config_item` array-object scopes, disjoint `#index` disambiguation, `OUTLINE_LIMIT_EXCEEDED` fail-closed behavior above 500 items, and Markdown `table_row` / `code_block` full-line spans. |
| `docs/architecture.md` | Workstream C | Updated the Single-File AST Outlines matrix and expanded the **Semantic Uniqueness, Coordinate Semantics & Position-Stability Contract** note. |
| `docs/targeted-structural-discovery-report.md` | Workstream C / D | Added this implementation, evidence, and categorized findings report (`WM-D1`, `WM-D2`). |

---

## 4. Source-Level Evidence on Original Unmodified Hard-Suite Fixtures

Executed against the unmodified fixtures in `Editing-Toolbench/10-26-26/fixtures` using compiled `dist/src/astExtractor.js`:

| Fixture | Total Symbols (Stock → New) | Newly Supported Scope | Kind | Exact Extracted Coordinates (`start` → `end`) |
| :--- | :--- | :--- | :--- | :--- |
| `matrix_kernel.py` | `21` → `26` | `FRAME_SYNC_STREAM` | `variable` | `{"line":7,"column":0}` → `{"line":7,"column":67}` |
| `validator_engine.py` | `29` → `32` | `VALID_SCOPES` | `variable` | `{"line":6,"column":0}` → `{"line":6,"column":38}` |
| `routing_manifest.json` | `3` → `23` | `tenants[ten_006]` | `config_item` | `{"line":75,"column":4}` → `{"line":88,"column":5}` |
| `routing_manifest.json` | `3` → `23` | `tenants[ten_013]` | `config_item` | `{"line":173,"column":4}` → `{"line":186,"column":5}` |
| `routing_manifest.json` | `3` → `23` | `tenants[ten_018]` | `config_item` | `{"line":243,"column":4}` → `{"line":256,"column":5}` |
| `MIGRATION_RUNBOOK.md` | `41` → `108` | `row:CHK-14-C` | `table_row` | `{"line":162,"column":0}` → `{"line":162,"column":66}` |
| `MIGRATION_RUNBOOK.md` | `41` → `108` | `row:canary-v3` | `table_row` | `{"line":235,"column":0}` → `{"line":235,"column":54}` |
| `MIGRATION_RUNBOOK.md` | `41` → `108` | `fence:L241` | `code_block` | `{"line":241,"column":0}` → `{"line":251,"column":3}` |

---

## 5. Regression Test Execution & Remaining Gaps

### Executed Commands & Actual Outcomes
1. **Build & Type Check (`tsc -p tsconfig.json`):**
   - **Command:** `npm run build`
   - **Outcome:** Exit code `0` (`[patch-web-tree-sitter] web-tree-sitter already patched`, zero TypeScript compilation errors).
2. **Symbol Discovery Regression Suite:**
   - **Command:** `node --test "dist/test/symbolDiscovery.test.js"`
   - **Outcome:** Exit code `0` — **`24/24` tests passed** (`0` failed, `0` skipped, duration `76,817.934 ms`), including:
     - `ok 18` — Snapshot tests for Markdown, JSON, TOML, YAML, and Bash fixtures
     - `ok 21` — `A1`: Python module-level assignments extracted (`FRAME_SYNC_STREAM`, `VALID_SCOPES`, tuple/pattern unpacking); function-local, class-local, control-flow-nested, and attribute/subscript assignments excluded (`905.7 ms`)
     - `ok 22` — `A2`: JSON array-object discovery (`id`, `name`, `key`, `*_id`, missing IDs `[idx]`, duplicate IDs `#idx`, conflicting keys `#idx`, `WM-R1` numeric/hash/shared-conflict collision suites, `WM-R2` 500-item success and 501-item `OUTLINE_LIMIT_EXCEEDED` fail-closed check, nested arrays, root arrays, Unicode keys) (`1,040.1 ms`)
     - `ok 23` — `A3`: Markdown `tbody` table rows (`row:CHK-14-C`, `row:canary-v3`), exclusion of `<thead>` headers, repeated and pattern-colliding row disambiguation (`row:L5 (L3)`, `row:foo (L6) (L4)`), fenced code block scopes (`fence:L20`), and `WM-R3` non-zero `end.column` assertions (`912.0 ms`)
     - `ok 24` — `B5/B6/B7`: Direct library, CLI (`--outline`), and MCP (`waymark_ask`) byte-for-byte symbol parity and strict verification that `tools/list` exposes only `["waymark_ask", "waymark_memory"]` (`3,609.2 ms`).

### Remaining Gaps
- **Deeply nested JSON arrays (>2 object levels deep):** `collectJsonSymbols` extracts root-level arrays, top-level property arrays (`tenants[...]`), and second-level property arrays (`cluster.nodes[...]`). Arrays nested 3+ object levels deep are intentionally not flattened into the top-level outline.
- **Query filtering is a substring filter, not an exact-identity admission gate (`WM-T1`):** Passing `query` to `discoverSymbolsInFile(repo, path, lang, query)` filters symbols by `s.name.toLowerCase().includes(q)`. Downstream mutation layers (Patch-DIFF) must match exact symbol names and kinds rather than treating a filtered outline query as an unambiguous single-symbol selector.
- **Python control-flow-guarded constants:** Assignments inside `if TYPE_CHECKING:` or `try/except ImportError:` blocks are excluded by `isPythonModuleLevelAssignment(node)` to avoid exposing conditional bindings as unconditional module globals.

---

## 6. Separate Findings & Disposition: Waymark Engine vs. Benchmark (Workstream D)

### Category 1: Waymark Engine Findings (All Remediated in PR #4)

| ID | Severity | Finding | Disposition & Verification |
| :--- | :--- | :--- | :--- |
| **WM-1** | **P1** | PoC JSON array-object extraction emitted identical symbol names (`tenants[dup]`) when multiple array elements shared an `id`, or silently picked the first property when an object had conflicting `id` and `name` keys. | **Fixed in `src/astExtractor.ts`:** Pre-scans each array for duplicate IDs and per-object conflicting keys, appending `#<index>` (`prefix[id#idx]`). Verified in `test/symbolDiscovery.test.ts` (`A2`). |
| **WM-2** | **P1** | Python `assignment` extraction without an ancestor check could leak class attributes or control-flow-local variables. | **Fixed in `src/astExtractor.ts`:** Added `isPythonModuleLevelAssignment(node)` verifying `assignment` → `expression_statement` → `module`. Verified in `test/symbolDiscovery.test.ts` (`A1`). |
| **WM-R1** | **P1** | Emitted `config_item` and `config_block` names could collide across within-array cases (`{"id":"1"}` vs unnamed index `1`; `items[x#0]` vs literal `{"id":"x#0"}`; `[{"id":"x","name":"y"},{"id":"x"}]`) and across separate arrays when a top-level key contained a literal dot (`{"a":{"b":[{"id":"x"}]},"a.b":[{"id":"x"}]}`) or when a JSON object contained duplicate keys. | **Fixed in `src/astExtractor.ts`:** `encodeJsonPathSegment()` backslash-escapes `\`, `.`, `[`, `]` in property names (`a.b[x]` vs `a\.b[x]`); `emittedInFile` enforces file-wide symbol uniqueness (`AMBIGUOUS_SYMBOL_IDENTITY` on duplicate keys); `idCounts` counts all distinct identifying values on every object; and literal IDs matching `/^\d+$/` or `/#\d+$/` are forced into the `#<index>` namespace (`items[1#0]`, `[x#0#1]`). Verified in `test/symbolDiscovery.test.ts` (`A2`). |
| **WM-R2** | **P1** | JSON arrays with `> 500` items silently returned `0` `config_item` symbols while still emitting the enclosing `config_block` (fail-open incomplete outline). | **Fixed in `src/astExtractor.ts`:** Arrays containing objects with `> 500` elements now fail closed with `WaymarkError("OUTLINE_LIMIT_EXCEEDED", ...)`. Verified in `test/symbolDiscovery.test.ts` (`A2` with `500` and `501` items). |
| **WM-3** | **P2** | PoC Markdown `tr_open` extraction emitted `table_row` symbols for `<thead>` header rows (`row:Check ID`). | **Fixed in `src/astExtractor.ts`:** Scoped `table_row` extraction strictly to `inTbody === true`. Verified in `test/symbolDiscovery.test.ts` (`A3`, snapshot `ok 18`). |
| **WM-4** | **P2** | Repeated Markdown first-cell identifiers across tables produced indistinguishable `row:<name>` names in the PoC. | **Fixed in `src/astExtractor.ts`:** Disambiguates repeated or pattern-colliding (`/^L\d+$/`, `/\(L\d+\)$/`) row identifiers as `row:<name> (L<startLine>)`. Verified in `test/symbolDiscovery.test.ts` (`A3`). |
| **WM-R3** | **P2** | Markdown symbols (`table_row`, `code_block`, `table`, `section`) emitted `end.column = 0`, producing zero-width spans on single-line table rows, and needed explicit documentation of UTF-16 `string.length` vs UTF-8 byte / Unicode code-point column units. | **Fixed in `src/astExtractor.ts` & docs:** `end.column` is populated with `lines[endLine - 1].length` (UTF-16 code units), providing non-zero inclusive full-line character spans (`row:CHK-14-C` → `column: 66`, `fence:L241` → `column: 3`), and documented as 1-based line-scoped observations. Verified with ASCII and emoji (`🚀`) rows in `test/symbolDiscovery.test.ts` (`A3`). |
| **WM-T1** | **P2** | Initial regression suite did not cover within-array and cross-array final-name collisions (`WM-R1`), the `500`/`501` JSON item boundary (`WM-R2`), or non-zero/emoji Markdown `end.column` coordinates (`WM-R3`). | **Fixed in `test/symbolDiscovery.test.ts`:** Added explicit assertions for all boundary classes in subtests `A2` and `A3`. |
| **WM-D1** | **P2** | Report table needed explicit qualification that `20/20` checks come from the benchmark's scoped-slice simulation rather than guarded Patch-DIFF transactional execution, along with cold/warm timing, `ast-grep` Markdown qualifications, and accurate `audit/manifest ledger` terminology (PostgreSQL in current Patch-DIFF vs file-authoritative intended design). | **Fixed in `docs/targeted-structural-discovery-report.md`:** Relabeled column to *Scoped-Slice Simulation / Final-Workspace Checks (`/20`)*, replaced `SQLite ledger` with `audit/manifest ledger (PostgreSQL / file-authoritative)`, and qualified cold/warm modes and `ast-grep-py` vs `ast-grep` CLI Markdown behavior. |
| **WM-D2** | **P3** | File-by-file summary table listed 4 files instead of all 5 changed files in the PR. | **Fixed in `docs/targeted-structural-discovery-report.md`:** Listed all 5 changed files in Section 3. |

---

### Category 2: External Benchmark Harness Findings — Workstream D (Separate Effort; Unmodified in PR #4)

Per Workstream D, no benchmark files were modified in this PR. Below is the categorized P1/P2/P3 follow-up finding list for an independently auditable benchmark-remediation effort:

| ID | Severity | Location in `Editing-Toolbench/10-26-26` | Finding & Remediation Requirement |
| :--- | :--- | :--- | :--- |
| **BM-1** | **P1** | `run_all_benchmarks.py` (`apply_scoped_edits_and_verify`) | **Direct Python string slicing described as Patch-DIFF integration:** Slices lines in Python (`lines[s_line - 1 : e_line]`) and calls `.replace(old_val, new_val, 1)` directly on disk rather than invoking Patch-DIFF's MCP admission/commit pipeline (`patchdiff_read_target` → `patchdiff_submit_edits` → `patchdiff_save`). Relabel as *"Scoped-Slice Simulation"* or wire through actual Patch-DIFF MCP calls. |
| **BM-2** | **P1** | `run_all_benchmarks.py` | **Receipts issued in the narrative but never enforced by the harness:** The benchmark does not mint or validate observation receipts (`obs_id`, content hash, or span bounds) before applying mutations. An out-of-scope or stale edit would not be rejected by an admission gate. |
| **BM-3** | **P1** | `waymark_runner.mjs` (`matchScope`), `run_all_benchmarks.py` | **Substring-based scope selection and silent smallest-scope selection:** `matchScope()` matches `s.name === query \|\| s.name.includes(query)` and silently picks the smallest line span (`(a.endLine - a.line) - (b.endLine - b.line)`). If a query is a substring of both a parent scope and an unrelated child scope, smallest-span tie-breaking can silently select the wrong symbol. |
| **BM-4** | **P2** | `run_all_benchmarks.py` (`apply_scoped_edits_and_verify`) | **Hardcoded selection of overlapping occurrences (`exact_hits[0]`):** When multiple scopes in the symbol list contain `old_val` (e.g., an enclosing `section` or `table` and a nested `table_row`), `apply_scoped_edits_and_verify()` picks `exact_hits[0]` after sorting by span length rather than requiring explicit symbol-kind + exact-name targeting. |
| **BM-5** | **P2** | `run_all_benchmarks.py` (`R19`) | **Markdown fence coverage not directly exercised:** Task `R19` (`MIGRATION_RUNBOOK.md`) sets `scope_query: "4. Literal Patch"`, which matches the enclosing H2 `section` (`4. Literal Patch & Fence Section`, lines 237–252) rather than directly querying `fence:L241` (`kind: "code_block"`, lines 241–251). Update `R19` in a benchmark PR to target `fence:L241` directly. |
| **BM-6** | **P2** | `waymark_runner.mjs`, `run_all_benchmarks.py` | **Cold vs. warm timing inconsistencies:** `waymark-engine` and `codegraph` timings measure warm in-process extraction inside a single Node.js process after grammar/graph initialization, whereas `probe` and `semgrep` timings measure per-file cold CLI subprocess spawns on Windows. Benchmark tables should report cold init time and warm per-query latency separately. |
| **BM-7** | **P3** | `run_all_benchmarks.py`, `waymark_runner.mjs` | **Absolute Windows paths & non-portable fixture references:** Both runner scripts hardcode `C:\Users\USER\Desktop\Frameworks\...` and `C:\Users\USER\AppData\Roaming\npm\...` instead of resolving paths relative to `__file__` / `import.meta.dirname` and environment variables (`WAYMARK_ROOT`), and should package the original fixtures/verifier or deterministic generator with pinned tool versions. |
