import { repoRoot } from "../paths.js";
import { ask, publish } from "../capnAdapter.js";
import { discoverSymbolsInFile } from "../astExtractor.js";
import { AdapterProfile, WaymarkError } from "../types.js";
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
  return (typeof args.capn_executable === "string" && args.capn_executable.trim()) || process.env.WAYMARK_CAPN_EXECUTABLE || "capn";
}

export const capnAskTool: McpToolHandler = {
  definition: {
    name: "capn_ask",
    description: "Query Capn's charted repository memory to check if an answer to the question already exists.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question to look up in Capn's charted memory.",
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

      const result = await ask(root, resolveProfile(args), resolveExecutable(args), question);
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
      }
      return jsonResult(payload);
    } catch (error) {
      return errorResult(error);
    }
  },
};

export const capnChartTool: McpToolHandler = {
  definition: {
    name: "capn_chart",
    description: "Directly chart a question, answer, and associated file references into Capn's long-term memory.",
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

export const waymarkAskTool: McpToolHandler = {
  definition: {
    ...capnAskTool.definition,
    name: "waymark_ask",
    description: "Query the codebase using Waymark 4-tier discovery (AST structural, literal path, deterministic fuzzy, charted memory).",
  },
  handler: capnAskTool.handler,
};

export const waymarkChartTool: McpToolHandler = {
  definition: {
    ...capnChartTool.definition,
    name: "waymark_chart",
    description: "Directly chart a question, answer, and associated file references into Waymark/Capn long-term repository memory.",
  },
  handler: capnChartTool.handler,
};

export const CAPN_TOOLS: McpToolHandler[] = [
  capnAskTool,
  capnChartTool,
  discoverSymbolsTool,
];
