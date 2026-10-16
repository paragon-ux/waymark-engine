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
