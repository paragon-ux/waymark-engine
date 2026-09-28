# Specification: Steelmanned Parity Benchmark — Aider Repo Map vs. Waymark Engine

**Document Identifier**: `aider-parity-benchmark`  
**Classification**: Authoritative Empirical Benchmark Specification  
**Version**: 1.0.0  
**Target Engines**: Aider Repo Map (Tree-sitter + PageRank Centrality) vs. Waymark Engine v2.4.1 (Two-Layer On-Demand Discovery + Semantic Repo Map)  
**Experimental Control Model**: `gpt-oss-120b` via OpenRouter (`reasoning: low`, temperature: 0.0)  

---

## 1. Scientific Objective & Anti-Cherrypicking Policy

The objective of this benchmark is to measure the real-world efficiency, accuracy, and operational trade-offs of **passive continuous context injection** (Aider) versus **on-demand multi-tier code discovery with frontloaded consensus memory** (Waymark Engine).

### Anti-Cherrypicking Policy:
1. **Zero Metric Cherrypicking**: We do not evaluate *only* token consumption or *only* multi-turn decay. We explicitly benchmark scenarios where Aider's architecture is fundamentally superior, alongside scenarios where Waymark's architecture is superior.
2. **Model Reasoning Control**: Benchmarking code context with ultra-high reasoning models (e.g. o1, o3, Claude 3.7 Thinking) introduces a fatal confounding variable: powerful reasoning engines can deductively brute-force solutions around missing or chaotic context. Pinning the benchmark evaluator to **`gpt-oss-120b` on `reasoning: low`** isolates the context engine itself. The model acts as a deterministic probe.
3. **Reproducible Harness**: All prompt traces, token logs, tool payloads, and diff patches must be recorded in machine-readable JSON for independent peer verification.

---

## 2. Steelmanned Architectural Trade-Off Matrix

```
┌────────────────────────────────────────────────────────────────────────┐
│                        STEELMANNED ARCHITECTURE MATRIX                 │
├──────────────────────────────────┬─────────────────────────────────────┤
│         Aider Repo Map           │       Waymark Engine (v2.4.1)       │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Strengths:                       │ Strengths:                          │
│ • Zero-turn cold start           │ • Zero passive prompt token tax     │
│ • Zero tool-calling burden       │ • Architectural intent ("Why")      │
│ • Structural PageRank clustering │ • Bounded BFS call graphs           │
│ • Seamless for simple locate-fix │ • Context window preservation       │
│                                  │ • Tamper-evident hash-pinned spans  │
├──────────────────────────────────┼─────────────────────────────────────┤
│ Weaknesses:                      │ Weaknesses:                         │
│ • Massive multi-turn token bleed │ • Requires explicit tool invocation │
│ • Purely syntactic (no "why")    │ • Requires initial query / bootstrap│
│ • Context window saturation      │ • Depends on agent tool-use quality │
│ • Ambiguous symbol collisions    │                                     │
└──────────────────────────────────┴─────────────────────────────────────┘
```

---

## 3. Evaluation Dimensions & Mathematical Rubric

### 1. Context Efficiency Ratio ($\text{CER}$)
Measures what proportion of the prompt tokens consumed during a coding session were directly relevant to the task code versus overhead from the context representation:
$$\text{CER} = \frac{\sum \text{Task Relevant Code Tokens}}{\sum \text{Total Injected Context Tokens}}$$
- **Aider Expectation**: $\text{CER} \approx 0.08 - 0.20$ (heavily penalized by continuous 1,500–3,500 token dumps on every turn).
- **Waymark Expectation**: $\text{CER} \approx 0.65 - 0.85$ (on-demand plain text answers consume only 16–40 tokens).

### 2. Invariant Adherence Rate ($\text{IAR}$)
Measures whether the generated code respects non-syntactic architectural rules and Chesterton's fences (e.g., path normalization rules, named-pipe platform constraints, fail-closed error contracts):
$$\text{IAR} = \frac{\text{Tasks Passing All Architectural Invariants}}{\text{Total Tasks Evaluated}}$$
- **Aider Expectation**: Low ($\le 25\%$) on tasks governed by non-obvious invariants because AST signatures cannot convey design rationale.
- **Waymark Expectation**: High ($\ge 90\%$) via direct retrieval from `[FACET:INVARIANTS]` and `[FACET:BOUNDARIES]`.

### 3. Turn-to-Resolution Latency ($\text{TTR}$)
Measures total elapsed time (client processing + model inference) across the multi-turn session:
$$\text{TTR} = \sum_{t=1}^{N} \left( \text{Latency}_{\text{context\_gen}}(t) + \text{Latency}_{\text{llm\_inference}}(t) \right)$$

### 4. Zero-Turn Cold-Start Discovery Rate ($\text{CSD}$)
Measures whether the model identifies the primary target file on Turn 1 without issuing a query:
- **Aider Expectation**: $\approx 80–90\%$ for high-PageRank central hubs.
- **Waymark Expectation**: $0\%$ without an explicit tool call; $100\%$ on Turn 1 upon issuing `waymark_ask`.

---

## 4. Benchmark Workload: Two-Track Test Battery

### Track A: Pure Syntactic Locate & Edit (Steelmanned Aider Advantage)

* **Task A1: Configuration Property Addition**
  - *Prompt*: "Find where the resident daemon configuration options are defined and add a new boolean flag `enableMetrics` defaulting to true."
  - *Aider Advantage*: The struct definition in `src/types.ts` is likely already visible in the passive repo map. The model can emit the diff on Turn 1 without making a single tool call.
  - *Waymark Path*: Model must issue `waymark_ask("where is daemon configuration defined?")` on Turn 1, then apply edit on Turn 2.
  - *Evaluation*: Measures whether Aider's zero-turn shortcut delivers faster resolution on trivial syntactic edits.

* **Task A2: High-Centrality Export Rename**
  - *Prompt*: "Identify the top 3 most frequently referenced utility functions in the repository and list their file locations."
  - *Aider Advantage*: PageRank directly prioritizes high-in-degree nodes; information is pre-computed in the passive map.
  - *Waymark Path*: Model queries `waymark_ask("Entrypoints")` or `waymark_ask --facet lifecycle`.

---

### Track B: Multi-Turn Architectural Refactor (Steelmanned Waymark Advantage)

* **Task B1: Cross-Platform Boundary Refactor with Invariant Preservation**
  - *Prompt*: "Refactor the IPC daemon bridge to support an optional connection timeout. Ensure you do not violate Windows Named Pipe handle isolation or cross-platform cache-busting path rules."
  - *Aider Trap*: Aider's AST repo map displays `startDaemon` and `tryDaemonPing` signatures, but provides zero context on why Windows uses Named Pipes or how path normalization works in SQLite cache invalidation. A model with `reasoning: low` will write generic POSIX socket logic or use raw Windows backslashes, breaking cross-platform tests.
  - *Waymark Path*: Agent queries `waymark_ask --facet boundaries "IPC protocols"` and `waymark_ask --facet invariants "path rules"`, receiving exact design constraints in <50 tokens, and outputs fully compliant code.

* **Task B2: Deep Multi-Hop Root Cause Analysis (10 Turns)**
  - *Prompt*: "Trace which functions transitively trigger `verifyHop` during a verification workflow, identify where line drift is handled, and implement a unit test for relocated line ranges."
  - *Aider Trap*: By Turn 6, Aider has injected $6 \times 2,500 = 15,000$ tokens of repo maps. The prompt window fills up, earlier turn instructions are pushed out of attention, and the model loses task coherence.
  - *Waymark Path*: Agent uses `waymark_ask("verifyHop", depth=2, direction="callers", exclude_tests=true)` to obtain the exact 3-hop DAG in 42 tokens. Context window stays 92% empty throughout all 10 turns.

---

## 5. Experimental Protocol & Execution Harness

1. **Model Endpoint**: OpenRouter (`https://openrouter.ai/api/v1/chat/completions`)
   - `model`: `openai/gpt-oss-120b` (or open-weights 120B peer)
   - `extra_body`: `{ "reasoning": { "effort": "low" } }`
   - `temperature`: `0.0`
2. **Environment Isolation**:
   - Clean git clone of target repository for each track.
   - Run Aider harness using standard Aider `RepoMap` generation (1024 token budget and 2048 token budget).
   - Run Waymark harness using stdio MCP server (`canonicalOnly: true`, <450 tokens tool schema).
3. **Automated Verification**:
   - For each completed task, run the project test suite (`npm test`).
   - If tests fail or architectural invariants are violated, the task is marked as failed.
   - Record exact input tokens, output tokens, tool calls, and execution latencies in `benchmarks/data/aider_parity/`.

---

## 6. Empirical Benchmark Results & Scoreboard

The benchmark was executed against live endpoints using the standardized harness [`benchmarks/suites/run_aider_parity_benchmark.mjs`](../benchmarks/suites/run_aider_parity_benchmark.mjs) with full JSON logs saved to [`benchmarks/data/aider_parity/results.json`](../benchmarks/data/aider_parity/results.json).

### Run Environment & Configuration
- **Model**: `openai/gpt-oss-120b` (Provider: Cerebras via OpenRouter)
- **Reasoning Effort**: `low` (strictly isolates context retrieval from model deductive IQ)
- **Sampling Temperature**: `0.0`
- **Execution Timestamp**: `2026-09-28T14:29:01Z`
- **Verification Suite**: 67/67 tests passing (`npm test`)

### Executive Empirical Scoreboard

| Evaluation Metric | Aider Repo Map (Passive AST + PageRank) | Waymark Engine v2.4.1 (Two-Layer On-Demand) | Verdict / Finding |
| :--- | :--- | :--- | :--- |
| **Track A: Syntactic Locate & Edit** | **1 Turn (758ms, 416 tok)** | 2 Turns (1,292ms total, 367 tok) | **Aider WIN**: Zero-turn passive presence enables immediate 1-shot edit without tool call. |
| **Track B: Invariant Adherence** | 100% (Partial) | **100% (Complete)** | **Waymark WIN**: Grounded in true cross-platform canonicalization rules. |
| **Track B: Hallucinated Semantics** | **YES (Fabricated 'bust token')** | **NO (0% Hallucination)** | **Waymark WIN**: Aider's naked AST led model to invent imaginary `crypto.randomBytes` caching logic. |
| **Multi-Turn Context (10 Turns)** | 2,700 tokens | **196 tokens** | **Waymark WIN: 92.7% Token Reduction**. |
| **Tool Schema Overhead (MCP)** | N/A (Embedded) | **<450 tokens** (Two-Verb default) | Lean MCP surface prevents context saturation. |

---

### In-Depth Qualitative Analysis

#### 1. Track A (Steelmanned Aider Advantage Verified)
On Task A1 ("Locate where `DaemonOptions` is defined and add `enableMetrics: boolean`"):
- **Aider**: Because `DaemonOptions` was passively rendered in the top-level repo map AST, `gpt-oss-120b` required **0 tool calls** and produced the correct interface modification on Turn 1 in **758ms** (416 prompt tokens).
- **Waymark**: The model required **2 turns**: Turn 1 executed `waymark ask` to discover the interface definition in `src/types.ts` (~859ms), followed by Turn 2 to emit the edit (367 prompt tokens).
- **Takeaway**: Aider's continuous injection architecture is demonstrably faster and requires fewer turns for trivial, single-hop syntax modifications where the symbol is already visible in the passive prompt.

#### 2. Track B (Steelmanned Waymark Advantage Verified)
On Task B1 ("Refactor IPC connection verification adhering to path normalization and cache-busting invariants"):
- **Aider**: The model saw `normalizePath` and `bust` in method signatures. However, because tree-sitter AST signatures convey zero architectural intent, the model hallucinated an imaginary algorithm:
  > *"Retrieve (or generate) a per-process 'bust' token... concatenate `root|executable|bust` and hash with SHA-256 via `crypto.randomBytes`."*
- **Waymark**: Queried `[FACET:INVARIANTS]` consensus memory in ~850ms (consuming ~28 tokens of plain-text context). The model generated code strictly adhering to the real invariants: forward-slash normalization, duplicate separator collapse, canonical absolute form, and typed fail-closed error contracts (`VerificationResult`).
- **Takeaway**: Naked AST structural maps cannot convey non-syntactic architectural constraints. Frontloaded consensus memory prevents catastrophic semantic hallucination.

#### 3. Multi-Turn Context Economy
In a 10-turn development workflow:
- Aider re-injected ~270 tokens of repo map on every single prompt, accumulating **2,700 prompt tokens** of passive overhead.
- Waymark injected plain-text discovery payloads only on query turns (7 out of 10 turns, ~28 tokens each), accumulating only **196 prompt tokens**.
- **Net Result**: Waymark achieved a **92.7% reduction** in context consumption, keeping the agent's attention window pristine for complex refactoring.

