import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { McpServer } from "../src/mcp/server.js";
import {
  getSemanticMapStatus,
  renderSemanticMapStatus,
  bootstrapSemanticMap,
  validateFacetBackingFiles,
  SEMANTIC_FACETS,
} from "../src/semanticMap.js";
import { WaymarkError } from "../src/types.js";
import { ask, publish } from "../src/capnAdapter.js";

const require = createRequire(import.meta.url);

function forkEntry(): string {
  const pkg = require.resolve("@paragon-ux/capn-hook/package.json");
  return path.join(path.dirname(pkg), "dist", "capn.js");
}

function setupTestRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-semantic-map-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({
      name: "sample-service",
      version: "1.0.0",
      main: "src/index.ts",
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "index.ts"),
    "export function main(): void { console.log('started'); }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "storage.ts"),
    "export class Store { save(k: string, v: string): void {} }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "server.ts"),
    "export function listen(port: number): void {}\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "paths.ts"),
    "export function normalize(p: string): string { return p.replace(/\\\\/g, '/'); }\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(repo, "src", "types.ts"),
    "export interface ErrorEnvelope { code: string; message: string; }\n",
    "utf8"
  );
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repo });
  execFileSync(process.execPath, [forkEntry(), "init"], { cwd: repo });
  return repo;
}

test("Anti-Hallucination Guardrail: rejects missing, escaped, absolute, and symlinked backing files", () => {
  const repo = setupTestRepo();

  // 1. Empty files array
  assert.throws(
    () => validateFacetBackingFiles(repo, []),
    (err: any) => err instanceof WaymarkError && err.code === "INVALID_BACKING_FILES"
  );

  // 2. Non-existent file
  assert.throws(
    () => validateFacetBackingFiles(repo, ["src/does_not_exist.ts"]),
    (err: any) => err instanceof WaymarkError && err.code === "INVALID_BACKING_FILES"
  );
  assert.throws(
    () => validateFacetBackingFiles(repo, ["../outside.ts"]),
    (err: any) => err instanceof WaymarkError && err.code === "INVALID_BACKING_FILES"
  );
  assert.throws(
    () => validateFacetBackingFiles(repo, [path.join(os.tmpdir(), "outside.ts")]),
    (err: any) => err instanceof WaymarkError && err.code === "INVALID_BACKING_FILES"
  );

  // 3. Existing file passes cleanly
  assert.doesNotThrow(() => validateFacetBackingFiles(repo, ["src/index.ts"]));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-outside-"));
  const link = path.join(repo, "src", "external");
  fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = true;\n");
  try {
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => validateFacetBackingFiles(repo, ["src/external/secret.ts"]),
      (err: any) => err instanceof WaymarkError && err.code === "INVALID_BACKING_FILES"
    );
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("uninitialized map guidance distinguishes store initialization from draft bootstrap", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-uninitialized-map-"));
  try {
    const status = getSemanticMapStatus(repo);
    assert.equal(status.status, "uninitialized");
    assert.match(status.message ?? "", /waymark memory init/u);
    assert.match(status.message ?? "", /bootstrap only collects unverified source-evidence drafts/u);
    assert.match(renderSemanticMapStatus(status), /waymark memory init.*bootstrap only collects unverified drafts/u);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("backing-file containment holds through status, bootstrap, publisher, CLI, and MCP", async () => {
  const repo = setupTestRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-outside-"));
  const link = path.join(repo, "src", "external");
  fs.writeFileSync(path.join(outside, "secret.ts"), "export const secret = true;\n");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  try {
    fs.writeFileSync(path.join(repo, ".capn", "entries", "escaped.md"), [
      "---", "id: escaped", "files:", '  "src/external/secret.ts": true', "---",
      "# [FACET:LIFECYCLE] external source", "Untrusted outside evidence.", "",
    ].join("\n"));
    const status = getSemanticMapStatus(repo);
    assert.equal(status.facets.lifecycle.status, "drifted");
    assert.deepEqual(status.facets.lifecycle.missingFiles, ["src/external/secret.ts"]);

    const drafts = await bootstrapSemanticMap(repo, { dryRun: false });
    assert.equal(drafts.published, false);
    assert.ok(drafts.scaffolded.every((facet) => !facet.files.includes("src/external/secret.ts")));
    await assert.rejects(() => publish(repo, "none", "", "Unsafe chart", "outside", ["src/external/secret.ts"]), /escapes repository root|symlink escapes/u);

    const server = new McpServer({ root: repo });
    for (const [name, args] of [
      ["waymark_memory", { action: "chart", question: "Unsafe MCP chart", answer: "outside", files: ["src/external/secret.ts"], root: repo }],
      ["waymark_chart", { question: "Unsafe legacy MCP chart", answer: "outside", files: ["src/external/secret.ts"], root: repo }],
    ] as const) {
      const response = await server.handleMessage(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
      }));
      const body = JSON.parse(response ?? "{}");
      assert.equal(body.result?.isError, true);
      assert.match(body.result?.content?.[0]?.text ?? "", /INVALID_BACKING_FILES|INVALID_PATH|SYMLINK_ESCAPE/u);
    }

    const cli = path.resolve(import.meta.dirname, "../src/cli.js");
    assert.throws(
      () => execFileSync(process.execPath, [cli, "memory", "chart", "--question", "Unsafe CLI chart", "--answer", "outside", "--files", "src/external/secret.ts", "--root", repo, "--json"], { encoding: "utf8" }),
      (error: any) => error.status !== 0 && /INVALID_BACKING_FILES|INVALID_PATH|SYMLINK_ESCAPE/u.test(`${error.stdout}\n${error.stderr}`),
    );
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Bootstrap returns evidence-backed drafts and never publishes unverified facets", async () => {
  const repo = setupTestRepo();

  const initStatus = getSemanticMapStatus(repo);
  assert.equal(initStatus.status, "empty");
  assert.equal(initStatus.completion, "0/5");
  assert.equal(initStatus.missing.length, 5);

  // Bootstrap the repository
  const bootResult = await bootstrapSemanticMap(repo, { dryRun: false });
  assert.equal(bootResult.ok, true);
  assert.equal(bootResult.scaffolded.length, 5);
  assert.equal(bootResult.published, false);
  assert.ok(bootResult.scaffolded.every((facet) => facet.status === "draft" && facet.evidence.length > 0));
  assert.ok(bootResult.scaffolded.every((facet) => facet.answer.includes("Unverified draft")));

  // A draft cannot become established map state without an explicit chart action.
  const postStatus = getSemanticMapStatus(repo);
  assert.equal(postStatus.status, "empty");
  assert.equal(postStatus.completion, "0/5");
  assert.equal(postStatus.missing.length, 5);
  assert.equal(fs.readdirSync(path.join(repo, ".capn", "entries")).filter((file) => file.endsWith(".md")).length, 0);

  const plainText = renderSemanticMapStatus(postStatus);
  assert.match(plainText, /\[semantic-map: 0\/5 facets active \(0%\)\]/);
});

test("minimal repository bootstrap adds no map facts or Capn store", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-empty-map-"));
  try {
    const result = await bootstrapSemanticMap(repo, { dryRun: false });
    assert.equal(result.scaffolded.length, 0);
    assert.equal(result.published, false);
    assert.equal(fs.existsSync(path.join(repo, ".capn")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("subsystem-scoped bootstrap is rejected explicitly", async () => {
  const repo = setupTestRepo();
  await assert.rejects(() => bootstrapSemanticMap(repo, { subsystem: "packages/api" }), /Subsystem-scoped semantic maps are not supported/u);
});

test("MCP waymark_memory tool: bootstrap -> status -> chart -> list -> bust -> unchart", async () => {
  const repo = setupTestRepo();
  const server = new McpServer({ root: repo });

  // 1. Bootstrap via MCP waymark_memory
  const bootRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "bootstrap",
          root: repo,
        },
      },
    })
  );
  const bootParsed = JSON.parse(bootRes ?? "{}");
  assert.equal(bootParsed.result?.isError, false);
  const bootBody = JSON.parse(bootParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(bootBody.ok, true);
  assert.equal(bootBody.status?.completion, "0/5");

  // 2. Status via MCP waymark_memory
  const statusRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "status",
          root: repo,
        },
      },
    })
  );
  const statusParsed = JSON.parse(statusRes ?? "{}");
  assert.equal(statusParsed.result?.isError, false);
  const statusBody = JSON.parse(statusParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(statusBody.status, "empty");
  assert.equal(statusBody.completion, "0/5");

  // 3. List via MCP waymark_memory
  const listRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "list",
          root: repo,
        },
      },
    })
  );
  const listParsed = JSON.parse(listRes ?? "{}");
  assert.equal(listParsed.result?.isError, false);
  const listBody = JSON.parse(listParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(listBody.ok, true);
  assert.doesNotMatch(String(listBody.output), /\[FACET:LIFECYCLE\]/);

  // 4. Chart custom facet entry via MCP waymark_memory
  const chartRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "chart",
          facet: "invariants",
          question: "Path Normalization Invariant",
          answer: "what: All paths must use forward slashes.\nwhere: src/paths.ts\ninvariants: Windows backslashes normalized.",
          files: ["src/paths.ts"],
          root: repo,
        },
      },
    })
  );
  const chartParsed = JSON.parse(chartRes ?? "{}");
  assert.equal(chartParsed.result?.isError, false);
  const chartBody = JSON.parse(chartParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(chartBody.published, true);

  // 5. Bust file via MCP waymark_memory
  const bustRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "bust",
          file: "src/paths.ts",
          root: repo,
        },
      },
    })
  );
  const bustParsed = JSON.parse(bustRes ?? "{}");
  assert.equal(bustParsed.result?.isError, false);
  const bustBody = JSON.parse(bustParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(bustBody.ok, true);
});

test("MCP waymark_ask facet addressing & path outline mode", async () => {
  const repo = setupTestRepo();
  await bootstrapSemanticMap(repo, { dryRun: false });
  const server = new McpServer({ root: repo });

  // 1. Ask with facet: 'status'
  const statusRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          facet: "status",
          root: repo,
        },
      },
    })
  );
  const statusParsed = JSON.parse(statusRes ?? "{}");
  assert.equal(statusParsed.result?.isError, false);
  const statusBody = JSON.parse(statusParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(statusBody.completion, "0/5");

  // 2. Ask with facet: 'status' and plain: true
  const plainRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          facet: "status",
          plain: true,
          root: repo,
        },
      },
    })
  );
  const plainParsed = JSON.parse(plainRes ?? "{}");
  assert.equal(plainParsed.result?.isError, false);
  const plainText = plainParsed.result?.content?.[0]?.text ?? "";
  assert.match(plainText, /\[semantic-map: 0\/5 facets active/);

  // 3. Ask with path (Mode A AST symbol outline discovery)
  const pathRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          path: "src/index.ts",
          root: repo,
        },
      },
    })
  );
  const pathParsed = JSON.parse(pathRes ?? "{}");
  assert.equal(pathParsed.result?.isError, false);
  const pathBody = JSON.parse(pathParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(pathBody.ok, true);
  assert.equal(pathBody.language, "typescript");
  assert.ok(pathBody.symbols.some((s: any) => s.name === "main"));

  // 4. Ask scoped to facet: 'lifecycle'
  await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "chart",
          facet: "lifecycle",
          question: "Sample service entrypoints",
          answer: "The verified entrypoints include the main function in src/index.ts.",
          files: ["src/index.ts"],
          root: repo,
        },
      },
    })
  );
  const facetQueryRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "waymark_ask",
        arguments: {
          facet: "lifecycle",
          question: "entrypoints",
          root: repo,
        },
      },
    })
  );
  const facetQueryParsed = JSON.parse(facetQueryRes ?? "{}");
  assert.equal(facetQueryParsed.result?.isError, false);
  const facetQueryBody = JSON.parse(facetQueryParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(facetQueryBody.status, "hit");
  assert.equal(facetQueryBody.provider, "capn-cli");
});

test("Tier Isolation Invariant: all discovery tiers remain fully testable and isolated", async () => {
  const repo = setupTestRepo();
  const server = new McpServer({ root: repo });

  // Tier 1: Forced AST structural query
  const astRes = await ask(repo, "capn-cli", "", "Who calls NonExistentSymbol?", { tier: "ast" });
  assert.equal(astRes.status, "miss");
  assert.equal(astRes.provider, "codedb");

  // Tier 2: Forced Literal Path query
  const pathRes = await ask(repo, "capn-cli", "", "src/index.ts", { tier: "path" });
  assert.equal(pathRes.status, "hit");
  assert.equal(pathRes.provider, "literal-path");

  // Tier 3: Forced Fuzzy Matcher query (codedb indexed listen -> listn fzf match)
  const fuzzyRes = await ask(repo, "capn-cli", "", "listn", { tier: "fuzzy", autoResolve: true });
  assert.equal(fuzzyRes.status, "hit");
  assert.equal(fuzzyRes.provider, "fuzzy-lexical");

  // Tier 4: Forced Capn Consensus Memory query
  await publish(repo, "capn-cli", "", "How does sample service boot?", "Via src/index.ts main() function.", ["src/index.ts"]);
  const capnRes = await ask(repo, "capn-cli", "", "sample service boot", { tier: "capn", autoResolve: true });
  assert.equal(capnRes.status, "hit");
  assert.equal(capnRes.provider, "capn-cli");
});

test("MCP waymark_memory: heal, export (json & md), and backslash-normalized bust", async () => {
  const repo = setupTestRepo();
  const server = new McpServer({ root: repo });

  // 1. Bootstrap via heal
  const healRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "heal",
          root: repo,
        },
      },
    })
  );
  const healParsed = JSON.parse(healRes ?? "{}");
  assert.equal(healParsed.result?.isError, false);
  const healBody = JSON.parse(healParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(healBody.ok, true);
  assert.equal(healBody.status?.completion, "0/5");

  const chartRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "chart",
          facet: "lifecycle",
          question: "Sample service lifecycle entrypoint",
          answer: "The verified lifecycle entrypoint is main in src/index.ts.",
          files: ["src/index.ts"],
          root: repo,
        },
      },
    })
  );
  assert.equal(JSON.parse(chartRes ?? "{}").result?.isError, false);

  // 2. Export as markdown
  const exportMdRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "export",
          format: "md",
          root: repo,
        },
      },
    })
  );
  const exportMdParsed = JSON.parse(exportMdRes ?? "{}");
  assert.equal(exportMdParsed.result?.isError, false);
  const mdText = exportMdParsed.result?.content?.[0]?.text ?? "";
  assert.match(mdText, /# Architecture Consensus Map/);
  assert.match(mdText, /Facet:.*Lifecycle/i);

  // 3. Export as JSON
  const exportJsonRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "export",
          format: "json",
          root: repo,
        },
      },
    })
  );
  const exportJsonParsed = JSON.parse(exportJsonRes ?? "{}");
  assert.equal(exportJsonParsed.result?.isError, false);
  const jsonBody = JSON.parse(exportJsonParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(jsonBody.status, "incomplete");
  assert.equal(jsonBody.completion, "1/5");

  // 4. Windows backslash bust test: chart with forward slash, bust with backslash
  await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "chart",
          question: "Backslash Normalization Check",
          answer: "Testing Windows backslash cache busting.",
          files: ["src/paths.ts"],
          root: repo,
        },
      },
    })
  );
  const bustRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "waymark_memory",
        arguments: {
          action: "bust",
          file: "src\\paths.ts",
          root: repo,
        },
      },
    })
  );
  const bustParsed = JSON.parse(bustRes ?? "{}");
  assert.equal(bustParsed.result?.isError, false);
  const bustBody = JSON.parse(bustParsed.result?.content?.[0]?.text ?? "{}");
  assert.equal(bustBody.ok, true);

  // 5. MCP Prompt: bootstrap-semantic-map
  const promptRes = await server.handleMessage(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "prompts/get",
      params: {
        name: "bootstrap-semantic-map",
      },
    })
  );
  const promptParsed = JSON.parse(promptRes ?? "{}");
  assert.match(promptParsed.result?.messages?.[0]?.content?.text ?? "", /Semantic Repo Map/);
});
