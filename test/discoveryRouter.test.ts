import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectRepoPaths, detectAstIntent, detectLiteralIntent, matchLiteralPath, queryWasmAst } from "../src/discoveryRouter.js";
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

  // Natural phrasing variants for declarations and definitions
  const i5 = detectAstIntent("Where is publish declared?");
  assert.equal(i5.requiresParser, true);
  assert.equal(i5.tool, "search_graph");
  assert.equal(i5.query, "publish");

  const i6 = detectAstIntent("Where is publish defined?");
  assert.equal(i6.requiresParser, true);
  assert.equal(i6.tool, "search_graph");
  assert.equal(i6.query, "publish");

  const i7 = detectAstIntent("declaration of publish");
  assert.equal(i7.requiresParser, true);
  assert.equal(i7.tool, "search_graph");
  assert.equal(i7.query, "publish");

  // Conceptual query must remain semantic fallback
  const i8 = detectAstIntent("Where are payment webhooks handled?");
  assert.equal(i8.requiresParser, false);
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

function literalWorkspace(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-literal-"));
  fs.mkdirSync(path.join(repo, "src", "auth"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src", "db"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "auth", "utils.ts"), "export const auth = 1\n");
  fs.writeFileSync(path.join(repo, "src", "db", "utils.ts"), "export const db = 1\n");
  fs.writeFileSync(path.join(repo, "src", "sample.ts"), "export const sample = 1\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  fs.writeFileSync(path.join(repo, "Dockerfile"), "FROM node:22\n");
  return repo;
}

test("detectLiteralIntent classifies literal queries and leaves natural language alone", () => {
  assert.deepEqual(detectLiteralIntent("sample.ts"), { isLiteral: true, normalized: "sample.ts" });
  assert.equal(detectLiteralIntent("src/auth/utils.ts").isLiteral, true);
  assert.equal(detectLiteralIntent(".gitignore").isLiteral, true);
  assert.equal(detectLiteralIntent("Dockerfile").isLiteral, true);
  assert.equal(detectLiteralIntent("Where is function capnChartArgs declared?").isLiteral, false);
  assert.equal(detectLiteralIntent("payment webhooks").isLiteral, false);
});

test("collectRepoPaths + matchLiteralPath resolve literals and fail closed on ambiguity", () => {
  const repo = literalWorkspace();
  const paths = collectRepoPaths(repo);

  assert.ok(paths.includes("src/sample.ts"));
  assert.ok(paths.includes("src/auth/utils.ts"));
  assert.ok(paths.includes("src/db/utils.ts"));
  assert.ok(paths.includes(".gitignore"));
  assert.ok(paths.includes("Dockerfile"));

  assert.deepEqual(matchLiteralPath("sample.ts", paths), [{ file: "src/sample.ts", kind: "basename" }]);
  assert.deepEqual(matchLiteralPath(".gitignore", paths), [{ file: ".gitignore", kind: "exact" }]);
  assert.deepEqual(matchLiteralPath("Dockerfile", paths), [{ file: "Dockerfile", kind: "exact" }]);
  assert.deepEqual(matchLiteralPath("src/auth/utils.ts", paths), [{ file: "src/auth/utils.ts", kind: "exact" }]);
  assert.deepEqual(matchLiteralPath("auth/utils.ts", paths), [{ file: "src/auth/utils.ts", kind: "suffix" }]);
  assert.deepEqual(matchLiteralPath("utils.ts", paths), []);
});

test("matchLiteralPath prioritizes a case-sensitive exact match", () => {
  const paths = ["src/foo.ts", "src/Foo.ts"];
  assert.deepEqual(matchLiteralPath("src/Foo.ts", paths), [{ file: "src/Foo.ts", kind: "exact" }]);
  assert.deepEqual(matchLiteralPath("src/foo.ts", paths), [{ file: "src/foo.ts", kind: "exact" }]);
});

test("ask() short-circuits a literal filename to provider literal-path", async () => {
  const repo = literalWorkspace();
  const res = await ask(repo, "capn-cli", "capn", ".gitignore");
  assert.equal(res.status, "hit");
  assert.equal(res.provider, "literal-path");
  assert.ok(typeof res.result === "string" && res.result.includes(".gitignore"));
});