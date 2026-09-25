import { repoRoot } from "../paths.js";
import { ask, publish, unchart, bust, prune, listEntries, context } from "../capnAdapter.js";
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

export const capnAskTool: McpToolHandler = {
  definition: {
    name: "capn_ask",
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
          description: "Collapse junction responses directly to top recommendation.",
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
      required: ["question"],
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!question) throw new WaymarkError("MISSING_ARGUMENT", "question is required");

      const rawTier = typeof args.tier === "string" ? args.tier.trim() : undefined;
      const tier = rawTier as DiscoveryTier | undefined;
      const autoResolve = args.auto_resolve === true || args.autoResolve === true;
      const timing = args.timing === true;
      const plain = args.plain === true;
      const daemon = args.daemon === true;

      const result = await ask(root, resolveProfile(args), resolveExecutable(args), question, {
        tier,
        autoResolve,
        timing,
        daemon,
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

export const waymarkAskTool: McpToolHandler = {
  definition: {
    ...capnAskTool.definition,
    name: "waymark_ask",
    description: "Query the codebase using Waymark 4-tier discovery (AST structural, literal path, deterministic fuzzy, charted consensus memory).",
  },
  handler: capnAskTool.handler,
};

export const capnChartTool: McpToolHandler = {
  definition: {
    name: "capn_chart",
    description: "Directly chart a question, answer, and associated file references into Capn's long-term consensus memory.",
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

export const waymarkChartTool: McpToolHandler = {
  definition: {
    ...capnChartTool.definition,
    name: "waymark_chart",
    description: "Directly chart a question, answer, and associated file references into Waymark/Capn long-term repository memory.",
  },
  handler: capnChartTool.handler,
};

export const discoverSymbolsTool: McpToolHandler = {
  definition: {
    name: "waymark_discover_symbols",
    description: "Discover syntax symbols in one repository-relative file without changing any state.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Repository-relative source file path.",
        },
        language: {
          type: "string",
          enum: ["typescript", "python"],
          description: "Optional source language when the file extension is not sufficient.",
        },
        root: {
          type: "string",
          description: "Optional repository root path. Defaults to current working directory.",
        },
      },
      required: ["path"],
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
      const storedPath = typeof args.path === "string" ? args.path.trim() : "";
      const language = typeof args.language === "string" ? args.language : undefined;
      if (!storedPath) throw new WaymarkError("MISSING_ARGUMENT", "path is required");
      return jsonResult(await discoverSymbolsInFile(root, storedPath, language));
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

export const capnUnchartTool: McpToolHandler = {
  definition: {
    ...waymarkUnchartTool.definition,
    name: "capn_unchart",
  },
  handler: waymarkUnchartTool.handler,
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

export const capnBustTool: McpToolHandler = {
  definition: {
    ...waymarkBustTool.definition,
    name: "capn_bust",
  },
  handler: waymarkBustTool.handler,
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

export const capnPruneTool: McpToolHandler = {
  definition: {
    ...waymarkPruneTool.definition,
    name: "capn_prune",
  },
  handler: waymarkPruneTool.handler,
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

export const capnListTool: McpToolHandler = {
  definition: {
    ...waymarkListTool.definition,
    name: "capn_list",
  },
  handler: waymarkListTool.handler,
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

export const capnContextTool: McpToolHandler = {
  definition: {
    ...waymarkContextTool.definition,
    name: "capn_context",
  },
  handler: waymarkContextTool.handler,
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
      },
    },
  },
  handler: async (args) => {
    try {
      const root = resolveRoot(args);
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

export const CAPN_TOOLS: McpToolHandler[] = [
  capnAskTool,
  waymarkAskTool,
  capnChartTool,
  waymarkChartTool,
  discoverSymbolsTool,
  waymarkUnchartTool,
  capnUnchartTool,
  waymarkBustTool,
  capnBustTool,
  waymarkPruneTool,
  capnPruneTool,
  waymarkListTool,
  capnListTool,
  waymarkContextTool,
  capnContextTool,
  waymarkDaemonStatusTool,
];
