import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { McpServer, shouldWarmResidentDaemon } from "../src/mcp/server.js";

const capnIndexPath = path.resolve(import.meta.dirname, "../src/mcp/capnIndex.js");
const daemonUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/daemon.js")).href;
const packageVersion = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8")).version;

const HANDSHAKE = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
].map((message) => JSON.stringify(message)).join("\n") + "\n";

/** A temp project root (has `.git`) so the stdio server attempts daemon warm-up. */
function projectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-mcp-stdio-"));
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

/** Runs the real stdio entry point with a preload that replaces WaymarkDaemon methods. */
function runStdioServer(root: string, preloadSource: string) {
  const preload = path.join(root, "preload.mjs");
  fs.writeFileSync(preload, preloadSource);
  return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, capnIndexPath], {
    cwd: root,
    input: HANDSHAKE,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
}

function responsesById(stdout: string): Map<number, any> {
  const byId = new Map<number, any>();
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    const message = JSON.parse(line);
    if (typeof message.id === "number") byId.set(message.id, message);
  }
  return byId;
}

test("MCP serverInfo reports the package.json version", async () => {
  const server = new McpServer({ enableDaemon: false });
  const response = await server.handleMessage(JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {} },
  }));
  const body = JSON.parse(response ?? "{}");
  assert.equal(body.result?.serverInfo?.name, "waymark-engine");
  assert.equal(body.result?.serverInfo?.version, packageVersion);
});

test("daemon warm-up is limited to project roots", () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-mcp-plain-"));
  const git = projectRoot();
  const capn = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-mcp-capn-"));
  fs.mkdirSync(path.join(capn, ".capn"));
  try {
    assert.equal(shouldWarmResidentDaemon(plain), false);
    assert.equal(shouldWarmResidentDaemon(git), true);
    assert.equal(shouldWarmResidentDaemon(capn), true);
    assert.equal(shouldWarmResidentDaemon(os.homedir()), false);
    assert.equal(shouldWarmResidentDaemon(path.parse(os.tmpdir()).root), false);
  } finally {
    for (const dir of [plain, git, capn]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP stdio answers the handshake while daemon warm-up never finishes", () => {
  const root = projectRoot();
  try {
    const result = runStdioServer(root, [
      `import { WaymarkDaemon } from ${JSON.stringify(daemonUrl)};`,
      "WaymarkDaemon.prototype.start = () => new Promise(() => {});",
    ].join("\n"));
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    const responses = responsesById(result.stdout);
    assert.equal(responses.get(1)?.result?.serverInfo?.version, packageVersion);
    const tools = (responses.get(2)?.result?.tools ?? []).map((tool: { name: string }) => tool.name);
    assert.ok(tools.includes("waymark_ask"), JSON.stringify(tools));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP stdio stops a daemon whose warm-up finishes after stdin closes", () => {
  const root = projectRoot();
  const marker = path.join(root, "daemon-stopped");
  try {
    const result = runStdioServer(root, [
      'import fs from "node:fs";',
      `import { WaymarkDaemon } from ${JSON.stringify(daemonUrl)};`,
      "WaymarkDaemon.prototype.start = () => new Promise((resolve) => setTimeout(resolve, 1000));",
      `WaymarkDaemon.prototype.stop = () => fs.writeFileSync(${JSON.stringify(marker)}, "stopped");`,
    ].join("\n"));
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(responsesById(result.stdout).has(1), result.stdout);
    assert.ok(fs.existsSync(marker), "late warm-up must stop the daemon it started");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
