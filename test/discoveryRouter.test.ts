import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectRepoPaths, detectAstIntent, detectLiteralIntent, matchLiteralPath, extractCandidateTokens } from "../src/discoveryRouter.js";
import { queryStructural, resolveCodedbCommand } from "../src/codedbAdapter.js";
import { ask } from "../src/capnAdapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const waymarkRoot = path.resolve(__dirname, "../..");

function hasCodedb(): boolean {
  try {
    const cmd = resolveCodedbCommand("");
    execFileSync(cmd.file, [...cmd.prefix, "--version"], { windowsHide: true, timeout: 10_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const skipCodedb = hasCodedb() ? false : "codedb binary not available (set WAYMARK_CODEDB_EXECUTABLE)";

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

  // Literal root filenames must not be classified as AST structural bare identifiers (LEDGER-01)
  assert.equal(detectAstIntent("embed.go").requiresParser, false);
  assert.equal(detectAstIntent("package.json").requiresParser, false);
  assert.equal(detectAstIntent("Dockerfile").requiresParser, false);

  // Narrative questions with 'architecture' must not capture project topology tree (LEDGER-03)
  const iArchNarrative = detectAstIntent("Explain plugin architecture");
  assert.notEqual(iArchNarrative.tool, "get_architecture");
  const iArchTopological = detectAstIntent("Architecture");
  assert.equal(iArchTopological.tool, "get_architecture");
});

test("queryStructural answers trace_path and search_graph directly", { skip: skipCodedb }, async () => {
  const traceRes = await queryStructural({ requiresParser: true, tool: "trace_path", functionName: "capnChartArgs" }, waymarkRoot);
  assert.equal(traceRes.hit, true);
  assert.ok(traceRes.output.includes("publish"));

  const symbolRes = await queryStructural({ requiresParser: true, tool: "search_graph", query: "capnChartArgs" }, waymarkRoot);
  assert.equal(symbolRes.hit, true);
  assert.ok(symbolRes.output.includes("src/capnAdapter.ts"));
});

test("ask() automatically delegates AST queries to the codedb call graph", { skip: skipCodedb }, async () => {
  const hitRes = await ask(waymarkRoot, "capn-cli", "capn", "Who calls capnChartArgs?");
  assert.equal(hitRes.status, "hit");
  assert.equal(hitRes.provider, "codedb");
  assert.ok(typeof hitRes.result === "string" && hitRes.result.includes("publish"));

  const symbolRes = await ask(waymarkRoot, "capn-cli", "capn", "Where is function capnChartArgs declared?");
  assert.equal(symbolRes.status, "hit");
  assert.equal(symbolRes.provider, "codedb");
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
  assert.deepEqual(detectLiteralIntent("sample.ts"), { isLiteral: true, normalized: "sample.ts", isExplicitPath: false });
  assert.equal(detectLiteralIntent("src/auth/utils.ts").isLiteral, true);
  assert.equal(detectLiteralIntent("src/auth/utils.ts").isExplicitPath, true);
  assert.equal(detectLiteralIntent("./README.md").isExplicitPath, true);
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

  // Bare repeated basename must fail closed, explicit relative path must succeed (LEDGER-02)
  const multiReadme = ["README.md", "packages/grafana-ui/README.md"];
  assert.deepEqual(matchLiteralPath("README.md", multiReadme, false), []);
  assert.deepEqual(matchLiteralPath("./README.md", multiReadme, true), [{ file: "README.md", kind: "exact" }]);
});

test("matchLiteralPath prioritizes a case-sensitive exact match", () => {
  const paths = ["src/foo.ts", "src/Foo.ts"];
  assert.deepEqual(matchLiteralPath("src/Foo.ts", paths), [{ file: "src/Foo.ts", kind: "exact" }]);
  assert.deepEqual(matchLiteralPath("src/foo.ts", paths), [{ file: "src/foo.ts", kind: "exact" }]);
});

test("extractCandidateTokens preserves compound dotted qualified identifiers (LEDGER-09)", () => {
  const { candidateTokens, shape } = extractCandidateTokens("Where is EventStore.verifyChain declared?");
  assert.equal(shape, "identifier-like");
  assert.ok(candidateTokens.includes("EventStore.verifyChain"));
});

test("ask() short-circuits a literal filename to provider literal-path", async () => {
  const repo = literalWorkspace();
  const res = await ask(repo, "capn-cli", "capn", ".gitignore");
  assert.equal(res.status, "hit");
  assert.equal(res.provider, "literal-path");
  assert.ok(typeof res.result === "string" && res.result.includes(".gitignore"));
});
