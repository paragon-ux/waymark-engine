# Waymark Engine

**Sub-millisecond AST structural & lexical BM25 code intelligence for AI coding agents.**

[![npm version](https://img.shields.io/npm/v/waymark-engine)](https://www.npmjs.com/package/waymark-engine)
[![CI](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml/badge.svg)](https://github.com/paragon-ux/waymark-engine/actions/workflows/verify.yml)
[![tests](https://img.shields.io/badge/tests-74%2F74-brightgreen)](https://github.com/paragon-ux/waymark-engine)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](https://github.com/paragon-ux/waymark-engine/blob/main/LICENSE)
[![recall](https://img.shields.io/badge/recall-lexical%20BM25%20(no%20embeddings)-informational)](https://github.com/paragon-ux/capn-hook)

---

## Executive Summary

**Waymark Engine** is a high-performance code intelligence platform built specifically for AI coding agents. It provides instant, deterministic code navigation without vector databases, embeddings, or blind context-window token dumping.

When an AI agent needs to locate an implementation or trace a dependency, reading thousands of lines of raw source code wastes valuable context tokens and induces hallucinations. Waymark Engine answers questions with **exact file paths, symbol names, line spans, and multi-hop call graphs in milliseconds**.

```text
                                 AI Coding Agent
                                        │
                         ┌──────────────┴──────────────┐
                         │                             │
                   waymark_ask                  waymark_memory
                 (Read & Discover)             (Write & Consensus)
                         │                             │
         ┌───────────────┼───────────────┐             │
         ▼               ▼               ▼             ▼
      Tier 1          Tier 2          Tier 3        Tier 4
   AST Call Graph   Path Router    Fuzzy Matcher  Lexical BM25
  (@paragon/codedb) (PrefixTrie)   (algo.go fzf)  (.capn hook)
         │               │               │             │
         └───────────────┼───────────────┘             │
                         ▼                             ▼
                 Discovery Junction           Consensus SQLite
               (deterministic miss)           (5-facet memory)
```

---

## Why Waymark Engine?

| Dimension | Standard Agent Workflow | With Waymark Engine |
| :--- | :--- | :--- |
| **Context Window Cost** | 10,000–50,000 tokens per search | **16–38 tokens** (`--plain` output) |
| **Tool Definition Overhead**| 3,000+ tokens (11 flat tools) | **<450 tokens** (Two-Verb MCP interface) |
| **Query Latency** | 2,000–15,000 ms (embedding search) | **<10 ms** (Warm resident daemon) |
| **Accuracy & Faithfulness** | Hallucinated line numbers | **100% deterministic** (AST-verified spans) |
| **Memory Across Sessions** | Amnesia after session reset | **5-Facet Consensus Ledger** in SQLite |

---

## Core Tenets

1. **Deterministic by Construction**: Every query path is zero-randomness. Semantic recall utilizes pure lexical BM25 (`@paragon-ux/capn-hook`) and hard-refuses embedding stores (`CAPN_NON_DETERMINISTIC_MODE`).
2. **Fail-Closed on Ambiguity**: When a symbol or caller cannot be verified with certainty, the engine emits a structured miss or a machine-readable Discovery Junction continuation. It **never guesses**.
3. **Two-Verb Lean Interface**: MCP surface is distilled into `waymark_ask` (read) and `waymark_memory` (write), minimizing tool catalog sprawl in LLM contexts.
4. **Live Observability**: Built-in interactive REPL and fixed-viewport SSE Web Viewer (`localhost:4141`) for real-time telemetry, cache hit tracking, and test battery execution.

---

## Quick Navigation

- 🚀 **[Getting Started](getting-started.md)**: Installation, CLI quickstart, resident daemon, and the Live REPL Observer.
- 🏗️ **[4-Tier Architecture](architecture.md)**: Deep dive into the 4 discovery tiers, Discovery Junction, and fail-closed guards.
- 🔌 **[Model Context Protocol (MCP)](mcp.md)**: Agent configuration (Antigravity, Claude, Cursor) and Two-Verb usage.
- 💻 **[CLI & Command Registry](commands.md)**: Complete CLI flags, query options, `waymark memory` catalog, and error codes.
- 📊 **[Empirical Benchmarks](benchmarks.md)**: Aider Repo Map parity benchmark (`gpt-oss-120b`) and metrics schema.
- 📦 **[Library API & Integrity](library-api.md)**: TypeScript SDK, `verifyHop`, and `anchorForRange` tamper-evidence primitives.
