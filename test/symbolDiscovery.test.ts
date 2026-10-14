import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSymbolsInFile, SUPPORTED_STRUCTURED_LANGUAGES } from "../src/astExtractor.js";
import { anchorForRange, normalizeRange } from "../src/paths.js";
import { McpServer } from "../src/mcp/server.js";
import type { AskMissResult } from "../src/types.js";


function setupRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-symbol-discovery-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["config", "user.name", "Waymark Test"], { cwd: repo, windowsHide: true });
  execFileSync("git", ["config", "user.email", "waymark-test@example.com"], { cwd: repo, windowsHide: true });
  fs.writeFileSync(path.join(repo, "sample.ts"), [
    "export interface User { id: string; }",
    "export type UserId = string;",
    "export class Service {",
    "  authenticate(user: User) { return user.id; }",
    "}",
    "export function createService() { return new Service(); }",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "sample.py"), [
    "class Greeter:",
    "    def hello(self):",
    "        return 'hi'",
    "",
    "def build():",
    "    return Greeter()",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "hook.mjs"), [
    "export class GuardRunner {",
    "  verify(cmd) {",
    "    const localNoise = 42;",
    "    return localNoise;",
    "  }",
    "}",
    "export function resolveRtkBinary() { return 'rtk'; }",
    "export const checkHealth = () => true;",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "module.mts"), [
    "export interface ModuleSpec { name: string; }",
    "export function loadModuleSpec(): ModuleSpec { return { name: 'core' }; }",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "sample.cs"), "class Program { static void Main() {} }\n", "utf8");
  fs.writeFileSync(path.join(repo, "unsupported.dart"), "void main() {}\n", "utf8");
  fs.writeFileSync(path.join(repo, "broken.ts"), "export function broken( {\n", "utf8");
  fs.writeFileSync(path.join(repo, "notes.txt"), "not source\n", "utf8");
  fs.writeFileSync(path.join(repo, "large.ts"), Buffer.alloc(1024 * 1024 + 1, "x"));
  fs.writeFileSync(path.join(repo, "doc.md"), [
    "# Documentation Title",
    "Some intro text.",
    "## Section One",
    "Content of section 1.",
    "| col1 | col2 |",
    "| --- | --- |",
    "| val1 | val2 |",
    "## Section Two",
    "Content of section 2.",
    "### Subsection A",
    "Nested text.",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "config.json"), JSON.stringify({
    name: "fixture-app",
    version: "1.0.0",
    scripts: {
      build: "tsc",
      test: "node --test",
    },
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(repo, "settings.toml"), [
    "[server]",
    "port = 8080",
    "host = \"127.0.0.1\"",
    "",
    "[[plugins]]",
    "name = \"logger\"",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "pipeline.yml"), [
    "name: CI Pipeline",
    "on: push",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "script.sh"), [
    "#!/usr/bin/env bash",
    "APP_ENV=\"test\"",
    "function run_build() {",
    "  echo \"building\"",
    "}",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(repo, "empty.md"), "", "utf8");
  fs.writeFileSync(path.join(repo, "empty.json"), "{}", "utf8");
  execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, windowsHide: true });
  return repo;
}

function cleanRepo(repo: string): void {
  try {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // ignore
  }
}

async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = await server.handleMessage(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  }));
  assert.ok(raw);
  const response = JSON.parse(raw);
  return JSON.parse(response.result.content[0].text) as Record<string, unknown>;
}

test("Waymark structured discovery has one normalized result across direct, MCP, and CLI paths", async () => {
  const repo = setupRepo();
  try {
    const direct = await discoverSymbolsInFile(repo, "sample.ts");
    assert.equal(direct.language, "typescript");
    assert.deepEqual(direct.symbols.map((symbol) => symbol.name), ["User", "UserId", "Service", "authenticate", "createService"]);
    assert.equal(direct.symbols.find((symbol) => symbol.name === "authenticate")?.kind, "method");
    const createService = direct.symbols.find((symbol) => symbol.name === "createService");
    assert.deepEqual(createService?.start, { line: 6, column: 7 });
    assert.equal(createService?.end.line, 6);
    assert.ok((createService?.end.column ?? 0) > (createService?.start.column ?? 0));

    const mcp = await callTool(new McpServer(), "waymark_discover_symbols", { path: "sample.ts", root: repo });
    assert.deepEqual(mcp, direct);

    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
    const cliResult = JSON.parse(execFileSync(process.execPath, [cli, "discover-symbols", "--path", "sample.ts"], {
      cwd: repo,
      windowsHide: true,
      encoding: "utf8",
    })) as Record<string, unknown>;
    assert.deepEqual(cliResult, direct);
  } finally {
    cleanRepo(repo);
  }
});

test("Waymark structured discovery supports Python, JavaScript (.mjs/.js), TypeScript (.mts), and fails closed at parser boundaries", async () => {
  const repo = setupRepo();
  try {
    const python = await discoverSymbolsInFile(repo, "sample.py");
    assert.equal(python.language, "python");
    assert.equal(python.symbols.find((symbol) => symbol.name === "Greeter")?.kind, "class");
    assert.equal(python.symbols.find((symbol) => symbol.name === "hello")?.kind, "method");
    assert.equal(python.symbols.find((symbol) => symbol.name === "build")?.kind, "function");

    const mjs = await discoverSymbolsInFile(repo, "hook.mjs");
    assert.equal(mjs.language, "javascript");
    assert.deepEqual(mjs.symbols.map((s) => `${s.name}:${s.kind}`), [
      "GuardRunner:class",
      "verify:method",
      "resolveRtkBinary:function",
      "checkHealth:function",
    ]);

    const mts = await discoverSymbolsInFile(repo, "module.mts");
    assert.equal(mts.language, "typescript");
    assert.deepEqual(mts.symbols.map((s) => `${s.name}:${s.kind}`), [
      "ModuleSpec:interface",
      "loadModuleSpec:function",
    ]);

    const cs = await discoverSymbolsInFile(repo, "sample.cs");
    assert.equal(cs.language, "csharp");
    assert.deepEqual(cs.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Program:class",
      "Main:method",
    ]);

    await assert.rejects(() => discoverSymbolsInFile(repo, "../sample.ts"), (error: any) => error.code === "INVALID_PATH");
    await assert.rejects(() => discoverSymbolsInFile(repo, "notes.txt"), (error: any) => error.code === "UNSUPPORTED_LANGUAGE");
    await assert.rejects(() => discoverSymbolsInFile(repo, "unsupported.dart"), (error: any) => error.code === "UNSUPPORTED_LANGUAGE");
    await assert.rejects(() => discoverSymbolsInFile(repo, "broken.ts"), (error: any) => error.code === "PARSE_ERROR");
    await assert.rejects(() => discoverSymbolsInFile(repo, "large.ts"), (error: any) => error.code === "FILE_TOO_LARGE");
  } finally {
    cleanRepo(repo);
  }
});

test("anchorForRange accepts flexible line range formats seamlessly", () => {
  const repo = setupRepo();
  try {
    const a1 = anchorForRange(repo, "sample.ts", { start: 1, end: 2 });
    assert.ok(a1.normalizedSpanHash);

    const a2 = anchorForRange(repo, "sample.ts", { startLine: 1, endLine: 2 });
    assert.equal(a2.normalizedSpanHash, a1.normalizedSpanHash);

    const a3 = anchorForRange(repo, "sample.ts", { start: { line: 1 }, end: { line: 2 } });
    assert.equal(a3.normalizedSpanHash, a1.normalizedSpanHash);
  } finally {
    cleanRepo(repo);
  }
});

test("Bimodal symbol discovery: auto-relativizes absolute path within repository", async () => {
  const repo = setupRepo();
  try {
    const absPath = path.join(repo, "sample.ts");
    const res = await discoverSymbolsInFile(repo, absPath);
    assert.equal(res.path, "sample.ts");
    assert.equal(res.symbols.length, 5);

    // MCP call with absolute path
    const mcp = await callTool(new McpServer(), "waymark_discover_symbols", { path: absPath, root: repo });
    assert.equal(mcp.path, "sample.ts");
  } finally {
    cleanRepo(repo);
  }
});

test("Bimodal symbol discovery: filters single-file symbols by query", async () => {
  const repo = setupRepo();
  try {
    const filtered = await discoverSymbolsInFile(repo, "sample.ts", undefined, "authenticate");
    assert.equal(filtered.symbols.length, 1);
    assert.equal(filtered.symbols[0]?.name, "authenticate");

    // MCP call with path and query
    const mcp = await callTool(new McpServer(), "waymark_discover_symbols", { path: "sample.ts", query: "authenticate", root: repo });
    assert.equal((mcp.symbols as any[]).length, 1);
    assert.equal((mcp.symbols as any[])[0].name, "authenticate");
  } finally {
    cleanRepo(repo);
  }
});

test("Bimodal symbol discovery: repo-wide symbol search when path omitted", async () => {
  const repo = setupRepo();
  try {
    const server = new McpServer();
    const raw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "waymark_discover_symbols", arguments: { query: "Greeter", root: repo } },
    }));
    assert.ok(raw);
    const resp = JSON.parse(raw);
    const result = JSON.parse(resp.result.content[0].text);
    assert.equal(result.tool, "symbol");
    assert.equal(result.query, "Greeter");
  } finally {
    cleanRepo(repo);
  }
});

test("Bimodal symbol discovery: plain text output", async () => {
  const repo = setupRepo();
  try {
    const server = new McpServer();
    const raw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "waymark_discover_symbols", arguments: { path: "sample.ts", plain: true, root: repo } },
    }));
    assert.ok(raw);
    const resp = JSON.parse(raw);
    const text = resp.result.content[0].text;
    assert.match(text, /\[symbols: sample\.ts\] \(5 symbols\)/);
    assert.match(text, /authenticate: method L4/);
  } finally {
    cleanRepo(repo);
  }
});

test("Edge Cases: escaping absolute paths, 0-match query filtering, and empty symbol results", async () => {
  const repo = setupRepo();
  try {
    const server = new McpServer();

    // 1. Escaping absolute path throws INVALID_PATH
    const outsidePath = path.resolve(repo, "..", "outside.ts");
    await assert.rejects(
      () => discoverSymbolsInFile(repo, outsidePath),
      (err: any) => err.code === "INVALID_PATH"
    );

    // 2. Both path and query omitted throws MISSING_ARGUMENT
    const missingRes = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "waymark_discover_symbols", arguments: { root: repo } },
    }));
    const missingBody = JSON.parse(JSON.parse(missingRes ?? "{}").result?.content?.[0]?.text ?? "{}");
    assert.equal(missingBody.ok, false);
    assert.equal(missingBody.code, "MISSING_ARGUMENT");

    // 3. Mode A-Filtered with query matching 0 symbols
    const zeroFilter = await discoverSymbolsInFile(repo, "sample.ts", undefined, "nonExistentFooBar");
    assert.equal(zeroFilter.symbols.length, 0);

    // 4. Mode B repo-wide plain text with 0 matches
    const zeroRepoPlain = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "waymark_discover_symbols", arguments: { query: "completelyNonExistentZzz", plain: true, root: repo } },
    }));
    const zeroRepoText = JSON.parse(zeroRepoPlain ?? "{}").result?.content?.[0]?.text ?? "";
    assert.match(zeroRepoText, /\[symbols: 'completelyNonExistentZzz'\] \(0 matches\)/);

    // 5. Backslash path on Windows within repo
    const backslashPath = `${repo}\\sample.ts`;
    const backslashRes = await discoverSymbolsInFile(repo, backslashPath);
    assert.equal(backslashRes.path, "sample.ts");
    assert.equal(backslashRes.symbols.length, 5);
  } finally {
    cleanRepo(repo);
  }
});

test("Waymark structured discovery extracts symbols for Markdown, JSON, TOML, YAML, and Bash", async () => {
  const repo = setupRepo();
  try {
    // 1. Markdown
    const md = await discoverSymbolsInFile(repo, "doc.md");
    assert.equal(md.language, "markdown");
    assert.ok(md.symbols.some((s) => s.name === "# Documentation Title" && s.kind === "section"));
    assert.ok(md.symbols.some((s) => s.name === "## Section One" && s.kind === "section" && s.start.line === 3));
    assert.ok(md.symbols.some((s) => s.kind === "table"));

    // 2. JSON
    const json = await discoverSymbolsInFile(repo, "config.json");
    assert.equal(json.language, "json");
    assert.ok(json.symbols.some((s) => s.name === "name" && s.kind === "config_block"));
    assert.ok(json.symbols.some((s) => s.name === "scripts.build" && s.kind === "config_block"));
    assert.ok(json.symbols.some((s) => s.name === "scripts.test" && s.kind === "config_block"));

    // 3. TOML
    const toml = await discoverSymbolsInFile(repo, "settings.toml");
    assert.equal(toml.language, "toml");
    assert.ok(toml.symbols.some((s) => s.name === "[server]" && s.kind === "config_block"));
    assert.ok(toml.symbols.some((s) => s.name === "[[plugins]]" && s.kind === "config_block"));
    assert.ok(toml.symbols.some((s) => s.name === "server.port"));

    // 4. YAML
    const yaml = await discoverSymbolsInFile(repo, "pipeline.yml");
    assert.equal(yaml.language, "yaml");
    assert.ok(yaml.symbols.some((s) => s.name === "name" && s.kind === "config_block"));
    assert.ok(yaml.symbols.some((s) => s.name === "jobs.build" && s.kind === "config_block"));

    // 5. Bash
    const bash = await discoverSymbolsInFile(repo, "script.sh");
    assert.equal(bash.language, "bash");
    assert.ok(bash.symbols.some((s) => s.name === "APP_ENV" && s.kind === "variable"));
    assert.ok(bash.symbols.some((s) => s.name === "run_build" && s.kind === "function"));
  } finally {
    cleanRepo(repo);
  }
});

test("waymark_ask outline mode returns structured coordinate map without reading file content", async () => {
  const repo = setupRepo();
  try {
    const server = new McpServer();
    const raw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "waymark_ask", arguments: { path: "doc.md", outline: true, root: repo } },
    }));
    assert.ok(raw);
    const resp = JSON.parse(raw);
    const result = JSON.parse(resp.result.content[0].text);
    assert.equal(result.ok, true);
    assert.equal(result.language, "markdown");
    assert.ok(result.symbols.length >= 3);

    // Plain text format
    const plainRaw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "waymark_ask", arguments: { path: "doc.md", outline: true, plain: true, root: repo } },
    }));
    assert.ok(plainRaw);
    const plainResp = JSON.parse(plainRaw);
    const plainText = plainResp.result.content[0].text;
    assert.match(plainText, /\[symbols: doc\.md\]/);
    assert.match(plainText, /## Section One: section L3/);

    // MCP question used as query filter in outline mode
    const filteredRaw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "waymark_ask", arguments: { path: "doc.md", outline: true, question: "Section Two", root: repo } },
    }));
    assert.ok(filteredRaw);
    const filteredResp = JSON.parse(filteredRaw);
    const filteredResult = JSON.parse(filteredResp.result.content[0].text);
    assert.equal(filteredResult.symbols.length, 1);
    assert.equal(filteredResult.symbols[0].name, "## Section Two");
  } finally {
    cleanRepo(repo);
  }
});

test("Library ask() and CLI ask --outline support plain text and query filtering cleanly", async () => {
  const repo = setupRepo();
  try {
    const { ask } = await import("../src/capnAdapter.js");
    const { renderPlainText } = await import("../src/renderPlainText.js");

    // 1. Library ask with outline: true produces clean plain text via renderPlainText
    const libRes = await ask(repo, "none", "", "", { path: "doc.md", outline: true });
    assert.equal(libRes.status, "hit");
    const plainLib = renderPlainText(libRes);
    assert.match(plainLib, /\[symbols: doc\.md\]/);
    assert.ok(!plainLib.includes("[object Object]"));

    // 2. 0-byte file handling
    const emptyMd = await discoverSymbolsInFile(repo, "empty.md");
    assert.equal(emptyMd.symbols.length, 0);

    const emptyJson = await discoverSymbolsInFile(repo, "empty.json");
    assert.equal(emptyJson.symbols.length, 0);

    // 3. CLI ask with positional query and --outline --plain
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
    const cliOutput = execFileSync(process.execPath, [cli, "ask", "build", "--path", "config.json", "--outline", "--plain"], {
      cwd: repo,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.match(cliOutput, /scripts\.build: config_block/);
    assert.ok(!cliOutput.includes("version: config_block"));

    // 4. Markdown line-order invariant (table should appear between section one and section two)
    const mdRes = await discoverSymbolsInFile(repo, "doc.md");
    for (let i = 1; i < mdRes.symbols.length; i++) {
      assert.ok(mdRes.symbols[i]!.start.line >= mdRes.symbols[i - 1]!.start.line, "Symbols must be strictly ordered by line");
    }
  } finally {
    cleanRepo(repo);
  }
});

test("JSONC/JSON5 clean rejection: rejects dialect extensions cleanly with UNSUPPORTED_LANGUAGE", async () => {
  const repo = setupRepo();
  try {
    fs.writeFileSync(path.join(repo, "sample.jsonc"), "{\n // comment\n \"name\": \"app\"\n}\n", "utf8");
    fs.writeFileSync(path.join(repo, "sample.json5"), "{\n unquoted: \"value\"\n}\n", "utf8");

    await assert.rejects(
      () => discoverSymbolsInFile(repo, "sample.jsonc"),
      (err: any) => err.code === "UNSUPPORTED_LANGUAGE"
    );
    await assert.rejects(
      () => discoverSymbolsInFile(repo, "sample.json5"),
      (err: any) => err.code === "UNSUPPORTED_LANGUAGE"
    );
  } finally {
    cleanRepo(repo);
  }
});

test("JSON: decodes escaped and unicode property keys for accurate symbol querying", async () => {
  const repo = setupRepo();
  try {
    const jsonContent = [
      "{",
      '  "build\\u005fscript": "tsc",',
      '  "caf\\u00e9": "coffee",',
      '  "key\\"escaped": true,',
      '  "nested": {',
      '    "item\\u005fid": 42',
      "  }",
      "}",
    ].join("\n");
    fs.writeFileSync(path.join(repo, "escaped.json"), jsonContent, "utf8");

    const res = await discoverSymbolsInFile(repo, "escaped.json");
    const names = res.symbols.map((s) => s.name);
    assert.ok(names.includes("build_script"), "Key \\u005f must decode to underscore");
    assert.ok(names.includes("café"), "Unicode \\u00e9 must decode to é");
    assert.ok(names.includes('key"escaped'));
    assert.ok(names.includes("nested.item_id"));

    // Query filtering matches decoded name
    const filtered = await discoverSymbolsInFile(repo, "escaped.json", undefined, "build_script");
    assert.equal(filtered.symbols.length, 1);
    assert.equal(filtered.symbols[0]!.name, "build_script");
  } finally {
    cleanRepo(repo);
  }
});

test("TOML: array-of-tables [[plugins]] emits headers and nested pairs with distinct coordinates and decoded headers", async () => {
  const repo = setupRepo();
  try {
    const tomlContent = [
      '["server.main"]',
      "port = 8080",
      "",
      "[[plugins]]",
      'name = "logger"',
      'level = "info"',
      "",
      "[[plugins]]",
      'name = "metrics"',
      "port = 9090",
    ].join("\n");
    fs.writeFileSync(path.join(repo, "plugins.toml"), tomlContent, "utf8");

    const res = await discoverSymbolsInFile(repo, "plugins.toml");
    const names = res.symbols.map((s) => s.name);
    assert.ok(names.includes("[server.main]"));
    assert.ok(names.includes("server.main.port"));
    assert.ok(names.includes("[[plugins]]"));
    assert.ok(names.includes("plugins.name"));
    assert.ok(names.includes("plugins.level"));
    assert.ok(names.includes("plugins.port"));

    // Verify multiple entries have distinct coordinates
    const pluginNameSymbols = res.symbols.filter((s) => s.name === "plugins.name");
    assert.equal(pluginNameSymbols.length, 2);
    assert.equal(pluginNameSymbols[0]!.start.line, 5);
    assert.equal(pluginNameSymbols[1]!.start.line, 9);

    // Filter queries
    const filteredLevel = await discoverSymbolsInFile(repo, "plugins.toml", undefined, "plugins.level");
    assert.equal(filteredLevel.symbols.length, 1);
    assert.equal(filteredLevel.symbols[0]!.start.line, 6);

    const filteredNames = await discoverSymbolsInFile(repo, "plugins.toml", undefined, "plugins.name");
    assert.equal(filteredNames.symbols.length, 2);
    assert.equal(filteredNames.symbols[0]!.start.line, 5);
    assert.equal(filteredNames.symbols[1]!.start.line, 9);
  } finally {
    cleanRepo(repo);
  }
});

test("YAML: handles root sequence, multi-document files, flow mapping, and scalars cleanly", async () => {
  const repo = setupRepo();
  try {
    // 1. Root sequence of mappings
    const seqContent = [
      "- name: service-auth",
      "  port: 8081",
      "- name: service-billing",
      "  port: 8082",
    ].join("\n");
    fs.writeFileSync(path.join(repo, "services.yml"), seqContent, "utf8");

    const seqRes = await discoverSymbolsInFile(repo, "services.yml");
    const seqNames = seqRes.symbols.map((s) => s.name);
    assert.ok(seqNames.includes("[0]"));
    assert.ok(seqNames.includes("[0].name"));
    assert.ok(seqNames.includes("[0].port"));
    assert.ok(seqNames.includes("[1]"));
    assert.ok(seqNames.includes("[1].name"));
    assert.ok(seqNames.includes("[1].port"));

    const nameOccurrences = seqRes.symbols.filter((s) => s.name.endsWith(".name"));
    assert.equal(nameOccurrences.length, 2);
    assert.equal(nameOccurrences[0]!.start.line, 1);
    assert.equal(nameOccurrences[1]!.start.line, 3);

    // 2. Multi-document YAML
    const multiDoc = [
      "---",
      "kind: Deployment",
      "metadata:",
      "  name: web-app",
      "---",
      "kind: Service",
      "metadata:",
      "  name: web-svc",
    ].join("\n");
    fs.writeFileSync(path.join(repo, "k8s.yml"), multiDoc, "utf8");

    const multiRes = await discoverSymbolsInFile(repo, "k8s.yml");
    const multiNames = multiRes.symbols.map((s) => s.name);
    assert.ok(multiNames.includes("doc[0].kind"));
    assert.ok(multiNames.includes("doc[0].metadata.name"));
    assert.ok(multiNames.includes("doc[1].kind"));
    assert.ok(multiNames.includes("doc[1].metadata.name"));

    // 3. Flow mapping
    const flowDoc = "{ host: 'localhost', port: 3000 }\n";
    fs.writeFileSync(path.join(repo, "flow.yml"), flowDoc, "utf8");
    const flowRes = await discoverSymbolsInFile(repo, "flow.yml");
    assert.ok(flowRes.symbols.some((s) => s.name === "host"));
    assert.ok(flowRes.symbols.some((s) => s.name === "port"));

    // 4. Root scalar does not crash
    fs.writeFileSync(path.join(repo, "scalar.yml"), "just-a-scalar-string\n", "utf8");
    const scalarRes = await discoverSymbolsInFile(repo, "scalar.yml");
    assert.equal(scalarRes.symbols.length, 0);
  } finally {
    cleanRepo(repo);
  }
});

test("Outline status economics: returns hit on matching symbols and clean miss on 0 symbols or filtered misses across library, MCP, and CLI", async () => {
  const repo = setupRepo();
  try {
    const { ask } = await import("../src/capnAdapter.js");
    const server = new McpServer();

    // 1. Library: Hit on existing file with symbols
    const hitRes = await ask(repo, "none", "", "", { path: "sample.ts", outline: true });
    assert.equal(hitRes.status, "hit");
    assert.equal(hitRes.confidence, "exact");

    // 2. Library: Miss on filter query returning 0 symbols
    const filterMissRes = (await ask(repo, "none", "", "nonExistentSymbolName", { path: "sample.ts", outline: true })) as AskMissResult;
    assert.equal(filterMissRes.status, "miss");
    assert.equal(filterMissRes.missCode, "SYMBOL_NOT_FOUND");
    assert.match(filterMissRes.reason, /No matching symbols found/);

    // 3. Library: Miss on empty file with 0 symbols
    const emptyRes = (await ask(repo, "none", "", "", { path: "empty.md", outline: true })) as AskMissResult;
    assert.equal(emptyRes.status, "miss");
    assert.equal(emptyRes.missCode, "SYMBOL_NOT_FOUND");

    // 4. MCP: Hit on existing file returns symbols payload
    const mcpHitRaw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "waymark_ask", arguments: { path: "sample.ts", outline: true, root: repo } },
    }));
    const mcpHit = JSON.parse(JSON.parse(mcpHitRaw ?? "{}").result.content[0].text);
    assert.equal(mcpHit.ok, true);
    assert.ok(mcpHit.symbols.length > 0);

    // 5. MCP: Miss on non-matching query returns missCode: SYMBOL_NOT_FOUND
    const mcpMissRaw = await server.handleMessage(JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "waymark_ask", arguments: { path: "sample.ts", outline: true, question: "nonExistentFooBar", root: repo } },
    }));
    const mcpMiss = JSON.parse(JSON.parse(mcpMissRaw ?? "{}").result.content[0].text);
    assert.equal(mcpMiss.status, "miss");
    assert.equal(mcpMiss.missCode, "SYMBOL_NOT_FOUND");

    // 6. CLI: Miss on non-matching query renders [miss] output
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
    const cliMissOutput = execFileSync(process.execPath, [cli, "ask", "nonExistentZzz", "--path", "sample.ts", "--outline", "--plain"], {
      cwd: repo,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.match(cliMissOutput, /\[miss\] No matching symbols found/);
  } finally {
    cleanRepo(repo);
  }
});

test("CLI: --help output documents --outline, --path, and all supported languages from canonical source", () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
  const helpOutput = execFileSync(process.execPath, [cli, "--help"], {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: "utf8",
  });

  assert.match(helpOutput, /--outline/);
  assert.match(helpOutput, /--path/);
  for (const lang of SUPPORTED_STRUCTURED_LANGUAGES) {
    assert.match(helpOutput, new RegExp(lang, "i"), `CLI --help must document supported language: ${lang}`);
  }
});

test("Snapshot tests: full symbol-list snapshots for Markdown, JSON, TOML, YAML, and Bash fixtures", async () => {
  const repo = setupRepo();
  try {
    // 1. Markdown full snapshot
    const md = await discoverSymbolsInFile(repo, "doc.md");
    assert.deepEqual(
      md.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.start.line })),
      [
        { name: "# Documentation Title", kind: "section", line: 1 },
        { name: "## Section One", kind: "section", line: 3 },
        { name: "Table (L5-L7)", kind: "table", line: 5 },
        { name: "## Section Two", kind: "section", line: 8 },
        { name: "### Subsection A", kind: "section", line: 10 },
      ]
    );

    // 2. JSON full snapshot
    const json = await discoverSymbolsInFile(repo, "config.json");
    assert.deepEqual(
      json.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.start.line })),
      [
        { name: "name", kind: "config_block", line: 2 },
        { name: "version", kind: "config_block", line: 3 },
        { name: "scripts", kind: "config_block", line: 4 },
        { name: "scripts.build", kind: "config_block", line: 5 },
        { name: "scripts.test", kind: "config_block", line: 6 },
      ]
    );

    // 3. TOML full snapshot
    const toml = await discoverSymbolsInFile(repo, "settings.toml");
    assert.deepEqual(
      toml.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.start.line })),
      [
        { name: "[server]", kind: "config_block", line: 1 },
        { name: "server.port", kind: "config_block", line: 2 },
        { name: "server.host", kind: "config_block", line: 3 },
        { name: "[[plugins]]", kind: "config_block", line: 5 },
        { name: "plugins.name", kind: "config_block", line: 6 },
      ]
    );

    // 4. YAML full snapshot
    const yaml = await discoverSymbolsInFile(repo, "pipeline.yml");
    assert.deepEqual(
      yaml.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.start.line })),
      [
        { name: "name", kind: "config_block", line: 1 },
        { name: "on", kind: "config_block", line: 2 },
        { name: "jobs", kind: "config_block", line: 3 },
        { name: "jobs.build", kind: "config_block", line: 4 },
        { name: "jobs.build.runs-on", kind: "config_block", line: 5 },
      ]
    );

    // 5. Bash full snapshot
    const bash = await discoverSymbolsInFile(repo, "script.sh");
    assert.deepEqual(
      bash.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.start.line })),
      [
        { name: "APP_ENV", kind: "variable", line: 2 },
        { name: "run_build", kind: "function", line: 3 },
      ]
    );
  } finally {
    cleanRepo(repo);
  }
});

test("Waymark structured discovery: Tier 1 in-process AST extraction across 15 modern & upgraded languages (Groups 1 and 2)", async () => {
  const repo = setupRepo();
  try {
    // Group 1: Modern Languages
    // 1. C# (.cs)
    fs.writeFileSync(path.join(repo, "Service.cs"), [
      "namespace Enterprise {",
      "  interface IService {}",
      "  class Service : IService {",
      "    public int Count { get; set; }",
      "    public Service() {}",
      "    public void Execute() {}",
      "  }",
      "  record Data(int X);",
      "  enum Status { Ready }",
      "  struct Point { int X; }",
      "}",
    ].join("\n"), "utf8");
    const cs = await discoverSymbolsInFile(repo, "Service.cs");
    assert.equal(cs.language, "csharp");
    assert.deepEqual(cs.symbols.map((s) => `${s.name}:${s.kind}`), [
      "IService:interface",
      "Service:class",
      "Count:property",
      "Service:constructor",
      "Execute:method",
      "Data:record",
      "Status:enum",
      "Point:struct",
    ]);

    // 2. Scala (.scala)
    fs.writeFileSync(path.join(repo, "sample.scala"), [
      "trait BaseTrait {}",
      "class BaseClass {",
      "  def run(): Unit = {}",
      "}",
      "object BaseObj {",
      "  def main(): Unit = {}",
      "}",
    ].join("\n"), "utf8");
    const scala = await discoverSymbolsInFile(repo, "sample.scala");
    assert.equal(scala.language, "scala");
    assert.deepEqual(scala.symbols.map((s) => `${s.name}:${s.kind}`), [
      "BaseTrait:trait",
      "BaseClass:class",
      "run:method",
      "BaseObj:class",
      "main:method",
    ]);

    // 3. Lua (.lua)
    fs.writeFileSync(path.join(repo, "sample.lua"), [
      "function topFunc() end",
      "local function localFunc() end",
      "function MyObj:method() end",
    ].join("\n"), "utf8");
    const lua = await discoverSymbolsInFile(repo, "sample.lua");
    assert.equal(lua.language, "lua");
    assert.deepEqual(lua.symbols.map((s) => `${s.name}:${s.kind}`), [
      "topFunc:function",
      "localFunc:function",
      "MyObj:method:function",
    ]);

    // 4. Zig (.zig)
    fs.writeFileSync(path.join(repo, "sample.zig"), [
      "pub const Point = struct {",
      "  fn init() Point { return .{}; }",
      "};",
      "pub const Color = enum { Red, Blue };",
      "pub fn calculate() void {}",
    ].join("\n"), "utf8");
    const zig = await discoverSymbolsInFile(repo, "sample.zig");
    assert.equal(zig.language, "zig");
    assert.deepEqual(zig.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Point:struct",
      "init:method",
      "Color:enum",
      "calculate:function",
    ]);

    // 5. Elixir (.ex & .exs)
    fs.writeFileSync(path.join(repo, "sample.ex"), [
      "defmodule Greeter do",
      "  def hello(name) do",
      "    name",
      "  end",
      "  defp secret() do",
      "    42",
      "  end",
      "end",
    ].join("\n"), "utf8");
    const elixir = await discoverSymbolsInFile(repo, "sample.ex");
    assert.equal(elixir.language, "elixir");
    assert.deepEqual(elixir.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Greeter:class",
      "hello:method",
      "secret:method",
    ]);

    fs.writeFileSync(path.join(repo, "script.exs"), [
      "defmodule ScriptTask do",
      "  def run() do",
      "    :ok",
      "  end",
      "end",
    ].join("\n"), "utf8");
    const elixirScript = await discoverSymbolsInFile(repo, "script.exs");
    assert.equal(elixirScript.language, "elixir");
    assert.deepEqual(elixirScript.symbols.map((s) => `${s.name}:${s.kind}`), [
      "ScriptTask:class",
      "run:method",
    ]);

    // 6. Solidity (.sol)
    fs.writeFileSync(path.join(repo, "sample.sol"), [
      "contract Token {",
      "  constructor() {}",
      "  function transfer() public {}",
      "  modifier checkOwner() {}",
      "}",
      "interface IERC20 {}",
      "struct User { address a; }",
      "enum State { Active }",
    ].join("\n"), "utf8");
    const solidity = await discoverSymbolsInFile(repo, "sample.sol");
    assert.equal(solidity.language, "solidity");
    assert.deepEqual(solidity.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Token:contract",
      "constructor:constructor",
      "transfer:method",
      "checkOwner:method",
      "IERC20:interface",
      "User:struct",
      "State:enum",
    ]);

    // Group 2: Upgraded Languages (In-Process WASM)
    // 7. Rust (.rs)
    fs.writeFileSync(path.join(repo, "sample.rs"), [
      "struct Vector;",
      "enum Color { Red }",
      "trait Drawable { fn draw(&self); }",
      "impl Drawable for Vector {",
      "  fn draw(&self) {}",
      "}",
      "fn compute() {}",
      "type Distance = f64;",
    ].join("\n"), "utf8");
    const rust = await discoverSymbolsInFile(repo, "sample.rs");
    assert.equal(rust.language, "rust");
    assert.deepEqual(rust.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Vector:struct",
      "Color:enum",
      "Drawable:trait",
      "draw:method",
      "compute:function",
      "Distance:type",
    ]);

    // 8. Go (.go)
    fs.writeFileSync(path.join(repo, "sample.go"), [
      "package main",
      "type Handler interface {",
      "  Handle()",
      "}",
      "type Config struct {",
      "  Port int",
      "}",
      "type Status int",
      "func (c *Config) Validate() bool { return true }",
      "func NewConfig() *Config { return &Config{} }",
    ].join("\n"), "utf8");
    const go = await discoverSymbolsInFile(repo, "sample.go");
    assert.equal(go.language, "go");
    assert.deepEqual(go.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Handler:interface",
      "Config:struct",
      "Status:type",
      "Validate:method",
      "NewConfig:function",
    ]);

    // 9. Java (.java)
    fs.writeFileSync(path.join(repo, "sample.java"), [
      "public class Manager {",
      "  public Manager() {}",
      "  public void process() {}",
      "}",
      "public interface Worker {}",
      "public record Job(String name) {}",
      "public enum Level { HIGH }",
    ].join("\n"), "utf8");
    const java = await discoverSymbolsInFile(repo, "sample.java");
    assert.equal(java.language, "java");
    assert.deepEqual(java.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Manager:class",
      "Manager:constructor",
      "process:method",
      "Worker:interface",
      "Job:record",
      "Level:enum",
    ]);

    // 10. C (.c, .h)
    fs.writeFileSync(path.join(repo, "sample.c"), [
      "struct Node { int val; };",
      "enum Day { MON };",
      "int add(int a, int b) { return a + b; }",
    ].join("\n"), "utf8");
    const c = await discoverSymbolsInFile(repo, "sample.c");
    assert.equal(c.language, "c");
    assert.deepEqual(c.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Node:struct",
      "Day:enum",
      "add:function",
    ]);

    fs.writeFileSync(path.join(repo, "header.h"), [
      "struct Header { int id; };",
      "int get_id(void) { return 0; }",
    ].join("\n"), "utf8");
    const h = await discoverSymbolsInFile(repo, "header.h");
    assert.equal(h.language, "c");
    assert.deepEqual(h.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Header:struct",
      "get_id:function",
    ]);

    // 11. C++ (.cpp, .hpp, .cc, .cxx)
    fs.writeFileSync(path.join(repo, "sample.cpp"), [
      "class Engine {",
      "public:",
      "  Engine();",
      "  void start();",
      "};",
      "struct Option {};",
      "enum Mode { AUTO };",
      "void run() {}",
    ].join("\n"), "utf8");
    const cpp = await discoverSymbolsInFile(repo, "sample.cpp");
    assert.equal(cpp.language, "cpp");
    assert.deepEqual(cpp.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Engine:class",
      "Engine:constructor",
      "start:method",
      "Option:struct",
      "Mode:enum",
      "run:function",
    ]);

    fs.writeFileSync(path.join(repo, "engine.hpp"), "class Loader { public: Loader(); };\n", "utf8");
    const hpp = await discoverSymbolsInFile(repo, "engine.hpp");
    assert.equal(hpp.language, "cpp");
    assert.equal(hpp.symbols[0]?.name, "Loader");

    fs.writeFileSync(path.join(repo, "worker.cc"), "void execute() {}\n", "utf8");
    const cc = await discoverSymbolsInFile(repo, "worker.cc");
    assert.equal(cc.language, "cpp");
    assert.equal(cc.symbols[0]?.name, "execute");

    fs.writeFileSync(path.join(repo, "driver.cxx"), "void drive() {}\n", "utf8");
    const cxx = await discoverSymbolsInFile(repo, "driver.cxx");
    assert.equal(cxx.language, "cpp");
    assert.equal(cxx.symbols[0]?.name, "drive");

    // 12. Ruby (.rb)
    fs.writeFileSync(path.join(repo, "sample.rb"), [
      "module Tooling",
      "  class Parser",
      "    def parse",
      "    end",
      "    def self.version",
      "    end",
      "  end",
      "end",
    ].join("\n"), "utf8");
    const ruby = await discoverSymbolsInFile(repo, "sample.rb");
    assert.equal(ruby.language, "ruby");
    assert.deepEqual(ruby.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Tooling:class",
      "Parser:class",
      "parse:method",
      "version:method",
    ]);

    // 13. Swift (.swift)
    fs.writeFileSync(path.join(repo, "sample.swift"), [
      "class App {",
      "  init() {}",
      "  func launch() {}",
      "}",
      "protocol Launchable {}",
      "struct Point {}",
      "enum Direction {}",
    ].join("\n"), "utf8");
    const swift = await discoverSymbolsInFile(repo, "sample.swift");
    assert.equal(swift.language, "swift");
    assert.deepEqual(swift.symbols.map((s) => `${s.name}:${s.kind}`), [
      "App:class",
      "init:constructor",
      "launch:method",
      "Launchable:interface",
      "Point:struct",
      "Direction:enum",
    ]);

    // 14. Kotlin (.kt)
    fs.writeFileSync(path.join(repo, "sample.kt"), [
      "class Controller {",
      "  val name = \"demo\"",
      "  fun handle() {}",
      "}",
      "interface Service {}",
      "object Singleton {}",
      "enum class State { IDLE }",
    ].join("\n"), "utf8");
    const kotlin = await discoverSymbolsInFile(repo, "sample.kt");
    assert.equal(kotlin.language, "kotlin");
    assert.deepEqual(kotlin.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Controller:class",
      "name:property",
      "handle:method",
      "Service:interface",
      "Singleton:class",
      "State:enum",
    ]);

    // 15. PHP (.php)
    fs.writeFileSync(path.join(repo, "sample.php"), [
      "<?php",
      "class Server {",
      "  public function serve() {}",
      "}",
      "interface Handler {}",
      "trait Logging {}",
      "enum Stage { case DEV; }",
      "function start() {}",
    ].join("\n"), "utf8");
    const php = await discoverSymbolsInFile(repo, "sample.php");
    assert.equal(php.language, "php");
    assert.deepEqual(php.symbols.map((s) => `${s.name}:${s.kind}`), [
      "Server:class",
      "serve:method",
      "Handler:interface",
      "Logging:trait",
      "Stage:enum",
      "start:function",
    ]);
  } finally {
    cleanRepo(repo);
  }
});




