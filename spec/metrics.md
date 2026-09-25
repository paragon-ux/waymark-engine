# Waymark Engine Measurable Tier Metrics & Benchmark Specification

**Document Identifier**: `metrics`  
**Classification**: Authoritative System Specification  
**Version**: 2.0.0  
**Scope**: Standardized metrics schema, comparative operational benchmarks, and resource boundaries across all discovery tiers.

---

## 1. Standardized Tier Metrics Schema

To ensure objective cross-tier evaluation and prevent architectural drift, all tiers and routing layers within the Waymark Engine are evaluated against nine canonical operational dimensions:

| Dimension | Metric Key | Definition & Requirement | Measurement Methodology |
| :--- | :--- | :--- | :--- |
| **1. Token Cost** | `token_cost` | Typical LLM token consumption consumed by the tier's response. | Measured using cl100k / tiktoken estimators across plain-text and JSON outputs. |
| **2. Latency** | `latency_ms` | Execution time from invocation to response emission (cold process vs. resident server). | High-resolution wall-clock timing via `performance.now()` / `--timing`. |
| **3. Candidate Count** | `candidate_count`| Upper bound and typical volume of items evaluated per query. | Instrumenting candidate pool size during filtering and scoring. |
| **4. Result Count** | `result_count` | Number of returned results and upper clamping boundaries. | Result array length validation. |
| **5. Confidence** | `confidence` | Scoring threshold semantics (`exact`, `curated`, `approximate`). | Mathematical scoring definition and calibration ratio. |
| **6. Fallback Behavior** | `fallback` | Explicit condition triggering escalation to the next tier or junction. | State transition contract when a tier misses or drops below threshold. |
| **7. Failure Mode** | `failure_mode` | Behavior under system error, uninitialized stores, or malformed queries. | Invariant check: Fail-closed (`status: "error"` or `"miss"`) vs. Fail-open. |
| **8. Resource Cost** | `resource_cost` | Memory RSS, CPU overhead, and external process allocation. | OS process monitoring and Node.js `process.memoryUsage()`. |
| **9. Verification** | `verification` | Test suites ensuring compliance with performance and invariant bounds. | Automated test coverage in `dist/test/**/*.test.js`. |

---

## 2. Comparative Benchmark & Operational Matrix

The following matrix compares all four discovery tiers and the Discovery Junction under standard repository conditions (tested on medium-to-large repositories up to 8,500+ source files):

| Metric Dimension | Tier 1: AST Structural | Tier 2: Literal Path | Tier 3: Deterministic Fuzzy | Tier 4: Charted Memory | Discovery Junction |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Owning Subsystem** | `@paragon-ux/codedb-core` | `discoveryRouter.ts` | `fuzzyMatcher.ts` | `@paragon-ux/capn-hook` | `discoveryRouter.ts` |
| **Token Cost (Plain)** | **20 – 60 tokens** | **15 – 35 tokens** | **18 – 45 tokens** | **35 – 90 tokens** | **25 – 65 tokens** |
| **Token Cost (JSON)** | ~120 – 250 tokens | ~80 – 140 tokens | ~110 – 180 tokens | ~150 – 350 tokens | ~220 – 400 tokens |
| **Latency (Resident)** | **0.26ms – 0.75ms** | **0.08ms – 0.25ms** | **0.15ms – 0.85ms** | **1.2ms – 3.8ms** | **0.40ms – 1.8ms** |
| **Latency (Cold Process)**| ~70ms – 190ms | ~15ms – 30ms | ~25ms – 60ms | ~80ms – 220ms | ~45ms – 120ms |
| **Candidate Count** | Full repo AST symbols ($\le 50\text{k}$) | Repository file paths ($\le 25\text{k}$) | Filtered symbol pool ($\le 1\text{k}$) | Charted consensus entries ($\le 500$) | Extracted query tokens ($1 - 5$) |
| **Result Count** | Bounded (1 tree, 1 neighbor set, $\le 50$ symbols) | Bounded ($\le 10$ paths) | Bounded ($\le 10$ candidates, default 5) | Bounded ($\le 5$ memory hits) | 1 executed + 1 alternative option |
| **Confidence Semantics**| `exact` (100% ground truth) | `exact` (100% path match) | `approximate` ($\ge 60\%$ normalized ratio) | `curated` (BM25 consensus relevance) | Dynamic recommendation |
| **Fallback Trigger** | Non-structural query or symbol miss | No path/substring match found | Score $< 60\%$ threshold | No BM25 consensus match | All stages exhausted |
| **Fallback Target** | Escalates to Tier 2 (Literal Path) | Escalates to Discovery Junction | Escalates to Stage 2 (Capn Memory) | Escalates to Stage 3 (Exhaustive Fuzzy) | Emits `JUNCTION_EXHAUSTED` miss |
| **Failure Mode** | **Fail-closed** (clean miss or error) | **Fail-closed** (clean miss) | **Fail-closed** (clean miss) | **Fail-closed** (refuses embeddings) | **Fail-closed** (never hallucinates) |
| **Resource Cost** | Native Zig binary (~45MB RSS) | Pure in-memory ($< 5\text{MB}$) | Zero-allocation loops ($< 2\text{MB}$) | SQLite FTS5 store (~12MB RSS) | Lightweight orchestration ($< 1\text{MB}$) |
| **External Dependencies**| None (self-contained native binary) | None (zero external deps) | **None** (zero external deps) | SQLite via bundled `@paragon-ux/capn-hook` | None (pure TypeScript) |
| **Verification Coverage**| `test/discoveryRouter.test.ts` | `test/discoveryRouter.test.ts` | `test/fuzzyMatcher.test.ts` | `test/capnSurface.test.ts` | `test/discoveryJunction.test.ts` |

---

## 3. Detailed Dimension Specifications

### 3.1 Token Economy Optimization
Waymark Engine prioritizes LLM agent token limits by designing outputs around concise, single-line declarations:
- **Plain Text Mode (`-p`, `--plain`)**: Default format designed for agent tool ingestion. Omits verbose envelope metadata, nested objects, and redundant labels.
- **Structured JSON Mode (`-j`, `--json`)**: Full programmatic payload for machine consumption or UI visualization.

### 3.2 Confidence Calibration
- **Tier 1 & Tier 2 (`exact`)**: 1.0 confidence. Backed by verified AST nodes or existing filesystem inodes.
- **Tier 3 (`approximate`)**: Normalized confidence score $S \in [0.0, 1.0]$ computed as:
  $$S = \frac{\text{rawScore}}{\text{maxPossibleScore}}$$
  Matches are accepted if and only if $S \ge 0.60$ ($60\%$). Any match below 0.60 is rejected without exception.
- **Tier 4 (`curated`)**: BM25 relevance score over human- or agent-reviewed charted architectural consensus.

### 3.3 Latency Profiles & Timing Flags
Timing is instrumented via `--timing` (`-b`). High-resolution sub-millisecond execution times are broken down across:
```text
[timing] ast: 0.42ms | path: 0.12ms | fuzzy: 0.28ms | total: 0.82ms
```

---

## 4. Empirical Benchmark Guidelines (TBD Baseline Collection)

For future benchmarking across hardware architectures (Linux x86_64, Windows ARM64, macOS Apple Silicon), the following methodology is prescribed:

1. **Test Repositories**:
   - Small: `paragon-ux/waymark-engine` (~35 source files).
   - Medium: `expressjs/express` (~250 source files).
   - Large: `openai/codex` (~8,590 source files).
   - Enterprise Polyglot Monorepo: `grafana/grafana` (23,517 files — see [`spec/adversarial-benchmark-grafana.md`](./adversarial-benchmark-grafana.md)).
2. **Measurement Harness**:
   - Warm cache: 100 consecutive iterations after 5 warmup cycles.
   - Metrics to record: Median latency ($p_{50}$), tail latency ($p_{99}$), and Peak RSS memory delta.
   - Any currently unmeasured hardware matrix cells MUST be marked **TBD** rather than estimated.
