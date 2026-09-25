# Specification: Discovery Junction (Fuzzy ⇄ Semantic)

**Layer Identifier**: `junction`  
**Owning Module**: [`src/discoveryRouter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/discoveryRouter.ts)  
**Status**: Stable

---

## 1. Architectural Motivation

A hard cascade (structural $\to$ literal $\to$ fuzzy $\to$ semantic) gated by rigid sentence-length or token-count heuristics fails on two critical real-world agent query patterns:
1. **Conversational Code Queries**: Queries like *"Where in the payment module is `refundOrdr` declared?"* are long and prose-like, yet carry a real code token requiring fuzzy alignment.
2. **Lowercase Typo Identifiers**: Queries like `flattenconfig` have no syntactic camelCase or underscore markers, making them indistinguishable from English prose to a syntactic classifier.

### The v2.0 Principle: Recommendation, Never a Silent Branch
The Discovery Junction treats syntactic token classification as an **inspectable recommendation** rather than a silent branch. When Tier 1 (AST) and Tier 2 (Literal Path) miss:
- The engine executes the top recommended option.
- It presents the unexecuted alternative option alongside the result.
- It provides machine-readable continuation instructions (`tool: "waymark_ask"` and `cliCommand`), allowing the agent to force the alternative path without re-deriving signals.

---

## 2. Signal Analysis & Token Extraction

```typescript
export function extractCandidateTokens(question: string): {
  shape: "identifier-like" | "narrative" | "mixed";
  candidateTokens: string[];
  plainTokens: string[];
};
```

1. **Punctuation Stripping**: Delimiters and punctuation (`?`, `!`, `,`, `;`, `:`, `(`, `)`, `"`, `'`, backticks) are stripped.
2. **Stop Word Filtering**: English grammatical stop words ("the", "in", "on", "where", "function", "module", "is", "how", etc.) are excluded from candidate analysis.
3. **Partitioning**:
   - `candidateTokens`: Tokens where `classifyTokenShape(word) === "identifier-like"`.
   - `plainTokens`: Remaining non-stopword tokens longer than 2 characters.
4. **Signal Shape**:
   - `shape: "identifier-like"` if `candidateTokens.length > 0`.
   - `shape: "narrative"` if `candidateTokens.length === 0`.

---

## 3. Three-Stage Execution Ordering

```
[Structural & Literal Miss]
             │
             ├──► Stage 1: Candidate tokens exist?
             │         │
             │       (YES) ──► Eager Fuzzy Scoring (rankFzf)
             │                    │
             │               Score >= 60%?
             │               ├──► (YES) Return Junction (Fuzzy executed, Capn unexecuted)
             │               └──► (NO)  Fall through to Stage 2
             │
             ├──► Stage 2: Capn Memory Query (Eager Execution)
             │         │
             │       Charted Hit?
             │       ├──► (YES) Return Junction (Capn executed, Fuzzy alternative)
             │       └──► (NO)  Fall through to Stage 3
             │
             └──► Stage 3: Exhaustive Fuzzy Pass
                       │
                     Scores plain tokens (e.g. "flattenconfig")
                       │
                     Score >= 60%?
                     ├──► (YES) Return Junction (Fuzzy executed via exhaustive pass)
                     └──► (NO)  Return AskMissResult (JUNCTION_EXHAUSTED)
```

1. **Stage 1 (Identifier-Shaped Tokens $\to$ Fuzzy First)**:
   Cheap (sub-millisecond per token). Evaluated eagerly whenever at least one candidate token exists. If any candidate achieves confidence $\ge 60\%$, the junction returns with `fuzzy-lexical` executed and `capn-cli` unexecuted (`executed: false`, `result: null`), preventing memory store pollution.
2. **Stage 2 (Narrative Queries $\to$ Semantic Eager Fallback)**:
   If no identifier-shaped tokens exist, or if all Stage 1 candidate scores fall below threshold, `capn-cli` executes eagerly against charted memory.
3. **Stage 3 (Exhaustive Fuzzy Typo Recovery)**:
   If both Stage 1 and Stage 2 miss, an exhaustive fuzzy pass iterates over all remaining `plainTokens`. This catches lowercase typos without paying for exhaustive sentence-wide scoring upfront.

---

## 4. Response Schemas & Continuation Semantics

### `AskJunctionResult` Schema
```typescript
export interface AskJunctionResult {
  waymark: 1;
  kind: "ask";
  status: "junction";
  provider?: "waymark-engine";
  query: string;
  signal: {
    shape: "identifier-like" | "narrative" | "mixed";
    candidateTokens: string[];
  };
  options: JunctionOption[];
  executedOption: JunctionOption;
  alternativeOption: JunctionOption;
  chartHint: string;
  recommendation?: string;
  tip?: string;
  timings?: Record<string, number>;
}
```

### `JunctionOption` Schema
```typescript
export interface JunctionOption {
  tier: "fuzzy-lexical" | "capn-cli";
  recommended: boolean;
  executed: boolean;
  confidence?: "exact" | "approximate" | "curated";
  result: unknown;
  note: string;
  continuation?: JunctionContinuation;
}

export interface JunctionContinuation {
  tool: "waymark_ask";
  args: {
    question: string;
    tier: DiscoveryTier;
  };
  cliCommand: string;
}
```

---

## 5. Overrides & Auto-Resolve

- `forceTier: "fuzzy-lexical" | "capn-cli"` / `--tier <ast|path|fuzzy|capn>`: Bypasses signal recommendation logic and forces immediate execution of the chosen tier.
- `autoResolve: true` / `--auto-resolve`: Collapses the junction to a flat `AskHitResult` (`status: "hit"`), matching the legacy v1 contract for callers that do not handle junction unions.

---

## 6. Measurable Operational Metrics

| Metric | Specification / Observed Value | Notes |
| :--- | :--- | :--- |
| **Token cost (Plain text)** | **~38 tokens** | Compact recommendation, signal summary, result, and continuation tip. |
| **Token cost (JSON)** | **~240 tokens** | Full typed envelope with continuation schemas and match ranges. |
| **Latency (Stage 1 hit)** | **~70ms – 160ms** (includes Tier 1/2 screen) | Sub-millisecond fuzzy scoring; dominates when codedb index is primed. |
| **Latency (Stage 2 hit)** | **~140ms – 240ms** | Includes Capn CLI process execution time. |
| **Latency (Stage 3 hit)** | **~180ms – 290ms** | Exhaustive pass runs after Capn miss. |
| **Candidate count** | 1–5 candidate tokens; 1–10 plain tokens | Bounded per query. |
| **Result count** | Exactly 2 options: `executedOption` and `alternativeOption` | Constant-size array; deterministic layout. |
| **Confidence** | `approximate` (fuzzy $\ge 60$) or `curated` (Capn hit) | Derived from executed tier. |
| **Fallback behavior** | Stage 1 $\to$ Stage 2 $\to$ Stage 3 $\to$ `JUNCTION_EXHAUSTED` | Linear fail-closed progression. |
| **Failure mode** | Fail-closed (`status: "miss"`, `missCode: "JUNCTION_EXHAUSTED"`) | Never invents or hallucinates an answer. |
| **Verification** | `test/discoveryJunction.test.ts` (tests 1–9) | 100% passing across all 3 stages and override modes. |
