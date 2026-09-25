# Specification: Tier 2 — Literal Path & Filename Router

**Tier Identifier**: `path` / `literal-path`  
**Owning Module**: [`src/discoveryRouter.ts`](../src/discoveryRouter.ts)  
**Status**: Stable

---

## 1. Purpose & Responsibility

Tier 2 bridges the **filename blind spot** inherent in statistical tokenizers (such as BM25). When an agent asks for a specific file (e.g., `sample.ts`, `src/api/webhooks.ts`, `.gitignore`, `Dockerfile`), standard lexical scoring dilutes file names across frequent occurrences in prose and import headers.

Tier 2 intercepts literal file references directly in memory before they dilute into search passes. It evaluates an in-memory, memoized array of repository paths using a deterministic, fail-closed matching cascade.

---

## 2. Entry Conditions & Intent Routing

Queries enter Tier 2 when `detectLiteralIntent(question)` returns `isLiteral: true`, or when forced via `--tier path`.

```typescript
export interface LiteralIntent {
  isLiteral: boolean;
  normalized: string;
}
```

A query is classified as a literal filename when:
- It contains a path separator (`/` or `\`).
- It ends with a known code/config extension (60+ supported extensions: `.ts`, `.js`, `.py`, `.go`, `.rs`, `.zig`, `.json`, `.yaml`, `.toml`, `.md`, `.sql`, etc.).
- It starts with a dot (`.` e.g., `.gitignore`, `.env.example`).
- It matches a known extensionless build/infrastructure filename (`Dockerfile`, `Makefile`, `Jenkinsfile`, `Procfile`, `Justfile`).

---

## 3. Matching Cascade & Invariants

Matching follows a strict 4-step fail-closed cascade over repository paths collected via `collectRepoPaths(root)` (cached with a 30-second TTL, excluding build directories such as `node_modules`, `dist`, `.git`, `.capn`):

1. **Exact Match (Case-Insensitive with Strict Tie-Breaker)**:
   Matches all paths matching the normalized query case-insensitively. If multiple paths match only differing by case, a strict case-sensitive match takes precedence.
2. **Unique Basename Match**:
   Extracts `baseName = normalized.split("/").pop()`. If exactly one repository path has this basename, it matches with `kind: "basename"`. If multiple files share the basename, the step refuses to guess and fails closed to prevent ambiguous attributions.
3. **Unique Suffix Match**:
   Finds paths ending with `/normalized`. If exactly one path matches, it succeeds with `kind: "suffix"`.
4. **Unique Substring Match**:
   Finds paths containing `normalized`. If exactly one path matches, it succeeds with `kind: "substring"`.

If multiple ambiguous candidates remain at any step (e.g., two files named `utils.ts` in different directories), Tier 2 fails closed (`matches: []`) and allows the query to proceed to the Discovery Junction.

---

## 4. Measurable Operational Metrics

| Metric | Specification / Observed Value | Notes |
| :--- | :--- | :--- |
| **Token cost** | 10–25 tokens (plain text); ~60 tokens (JSON) | Emits matching file path and match kind (`[exact]`, `[basename]`). |
| **Latency** | **< 2ms** (cached); ~10–15ms (cold repo walk) | Zero external process invocations; pure in-memory regex and array scan. |
| **Candidate count** | All repository file paths (typically 100–10,000 paths) | Screened with fast string comparisons. |
| **Result count** | 1 to $N$ matching paths (strictly 1 for basename/suffix/substring) | Exact matches may return case-variants. |
| **Confidence** | `exact` (100% deterministic file existence) | Verified against physical filesystem. |
| **Fallback behavior** | On miss (`matches: []`), escalates to Discovery Junction | Does not hallucinate or guess among competing basenames. |
| **Failure mode** | Clean miss (`status: "miss"`, `missCode: "SYMBOL_NOT_FOUND"`) | Never errors unless directory read access is denied. |
| **Resource cost** | Minimal (< 2MB heap for path array cache) | Auto-invalidated after 30,000ms TTL. |
| **Verification** | `test/discoveryRouter.test.ts` (tests 12–15, 21–24) | Verifies exact, basename, suffix, case-preference, and fail-closed ambiguity. |
