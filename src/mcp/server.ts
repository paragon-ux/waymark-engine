import { CAPN_TOOLS } from "./capnTools.js";
import {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpPromptDefinition,
  McpResourceDefinition,
  McpToolHandler,
} from "./types.js";

export const CAPN_RESOURCES: McpResourceDefinition[] = [
  {
    uri: "capn://status",
    name: "Capn Memory Status",
    description: "Current Capn adapter profile and executable configuration",
    mimeType: "application/json",
  },
  {
    uri: "waymark://manifest",
    name: "Waymark Engine Manifest",
    description: "Tier configuration and symbol discovery capabilities of waymark-engine",
    mimeType: "application/json",
  },
];

export const CAPN_PROMPTS: McpPromptDefinition[] = [
  {
    name: "explore-subsystem",
    description: "Guide a structured 4-tier exploration of a subsystem or symbol in the codebase.",
    arguments: [
      {
        name: "query",
        description: "The symbol, function, concept, or path to investigate.",
        required: true,
      },
      {
        name: "root",
        description: "Optional repository root path.",
        required: false,
      },
    ],
  },
  {
    name: "architectural-map",
    description: "Generate an architectural call-graph map and consensus memory summary for a feature.",
    arguments: [
      {
        name: "topic",
        description: "The architectural topic or subsystem to map.",
        required: true,
      },
    ],
  },
];

export interface McpServerOptions {
  name?: string;
  version?: string;
  tools?: McpToolHandler[];
  resources?: McpResourceDefinition[];
  prompts?: McpPromptDefinition[];
  root?: string;
  enableDaemon?: boolean;
}

export class McpServer {
  private readonly toolMap: Map<string, McpToolHandler> = new Map();
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly resources: McpResourceDefinition[];
  private readonly prompts: McpPromptDefinition[];
  private readonly root: string;
  private readonly enableDaemon: boolean;
  private daemon: any = null;

  constructor(optionsOrHandlers: McpServerOptions | McpToolHandler[] = CAPN_TOOLS) {
    if (Array.isArray(optionsOrHandlers)) {
      this.serverName = "waymark-engine";
      this.serverVersion = "2.1.2";
      this.resources = CAPN_RESOURCES;
      this.prompts = CAPN_PROMPTS;
      this.root = process.cwd();
      this.enableDaemon = true;
      for (const item of optionsOrHandlers) {
        this.toolMap.set(item.definition.name, item);
      }
    } else {
      this.serverName = optionsOrHandlers.name ?? "waymark-engine";
      this.serverVersion = optionsOrHandlers.version ?? "2.1.2";
      const tools = optionsOrHandlers.tools ?? CAPN_TOOLS;
      this.resources = optionsOrHandlers.resources ?? CAPN_RESOURCES;
      this.prompts = optionsOrHandlers.prompts ?? CAPN_PROMPTS;
      this.root = optionsOrHandlers.root ?? process.cwd();
      this.enableDaemon = optionsOrHandlers.enableDaemon !== false;
      for (const item of tools) {
        this.toolMap.set(item.definition.name, item);
      }
    }
  }

  public getToolDefinitions() {
    return Array.from(this.toolMap.values()).map((h) => h.definition);
  }

  public async handleMessage(rawMessage: string): Promise<string | null> {
    const trimmed = rawMessage.trim();
    if (!trimmed) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }

    if (!parsed || typeof parsed !== "object") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }

    const message = parsed as Record<string, unknown>;
    const isNotification = message.id === undefined || message.id === null;

    if (isNotification) {
      await this.handleNotification(message as unknown as JsonRpcNotification);
      return null;
    }

    const response = await this.handleRequest(message as unknown as JsonRpcRequest);
    return JSON.stringify(response);
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (notification.method === "notifications/initialized") {
      return;
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    const supportedVersions = ["2026-07-28", "2025-11-25", "2024-11-05"];

    if (method === "server/discover") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resultType: "complete",
          supportedVersions,
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: this.serverName,
              version: this.serverVersion,
            },
          },
          instructions: "Waymark discovery engine: AST structural graph, literal path router, deterministic fzf fuzzy matcher, and repository consensus BM25 memory.",
        },
      };
    }

    if (method === "initialize") {
      const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      const negotiated = supportedVersions.includes(requested) ? requested : "2024-11-05";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: negotiated,
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion,
          },
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          instructions: "Waymark discovery engine: AST structural graph, literal path router, deterministic fzf fuzzy matcher, and repository consensus BM25 memory.",
        },
      };
    }

    if (method === "ping") {
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };
    }

    if (method === "tools/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.getToolDefinitions(),
        },
      };
    }

    if (method === "tools/call") {
      let toolName = typeof params?.name === "string" ? params.name : "";
      if (toolName === "waymark_ask") toolName = "capn_ask";
      if (toolName === "waymark_chart") toolName = "capn_chart";
      const toolArgs = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;

      const handler = this.toolMap.get(toolName);
      if (!handler) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Tool not found: ${toolName}`,
          },
        };
      }

      try {
        const result = await handler.handler(toolArgs);
        return {
          jsonrpc: "2.0",
          id,
          result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Internal error";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ error: message }) }],
            isError: true,
          },
        };
      }
    }

    if (method === "resources/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: this.resources,
        },
      };
    }

    if (method === "resources/read") {
      const uri = typeof params?.uri === "string" ? params.uri : "";

      if (uri === "capn://status") {
        const capnObj = {
          waymark: 1,
          kind: "capn-status",
          profile: process.env.WAYMARK_CAPN_PROFILE === "none" ? "none" : "capn-cli",
          capnExecutable: process.env.WAYMARK_CAPN_EXECUTABLE || "capn",
        };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(capnObj, null, 2),
              },
            ],
          },
        };
      }

      if (uri === "waymark://manifest") {
        const manifestObj = {
          waymark: 1,
          name: this.serverName,
          version: this.serverVersion,
          tiers: [
            { tier: 1, name: "AST Structural Call Graph", engine: "@paragon-ux/codedb-core" },
            { tier: 2, name: "Literal Path Router", resolution: "exact-and-substring" },
            { tier: 3, name: "Deterministic Fuzzy Matcher", engine: "Junegunn Choi fzf (algo.go)" },
            { tier: 4, name: "Charted Consensus Memory", engine: "@paragon-ux/capn-hook (BM25)" },
          ],
          capabilities: ["symbol-discovery", "call-graph", "fuzzy-matching", "consensus-memory", "single-file-ast"],
        };
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(manifestObj, null, 2),
              },
            ],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Resource not found: ${uri}`,
        },
      };
    }

    if (method === "prompts/list") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          prompts: this.prompts,
        },
      };
    }

    if (method === "prompts/get") {
      const name = String(params?.name ?? "");
      const args = (params?.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, string>;
      if (name === "explore-subsystem") {
        const query = args.query ?? "unknown";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: "Guide a structured 4-tier exploration of a subsystem or symbol in the codebase.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Please explore the codebase using waymark-engine MCP tools for: "${query}". First use capn_ask to check Tier 1 AST call graphs or Tier 3 Discovery Junction recommendations, inspect relevant files with waymark_discover_symbols, and chart findings with capn_chart.`,
                },
              },
            ],
          },
        };
      }
      if (name === "architectural-map") {
        const topic = args.topic ?? "unknown";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: "Generate an architectural call-graph map and consensus memory summary for a feature.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Trace the architectural call chain and execution flow for: "${topic}". Use capn_ask to resolve callers and callees, verify exact file paths, and summarize the policy in long-term memory via capn_chart.`,
                },
              },
            ],
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Prompt not found: ${name}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    };
  }

  public async startResidentDaemon(): Promise<void> {
    if (!this.enableDaemon || this.daemon) return;
    try {
      const { WaymarkDaemon } = await import("../daemon.js");
      this.daemon = new WaymarkDaemon(this.root, 0); // 0 = keep alive for entire MCP session
      await this.daemon.start();
    } catch {
      // non-fatal: fail closed to cold query path
    }
  }

  public close(): void {
    if (this.daemon) {
      try {
        this.daemon.stop();
      } catch {
        // ignore
      }
      this.daemon = null;
    }
  }

  public async runStdio(): Promise<void> {
    await this.startResidentDaemon();

    const cleanup = () => this.close();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("exit", cleanup);

    process.stdin.setEncoding("utf8");
    let buffer = "";

    process.stdin.on("data", async (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const response = await this.handleMessage(line);
        if (response) {
          process.stdout.write(`${response}\n`);
        }
      }
    });

    process.stdin.on("end", async () => {
      if (buffer.trim()) {
        const response = await this.handleMessage(buffer);
        if (response) {
          process.stdout.write(`${response}\n`);
        }
      }
      this.close();
    });
  }
}
