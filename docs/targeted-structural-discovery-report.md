# Targeted Structural Discovery Extension & Benchmark Verification Report

**Date:** 2026-10-26  
**Scope:** Waymark Engine (`src/astExtractor.ts`, `test/symbolDiscovery.test.ts`, `README.md`, `docs/architecture.md`)  
**Benchmark Reference:** `Editing-Toolbench/10-26-26` (20-scope / 45-target hard suite across Python, JSON, and Markdown)

---

## 1. Executive Summary

To evaluate whether Waymark Engine or an external structural discovery alternative (`ast-grep`, `@colbymchenry/codegraph`, `@probelabs/probe`, `semgrep`, `ripgrep`) best serves as the structural discovery substrate for targeted editing workflows, we executed a 20-scope / 45-target empirical benchmark across five multi-hundred-line fixtures (`matrix_kernel.py`, `validator_engine.py`, `schema_defs.py`, `routing_manifest.json`, `MIGRATION_RUNBOOK.md`).

### Comparative Benchmark Results (20 Scopes / 45 Edit Targets)

| Tool / Engine | Version | Zero-Hint Outline? | Scopes Resolved (`/20`) | Edit Targets Resolved (`/45`) | Final Workspace Checks (`/20`) | Discovery Time (5 files) | Why Targets Were Missed / Operational Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`waymark-engine` (Stock v4.0.2)** | `4.0.2` | **Yes** | `11 / 20` (55.0%) | `26 / 45` (57.8%) | `11 / 20` | `75.5 ms` | Missed 2 Python module-level assignments (`FRAME_SYNC_STREAM`, `VALID_SCOPES`), 3 JSON array-object scopes (`tenants[ten_*]`), and 4 Markdown table-row / code-fence scopes (`row:CHK-14-C`, `row:canary-v3`, `fence:L241`). |
| **`waymark-engine` (Extended — This PR)** | `4.0.2+ext` | **Yes** | **`20 / 20` (100.0%)** | **`45 / 45` (100.0%)** | **`20 / 20` (100.0%)** | **`60.1 ms`** | **Zero misses.** Extending `src/astExtractor.ts` across Python module-level assignments, JSON array-object items, and Markdown table rows + code fences resolves all 20 scopes and 45 edit targets in a single zero-hint outline pass. |
| **`ast-grep-py` (Pattern: Naive Identifier)** | `0.51.0` | No (requires pattern) | `1 / 20` (5.0%) | `3 / 45` (6.7%) | `1 / 20` | `19.6 ms` | Passing bare symbol names matches only self-contained leaf nodes; returns the signature line instead of the enclosing block for classes/functions, and fails on JSON/Markdown. |
| **`ast-grep-py` (Pattern: Typed Declaration)** | `0.51.0` | No (requires syntax template) | `11 / 20` (55.0%) | `25 / 45` (55.6%) | `11 / 20` | `20.2 ms` | Adding `def $F($$$): $$$` resolves top-level functions, but cannot disambiguate `LegacyValidator.validate_payload` vs `StrictValidator.validate_payload` without relational rules, and has no Markdown grammar (`Lang` supports only Python/JS/TS/HTML/CSS). |
| **`ast-grep-py` (Relational Rule Dict: `inside` + `has`)** | `0.51.0` | No (requires per-edit rule) | `20 / 20` (`14` AST + `6` MD fallback) | `45 / 45` (`34` AST + `11` MD fallback) | `20 / 20` | `23.5 ms` | Reaches `14/14` on Python + JSON only when the caller constructs a custom YAML/JSON relational rule (`kind` + `inside` + `has` + `stopBy: end`) per target, and still requires a separate parser for Markdown (`0/6` native). |
| **`@colbymchenry/codegraph`** | `1.6.2` | Yes (JS/TS/Py only) | `11 / 20` (55.0%) | `25 / 45` (55.6%) | `11 / 20` | `101.2 ms` | Indexes Python classes, functions, and methods (`11/13` Python scopes), but does not index Python module-level assignments (`0/2`) and does **not** index `.json` or `.md` files (`0 nodes`). |
| **`@probelabs/probe` (`extract` / `search`)** | `0.6.0` | No (requires query/line) | `10 / 20` (50.0%) | `24 / 45` (53.3%) | `10 / 20` | `1,636.3 ms` | Resolves Python classes/functions (`File#Symbol`), but fails on `Class.method` disambiguation (picks first class's method), Python module-level constants, JSON array elements (returns entire 270-line root object), and Markdown rows/fences. |
| **`semgrep` (`--json`)** | `1.182.1` | No (requires `-e` pattern) | `11 / 20` (55.0%) | `26 / 45` (57.8%) | `11 / 20` | `19,356.2 ms` | **6.1–9.9 seconds per CLI invocation** on Windows (`19.4s` across 3 Python files), `0` matches on JSON (`--lang json -e "\"ten_006\""`), and no structural Markdown table-row or section-scope support. |
| **`ripgrep` (`rg --json`)** | `15.2.0` | No (lexical regex) | `5 / 20` (25.0%) | `8 / 45` (17.8%) | `5 / 20` | `116.5 ms` | Returns single match lines (`s_line == e_line`) rather than enclosing syntactic blocks; multi-line scopes fail whenever target values lie on subsequent lines. |

---

## 2. Pre-Implementation Plan Remediations Applied

Before implementing the production changes in `src/astExtractor.ts`, five edge cases in the benchmark proof-of-concept (`waymark_runner.mjs`) were identified and remediated:

1. **Markdown `<thead>` vs `<tbody>` Row Filtering (`src/astExtractor.ts`, `test/symbolDiscovery.test.ts`):**
   - The PoC's `discoverExtended()` emitted `table_row` symbols for every `tr_open`, polluting `MIGRATION_RUNBOOK.md` with 21 `<thead>` header rows (`row:Check ID`, `row:Cohort`).
   - Production `extractMarkdownSymbols()` tracks `tbody_open` / `tbody_close` and extracts only `<tbody>` data rows (`108` clean symbols in `MIGRATION_RUNBOOK.md` vs `129` in the PoC).
   - Updated the existing `doc.md` snapshot in `test/symbolDiscovery.test.ts` to include `{ name: "row:val1", kind: "table_row", line: 7 }`.
2. **Strict Python Module-Level Guard (`src/astExtractor.ts`):**
   - Because `collectStructuredSymbols()` is shared across 19+ Tree-sitter grammars and `parseSourceIndex()`, Python `assignment` extraction is guarded by `language === "python" && !currentClass && isPythonModuleLevelAssignment(node)`, which walks the AST parent chain to `module` and rejects assignments inside functions, classes, comprehensions, or control-flow blocks (`if`/`for`/`while`/`with`/`try`) as well as attribute/subscript mutations (`obj.x = 1`, `arr[0] = 1`).
   - Added support for module-level tuple/pattern unpacking (`ALPHA, BETA = 10, 20` and `(GAMMA, DELTA) = (30, 40)`).
3. **Explicit JSON Array-Object Disambiguation (`src/astExtractor.ts`):**
   - Rather than silently claiming non-unique or conflicting keys are unique semantic IDs, `extractJsonArrayObjects()` pre-scans each array (`id`, `name`, `key`, `*_id`):
     - **Unique single identifier:** `tenants[ten_006]`
     - **Missing identifier (or empty string / non-string):** `items[0]`
     - **Duplicate identifier across elements in the same array:** `dup_tenants[ten_dup#0]`, `dup_tenants[ten_dup#1]`
     - **Conflicting identifying keys on the same object** (e.g., both `"id": "conflict_a"` and `"name": "conflict_b"` with different values): `conflicting[conflict_a#0]`
   - Supports top-level object property arrays (`tenants[...]`), second-level object property arrays (`cluster.nodes[node_a]`), and root-level JSON arrays (`[root_0]`), bounded by `MAX_JSON_ARRAY_ITEMS = 500`.
4. **Markdown Duplicate Row & Fenced Code Block Disambiguation (`src/astExtractor.ts`):**
   - When the same first-cell identifier appears in multiple `<tbody>` rows (within one table or across multiple tables), all occurrences are disambiguated with their 1-based line number: `row:CHK-DUP (L6)` and `row:CHK-DUP (L12)`. Empty first cells fall back to `row:L<startLine>`.
   - Fenced code blocks emit `fence:L<startLine>` (`kind: "code_block"`) with exact opening-to-closing fence line ranges.
5. **Type Contract & Two-Verb MCP Preservation (`src/astExtractor.ts`):**
   - Extended `StructuredSymbolKind` with `"config_item" | "table_row" | "code_block"`. No changes were required to the public result envelope or the two-verb MCP surface (`waymark_ask`, `waymark_memory`).

---

## 3. File-by-File Implementation Summary

| File | Workstream | Summary of Changes |
| :--- | :--- | :--- |
| `src/astExtractor.ts` | Workstream A (`+174 / -1`) | Added `"config_item" \| "table_row" \| "code_block"` to `StructuredSymbolKind`; added `isPythonModuleLevelAssignment()` and Python module-level `assignment` extraction in `collectStructuredSymbols()`; extended `extractMarkdownSymbols()` with `tbody`-scoped `table_row` extraction (with duplicate `(L<line>)` disambiguation) and `fence` extraction (`fence:L<startLine>`); extended `collectJsonSymbols()` with `isJsonIdentifyingKey()` and `extractJsonArrayObjects()`. |
| `test/symbolDiscovery.test.ts` | Workstream B (`+282 / -0`) | Updated `doc.md` snapshot for `row:val1`; added 4 comprehensive regression subtests covering Workstreams A1, A2, A3, and B5/B6/B7 (library, CLI, and MCP parity + strict 2-verb MCP schema check). |
| `README.md` | Workstream C (`+2 / -2`) | Documented Python module-level `variable` assignments, JSON `config_item` array-object scopes and `#index` disambiguation, and Markdown `table_row` (`row:<first-cell>`) and `code_block` (`fence:L<startLine>`) scopes. |
| `docs/architecture.md` | Workstream C (`+5 / -3`) | Updated the Single-File AST Outlines matrix and added the **Semantic Uniqueness & Position-Stability Contract** note. |

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
| `MIGRATION_RUNBOOK.md` | `41` → `108` | `row:CHK-14-C` | `table_row` | `{"line":162,"column":0}` → `{"line":162,"column":0}` |
| `MIGRATION_RUNBOOK.md` | `41` → `108` | `row:canary-v3` | `table_row` | `{"line":235,"column":0}` → `{"line":235,"column":0}` |
| `MIGRATION_RUNBOOK.md` | `41` → `108` | `fence:L241` | `code_block` | `{"line":241,"column":0}` → `{"line":251,"column":0}` |

---

## 5. Regression Test Execution & Remaining Gaps

### Executed Commands & Actual Outcomes
1. **Build & Type Check (`tsc -p tsconfig.json`):**
   - **Command:** `npm run build`
   - **Outcome:** Exit code `0` (`[patch-web-tree-sitter] web-tree-sitter already patched`, zero TypeScript compilation errors).
2. **Symbol Discovery Regression Suite:**
   - **Command:** `node --test "dist/test/symbolDiscovery.test.js"`
   - **Outcome:** Exit code `0` — **`24/24` tests passed** (`0` failed, `0` skipped, duration `65,799.031 ms`), including:
     - `ok 18` — Snapshot tests for Markdown, JSON, TOML, YAML, and Bash fixtures
     - `ok 21` — `A1`: Python module-level assignments extracted (`FRAME_SYNC_STREAM`, `VALID_SCOPES`, tuple/pattern unpacking); function-local, class-local, control-flow-nested, and attribute/subscript assignments excluded (`754.4 ms`)
     - `ok 22` — `A2`: JSON array-object discovery (`id`, `name`, `key`, `*_id`, missing IDs `[idx]`, duplicate IDs `#idx`, conflicting keys `#idx`, nested arrays, root arrays, Unicode keys, malformed JSON resilience) (`820.5 ms`)
     - `ok 23` — `A3`: Markdown `tbody` table rows (`row:CHK-14-C`, `row:canary-v3`), exclusion of `<thead>` headers, repeated row disambiguation (`row:CHK-DUP (L6)`, `row:CHK-DUP (L12)`), and fenced code block scopes (`fence:L14`, `fence:L20`) (`745.8 ms`)
     - `ok 24` — `B5/B6/B7`: Direct library, CLI (`--outline --json`), and MCP (`waymark_ask`) byte-for-byte symbol parity and strict verification that `tools/list` exposes only `["waymark_ask", "waymark_memory"]` (`2,926.5 ms`).

### Remaining Gaps
- **Deeply nested JSON arrays (>2 object levels deep):** `collectJsonSymbols` extracts root-level arrays, top-level property arrays (`tenants[...]`), and second-level property arrays (`cluster.nodes[...]`). Arrays nested 3+ object levels deep are intentionally not flattened into the top-level outline to keep outline token budgets compact.
- **Python control-flow-guarded constants:** Assignments inside `if TYPE_CHECKING:` or `try/except ImportError:` blocks are excluded by `isPythonModuleLevelAssignment(node)` to avoid exposing conditional/local bindings as unconditional module globals.

---

## 6. Separate Findings & Disposition: Waymark Engine vs. Benchmark (Workstream D)

### Category 1: Waymark Engine Findings (All Remediated in This PR)

| ID | Severity | Finding | Disposition |
| :--- | :--- | :--- | :--- |
| **WM-1** | **P1** | JSON array-object extraction in the PoC silently emitted identical symbol names (`tenants[dup]`) when multiple array elements shared an `id`, or silently picked the first matching property when an object had conflicting `id` and `name` properties. | **Fixed in `src/astExtractor.ts`:** Pre-scans each array for duplicate IDs and per-object conflicting ID keys, appending `#<index>` (`prefix[id#idx]`) whenever uniqueness is violated. |
| **WM-2** | **P1** | Python `assignment` extraction without an ancestor check could leak class attributes or control-flow-local variables if `currentClass` were not set or if assignments appeared inside module-level `if`/`for`/`try` blocks. | **Fixed in `src/astExtractor.ts`:** Added `isPythonModuleLevelAssignment(node)` verifying the exact parent chain (`assignment` → `expression_statement` → `module`). |
| **WM-3** | **P2** | Markdown `tr_open` extraction in the PoC emitted `table_row` symbols for `<thead>` table header rows (`row:Check ID`, `row:Cohort`), adding noise and breaking the existing `doc.md` snapshot expectation. | **Fixed in `src/astExtractor.ts`:** Scoped `table_row` extraction strictly to `inTbody === true`. |
| **WM-4** | **P2** | Repeated Markdown first-cell identifiers across multiple tables produced indistinguishable `row:<name>` symbol names in the PoC. | **Fixed in `src/astExtractor.ts`:** Two-pass `rowNameCounts` check disambiguates all colliding row identifiers as `row:<name> (L<startLine>)`. |

---

### Category 2: Benchmark Harness Findings — Workstream D (Out of Scope for This PR; Unmodified)

Per Workstream D, no benchmark files were modified in this PR. Below is the categorized P1/P2/P3 follow-up finding list for an independently auditable benchmark-remediation PR:

| ID | Severity | Location in `Editing-Toolbench/10-26-26` | Finding & Remediation Requirement |
| :--- | :--- | :--- | :--- |
| **BM-1** | **P1** | `run_all_benchmarks.py` (`apply_scoped_edits_and_verify`) | **Direct Python string slicing described as Patch-DIFF integration:** Slices lines in Python (`lines[s_line - 1 : e_line]`) and calls `.replace(old_val, new_val, 1)` directly on disk rather than invoking Patch-DIFF's MCP admission/commit pipeline (`patchdiff_read_target` → `patchdiff_submit_edits` → `patchdiff_save`). Relabel as *"Scoped-Slice Simulation"* or wire through actual Patch-DIFF MCP calls. |
| **BM-2** | **P1** | `run_all_benchmarks.py` | **Receipts issued in the narrative but never enforced by the harness:** The benchmark does not mint or validate observation receipts (`obs_id`, content hash, or span bounds) before applying mutations. An out-of-scope or stale edit would not be rejected by an admission gate. |
| **BM-3** | **P1** | `waymark_runner.mjs` (`matchScope`), `run_all_benchmarks.py` | **Substring-based scope selection and silent smallest-scope selection:** `matchScope()` matches `s.name === query \|\| s.name.includes(query)` and silently picks the smallest line span (`(a.endLine - a.line) - (b.endLine - b.line)`). If a query is a substring of both a parent scope and an unrelated child scope, smallest-span tie-breaking can silently select the wrong symbol. |
| **BM-4** | **P2** | `run_all_benchmarks.py` (`apply_scoped_edits_and_verify`) | **Hardcoded selection of overlapping occurrences (`exact_hits[0]`):** When multiple scopes in the symbol list contain `old_val` (e.g., an enclosing `section` or `table` and a nested `table_row`), `apply_scoped_edits_and_verify()` picks `exact_hits[0]` after sorting by span length rather than requiring explicit symbol-kind + exact-name targeting. |
| **BM-5** | **P2** | `run_all_benchmarks.py` (`R19`) | **Markdown fence coverage not directly exercised:** Task `R19` (`MIGRATION_RUNBOOK.md`) sets `scope_query: "4. Literal Patch"`, which matches the enclosing H2 `section` (`4. Literal Patch & Fence Section`, lines 237–252) rather than directly querying `fence:L241` (`kind: "code_block"`, lines 241–251). Update `R19` in a benchmark PR to target `fence:L241` directly. |
| **BM-6** | **P2** | `waymark_runner.mjs`, `run_all_benchmarks.py` | **Cold vs. warm timing inconsistencies:** `waymark-engine` and `codegraph` timings measure warm in-process extraction inside a single Node.js process after grammar/graph initialization, whereas `probe` and `semgrep` timings measure per-file cold CLI subprocess spawns on Windows. Benchmark tables should report cold init time and warm per-query latency separately. |
| **BM-7** | **P3** | `run_all_benchmarks.py`, `waymark_runner.mjs` | **Absolute Windows paths & non-portable fixture references:** Both runner scripts hardcode `C:\Users\USER\Desktop\Frameworks\...` and `C:\Users\USER\AppData\Roaming\npm\...` instead of resolving paths relative to `__file__` / `import.meta.dirname` and environment variables (`WAYMARK_ROOT`). |
