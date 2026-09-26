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
      const question = typeof args.question === "string" ? args.question.trim() : "";
      const timing = args.timing === true;
      const plain = args.plain === true;
      const daemon = args.daemon === true;
      const depth = typeof args.depth === "number" ? Math.min(Math.max(1, args.depth), 5) : undefined;
      const direction = (args.direction === "callers" || args.direction === "callees" || args.direction === "both")
        ? args.direction
        : undefined;
      const excludeTests = args.exclude_tests === true || args.excludeTests === true;

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

      if (!question) throw new WaymarkError("MISSING_ARGUMENT", "question or symbols is required");

      const rawTier = typeof args.tier === "string" ? args.tier.trim() : undefined;
      const tier = rawTier as DiscoveryTier | undefined;
      const autoResolve = args.auto_resolve !== false && args.autoResolve !== false;

      const result = await ask(root, resolveProfile(args), resolveExecutable(args), question, {
        tier,
        autoResolve,
        timing,
        daemon,
        depth,
        direction,
        excludeTests,
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

export const WAYMARK_TOOLS: McpToolHandler[] = [
  waymarkAskTool,
  waymarkChartTool,
  discoverSymbolsTool,
  waymarkUnchartTool,
  waymarkBustTool,
  waymarkPruneTool,
  waymarkListTool,
  waymarkContextTool,
  waymarkDaemonStatusTool,
  waymarkInitTool,
];

export const CAPN_TOOLS = WAYMARK_TOOLS;
