# Specification: Tier 4 — Charted Semantic Memory (BM25)

**Tier Identifier**: `capn` / `capn-cli`  
**Owning Module**: [`src/capnAdapter.ts`](file:///c:/Users/USER/Desktop/Frameworks/deepseek-playground-2/Waymark-grill-logic/src/capnAdapter.ts)  
**Upstream Engine**: [`@paragon-ux/capn-hook`](https://github.com/paragon-ux/capn-hook) (v1.1.0, bundled lexical fork)  
**Status**: Stable

---

## 1. Purpose & Responsibility

Tier 4 operates as an **agentic consensus memory protocol**, retaining curated answers, architectural rationale, and verified cross-file explanations recorded by agents and developers.

### Strict Distinction from Code Search
Tier 4 is **NOT a general code search engine or catch-all crutch**. Syntactic and structural questions (callers, definitions, line spans) belong strictly in Tiers 1–3. Routing pure code queries into Tier 4 degrades performance and pollutes the repository's long-term memory store. Tier 4 is reserved for conceptual questions ("How does authentication work?", "Where are webhook retries handled?").

---

## 2. Deterministic Lexical Guard Invariant

The semantic tier is **deterministic by construction**. It forbids non-deterministic vector embeddings, neural re-rankers, or external cloud inference.

### Invariant Checks (`assertLexicalStore`)
Before any query executes against Capn memory, `assertLexicalStore(root)` evaluates `.capn/config.json`:
1. **Store Missing**: Throws `CAPN_STORE_UNINITIALIZED` (exit code 2).
2. **Embedding Mode**: If `config.embedding !== false`, throws `CAPN_NON_DETERMINISTIC_MODE` (exit code 2), refusing to execute under QMD hybrid mode or download unpinned neural models.
3. **Lexical Mode**: Only passes when `config.embedding === false` (the default when initialized via `@paragon-ux/capn-hook`).

---

## 3. Entry Conditions & Decoupling Invariants

### Query Entry Conditions
- Eagerly recommended in Stage 2 of the Discovery Junction when queries lack identifier-like tokens (`shape: "narrative"`).
- Fallback escalation when Tier 3 fuzzy confidence falls below threshold (< 60%).
- Explicitly forced via `--tier capn` or `{ forceTier: "capn-cli" }`.

### Charting Decoupling Invariant (Spec §8)
`publish()` and `waymark-chart` accept any question in any orthographic shape (including bare code tokens like `refundOrder`).
- **No Token Classification in Charting**: `publish()` MUST NEVER invoke `classifyTokenShape` or gate entries based on syntax.
- **Agent Authority**: The agent asking the question decides whether an answer is worth retaining. The engine enforces store integrity, not retention value.

---

## 4. Wrapped Surface & Command Operations

| Operation | CLI Command | Purpose |
| :--- | :--- | :--- |
| `ask` | `waymark-ask <q>` | Queries charted entries via BM25 ranker. |
| `chart` | `waymark-chart --question <q> --answer <a> --files <f>` | Persists a verified Q&A entry with backing file references. |
| `unchart`| `waymark-unchart <id>` | Removes a specific charted entry by hash identifier. |
| `bust` | `waymark-bust <path>` | Invalidate all entries backed by a specific file. |
| `prune` | `waymark-prune` | Automatically purges entries whose backing files were modified or deleted. |
| `list` | `waymark-list` | Formatted summary of all active charted entries in the repository. |
| `context`| `waymark-context` | Emits the two-phase ask-first prompting hints for LLM system prompts. |

---

## 5. Measurable Operational Metrics

| Metric | Specification / Observed Value | Notes |
| :--- | :--- | :--- |
| **Token cost** | 40–120 tokens (plain text); ~180 tokens (JSON) | Emits curated answer, backing files, and verification status. |
| **Latency** | **~80ms – 180ms** | Invokes bundled Node entry (`dist/capn.js`) via direct `execFile`. |
| **Candidate count** | Up to total charted entries (typically 10–500 entries) | BM25 FTS5 inverted index scan. |
| **Result count** | 1 top charted answer or clean miss | Returns `"No charted answer."` on threshold miss. |
| **Confidence** | `curated` (Human/agent-verified repository consensus) | Verified against file staleness hashes. |
| **Fallback behavior** | On miss, escalates to Stage 3 (Exhaustive Fuzzy Pass) | Catches lowercase-typo'd identifiers before giving up. |
| **Failure mode** | Fail-closed (`CAPN_STORE_UNINITIALIZED` / `CAPN_NON_DETERMINISTIC_MODE`) | Refuses uninitialized or non-deterministic stores. |
| **Resource cost** | SQLite FTS5 database (~50KB–2MB disk footprint) | Zero background daemon; zero resident memory when idle. |
| **Verification** | `test/capnSurface.test.ts`, `test/lexicalGuard.test.ts` | Verifies full CLI lifecycle, mode guards, and store initialization. |
