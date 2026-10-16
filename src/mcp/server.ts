import fs from "node:fs";
import { createRequire } from "node:module";
import { canonicalRoot, WaymarkDaemon } from "../daemon.js";
import { collectRepoPathsBounded } from "../discoveryRouter.js";
import { repoRootAsync } from "../paths.js";
import { CAPN_TOOLS } from "./capnTools.js";
import {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpPromptDefinition,
  McpResourceDefinition,
  McpToolHandler,
} from "./types.js";

const require = createRequire(import.meta.url);

/** Version reported in MCP serverInfo, read from package.json so it cannot drift from releases. */
export const PACKAGE_VERSION: string = (require("../../../package.json") as { version: string }).version;

/** Newest first; `server/discover` advertises this list and per-request `_meta` versions are checked against it. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2024-11-05"];

/** Methods whose results are a `CacheableResult` (required `ttlMs` + `cacheScope`) in protocol revision 2026-07-28. */
const CACHEABLE_METHODS = new Set(["server/discover", "tools/list", "prompts/list", "resources/list", "resources/read"]);

/** Tools, prompts, resources, and server metadata are fixed for the life of a server process. */
const CACHE_TTL_MS = 3_600_000;

/** Repositories with more files than this are never warmed; their calls stay on the cold path. */
const DEFAULT_WARM_MAX_FILES = 50_000;
/** A warm-up walk that runs longer than this is abandoned. */
const DEFAULT_WARM_TIMEOUT_MS = 10_000;
/** Each warm root holds a resident codedb process and a path trie, so only a few stay warm. */
const DEFAULT_WARM_MAX_ROOTS = 2;
/** Roots remembered as over budget or failed, so they are not re-walked on every call. */
const MAX_REMEMBERED_ROOTS = 32;

export interface McpWarmupOptions {
  /**
   * Warm a resident daemon for each root that tool calls target. Defaults to on once
   * `runStdio()` owns the process and off for direct `handleMessage()` use.
   * `WAYMARK_MCP_WARM=0`, `WAYMARK_DISABLE_RESIDENT=1`, or `enableDaemon: false` force it off.
   */
  enabled?: boolean;
  /** Abandon warm-up for a root with more files than this (`WAYMARK_MCP_WARM_MAX_FILES`). */
  maxFiles?: number;
  /** Abandon warm-up for a root whose file walk runs longer than this (`WAYMARK_MCP_WARM_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Most roots kept warm at once; the least recently used is stopped (`WAYMARK_MCP_WARM_MAX_ROOTS`). */
  maxRoots?: number;
}

/**
 * - `warming`: walking the tree or starting the daemon.
 * - `warm`: this server's daemon serves the root.
 * - `external`: another process already serves the root.
 * - `over-budget`: the root exceeded the file or time budget and stays on the cold path.
 * - `failed`: the root could not be resolved or the daemon failed to start.
 * - `stopped`: the server closed or evicted the root mid warm-up.
 * - `disabled`: warm-up is off.
 */
export type WarmupState = "warming" | "warm" | "external" | "over-budget" | "failed" | "stopped" | "disabled";

interface WarmRoot {
  root: string;
  state: WarmupState;
  daemon: WaymarkDaemon | null;
  abort: AbortController;
  done: Promise<WarmupState>;
}

function envFlagOff(value: string | undefined): boolean {
  return value !== undefined && ["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}

function positiveInt(value: number | string | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

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
    description: "Guide a structured 4-tier, repository-wide exploration of a subsystem concept or symbol; filesystem-scoped subsystem queries are unsupported.",
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
  {
    name: "bootstrap-semantic-map",
    description: "Collect source excerpts as unverified drafts for the repository Semantic Repo Map; a human must verify and explicitly chart each claim.",
    arguments: [
      {
        name: "root",
        description: "Optional repository root path.",
        required: false,
      },
    ],
  },
];

export interface McpServerOptions {
  name?: string;
  version?: string;
  tools?: McpToolHandler[];
  canonicalOnly?: boolean;
  resources?: McpResourceDefinition[];
  prompts?: McpPromptDefinition[];
  root?: string;
  enableDaemon?: boolean;
  warmup?: McpWarmupOptions;
}

export class McpServer {
  private readonly toolMap: Map<string, McpToolHandler> = new Map();
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly canonicalOnly: boolean;
  private readonly resources: McpResourceDefinition[];
  private readonly prompts: McpPromptDefinition[];
  private readonly root: string;
  private readonly warmupAllowed: boolean;
  private warmupEnabled: boolean;
  private readonly warmMaxFiles: number;
  private readonly warmTimeoutMs: number;
  private readonly warmMaxRoots: number;
  /** Keyed by canonical repository root, least recently used first. */
  private readonly warmRoots = new Map<string, WarmRoot>();
  /** Canonical requested root to the repository root that tools resolve it to. */
  private readonly repoRoots = new Map<string, Promise<string>>();
  private closed = false;
  constructor(optionsOrHandlers: McpServerOptions | McpToolHandler[] = CAPN_TOOLS) {
    process.env.WAYMARK_MCP_SESSION = "1";
    const verbose = process.env.WAYMARK_MCP_VERBOSE === "1" || process.env.WAYMARK_MCP_ALL_TOOLS === "1";
    if (Array.isArray(optionsOrHandlers)) {
      this.serverName = "waymark-engine";
      this.serverVersion = PACKAGE_VERSION;
      this.canonicalOnly = !verbose;
      this.resources = CAPN_RESOURCES;
      this.prompts = CAPN_PROMPTS;
      this.root = process.cwd();
      for (const item of optionsOrHandlers) {
        this.toolMap.set(item.definition.name, item);
      }
    } else {
      this.serverName = optionsOrHandlers.name ?? "waymark-engine";
      this.serverVersion = optionsOrHandlers.version ?? PACKAGE_VERSION;
      this.canonicalOnly = optionsOrHandlers.canonicalOnly !== undefined
        ? optionsOrHandlers.canonicalOnly
        : !verbose;
      const tools = optionsOrHandlers.tools ?? CAPN_TOOLS;
      this.resources = optionsOrHandlers.resources ?? CAPN_RESOURCES;
      this.prompts = optionsOrHandlers.prompts ?? CAPN_PROMPTS;
      this.root = optionsOrHandlers.root ?? process.cwd();
      for (const item of tools) {
        this.toolMap.set(item.definition.name, item);
      }
    }
    const options: McpServerOptions = Array.isArray(optionsOrHandlers) ? {} : optionsOrHandlers;
    const warmup = options.warmup ?? {};
    this.warmupAllowed = options.enableDaemon !== false
      && warmup.enabled !== false
      && !envFlagOff(process.env.WAYMARK_MCP_WARM)
      && process.env.WAYMARK_DISABLE_RESIDENT !== "1";
    this.warmupEnabled = this.warmupAllowed && warmup.enabled === true;
    this.warmMaxFiles = positiveInt(warmup.maxFiles ?? process.env.WAYMARK_MCP_WARM_MAX_FILES, DEFAULT_WARM_MAX_FILES);
    this.warmTimeoutMs = positiveInt(warmup.timeoutMs ?? process.env.WAYMARK_MCP_WARM_TIMEOUT_MS, DEFAULT_WARM_TIMEOUT_MS);
    this.warmMaxRoots = positiveInt(warmup.maxRoots ?? process.env.WAYMARK_MCP_WARM_MAX_ROOTS, DEFAULT_WARM_MAX_ROOTS);
  }

  public getToolDefinitions() {
    if (this.canonicalOnly) {
      const canonicalNames = new Set(["waymark_ask", "waymark_memory"]);
      return Array.from(this.toolMap.values())
        .filter((h) => canonicalNames.has(h.definition.name))
        .map((h) => h.definition);
    }
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

    const request = message as unknown as JsonRpcRequest;
    const response = await this.handleRequest(request);
    return JSON.stringify(this.withResultFields(response, request.method));
  }

  /**
   * Adds the result fields protocol revision 2026-07-28 requires (`resultType`, cache hints)
   * plus `serverInfo` in `_meta`. Results stay valid for earlier revisions, which ignore extra fields.
   */
  private withResultFields(response: JsonRpcResponse, method: string): JsonRpcResponse {
    if (!response.result || typeof response.result !== "object") return response;
    const result = response.result as Record<string, unknown>;
    return {
      ...response,
      result: {
        resultType: "complete",
        ...(CACHEABLE_METHODS.has(method) ? { ttlMs: CACHE_TTL_MS, cacheScope: "private" } : {}),
        ...result,
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: this.serverName, version: this.serverVersion },
          ...(result._meta as Record<string, unknown> | undefined),
        },
      },
    };
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (notification.method === "notifications/initialized") {
      return;
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method, params } = request;

    const supportedVersions = SUPPORTED_PROTOCOL_VERSIONS;

    // Revision 2026-07-28 carries the protocol version on every request; discover and the legacy handshake negotiate it instead.
    const requestedVersion = (params?._meta as Record<string, unknown> | undefined)?.["io.modelcontextprotocol/protocolVersion"];
    if (
      typeof requestedVersion === "string"
      && method !== "server/discover"
      && method !== "initialize"
      && !supportedVersions.includes(requestedVersion)
    ) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32022,
          message: "Unsupported protocol version",
          data: { supported: supportedVersions, requested: requestedVersion },
        },
      };
    }

    if (method === "server/discover") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          supportedVersions,
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
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

      // Fire and forget: this call takes the cold path; later calls on the root find it warm.
      const targetRoot = typeof toolArgs.root === "string" && toolArgs.root.trim() ? toolArgs.root.trim() : this.root;
      void this.warmRoot(targetRoot);

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
            description: "Guide repository-wide discovery for a subsystem concept or symbol; filesystem-scoped queries are unsupported.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Please explore the codebase using waymark-engine MCP tools for: "${query}". First use waymark_ask to check Tier 1 AST call graphs or Tier 3 Discovery Junction recommendations, inspect relevant file AST outlines with waymark_ask (argument: path), and chart architectural findings into consensus memory via waymark_memory (action: "chart", or waymark_chart).`,
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
                  text: `Trace the architectural call chain and execution flow for: "${topic}". Use waymark_ask to resolve callers and callees (arguments: depth, direction), verify exact file paths, and summarize the consensus policy in long-term memory via waymark_memory (action: "chart", or waymark_chart).`,
                },
              },
            ],
          },
        };
      }
      if (name === "bootstrap-semantic-map") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: "Collect source excerpts as unverified drafts; a human must verify and explicitly chart each claim.",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Inspect the repository-wide Semantic Repo Map with waymark_memory(action="status"). Bootstrap may collect source excerpts as unverified drafts but never publishes claims. Verify each claim against its cited source and publish only supported conclusions with waymark_memory(action="chart"). Subsystem-scoped maps are unsupported.`,
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

  /**
   * Warms a resident daemon in the background for the repository that tools resolve `root` to.
   * Memoized per repository, so repeat calls share one warm-up; never rejects.
   */
  public warmRoot(root: string = this.root): Promise<WarmupState> {
    if (!this.warmupEnabled || this.closed) return Promise.resolve("disabled");
    const requested = canonicalRoot(root);
    let repo = this.repoRoots.get(requested);
    if (!repo) {
      repo = repoRootAsync(root);
      this.repoRoots.set(requested, repo);
      // A root that does not exist yet may exist on a later call.
      repo.catch(() => this.repoRoots.delete(requested));
    }
    return repo.then((repoRoot) => this.warmRepo(repoRoot), (): WarmupState => "failed");
  }

  /** Warm-up state per repository root, least recently used first. */
  public getWarmupStatus(): Array<{ root: string; state: WarmupState }> {
    return Array.from(this.warmRoots.values(), ({ root, state }) => ({ root, state }));
  }

  private warmRepo(repoRoot: string): Promise<WarmupState> {
    if (this.closed) return Promise.resolve("stopped");
    const key = canonicalRoot(repoRoot);
    const known = this.warmRoots.get(key);
    if (known) {
      this.warmRoots.delete(key);
      this.warmRoots.set(key, known);
      return known.done;
    }
    const entry: WarmRoot = { root: repoRoot, state: "warming", daemon: null, abort: new AbortController(), done: Promise.resolve("warming") };
    this.warmRoots.set(key, entry);
    entry.done = this.runWarmup(entry);
    this.evictWarmRoots();
    return entry.done;
  }

  private async runWarmup(entry: WarmRoot): Promise<WarmupState> {
    const { signal } = entry.abort;
    const settle = (state: WarmupState): WarmupState => {
      entry.state = state;
      return state;
    };
    try {
      if (!(await fs.promises.stat(entry.root)).isDirectory()) return settle("failed");
      const walk = await collectRepoPathsBounded(entry.root, {
        maxFiles: this.warmMaxFiles,
        timeoutMs: this.warmTimeoutMs,
        signal,
      });
      if (!walk.complete) return settle(walk.reason === "aborted" ? "stopped" : "over-budget");
      const daemon = new WaymarkDaemon(entry.root, 0); // 0 = keep alive for the MCP session
      let serving = false;
      try {
        serving = await daemon.start({ paths: walk.paths, signal });
      } finally {
        // stop() also releases the resident codedb client that a refused or failed start left open.
        if (!serving || signal.aborted) daemon.stop();
      }
      if (signal.aborted) return settle("stopped");
      if (!serving) return settle("external");
      entry.daemon = daemon;
      return settle("warm");
    } catch {
      // non-fatal: the root stays on the cold query path
      return settle(signal.aborted ? "stopped" : "failed");
    }
  }

  private evictWarmRoots(): void {
    const holding = Array.from(this.warmRoots).filter(([, entry]) => entry.state === "warming" || entry.state === "warm");
    for (const [key, entry] of holding.slice(0, Math.max(0, holding.length - this.warmMaxRoots))) {
      this.warmRoots.delete(key);
      this.releaseWarmRoot(entry);
    }
    for (const [key, entry] of this.warmRoots) {
      if (this.warmRoots.size <= this.warmMaxRoots + MAX_REMEMBERED_ROOTS) break;
      if (entry.state !== "warming" && entry.state !== "warm") this.warmRoots.delete(key);
    }
  }

  /** Stops a warm daemon now; a warm-up still in flight sees the abort and stops its own daemon when it settles. */
  private releaseWarmRoot(entry: WarmRoot): void {
    entry.abort.abort();
    if (entry.daemon) {
      try {
        entry.daemon.stop();
      } catch {
        // ignore
      }
      entry.daemon = null;
    }
  }

  public close(): void {
    this.closed = true;
    for (const entry of this.warmRoots.values()) this.releaseWarmRoot(entry);
    this.warmRoots.clear();
  }

  public async runStdio(): Promise<void> {
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

    // Nothing is indexed at startup: the launch folder (often the home folder) says nothing
    // about intent. Tool calls warm the roots they target, in the background.
    this.warmupEnabled = this.warmupAllowed;
  }
}
