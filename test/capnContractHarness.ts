// Test-only executable spec of the capn store-dir contract Waymark requires from
// @paragon-ux/capn-hook (docs/memory-store.md). Usage, as Waymark invokes capn:
//
//   node capnContractHarness.js --root <dir> --store-dir <dir> <command> [args...]
//
// When the bundled fork already accepts the flags, the harness runs it unchanged.
// Otherwise it runs a temp copy of the bundled fork with the contract applied:
//   1. capnDir(root) returns --store-dir instead of <root>/.capn;
//   2. findProjectRoot() returns --root instead of walking up for `.capn`;
//   3. ensureGitignore() leaves the repository .gitignore alone.
// node_modules is never modified. Delete this file once the fork ships the flags.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { bundledForkEntry, forkSourceSupportsStoreDir } from "./capnContract.js";

const entry = bundledForkEntry();
const source = fs.readFileSync(entry, "utf8");
const args = process.argv.slice(2);

function usage(): never {
  process.stdout.write("Usage:\n  capn --root <dir> --store-dir <dir> <command> [args...]\n");
  process.exit(1);
}

function applyOnce(text: string, before: string, after: string): string {
  const count = text.split(before).length - 1;
  if (count !== 1) {
    process.stderr.write(`capnContractHarness: expected one match in the bundled fork for ${JSON.stringify(before)}, found ${count}\n`);
    process.exit(3);
  }
  return text.replace(before, () => after);
}

if (forkSourceSupportsStoreDir(source)) {
  process.argv = [process.argv[0]!, entry, ...args];
  await import(pathToFileURL(entry).href);
} else {
  let root = "";
  let storeDir = "";
  while (args[0] === "--root" || args[0] === "--store-dir") {
    const flag = args.shift();
    const value = args.shift();
    if (!value) usage();
    if (flag === "--root") root = path.resolve(value);
    else storeDir = value;
  }
  if (!root || !storeDir) usage();
  (globalThis as Record<string, unknown>).__capnContract = { root, storeDir: path.resolve(root, storeDir) };

  const forkRequire = createRequire(entry);
  let patched = source;
  patched = applyOnce(patched, 'function capnDir(root) {\n  return resolve(root, ".capn");\n}', "function capnDir(root) {\n  return globalThis.__capnContract.storeDir;\n}");
  patched = applyOnce(patched, "function findProjectRoot(start) {\n", "function findProjectRoot(start) {\n  return globalThis.__capnContract.root;\n");
  patched = applyOnce(patched, "function ensureGitignore(root) {\n", "function ensureGitignore(root) {\n  return;\n");
  patched = applyOnce(patched, 'from "execa";', `from ${JSON.stringify(pathToFileURL(forkRequire.resolve("execa")).href)};`);
  patched = applyOnce(patched, "createRequire(import.meta.url)", `createRequire(${JSON.stringify(entry)})`);

  const digest = crypto.createHash("sha256").update(patched).digest("hex").slice(0, 16);
  const copy = path.join(os.tmpdir(), `waymark-capn-contract-${digest}.mjs`);
  if (!fs.existsSync(copy)) {
    const staging = `${copy}.${process.pid}.tmp`;
    fs.writeFileSync(staging, patched, "utf8");
    try {
      fs.renameSync(staging, copy);
    } catch (error) {
      fs.rmSync(staging, { force: true });
      if (!fs.existsSync(copy)) throw error;
    }
  }
  process.argv = [process.argv[0]!, copy, ...args];
  await import(pathToFileURL(copy).href);
}
