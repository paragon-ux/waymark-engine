import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { McpServer } from "../src/mcp/server.js";
import { skipCodedb } from "./codedb.js";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

function setupRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-discovery-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "sample.ts"),
    "export function helloWorld(): string { return 'hello'; }\nexport function auditTrail(): string { return 'audit'; }\n",
    "utf8",
  );
  return repo;
}

interface CliResult {
  code: number;
  value: Record<string, unknown> | null;
}

function runCli(root: string, args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  let value: Record<string, unknown> | null = null;
  try {
    const lines = (result.stdout ?? "").trim().split(/\r?\n/);
    value = JSON.parse(lines[lines.length - 1] ?? "null") as Record<string, unknown>;
  } catch {
    value = null;
  }
  return { code: result.status ?? 1, value };
}

test("CLI ask routes structural questions to the codedb call graph", { skip: skipCodedb() }, () => {
  const repo = setupRepo();
  const result = runCli(repo, ["ask", "Where is function helloWorld declared?"]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.value?.provider, "codedb");
  assert.equal(result.value?.status, "hit");
  assert.match(String(result.value?.result), /helloWorld/);
});

test("CLI ask with profile none short-circuits deterministically", () => {
  const repo = setupRepo();
  const result = runCli(repo, ["ask", "--profile", "none", "Any question at all"]);
  assert.equal(result.code, 0);
  assert.equal(result.value?.provider, "none");
  assert.equal(result.value?.status, "miss");
});

test("CLI chart with profile none is a deterministic no-op", () => {
  const repo = setupRepo();
  const result = runCli(repo, [
    "chart",
    "--profile", "none",
    "--question", "What is the audit trail?",
    "--answer", "It is sample.ts",
    "--files", "src/sample.ts",
  ]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.value?.published, false);
  assert.equal(result.value?.adapter, "none");
});

test("MCP discovery server exposes exactly the discovery tools", async () => {
  const server = new McpServer();
  const response = await server.handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const parsed = JSON.parse(response ?? "{}") as { result?: { tools?: Array<{ name: string }> } };
  const names = (parsed.result?.tools ?? []).map((tool) => tool.name);
  assert.deepEqual(names.sort(), ["capn_ask", "capn_chart", "waymark_discover_symbols"]);
});

test("CLI init creates lexical Capn store with embedding false", () => {
  const repo = setupRepo();
  const result = runCli(repo, ["init"]);
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.value?.ok, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".capn", "config.json"), "utf8"));
  assert.equal(cfg.embedding, false);
});

