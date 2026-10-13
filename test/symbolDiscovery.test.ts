import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSymbolsInFile } from "../src/astExtractor.js";
import { anchorForRange, normalizeRange } from "../src/paths.js";
import { McpServer } from "../src/mcp/server.js";


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
  fs.writeFileSync(path.join(repo, "unsupported.cs"), "class Program { static void Main() {} }\n", "utf8");
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

    await assert.rejects(() => discoverSymbolsInFile(repo, "../sample.ts"), (error: any) => error.code === "INVALID_PATH");
    await assert.rejects(() => discoverSymbolsInFile(repo, "notes.txt"), (error: any) => error.code === "UNSUPPORTED_LANGUAGE");
    await assert.rejects(() => discoverSymbolsInFile(repo, "unsupported.cs"), (error: any) => error.code === "UNSUPPORTED_LANGUAGE");
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




