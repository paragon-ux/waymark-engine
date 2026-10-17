import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ask, bust, context, initCapn, listEntries, migrateMemoryStore, prune, publish, unchart } from "../src/capnAdapter.js";
import { collectRepoPaths, invalidatePathsCache } from "../src/discoveryRouter.js";
import { getPidFilePath } from "../src/daemon.js";
import { getSemanticMapStatus } from "../src/semanticMap.js";
import { logSessionEvent } from "../src/sessionLogger.js";
import { ensureStateDir, memoryStoreDir, stateDir } from "../src/stateDir.js";
import { bundledForkEntry } from "./capnContract.js";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");
const QUESTION = "Where is the app entry declared?";

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function setupRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-state-dir-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "export function appEntry(): void {}\n", "utf8");
  return repo;
}

function entryBody(question: string, files: Record<string, string>, details = ""): string {
  const fileLines = Object.entries(files).map(([file, hash]) => `  ${file}: ${hash}`).join("\n");
  return `---\ncapn: 1\nid: ${sha256(question).slice(0, 8)}\nat: 2026-01-01T00:00:00.000Z\nfiles:\n${fileLines}\n---\n\n# ${question}\n${details ? `\n${details}\n` : ""}`;
}

/** A `.capn` folder as some other capn would leave it, with a stale entry a prune would delete. */
function writeForeignCapnStore(repo: string, embedding: boolean, entryHash = "0".repeat(64)): void {
  const dir = path.join(repo, ".capn");
  fs.mkdirSync(path.join(dir, "entries"), { recursive: true });
  fs.mkdirSync(path.join(dir, "qmd"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({ embedding })}\n`);
  fs.writeFileSync(path.join(dir, "entries", `${sha256(QUESTION).slice(0, 8)}.md`), entryBody(QUESTION, { "src/app.ts": entryHash }, "Upstream detail."));
  fs.writeFileSync(path.join(dir, "map.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "qmd", "index.sqlite"), "not a database");
}

/** Every path under a directory with its content hash and mtime. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        out[`${rel}/`] = "dir";
        walk(full);
      } else {
        out[rel] = `${sha256(fs.readFileSync(full))}@${fs.statSync(full).mtimeMs}`;
      }
    }
  };
  walk(dir);
  return out;
}

function untracked(repo: string): string {
  return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
}

async function exerciseEverySurface(repo: string): Promise<void> {
  const init = await initCapn(repo, "");
  assert.equal(init.ok, true, JSON.stringify(init));
  const published = await publish(repo, "capn-cli", "", QUESTION, "In src/app.ts.", ["src/app.ts"]);
  assert.equal(published.published, true, published.error);
  const hit = await ask(repo, "capn-cli", "", "app entry declared", { tier: "capn", autoResolve: true });
  assert.equal(hit.status, "hit", JSON.stringify(hit));
  assert.match(String((await listEntries(repo, "")).output), /app entry/);
  assert.equal((await context(repo, "")).ok, true);
  assert.match(String((await bust(repo, "", "src/app.ts")).output), /busted 1/);
  assert.equal((await prune(repo, "")).ok, true);
  assert.equal((await unchart(repo, "", "deadbeef", true)).ok, true);
  getSemanticMapStatus(repo);

  invalidatePathsCache();
  const paths = collectRepoPaths(repo);
  assert.ok(paths.includes("src/app.ts"));
  assert.ok(!paths.some((p) => p.startsWith(".capn/") || p.startsWith(".waymark/")));
  assert.equal(fs.existsSync(path.join(stateDir(repo), "paths.v2.cache")), true);

  const telemetry = process.env.WAYMARK_TELEMETRY;
  process.env.WAYMARK_TELEMETRY = "1";
  try {
    logSessionEvent({
      timestamp: new Date().toISOString(), caller: "cli", repoRoot: repo, query: QUESTION, category: "ask",
      tierRoute: "capn", payloadTokens: 1, latencyMs: 1, status: "hit",
    });
  } finally {
    if (telemetry === undefined) delete process.env.WAYMARK_TELEMETRY; else process.env.WAYMARK_TELEMETRY = telemetry;
  }
  assert.equal(fs.existsSync(path.join(stateDir(repo), "sessions", "active.jsonl")), true);

  const pidFile = path.relative(repo, getPidFilePath(repo));
  assert.ok(pidFile.startsWith("..") || path.isAbsolute(pidFile), `pid file must live outside the repository: ${pidFile}`);
}

test("Waymark leaves a foreign .capn store untouched across every memory, path, and log surface", async () => {
  const repo = setupRepo();
  try {
    writeForeignCapnStore(repo, true);
    const before = snapshot(path.join(repo, ".capn"));

    await exerciseEverySurface(repo);
    const refused = await migrateMemoryStore(repo, "");
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /MIGRATE_SOURCE_NOT_LEXICAL/);

    assert.deepEqual(snapshot(path.join(repo, ".capn")), before);
    assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false, "the repository .gitignore must stay untouched");
    assert.equal(JSON.parse(fs.readFileSync(path.join(memoryStoreDir(repo), "config.json"), "utf8")).embedding, false);
    assert.equal(fs.readFileSync(path.join(stateDir(repo), ".gitignore"), "utf8"), "*\n");
    assert.equal(untracked(repo).includes(".waymark"), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Waymark never creates .capn in a repository without one", async () => {
  const repo = setupRepo();
  try {
    await exerciseEverySurface(repo);
    assert.equal(fs.existsSync(path.join(repo, ".capn")), false);
    assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
    assert.equal(untracked(repo), "?? src/app.ts\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("the bundled capn fork honors --store-dir and leaves a foreign .capn untouched", async () => {
  const repo = setupRepo();
  const fork = bundledForkEntry();
  try {
    writeForeignCapnStore(repo, false);
    const before = snapshot(path.join(repo, ".capn"));
    const init = await initCapn(repo, fork);
    assert.equal(init.ok, true, JSON.stringify(init));
    const published = await publish(repo, "capn-cli", fork, "Where is appEntry?", "In src/app.ts.", ["src/app.ts"]);
    assert.equal(published.published, true, published.error);
    assert.equal(fs.existsSync(path.join(memoryStoreDir(repo), "config.json")), true);
    assert.deepEqual(snapshot(path.join(repo, ".capn")), before);
    assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("a capn without --store-dir support is refused before it touches disk", async () => {
  const repo = setupRepo();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-old-capn-"));
  // Stands in for capn-hook 1.x: `--root` is an unknown command, so it prints usage and exits 1.
  const oldCapn = path.join(bin, "capn.mjs");
  fs.writeFileSync(oldCapn, 'process.stderr.write("Usage: capn <command> [args]\\n");\nprocess.exit(1);\n', "utf8");
  try {
    writeForeignCapnStore(repo, false);
    const before = snapshot(path.join(repo, ".capn"));
    const init = await initCapn(repo, oldCapn);
    assert.equal(init.ok, false);
    assert.equal(init.exitCode, 2);
    assert.match(String(init.error), /^CAPN_STORE_DIR_UNSUPPORTED: /);
    const published = await publish(repo, "capn-cli", oldCapn, "Where is appEntry?", "In src/app.ts.", ["src/app.ts"]);
    assert.equal(published.published, false);
    assert.match(String(published.error), /CAPN_STORE_DIR_UNSUPPORTED/);
    assert.equal(fs.existsSync(memoryStoreDir(repo)), false);
    const cli = spawnSync(process.execPath, [cliPath, "init", "--root", repo, "--capn-executable", oldCapn], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.status, 2, cli.stdout + cli.stderr);
    assert.deepEqual(snapshot(path.join(repo, ".capn")), before);
    assert.equal(fs.existsSync(path.join(repo, ".gitignore")), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test("memory migrate copies a lexical .capn store without modifying it, and fails closed otherwise", async () => {
  const repo = setupRepo();
  const embeddingRepo = setupRepo();
  const emptyRepo = setupRepo();
  try {
    writeForeignCapnStore(repo, false, sha256(fs.readFileSync(path.join(repo, "src", "app.ts"))));
    const before = snapshot(path.join(repo, ".capn"));

    const cli = spawnSync(process.execPath, [cliPath, "memory", "migrate", "--root", repo], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.status, 0, cli.stdout + cli.stderr);
    const migrated = JSON.parse(cli.stdout.trim().split(/\r?\n/u).pop() ?? "{}") as Record<string, unknown>;
    assert.equal(migrated.kind, "migrate");
    assert.equal(migrated.copied, 1);
    assert.deepEqual(snapshot(path.join(repo, ".capn")), before);

    const hit = await ask(repo, "capn-cli", "", "app entry declared", { tier: "capn", autoResolve: true });
    assert.equal(hit.status, "hit", JSON.stringify(hit));
    assert.match(String((await listEntries(repo, "")).output), /Where is the app entry declared\?/);

    const again = await migrateMemoryStore(repo, "");
    assert.equal(again.ok, false);
    assert.match(String(again.error), /MIGRATE_DESTINATION_NOT_EMPTY/);
    assert.deepEqual(snapshot(path.join(repo, ".capn")), before);

    writeForeignCapnStore(embeddingRepo, true);
    const refused = await migrateMemoryStore(embeddingRepo, "");
    assert.equal(refused.ok, false);
    assert.match(String(refused.error), /MIGRATE_SOURCE_NOT_LEXICAL/);
    assert.equal(fs.existsSync(stateDir(embeddingRepo)), false);

    const missing = await migrateMemoryStore(emptyRepo, "");
    assert.match(String(missing.error), /MIGRATE_SOURCE_NOT_LEXICAL/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(embeddingRepo, { recursive: true, force: true });
    fs.rmSync(emptyRepo, { recursive: true, force: true });
  }
});

test("ensureStateDir writes .waymark/.gitignore once and keeps an existing one", () => {
  const repo = setupRepo();
  try {
    ensureStateDir(repo);
    assert.equal(fs.readFileSync(path.join(stateDir(repo), ".gitignore"), "utf8"), "*\n");
    fs.writeFileSync(path.join(stateDir(repo), ".gitignore"), "*\n!keep.txt\n");
    ensureStateDir(repo);
    assert.equal(fs.readFileSync(path.join(stateDir(repo), ".gitignore"), "utf8"), "*\n!keep.txt\n");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
