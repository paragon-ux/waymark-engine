import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../paths.js";
import { ask, publish, unchart, bust, prune, listEntries, context, initCapn } from "../capnAdapter.js";
import { discoverSymbolsInFile } from "../astExtractor.js";
import { tryDaemonPing, getDaemonAddress } from "../daemon.js";
import { renderPlainText } from "../renderPlainText.js";
import { AdapterProfile, DiscoveryTier, WaymarkError } from "../types.js";
import { McpToolCallResult, McpToolHandler } from "./types.js";

function jsonResult(value: unknown, isError = false): McpToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

function errorResult(error: unknown): McpToolCallResult {
  if (error instanceof WaymarkError) {
    return jsonResult({ waymark: 1, kind: "error", ok: false, code: error.code, message: error.message }, true);
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return jsonResult({ waymark: 1, kind: "error", ok: false, code: "UNEXPECTED_ERROR", message }, true);
}

function resolveRoot(args: Record<string, unknown>): string {
  const custom = typeof args.root === "string" && args.root.trim() ? args.root.trim() : process.cwd();
  return repoRoot(custom);
}

function resolveProfile(args: Record<string, unknown>): AdapterProfile {
  const value = typeof args.profile === "string" && args.profile ? args.profile : process.env.WAYMARK_CAPN_PROFILE;
  return value === "none" ? "none" : "capn-cli";
}

function resolveExecutable(args: Record<string, unknown>): string {
  return (typeof args.capn_executable === "string" && args.capn_executable.trim()) || process.env.WAYMARK_CAPN_EXECUTABLE || "";
}

export const waymarkAskTool: McpToolHandler = {
  definition: {
    name: "waymark_ask",
    description: "Query repository memory and tiered discovery (AST structural, literal path, deterministic fuzzy, charted consensus) to answer code questions without hallucination.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to look up.",
        },
        query: {
          type: "string",
          description: "Symbol name, substring, or alias for question.",
        },
        path: {
          type: "string",
          description: "Repository-relative or absolute source file path. If provided alone or without question, performs file AST extraction.",
        },
        facet: {
          type: "string",
          enum: ["lifecycle", "data_state", "boundaries", "invariants", "failure", "status"],
          description: "Optional facet filter to scope query to an architectural domain in the Semantic Repo Map, or 'status' to inspect map health.",
        },
        tier: {
          type: "string",
          enum: ["auto", "ast", "path", "fuzzy", "capn"],
          description: "Optional forced discovery tier: auto | ast | path | fuzzy | capn. Defaults to auto.",
        },
        auto_resolve: {
          type: "boolean",
          description: "Collapse junction responses directly to top recommendation. Defaults to true in MCP for agent workflows.",
        },
        timing: {
          type: "boolean",
          description: "Collect high-resolution tier execution timing metrics.",
        },
        plain: {
          type: "boolean",
          description: "Emit token-minimal plain text formatted result for LLM context efficiency (~16-38 tokens).",
        },
        daemon: {
          type: "boolean",
          description: "Accelerate query via persistent in-memory background daemon IPC.",
        },
        depth: {
          type: "integer",
          description: "Call graph traversal depth (1-5) for structural AST queries. Defaults to 1.",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees", "both"],
          description: "Call graph traversal direction: callers | callees | both. Defaults to both.",
        },
        exclude_tests: {
          type: "boolean",
          description: "Optional. Filter out test files (e.g. tests/, *_test.*, *.spec.*) from call graph results to reduce token noise.",
        },
        dev: {
          type: "boolean",
          description: "Optional. Enable Dev Mode for diagnostic telemetry, tier timing breakdown, and runtime invariant assertions.",
        },
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of multiple symbol identifiers to inspect concurrently across the AST call graph.",
        },
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        profile: {
          type: "string",
          enum: ["capn-cli", "none"],
          description: "Optional adapter profile; defaults to capn-cli.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const rawQuestion = typeof args.question === "string" ? args.question.trim() : "";
      const rawQuery = typeof args.query === "string" ? args.query.trim() : "";
      const question = rawQuestion || rawQuery;
      const timing = args.timing === true;
      const plain = args.plain === true;
      const daemon = args.daemon === true;
      const dev = args.dev === true;
      const depth = typeof args.depth === "number" ? Math.min(Math.max(1, args.depth), 5) : undefined;
      const direction = (args.direction === "callers" || args.direction === "callees" || args.direction === "both")
        ? args.direction
        : undefined;
      const excludeTests = args.exclude_tests === true || args.excludeTests === true;
      const facet = typeof args.facet === "string" ? args.facet.trim() : undefined;
      const rawPath = typeof args.path === "string" ? args.path.trim() : undefined;

      // 1. Facet status check
      if (facet === "status") {
        const { getSemanticMapStatus } = await import("../semanticMap.js");
        const status = getSemanticMapStatus(root);
        if (plain) {
          return {
            content: [{ type: "text", text: renderPlainText(status) }],
            isError: false,
          };
        }
        return jsonResult(status);
      }

      // 2. Multi-symbol batch query
      const rawSymbols = Array.isArray(args.symbols) ? args.symbols.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
      if (rawSymbols.length > 0) {
        const { queryMultiSymbols } = await import("../codedbAdapter.js");
        const res = await queryMultiSymbols(root, rawSymbols, resolveExecutable(args));
        if (plain) {
          return {
            content: [{ type: "text", text: renderPlainText(res) }],
            isError: false,
          };
        }
        return jsonResult(res);
      }

      // 3. File AST outline discovery (Mode A) when path provided without question
      if (rawPath && !question && !facet) {
        const res = await discoverSymbolsInFile(root, rawPath, undefined, rawQuery || undefined);
        if (plain) {
          return {
            content: [{ type: "text", text: renderPlainText(res) }],
            isError: false,
          };
        }
        return jsonResult(res);
      }

      if (!question && !facet) throw new WaymarkError("MISSING_ARGUMENT", "question, query, path, symbols, or facet is required");

      const rawTier = typeof args.tier === "string" ? args.tier.trim() : undefined;
      const tier = rawTier as DiscoveryTier | undefined;
      const autoResolve = args.auto_resolve !== false && args.autoResolve !== false;

      const result = await ask(root, resolveProfile(args), resolveExecutable(args), question, {
        tier,
        autoResolve,
        timing: timing || dev,
        daemon,
        depth,
        direction,
        excludeTests,
        dev,
        facet,
        path: rawPath,
      });

      if (plain) {
        return {
          content: [{ type: "text", text: renderPlainText(result) }],
          isError: false,
        };
      }

      const payload: Record<string, unknown> = {
        waymark: 1,
        kind: "ask",
        provider: result.provider ?? "waymark-engine",
        status: result.status,
      };
      if (result.status === "hit") {
        payload.result = result.result;
        if (result.timings) payload.timings = result.timings;
      } else if (result.status === "junction") {
        payload.query = result.query;
        payload.signal = result.signal;
        payload.options = result.options;
        payload.executedOption = result.executedOption;
        payload.alternativeOption = result.alternativeOption;
        payload.chartHint = result.chartHint;
        if (result.recommendation) payload.recommendation = result.recommendation;
        if (result.tip) payload.tip = result.tip;
        if (result.timings) payload.timings = result.timings;
      } else if (result.status === "error") {
        payload.error = "error" in result ? result.error : ("message" in result ? result.message : "Error");
      } else {
        payload.matches = "matches" in result ? result.matches : [];
        if ("missCode" in result) payload.missCode = result.missCode;
        if ("reason" in result) payload.reason = result.reason;
        if (result.timings) payload.timings = result.timings;
      }
      return jsonResult(payload);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkMemoryTool: McpToolHandler = {
  definition: {
    name: "waymark_memory",
    description: "Universal repository consensus memory manager: chart architectural knowledge, bootstrap the Semantic Repo Map, list entries, bust invalidated files, prune stale entries, and unchart by ID.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["chart", "bootstrap", "bust", "prune", "list", "unchart", "init", "context", "status", "heal", "export", "evict", "close"],
          description: "Consensus memory action to execute: chart | bootstrap | bust | prune | list | unchart | init | context | status | heal | export | evict | close.",
        },
        question: {
          type: "string",
          description: "The question or topic charted (required for action='chart').",
        },
        answer: {
          type: "string",
          description: "The conclusive charted answer adhering to <= 100 token budget (required for action='chart').",
        },
        facet: {
          type: "string",
          enum: ["lifecycle", "data_state", "boundaries", "invariants", "failure"],
          description: "Optional architectural facet tag when charting an entry in the Semantic Repo Map.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of repository-relative backing file paths (required for active facets).",
        },
        file: {
          type: "string",
          description: "Repository-relative file path (required for action='bust').",
        },
        id: {
          type: "string",
          description: "Entry hex ID to delete (required for action='unchart').",
        },
        if_exists: {
          type: "boolean",
          description: "Idempotently succeed if entry id is already deleted (for action='unchart').",
        },
        dry_run: {
          type: "boolean",
          description: "Inspect without writing changes (for action='bootstrap').",
        },
        subsystem: {
          type: "string",
          description: "Optional subsystem/package scope for bootstrap in monorepos.",
        },
        format: {
          type: "string",
          enum: ["md", "json"],
          description: "Export format for action='export': md | json. Defaults to md.",
        },
        plain: {
          type: "boolean",
          description: "Emit token-minimal plain text formatted result for LLM context efficiency.",
        },
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        profile: {
          type: "string",
          enum: ["capn-cli", "none"],
          description: "Optional adapter profile; defaults to capn-cli.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
      required: ["action"],
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const action = typeof args.action === "string" ? args.action.trim() : "";
      const plain = args.plain === true;
      const executable = resolveExecutable(args);
      const profile = resolveProfile(args);

      if (action === "chart") {
        let question = typeof args.question === "string" ? args.question.trim() : "";
        const answer = typeof args.answer === "string" ? args.answer.trim() : "";
        const rawFacet = typeof args.facet === "string" ? args.facet.trim().toLowerCase() : undefined;
        const files = Array.isArray(args.files)
          ? args.files.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
          : [];

        if (rawFacet) {
          const facetTag = `[FACET:${rawFacet.toUpperCase()}]`;
          if (!question.toUpperCase().includes(facetTag)) {
            question = `${facetTag} ${question}`.trim();
          }
        }

        if (!question) throw new WaymarkError("MISSING_ARGUMENT", "chart requires a question");
        if (!answer) throw new WaymarkError("MISSING_ARGUMENT", "chart requires an answer");

        // Anti-Hallucination Guard for facets
        if (rawFacet || question.includes("[FACET:")) {
          const { validateFacetBackingFiles } = await import("../semanticMap.js");
          validateFacetBackingFiles(root, files, answer.toLowerCase().includes("not_applicable"));
        }

        const res = await publish(root, profile, executable, question, answer, files);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.published };
        }
        return jsonResult(res, !res.published);
      }

      if (action === "bootstrap") {
        const { bootstrapSemanticMap } = await import("../semanticMap.js");
        const dryRun = args.dry_run === true || args.dryRun === true;
        const subsystem = typeof args.subsystem === "string" ? args.subsystem : undefined;
        const res = await bootstrapSemanticMap(root, { dryRun, subsystem, executable });
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "status") {
        const { getSemanticMapStatus } = await import("../semanticMap.js");
        const status = getSemanticMapStatus(root);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(status) }], isError: false };
        }
        return jsonResult(status);
      }

      if (action === "bust") {
        const targetFile = typeof args.file === "string" && args.file.trim()
          ? args.file.trim()
          : (Array.isArray(args.files) && typeof args.files[0] === "string" ? args.files[0].trim() : "");
        if (!targetFile) throw new WaymarkError("MISSING_ARGUMENT", "bust requires a file path");
        const res = await bust(root, executable, targetFile);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "prune") {
        const res = await prune(root, executable);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "list") {
        const res = await listEntries(root, executable);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "unchart") {
        const id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id) throw new WaymarkError("MISSING_ARGUMENT", "unchart requires an id");
        const ifExists = args.if_exists === true || args.ifExists === true;
        const res = await unchart(root, executable, id, ifExists);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "init") {
        const res = await initCapn(root, executable);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "context") {
        const res = await context(root, executable);
        if (plain) {
          return { content: [{ type: "text", text: renderPlainText(res) }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "heal") {
        const { bootstrapSemanticMap, renderSemanticMapStatus } = await import("../semanticMap.js");
        const subsystem = typeof args.subsystem === "string" ? args.subsystem.trim() : undefined;
        const res = await bootstrapSemanticMap(root, { dryRun: false, subsystem, executable });
        if (plain) {
          return { content: [{ type: "text", text: `[healed: ${renderSemanticMapStatus(res.status)}]` }], isError: !res.ok };
        }
        return jsonResult(res, !res.ok);
      }

      if (action === "export") {
        const { getSemanticMapStatus } = await import("../semanticMap.js");
        const status = getSemanticMapStatus(root);
        const format = args.format === "json" ? "json" : (plain ? "md" : (args.format || "md"));
        if (format === "json" && !plain) {
          return jsonResult(status);
        }
        const lines = [
          `# Architecture Consensus Map`,
          `**Generated by Waymark Engine** | Status: ${status.status} (${status.completion} facets active)`,
          "",
        ];
        for (const [id, f] of Object.entries(status.facets)) {
          lines.push(`## Facet: ${f.name} (\`${id}\`)`);
          lines.push(`- **Status**: ${f.status}`);
          lines.push(`- **Files**: ${f.files.join(", ") || "None"}`);
          if (f.details) {
            lines.push("");
            lines.push(f.details);
            lines.push("");
          }
        }
        return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
      }

      if (action === "evict" || action === "close") {
        const { closeResidentClient, closeAllResidentClients } = await import("../residentCodedb.js");
        const target = typeof args.root === "string" && args.root.trim() ? args.root.trim() : root;
        const all = args.all === true;
        if (all) {
          closeAllResidentClients();
          const msg = "Closed all resident codedb instances.";
          return plain ? { content: [{ type: "text", text: msg }], isError: false } : jsonResult({ ok: true, message: msg });
        }
        const closed = closeResidentClient(target);
        const msg = closed
          ? `Closed resident codedb instance for ${target}.`
          : `No active resident codedb instance found for ${target}.`;
        return plain ? { content: [{ type: "text", text: msg }], isError: false } : jsonResult({ ok: true, closed, root: target });
      }

      throw new WaymarkError("UNKNOWN_COMMAND", `Unknown memory action: ${action}. Allowed: chart, bootstrap, bust, prune, list, unchart, init, context, status, heal, export, evict, close.`);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkChartTool: McpToolHandler = {
  definition: {
    name: "waymark_chart",
    description: "Directly chart a question, answer, and associated file references into Waymark long-term consensus memory.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question or topic charted.",
        },
        answer: {
          type: "string",
          description: "The conclusive charted answer.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Array of repository-relative file paths referenced in the answer.",
        },
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        profile: {
          type: "string",
          enum: ["capn-cli", "none"],
          description: "Optional adapter profile; defaults to capn-cli.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
      required: ["question", "answer"],
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const answer = typeof args.answer === "string" ? args.answer.trim() : "";
      const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string") : [];
      if (!question) throw new WaymarkError("MISSING_ARGUMENT", "question is required");
      if (!answer) throw new WaymarkError("MISSING_ARGUMENT", "answer is required");

      for (const relPath of files) {
        const fullPath = path.resolve(root, relPath);
        if (!fs.existsSync(fullPath)) {
          throw new WaymarkError("INVALID_ARGUMENT", `Chart backing file not found: "${relPath}" (resolved to "${fullPath}"). Pass valid repository files.`);
        }
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) {
          throw new WaymarkError("INVALID_ARGUMENT", `Chart backing path is not a file: "${relPath}" (is directory).`);
        }
      }

      const result = await publish(root, resolveProfile(args), resolveExecutable(args), question, answer, files);
      const payload: Record<string, unknown> = {
        waymark: 1,
        kind: "chart",
        published: result.published,
        adapter: result.adapter,
        output: result.output,
      };
      if (!result.published && result.error) {
        payload.error = result.error;
      }
      return jsonResult(payload);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const discoverSymbolsTool: McpToolHandler = {
  definition: {
    name: "waymark_discover_symbols",
    description: "Discover syntax symbols in one file, filter symbols by name, or discover symbols across the repository without changing any state.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Optional repository-relative source file path to extract symbols from.",
        },
        query: {
          type: "string",
          description: "Optional symbol query to search across the repository or filter within a file.",
        },
        symbol: {
          type: "string",
          description: "Optional symbol query alias for query.",
        },
        language: {
          type: "string",
          enum: ["typescript", "python"],
          description: "Optional source language when the file extension is not sufficient.",
        },
        plain: {
          type: "boolean",
          description: "Emit token-minimal plain text formatted result for LLM context efficiency.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const storedPath = typeof args.path === "string" ? args.path.trim() : "";
      const rawQuery = (typeof args.query === "string" ? args.query.trim() : "") || (typeof args.symbol === "string" ? args.symbol.trim() : "");
      const language = typeof args.language === "string" ? args.language : undefined;
      const plain = args.plain === true;

      if (!storedPath && !rawQuery) {
        throw new WaymarkError("MISSING_ARGUMENT", "Either path or query is required");
      }

      if (storedPath) {
        const res = await discoverSymbolsInFile(root, storedPath, language, rawQuery);
        if (plain) {
          return {
            content: [{ type: "text", text: renderPlainText(res) }],
            isError: false,
          };
        }
        return jsonResult(res);
      } else {
        const { discoverSymbolsInRepo } = await import("../astExtractor.js");
        const res = await discoverSymbolsInRepo(root, rawQuery);
        if (plain) {
          return {
            content: [{ type: "text", text: renderPlainText(res) }],
            isError: false,
          };
        }
        return jsonResult(res);
      }
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkUnchartTool: McpToolHandler = {
  definition: {
    name: "waymark_unchart",
    description: "Delete one charted consensus memory entry by ID from Capn repository memory.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The unique ID of the charted entry to remove.",
        },
        if_exists: {
          type: "boolean",
          description: "If true, quietly succeeds without error if the ID is not found.",
        },
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
      required: ["id"],
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) throw new WaymarkError("MISSING_ARGUMENT", "id is required");
      const ifExists = args.if_exists === true || args.ifExists === true;
      const res = await unchart(root, resolveExecutable(args), id, ifExists);
      return jsonResult(res, !res.ok);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkBustTool: McpToolHandler = {
  definition: {
    name: "waymark_bust",
    description: "Delete every charted memory entry backed by a specific repository file.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Repository-relative file path whose associated chart entries should be invalidated.",
        },
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
      required: ["file"],
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const file = typeof args.file === "string" ? args.file.trim() : "";
      if (!file) throw new WaymarkError("MISSING_ARGUMENT", "file path is required");
      const res = await bust(root, resolveExecutable(args), file);
      return jsonResult(res, !res.ok);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkPruneTool: McpToolHandler = {
  definition: {
    name: "waymark_prune",
    description: "Delete every charted memory entry whose backing files have changed or vanished.",
    inputSchema: {
      type: "object",
      properties: {
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const res = await prune(root, resolveExecutable(args));
      return jsonResult(res, !res.ok);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkListTool: McpToolHandler = {
  definition: {
    name: "waymark_list",
    description: "List all charted consensus memory entries in the repository.",
    inputSchema: {
      type: "object",
      properties: {
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const res = await listEntries(root, resolveExecutable(args));
      return jsonResult(res, !res.ok);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkContextTool: McpToolHandler = {
  definition: {
    name: "waymark_context",
    description: "Retrieve the ask-first charting contract and syntax guidelines for Waymark Engine.",
    inputSchema: {
      type: "object",
      properties: {
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const res = await context(root, resolveExecutable(args));
      return jsonResult(res, !res.ok);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkDaemonStatusTool: McpToolHandler = {
  definition: {
    name: "waymark_daemon_status",
    description: "Check the status of the resident in-memory background daemon for this repository.",
    inputSchema: {
      type: "object",
      properties: {
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
        reload: {
          type: "boolean",
          description: "Optional. If true, reloads and invalidates the in-memory PrefixTrie and path cache for the resident daemon.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);

      if (args.reload === true) {
        const { tryDaemonReload } = await import("../daemon.js");
        const { invalidatePathsCache } = await import("../discoveryRouter.js");
        invalidatePathsCache();
        const reloadRes = await tryDaemonReload(root);
        return jsonResult({
          waymark: 1,
          kind: "daemon",
          action: "reload",
          status: reloadRes?.ok ? "reloaded" : "not_running",
          ok: Boolean(reloadRes && reloadRes.ok),
          root,
        });
      }

      const ping = await tryDaemonPing(root, 500);
      if (ping && ping.ok) {
        return jsonResult({
          waymark: 1,
          kind: "daemon",
          status: "running",
          ok: true,
          pid: ping.pid,
          uptime: ping.uptime,
          root,
          address: getDaemonAddress(root),
        });
      }
      return jsonResult({
        waymark: 1,
        kind: "daemon",
        status: "stopped",
        ok: false,
        root,
      });
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkInitTool: McpToolHandler = {
  definition: {
    name: "waymark_init",
    description: "Initialize the repository's deterministic lexical store (.capn) with embedding mode disabled.",
    inputSchema: {
      type: "object",
      properties: {
        capn_executable: {
          type: "string",
          description: "Optional custom path to the Capn executable.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const res = await initCapn(root, resolveExecutable(args));
      return jsonResult(res, !res.ok);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const waymarkMapStatusTool: McpToolHandler = {
  definition: {
    name: "waymark_map_status",
    description: "Inspect the Semantic Repo Map health, completion ratio, and backing file drift.",
    inputSchema: {
      type: "object",
      properties: {
        plain: {
          type: "boolean",
          description: "Optional. Emit token-minimal plain text (~25 tokens). Defaults to false.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const { getSemanticMapStatus, renderSemanticMapStatus } = await import("../semanticMap.js");
      const status = getSemanticMapStatus(root);
      if (args.plain) {
        return {
          content: [{ type: "text", text: renderSemanticMapStatus(status) }],
          isError: false,
        };
      }
      return jsonResult(status, false);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const CANONICAL_MCP_TOOLS: McpToolHandler[] = [
  waymarkAskTool,
  waymarkMemoryTool,
];

export const WAYMARK_TOOLS: McpToolHandler[] = [
  waymarkAskTool,
  waymarkMemoryTool,
  waymarkChartTool,
  discoverSymbolsTool,
  waymarkUnchartTool,
  waymarkBustTool,
  waymarkPruneTool,
  waymarkListTool,
  waymarkContextTool,
  waymarkDaemonStatusTool,
  waymarkMapStatusTool,
  waymarkInitTool,
];

export const CAPN_TOOLS = WAYMARK_TOOLS;

