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
      this.serverName = "waymark-discovery-mcp";
      this.serverVersion = "2.0.0";
      this.resources = CAPN_RESOURCES;
      this.prompts = [];
      this.root = process.cwd();
      this.enableDaemon = true;
      for (const item of optionsOrHandlers) {
        this.toolMap.set(item.definition.name, item);
      }
    } else {
      this.serverName = optionsOrHandlers.name ?? "waymark-discovery-mcp";
      this.serverVersion = optionsOrHandlers.version ?? "2.0.0";
      const tools = optionsOrHandlers.tools ?? CAPN_TOOLS;
      this.resources = optionsOrHandlers.resources ?? CAPN_RESOURCES;
      this.prompts = optionsOrHandlers.prompts ?? [];
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

    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: this.serverName,
            version: this.serverVersion,
          },
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
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
      const toolName = typeof params?.name === "string" ? params.name : "";
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
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32602,
          message: `Prompt not found: ${String(params?.name ?? "")}`,
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
