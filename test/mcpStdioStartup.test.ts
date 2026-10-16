import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { canonicalRoot, WaymarkDaemon } from "../src/daemon.js";
import { McpServer } from "../src/mcp/server.js";
import type { McpToolHandler } from "../src/mcp/types.js";

const capnIndexPath = path.resolve(import.meta.dirname, "../src/mcp/capnIndex.js");
const daemonUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/daemon.js")).href;
const packageVersion = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8")).version;

// Temp roots must resolve to themselves, never to an enclosing Git checkout.
process.env.GIT_CEILING_DIRECTORIES = fs.realpathSync.native(os.tmpdir());

const HANDSHAKE = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
];

function tempRoot(prefix = "waymark-mcp-warm-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function toolCall(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Runs the real stdio entry point, optionally with a preload that replaces WaymarkDaemon methods. */
function startStdio(cwd: string, options: { preload?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const preloadArgs = options.preload ? ["--import", pathToFileURL(options.preload).href] : [];
  const child = spawn(process.execPath, [...preloadArgs, capnIndexPath, ...(options.args ?? [])], {
    cwd,
    env: { ...process.env, ...options.env },
    windowsHide: true,
  });
  const responses = new Map<number, any>();
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/u);
    stdout = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const message = JSON.parse(line);
      if (typeof message.id === "number") responses.set(message.id, message);
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    send(...messages: object[]) {
      for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async response(id: number): Promise<any> {
      await waitFor(() => responses.has(id), `response ${id} (stderr: ${stderr})`);
      return responses.get(id);
    },
    /** Closes stdin and resolves the exit code; the server must exit on its own. */
    async end(): Promise<{ code: number | null; stderr: string }> {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 15_000);
      const code = await exited;
      clearTimeout(timer);
      return { code, stderr };
    },
  };
}

function writePreload(root: string, lines: string[]): string {
  const preload = path.join(root, "preload.mjs");
  fs.writeFileSync(preload, [
    'import fs from "node:fs";',
    `import { WaymarkDaemon } from ${JSON.stringify(daemonUrl)};`,
    ...lines,
  ].join("\n"));
  return preload;
}

const probeTool: McpToolHandler = {
  definition: { name: "probe", description: "Answers immediately.", inputSchema: { type: "object", properties: {} } },
  handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

/** Replaces WaymarkDaemon start/stop for one in-process test and records what they were called for. */
async function withDaemonStub(
  start: () => Promise<boolean>,
  body: (calls: { started: string[]; stopped: string[] }) => Promise<void>,
): Promise<void> {
  const { start: originalStart, stop: originalStop } = WaymarkDaemon.prototype;
  const calls = { started: [] as string[], stopped: [] as string[] };
  WaymarkDaemon.prototype.start = function (this: WaymarkDaemon) {
    calls.started.push(canonicalRoot(this.root));
    return start();
  };
  WaymarkDaemon.prototype.stop = function (this: WaymarkDaemon) {
    calls.stopped.push(canonicalRoot(this.root));
  };
  try {
    await body(calls);
  } finally {
    WaymarkDaemon.prototype.start = originalStart;
    WaymarkDaemon.prototype.stop = originalStop;
  }
}

test("MCP serverInfo reports the package.json version", async () => {
  const server = new McpServer({ enableDaemon: false });
  const response = await server.handleMessage(JSON.stringify(HANDSHAKE[0]));
  const body = JSON.parse(response ?? "{}");
  assert.equal(body.result?.serverInfo?.name, "waymark-engine");
  assert.equal(body.result?.serverInfo?.version, packageVersion);
});

test("MCP stdio indexes nothing at startup, even in a project root", async () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, ".git"));
  const marker = path.join(root, "daemon-started");
  try {
    const session = startStdio(root, {
      preload: writePreload(root, [`WaymarkDaemon.prototype.start = async () => { fs.writeFileSync(${JSON.stringify(marker)}, ""); return true; };`]),
    });
    session.send(...HANDSHAKE);
    assert.equal((await session.response(1)).result?.serverInfo?.version, packageVersion);
    const tools = ((await session.response(2)).result?.tools ?? []).map((tool: { name: string }) => tool.name);
    assert.ok(tools.includes("waymark_ask"), JSON.stringify(tools));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { code, stderr } = await session.end();
    assert.equal(code, 0, stderr);
    assert.equal(fs.existsSync(marker), false, "startup must not warm the launch folder");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP stdio answers a tool call while that root's warm-up never finishes", async () => {
  const launch = tempRoot();
  const target = tempRoot();
  const marker = path.join(launch, "daemon-started");
  try {
    const session = startStdio(launch, {
      preload: writePreload(launch, [
        `WaymarkDaemon.prototype.start = function () { fs.writeFileSync(${JSON.stringify(marker)}, this.root); return new Promise(() => {}); };`,
      ]),
    });
    session.send(...HANDSHAKE, toolCall(3, "waymark_daemon_status", { root: target }));
    const response = await session.response(3);
    assert.equal(response.error, undefined, JSON.stringify(response));
    assert.equal(JSON.parse(response.result.content[0].text).status, "stopped");
    await waitFor(() => fs.existsSync(marker), "warm-up of the call's root");
    assert.equal(canonicalRoot(fs.readFileSync(marker, "utf8")), canonicalRoot(target));
    const { code, stderr } = await session.end();
    assert.equal(code, 0, stderr);
  } finally {
    for (const dir of [launch, target]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP stdio stops a daemon whose warm-up finishes after stdin closes", async () => {
  const root = tempRoot();
  const started = path.join(root, "daemon-started");
  const stopped = path.join(root, "daemon-stopped");
  try {
    const session = startStdio(root, {
      preload: writePreload(root, [
        `WaymarkDaemon.prototype.start = () => { fs.writeFileSync(${JSON.stringify(started)}, ""); return new Promise((resolve) => setTimeout(() => resolve(true), 1000)); };`,
        `WaymarkDaemon.prototype.stop = () => fs.writeFileSync(${JSON.stringify(stopped)}, "");`,
      ]),
    });
    session.send(...HANDSHAKE, toolCall(3, "waymark_daemon_status"));
    await session.response(3);
    await waitFor(() => fs.existsSync(started), "warm-up start");
    const { code, stderr } = await session.end();
    assert.equal(code, 0, stderr);
    assert.ok(fs.existsSync(stopped), "late warm-up must stop the daemon it started");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP stdio --root sets the default tool root", async () => {
  const launch = tempRoot();
  const target = tempRoot();
  try {
    const session = startStdio(launch, { args: ["--root", target], env: { WAYMARK_MCP_WARM: "0" } });
    session.send(...HANDSHAKE, toolCall(3, "waymark_daemon_status"));
    const body = JSON.parse((await session.response(3)).result.content[0].text);
    assert.equal(canonicalRoot(body.root), canonicalRoot(target));
    assert.equal((await session.end()).code, 0);

    const missing = spawnSync(process.execPath, [capnIndexPath, "--root"], { cwd: launch, input: "", encoding: "utf8", timeout: 30_000, windowsHide: true });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--root requires a path/u);
  } finally {
    for (const dir of [launch, target]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("first tool call on a root starts its warm-up without waiting for it", async () => {
  const launch = tempRoot();
  const target = tempRoot();
  const server = new McpServer({ root: launch, tools: [probeTool], warmup: { enabled: true } });
  try {
    await withDaemonStub(() => new Promise(() => {}), async (calls) => {
      const first = JSON.parse(await server.handleMessage(JSON.stringify(toolCall(1, "probe", { root: target }))) ?? "{}");
      assert.equal(first.result?.content?.[0]?.text, "ok");
      await waitFor(() => calls.started.length === 1, "warm-up start");
      assert.deepEqual(calls.started, [canonicalRoot(target)]);

      // Repeat calls share the warm-up; a call without `root` warms the server root.
      await server.handleMessage(JSON.stringify(toolCall(2, "probe", { root: target })));
      await server.handleMessage(JSON.stringify(toolCall(3, "probe")));
      await waitFor(() => calls.started.length === 2, "server-root warm-up start");
      assert.deepEqual(calls.started, [canonicalRoot(target), canonicalRoot(launch)]);
      assert.deepEqual(server.getWarmupStatus().map(({ state }) => state), ["warming", "warming"]);
    });
  } finally {
    server.close();
    for (const dir of [launch, target]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("warm-up is abandoned for a root over the file budget", async () => {
  const root = tempRoot();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `file${i}.ts`), "");
  const small = new McpServer({ root, tools: [probeTool], warmup: { enabled: true, maxFiles: 3 } });
  const large = new McpServer({ root, tools: [probeTool], warmup: { enabled: true, maxFiles: 5 } });
  try {
    await withDaemonStub(async () => true, async (calls) => {
      assert.equal(await small.warmRoot(root), "over-budget");
      assert.deepEqual(calls.started, []);
      assert.equal(await large.warmRoot(root), "warm");
      assert.deepEqual(calls.started, [canonicalRoot(root)]);
    });
  } finally {
    small.close();
    large.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WAYMARK_MCP_WARM=0 and enableDaemon: false disable warm-up", async () => {
  const root = tempRoot();
  const previous = process.env.WAYMARK_MCP_WARM;
  process.env.WAYMARK_MCP_WARM = "0";
  const optedOut = new McpServer({ root, tools: [probeTool], warmup: { enabled: true } });
  if (previous === undefined) delete process.env.WAYMARK_MCP_WARM;
  else process.env.WAYMARK_MCP_WARM = previous;
  const noDaemon = new McpServer({ root, tools: [probeTool], enableDaemon: false, warmup: { enabled: true } });
  try {
    await withDaemonStub(async () => true, async (calls) => {
      for (const server of [optedOut, noDaemon]) {
        await server.handleMessage(JSON.stringify(toolCall(1, "probe", { root })));
        assert.equal(await server.warmRoot(root), "disabled");
        assert.deepEqual(server.getWarmupStatus(), []);
      }
      assert.deepEqual(calls.started, []);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("warm roots are capped and close() stops every warm daemon", async () => {
  const [a, b] = [tempRoot(), tempRoot()];
  const server = new McpServer({ root: a, tools: [probeTool], warmup: { enabled: true, maxRoots: 1 } });
  try {
    await withDaemonStub(async () => true, async (calls) => {
      assert.equal(await server.warmRoot(a), "warm");
      assert.equal(await server.warmRoot(a), "warm");
      assert.deepEqual(calls.started, [canonicalRoot(a)], "a root is warmed once");
      assert.equal(await server.warmRoot(b), "warm");
      assert.deepEqual(calls.stopped, [canonicalRoot(a)], "the least recently used root is stopped");
      server.close();
      assert.deepEqual(calls.stopped, [canonicalRoot(a), canonicalRoot(b)]);
      assert.equal(await server.warmRoot(b), "disabled");
    });
  } finally {
    server.close();
    for (const dir of [a, b]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
