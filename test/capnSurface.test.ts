import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { ask, initCapn, publish, unchart, bust, prune, listEntries, context } from "../src/capnAdapter.js";


const require = createRequire(import.meta.url);

function forkEntry(): string {
  const pkg = require.resolve("@paragon-ux/capn-hook/package.json");
  return path.join(path.dirname(pkg), "dist", "capn.js");
}

function setupRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-capn-surface-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "payments.ts"), "export const webhook = true\n");
  // Initialize the lexical store with the bundled fork under plain node.
  execFileSync(process.execPath, [forkEntry(), "init"], { cwd: repo });
  return repo;
}

test("full wrapped capn surface: chart -> ask -> list -> bust -> chart -> unchart -> prune -> context", async () => {
  const repo = setupRepo();
  const exe = ""; // auto-resolution: bundled @paragon-ux/capn-hook, no PATH

  const published = await publish(repo, "capn-cli", exe, "Where are payment webhooks handled?", "They live in src/payments.ts.", ["src/payments.ts"]);
  assert.equal(published.published, true);

  const junction = await ask(repo, "capn-cli", exe, "payment webhooks");
  assert.equal(junction.status, "junction");
  assert.equal((junction as any).executedOption.tier, "capn-cli");

  const hit = await ask(repo, "capn-cli", exe, "payment webhooks", { autoResolve: true });
  assert.equal(hit.status, "hit");
  assert.equal(hit.provider, "capn-cli");

  const list = await listEntries(repo, exe);
  assert.equal(list.ok, true);
  assert.match(String(list.output), /payment webhooks/);

  const ctx = await context(repo, exe);
  assert.equal(ctx.ok, true);
  assert.match(String(ctx.output), /capn ask/);

  const busted = await bust(repo, exe, "src/payments.ts");
  assert.equal(busted.ok, true);
  assert.match(String(busted.output), /busted 1/);

  // Re-chart, then unchart by id (the entry id is its own 8-hex line in `list`).
  await publish(repo, "capn-cli", exe, "Where are payment webhooks handled?", "They live in src/payments.ts.", ["src/payments.ts"]);
  const list2 = await listEntries(repo, exe);
  const idMatch = String(list2.output).match(/^([0-9a-f]{8})$/m);
  assert.ok(idMatch, "entry id should be listed");
  const uncharted = await unchart(repo, exe, idMatch?.[1] ?? "");
  assert.equal(uncharted.ok, true);
  const list3 = await listEntries(repo, exe);
  assert.doesNotMatch(String(list3.output), /payment webhooks/);

  const pruned = await prune(repo, exe);
  assert.equal(pruned.ok, true);
});

test("unchart rejects unknown ids with a typed error", async () => {
  const repo = setupRepo();
  const result = await unchart(repo, "", "deadbeef");
  assert.equal(result.ok, false);
  assert.match(String(result.error), /unknown id/);
});

test("initCapn initializes store in deterministic lexical mode", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-init-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const result = await initCapn(repo);
  assert.equal(result.ok, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, ".capn", "config.json"), "utf8"));
  assert.equal(cfg.embedding, false);
});

