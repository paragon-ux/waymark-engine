import test from "node:test";
import assert from "node:assert/strict";
import { McpServer, PACKAGE_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp/server.js";

const REVISION = "2026-07-28";
const REQUEST_META = {
  "io.modelcontextprotocol/protocolVersion": REVISION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

async function call(server: McpServer, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const response = await server.handleMessage(JSON.stringify({
    jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: REQUEST_META },
  }));
  return JSON.parse(response ?? "{}");
}

const CACHEABLE: Array<[string, Record<string, unknown>]> = [
  ["server/discover", {}],
  ["tools/list", {}],
  ["prompts/list", {}],
  ["resources/list", {}],
  ["resources/read", { uri: "waymark://manifest" }],
];

const NON_CACHEABLE: Array<[string, Record<string, unknown>]> = [
  ["ping", {}],
  ["prompts/get", { name: "explore-subsystem", arguments: { query: "verifyHop" } }],
];

test(`server/discover advertises ${REVISION}`, async () => {
  const body = await call(new McpServer({ enableDaemon: false }), "server/discover");
  assert.deepEqual(body.result?.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS);
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(REVISION));
});

test(`every ${REVISION} result carries resultType and serverInfo`, async () => {
  const server = new McpServer({ enableDaemon: false });
  for (const [method, params] of [...CACHEABLE, ...NON_CACHEABLE]) {
    const body = await call(server, method, params);
    assert.equal(body.error, undefined, `${method}: ${JSON.stringify(body.error)}`);
    assert.equal(body.result?.resultType, "complete", `${method} must set resultType`);
    assert.deepEqual(
      body.result?._meta?.["io.modelcontextprotocol/serverInfo"],
      { name: "waymark-engine", version: PACKAGE_VERSION },
      `${method} must identify the server in _meta`,
    );
  }
});

test("tool call results carry resultType", async () => {
  const body = await call(new McpServer({ enableDaemon: false }), "tools/call", { name: "waymark_context", arguments: {} });
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  assert.equal(body.result?.resultType, "complete");
  assert.ok(Array.isArray(body.result?.content));
});

test("cacheable results carry ttlMs and cacheScope; others do not", async () => {
  const server = new McpServer({ enableDaemon: false });
  for (const [method, params] of CACHEABLE) {
    const { result } = await call(server, method, params);
    assert.ok(Number.isInteger(result?.ttlMs) && result.ttlMs >= 0, `${method} ttlMs: ${result?.ttlMs}`);
    assert.ok(["public", "private"].includes(result?.cacheScope), `${method} cacheScope: ${result?.cacheScope}`);
  }
  for (const [method, params] of NON_CACHEABLE) {
    const { result } = await call(server, method, params);
    assert.equal(result?.ttlMs, undefined, `${method} is not a CacheableResult`);
    assert.equal(result?.cacheScope, undefined, `${method} is not a CacheableResult`);
  }
});

test("unsupported per-request protocol versions return UnsupportedProtocolVersionError", async () => {
  const server = new McpServer({ enableDaemon: false });
  const response = await server.handleMessage(JSON.stringify({
    jsonrpc: "2.0", id: 7, method: "tools/list",
    params: { _meta: { ...REQUEST_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  }));
  const body = JSON.parse(response ?? "{}");
  assert.equal(body.id, 7);
  assert.equal(body.result, undefined);
  assert.equal(body.error?.code, -32022);
  assert.deepEqual(body.error?.data, { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: "1900-01-01" });

  const discover = await server.handleMessage(JSON.stringify({
    jsonrpc: "2.0", id: 8, method: "server/discover",
    params: { _meta: { ...REQUEST_META, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } },
  }));
  assert.deepEqual(JSON.parse(discover ?? "{}").result?.supportedVersions, SUPPORTED_PROTOCOL_VERSIONS, "discover still answers so clients can renegotiate");
});

const ROOT_PROMPTS: Array<[string, Record<string, string>]> = [
  ["explore-subsystem", { query: "verifyHop" }],
  ["architectural-map", { topic: "capnStoreArgs" }],
  ["bootstrap-semantic-map", {}],
];

async function promptText(server: McpServer, name: string, args: Record<string, unknown>): Promise<string> {
  const body = await call(server, "prompts/get", { name, arguments: args });
  assert.equal(body.error, undefined, `${name}: ${JSON.stringify(body.error)}`);
  return body.result?.messages?.[0]?.content?.text ?? "";
}

test("every prompt declares an optional root argument", async () => {
  const { result } = await call(new McpServer({ enableDaemon: false }), "prompts/list");
  for (const [name] of ROOT_PROMPTS) {
    const prompt = result?.prompts?.find((entry: { name: string }) => entry.name === name);
    assert.ok(prompt, `${name} is listed`);
    const root = prompt.arguments?.find((arg: { name: string }) => arg.name === "root");
    assert.equal(root?.required, false, `${name} declares an optional root`);
  }
});

test("prompts tell the agent to pass the given root on every tool call", async () => {
  const server = new McpServer({ enableDaemon: false });
  const root = String.raw`C:\work\my "repo"`;
  for (const [name, args] of ROOT_PROMPTS) {
    const text = await promptText(server, name, { ...args, root: `  ${root}  ` });
    assert.ok(
      text.endsWith(` Pass root: ${JSON.stringify(root)} on every waymark_ask and waymark_memory call.`),
      `${name}: ${text}`,
    );
  }
});

test("prompts without a root leave the tool calls on the server root", async () => {
  const server = new McpServer({ enableDaemon: false });
  for (const [name, args] of ROOT_PROMPTS) {
    for (const root of [undefined, "", "   ", 42]) {
      const text = await promptText(server, name, root === undefined ? args : { ...args, root });
      assert.ok(text.length > 0, `${name} has text`);
      assert.doesNotMatch(text, /Pass root/u, `${name} with root ${JSON.stringify(root)}`);
    }
  }
  assert.match(await promptText(server, "explore-subsystem", { query: "verifyHop" }), /for: "verifyHop"/u);
  assert.match(await promptText(server, "architectural-map", { topic: "capnStoreArgs" }), /for: "capnStoreArgs"/u);
});
