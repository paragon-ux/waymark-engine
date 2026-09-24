import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { ask, assertLexicalStore, readCapnConfig } from "../src/capnAdapter.js";
import { hasCodedb } from "./codedb.js";

function setupRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-lexical-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "sample.ts"),
    "export function helloWorld(): string { return 'hello'; }\n",
    "utf8",
  );
  return repo;
}

test("readCapnConfig: missing store -> null; lexical config parsed", () => {
  const repo = setupRepo();
  assert.equal(readCapnConfig(repo), null);
  fs.mkdirSync(path.join(repo, ".capn"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".capn", "config.json"), '{"embedding": false}');
  assert.deepEqual(readCapnConfig(repo), { embedding: false });
  fs.writeFileSync(path.join(repo, ".capn", "config.json"), '{"embedding": true}');
  assert.deepEqual(readCapnConfig(repo), { embedding: true });
});

test("assertLexicalStore fails closed: uninitialized store", () => {
  const repo = setupRepo();
  assert.throws(() => assertLexicalStore(repo), (error: any) => error.code === "CAPN_STORE_UNINITIALIZED");
});

test("assertLexicalStore fails closed: embedding (QMD hybrid) mode", () => {
  const repo = setupRepo();
  fs.mkdirSync(path.join(repo, ".capn"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".capn", "config.json"), '{"embedding": true}');
  assert.throws(() => assertLexicalStore(repo), (error: any) => error.code === "CAPN_NON_DETERMINISTIC_MODE");
});

test("assertLexicalStore passes a lexical-only store", () => {
  const repo = setupRepo();
  fs.mkdirSync(path.join(repo, ".capn"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".capn", "config.json"), '{"embedding": false}');
  assert.doesNotThrow(() => assertLexicalStore(repo));
});

test("ask() refuses the semantic fallback without a lexical store (structural path unaffected)", async () => {
  const repo = setupRepo();
  // Structural question: answered by the codedb call graph, no store required.
  if (hasCodedb()) {
    const astResult = await ask(repo, "capn-cli", "capn", "Where is function helloWorld declared?");
    assert.equal(astResult.provider, "codedb");
  }

  // Non-structural question: semantic fallback must fail closed on an uninitialized store.
  await assert.rejects(
    () => ask(repo, "capn-cli", "capn", "How does authentication work in this project?"),
    (error: any) => error.code === "CAPN_STORE_UNINITIALIZED",
  );

  // Embedding-mode store: same fail-closed behavior.
  fs.mkdirSync(path.join(repo, ".capn"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".capn", "config.json"), '{"embedding": true}');
  await assert.rejects(
    () => ask(repo, "capn-cli", "capn", "How does authentication work in this project?"),
    (error: any) => error.code === "CAPN_NON_DETERMINISTIC_MODE",
  );

  // Lexical store: the guard passes and the bundled fork decides (hit/miss/error,
  // but never the mode error).
  fs.writeFileSync(path.join(repo, ".capn", "config.json"), '{"embedding": false}');
  const result = await ask(repo, "capn-cli", "", "How does authentication work in this project?");
  assert.ok(result.status === "miss" || result.status === "error", `unexpected status: ${result.status}`);
});
