# Specification: Tier 3 — Deterministic Fuzzy Lexical Matcher

**Tier Identifier**: `fuzzy` / `fuzzy-lexical`  
**Owning Module**: [`src/fuzzyMatcher.ts`](../src/fuzzyMatcher.ts)  
**Algorithm Origin**: Junegunn Choi (`fzf` `algo.go`)  
**Status**: Stable

---

## 1. Purpose & Responsibility

Tier 3 resolves syntactic code queries that miss exact AST or literal path lookup due to typographical errors, casing mismatches, partial prefixes, or abbreviations (e.g. `refundOrdr` $\to$ `refundOrder`, `bundledCodeb` $\to$ `bundledCodedbBinary`, `flattenconfig` $\to$ `flattenConfig`).

Tier 3 executes an embedded, deterministic implementation of Junegunn Choi's `fzf` scoring algorithm without third-party npm dependencies. It provides continuous 0–100 confidence scoring, exact character alignment spans (`matchRanges`), and repository proximity weighting while remaining completely deterministic across repeated invocations and candidate orderings.

---

## 2. Algorithm Constants & Scoring Rules

Tier 3 adheres strictly to the empirical constants from `algo.go`:

| Constant | Value | Description |
| :--- | :---: | :--- |
| `SCORE_MATCH` | `16` | Base score per matched character. |
| `SCORE_GAP_START` | `-3` | Penalty for opening a gap in the alignment. |
| `SCORE_GAP_EXTENSION` | `-1` | Penalty per additional skipped character in a gap. |
| `BONUS_BOUNDARY` | `8` | Contextual bonus for matching at a word delimiter (`/`, `\`, `_`, `-`, `.`, `:`, space, tab). |
| `BONUS_CAMEL_123` | `7` | Bonus for matching a camelCase transition (`lower` $\to$ `Upper`) or digit boundary. |
| `BONUS_CONSECUTIVE` | `4` | Bonus for contiguous consecutive character matches. |
| `BONUS_FIRST_CHAR_MULTIPLIER` | `2` | Multiplier applied to the first matched character's contextual boundary bonus. |

### Subsequence Guard
Matching requires the pattern to be a strict subsequence of the candidate name. If any character is missing in sequence, `scoreFzf` returns `-1` immediately without executing DP matrix alignment.

---

## 3. Two-Pass Lazy Traceback Architecture

To satisfy strict sub-millisecond per-token latency budgets over tens of thousands of repository symbols without incurring memory allocation penalties, Tier 3 splits matching into two passes:

```
Candidates (10,000 - 50,000 symbols)
                 │
                 ▼
    [Pass 1: Score-Only Filter]
    • Rolling 1D Int32Array (H[j], M[j])
    • Zero heap allocations
    • Subsequence fast check
    • Discards candidates below threshold (< 60)
                 │
                 ▼ (Top K Survivors, default K=5)
    [Pass 2: Lazy Traceback Matrix]
    • Flat 1D Int32Array ((pLen + 1) * (tLen + 1))
    • Full 2D Smith-Waterman backtracking
    • Groups contiguous indices into [start, end] ranges
                 │
                 ▼
          FuzzyScoreResult[]
```

1. **Pass 1 — Bulk Score-Only Filter (`scoreFzf`)**:
   Computes exact alignment scores using rolling 1D buffers (`H` and `M` of size $tLen + 1$). Zero array objects are created per candidate. Candidates scoring below confidence threshold (default 60%) are discarded immediately.
2. **Pass 2 — Lazy Traceback Matrix (`tracebackFzf`)**:
   Executed only for the top-$K$ surviving candidates (default $K=5$). Constructs a flat 1D matrix of size $(pLen + 1) \times (tLen + 1)$ and backtracks from the optimal ending cell to recover the exact character indices and consolidate contiguous slices into `[start, end]` ranges.

---

## 4. Orthography & Proximity Adjustments

### Syntactic Token Classification (`classifyTokenShape`)
```typescript
export function classifyTokenShape(token: string): TokenShape;
```
Evaluates orthographic shape without dictionary lookups:
- `"identifier-like"`: Contains camelCase boundary (`[a-z][A-Z]`), snake_case underscore (`_`), or qualified dot (`.`).
- `"plain"`: All other strings (English prose and lowercase typos).

### Repository Path Proximity Boost
Candidates located near the querying file receive a structural proximity bonus added to their raw score prior to normalization:
- **Same directory**: `+20` points.
- **Same parent module / crate**: `+10` points.

### Score Normalization
Normalized confidence (0–100%) scales against the theoretical maximum achievable score for a contiguous pattern of length $pLen$:
$$\text{maxPossible} = (\text{SCORE\_MATCH} + \text{BONUS\_BOUNDARY} \times \text{BONUS\_FIRST\_CHAR\_MULTIPLIER}) + (pLen - 1) \times (\text{SCORE\_MATCH} + \text{BONUS\_CONSECUTIVE})$$
$$\text{confidence} = \min\left(100, \text{round}\left(\frac{\text{rawScore} + \text{proximity}}{\text{maxPossible}} \times 100\right)\right)$$

### Deterministic Tie-Breaking
When multiple candidates achieve the same confidence score, sorting order is guaranteed by:
1. `confidence` descending;
2. `candidate.name.length` ascending (shorter, tighter identifiers preferred);
3. `candidate.path` ascending (lexicographical repository path);
4. `candidate.line` ascending.

---

## 5. Measurable Operational Metrics

| Metric | Specification / Observed Value | Notes |
| :--- | :--- | :--- |
| **Token cost** | 16–35 tokens (plain text); ~110 tokens (JSON) | Emits symbol name, file path, line number, score, and match ranges. |
| **Latency (Pass 1 per-token)**| **< 2.5ms** over 50,000 candidate symbols | Zero heap allocation rolling DP scan. |
| **Latency (Pass 2 traceback)**| **< 0.15ms** total across top-5 survivors | Computed only on top-K survivors. |
| **Candidate count** | 1 to 100 candidates from `queryFuzzyCandidates` | Screened from codedb's symbol index. |
| **Result count** | $\le 5$ top survivors (configurable via `maxResults`) | Bounded to high-confidence matches. |
| **Confidence** | `approximate` ($60\% \le \text{confidence} \le 100\%$) | Threshold defaults to 60. |
| **Fallback behavior** | If top candidate $< 60\%$, falls through to Stage 2 (Capn) | Unresolved queries escalate to semantic memory. |
| **Failure mode** | Clean miss (`status: "miss"`, `missCode: "SYMBOL_NOT_FOUND"`) | Never errors on low scores. |
| **Resource cost** | Minimal (< 100KB during traceback) | Rolling buffers avoid GC churn. |
| **Verification** | `test/fuzzyMatcher.test.ts` (tests 1–7) | Verified across `algo.go` constants, traceback, and 1,000 shuffles. |
