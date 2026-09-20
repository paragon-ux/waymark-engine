import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverSymbolsInFile } from "../src/astExtractor.js";
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
  fs.writeFileSync(path.join(repo, "broken.ts"), "export function broken( {\n", "utf8");
  fs.writeFileSync(path.join(repo, "notes.txt"), "not source\n", "utf8");
  fs.writeFileSync(path.join(repo, "large.ts"), Buffer.alloc(1024 * 1024 + 1, "x"));
  execFileSync("git", ["add", "."], { cwd: repo, windowsHide: true });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo, windowsHide: true });
  return repo;
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
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Waymark structured discovery supports Python and fails closed at parser boundaries", async () => {
  const repo = setupRepo();
  try {
    const python = await discoverSymbolsInFile(repo, "sample.py");
    assert.equal(python.language, "python");
    assert.equal(python.symbols.find((symbol) => symbol.name === "Greeter")?.kind, "class");
    assert.equal(python.symbols.find((symbol) => symbol.name === "hello")?.kind, "method");
    assert.equal(python.symbols.find((symbol) => symbol.name === "build")?.kind, "function");

    await assert.rejects(() => discoverSymbolsInFile(repo, "../sample.ts"), (error: any) => error.code === "INVALID_PATH");
    await assert.rejects(() => discoverSymbolsInFile(repo, "notes.txt"), (error: any) => error.code === "UNSUPPORTED_LANGUAGE");
    await assert.rejects(() => discoverSymbolsInFile(repo, "broken.ts"), (error: any) => error.code === "PARSE_ERROR");
    await assert.rejects(() => discoverSymbolsInFile(repo, "large.ts"), (error: any) => error.code === "FILE_TOO_LARGE");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
