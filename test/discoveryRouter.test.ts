import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectAstIntent, queryWasmAst } from "../src/discoveryRouter.js";
import { extractAstFromRepo } from "../src/astExtractor.js";
import { ask } from "../src/capnAdapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const waymarkRoot = path.resolve(__dirname, "../..");

test("detectAstIntent classifies structural queries correctly", () => {
  const i1 = detectAstIntent("Who calls capnChartArgs?");
  assert.equal(i1.requiresParser, true);
  assert.equal(i1.tool, "trace_path");
  assert.equal(i1.functionName, "capnChartArgs");

  const i2 = detectAstIntent("Where is function publish declared?");
  assert.equal(i2.requiresParser, true);
  assert.equal(i2.tool, "search_graph");
  assert.equal(i2.query, "publish");

  const i3 = detectAstIntent("Show the entrypoints and architecture of the repository");
  assert.equal(i3.requiresParser, true);
  assert.equal(i3.tool, "get_architecture");

  const i4 = detectAstIntent("Why does Waymark require contiguous verified prefixes?");
  assert.equal(i4.requiresParser, false);
});

test("extractAstFromRepo parses Waymark repository using in-process WebAssembly", async () => {
  const result = await extractAstFromRepo(waymarkRoot, ["src"]);
  assert.ok(result.filesParsed >= 10, `Expected at least 10 files parsed, got ${result.filesParsed}`);
  assert.ok(result.symbols.length >= 40, `Expected at least 40 symbols, got ${result.symbols.length}`);
  assert.ok(result.calls.length >= 100, `Expected at least 100 calls, got ${result.calls.length}`);

  // capnChartArgs should be found in src/capnAdapter.ts
  const chartArgs = result.symbols.find((s) => s.name === "capnChartArgs");
  assert.ok(chartArgs, "capnChartArgs symbol should be extracted");
  assert.equal(chartArgs.file, "src/capnAdapter.ts");

  // publish should be called by mcp tool handlers or cli
  const publishCallers = result.callersMap.get("capnChartArgs") || [];
  assert.ok(publishCallers.includes("publish"), "publish should call capnChartArgs");
});

test("queryWasmAst answers trace_path and search_graph directly", async () => {
  const traceRes = await queryWasmAst({ requiresParser: true, tool: "trace_path", functionName: "capnChartArgs" }, waymarkRoot);
  assert.equal(traceRes.hit, true);
  assert.ok(traceRes.output.includes("publish"));

  const symbolRes = await queryWasmAst({ requiresParser: true, tool: "search_graph", query: "capnChartArgs" }, waymarkRoot);
  assert.equal(symbolRes.hit, true);
  assert.ok(symbolRes.output.includes("src/capnAdapter.ts"));
});

test("ask() automatically delegates AST queries to in-process Tree-sitter WASM", async () => {
  const hitRes = await ask(waymarkRoot, "capn-cli", "capn", "Who calls capnChartArgs?");
  assert.equal(hitRes.status, "hit");
  assert.equal(hitRes.provider, "wasm-ast");
  assert.ok(typeof hitRes.result === "string" && hitRes.result.includes("publish"));

  const symbolRes = await ask(waymarkRoot, "capn-cli", "capn", "Where is function capnChartArgs declared?");
  assert.equal(symbolRes.status, "hit");
  assert.equal(symbolRes.provider, "wasm-ast");
  assert.ok(typeof symbolRes.result === "string" && symbolRes.result.includes("src/capnAdapter.ts"));
});