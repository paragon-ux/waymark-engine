import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { McpServer } from "../src/mcp/server.js";
import { resolveCodedbCommand, runJson } from "../src/codedbAdapter.js";
import type { CallGraphHopNode } from "../src/types.js";
import { initMemoryStoreSync } from "./capnContract.js";

function setupRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-qualified-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "daemon.ts"),
    [
      "export class Daemon {",
      "  start(): number {",
      "    return boot();",
      "  }",
      "}",
      "export function boot(): number {",
      "  return 1;",
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "app.ts"),
    [
      'import { Daemon } from "./daemon";',
      "export function launch(d: Daemon): number {",
      "  return d.start();",
      "}",
      "export const tools = {",
      "  run: () => {",
      "    return launch(new Daemon());",
      "  },",
      "};",
      "launch(new Daemon());",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "test", "app.test.ts"),
    ['import { boot } from "../src/daemon";', 'test("boots", () => {', "  boot();", "});", ""].join("\n"),
    "utf8"
  );
  initMemoryStoreSync(repo);
  return repo;
}

/** The resolved codedb emits `qualified`/`kind` (codedb-core after 2.0.2). */
async function codedbHasQualifiedNodes(repo: string): Promise<boolean> {
  const run = await runJson(repo, resolveCodedbCommand(), ["callers", "boot", "--json"]);
  const results = (run.payload?.results ?? []) as Array<{ qualified?: string }>;
  return results.some((r) => r.qualified !== undefined);
}

async function ask(server: McpServer, id: number, args: Record<string, unknown>): Promise<any> {
  const res = await server.handleMessage(
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "waymark_ask", arguments: args } })
  );
  const text = JSON.parse(res ?? "{}").result?.content?.[0]?.text ?? "";
  return args.plain ? text : JSON.parse(text || "{}");
}

const brief = (n: CallGraphHopNode) => `${n.kind} ${n.name} ${n.path}:${n.line}`;

test("Call graph: hops follow qualified names, and module nodes are labelled callers", async (t) => {
  const repo = setupRepo();
  if (!(await codedbHasQualifiedNodes(repo))) {
    t.skip("the resolved codedb predates qualified call-graph nodes; set WAYMARK_CODEDB_EXECUTABLE to a newer build");
    return;
  }
  const server = new McpServer({ root: repo });

  const body = await ask(server, 1, { question: "Who calls boot?", depth: 3, direction: "callers", root: repo });
  assert.equal(body.status, "hit");
  const level1: CallGraphHopNode[] = body.result.callers;
  assert.deepEqual(level1.map(brief).sort(), ["method Daemon.start src/daemon.ts:2", "module <module> test/app.test.ts:1"]);

  // The qualified name is the next hop's query: `Daemon.start` resolves even
  // though codedb would need it qualified to tell it from other `start`s.
  const start = level1.find((n) => n.name === "Daemon.start")!;
  assert.deepEqual(start.callers!.map(brief), ["function launch src/app.ts:2"]);
  const launch = start.callers![0]!;
  assert.deepEqual(launch.callers!.map(brief).sort(), ["method tools.run src/app.ts:6", "module <module> src/app.ts:1"]);

  // Traversal never hops from a module node.
  const testModule = level1.find((n) => n.kind === "module")!;
  assert.equal(testModule.callers, undefined);

  const noTests = await ask(server, 2, { question: "Who calls boot?", depth: 1, direction: "callers", exclude_tests: true, root: repo });
  assert.deepEqual((noTests.result.callers as CallGraphHopNode[]).map(brief), ["method Daemon.start src/daemon.ts:2"]);

  const plain = await ask(server, 3, { question: "Who calls boot?", depth: 3, direction: "callers", plain: true, root: repo });
  assert.match(plain, /- Daemon\.start \[method\] \(src\/daemon\.ts:2\)/);
  assert.match(plain, /- <module> \[module\] \(test\/app\.test\.ts:1\)/);
  assert.match(plain, /- tools\.run \[method\] \(src\/app\.ts:6\)/);
  assert.match(plain, /- launch \(src\/app\.ts:2\)/);
});
