#!/usr/bin/env node
// Test harness presenting the real capn-hook CLI surface over an isolated .capn
// store rooted in the caller's cwd. Not a fake protocol echo — the same
// capn-hook code (store, entries, qmd FTS index) runs for every call, with
// lexical recall standardized (embedding: false): deterministic latency, no
// model download, behavior identical to a production `capn` invocation.
//
// Location of capn-hook, in order:
//   1. $CAPN_HOOK_DIST             (explicit override)
//   2. this repo's node_modules    (devDependency; npm ci installs it)
//   3. the global npm tree         (local machine convenience)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function findCapnEntry() {
  if (process.env.CAPN_HOOK_DIST) return path.resolve(process.env.CAPN_HOOK_DIST);
  // Devdependency of this repository: resolve relative to the harness file so the
  // temp-repo cwd the tests run in never matters.
  const require = createRequire(path.join(HERE, "resolver-anchor.js"));
  try {
    const packageJsonPath = require.resolve("capn-hook/package.json");
    const entry = path.join(path.dirname(packageJsonPath), "dist", "capn.js");
    if (fs.existsSync(entry)) return entry;
  } catch {
    // fall through to the global tree
  }
  const globalNpm = process.platform === "win32" && process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules", "capn-hook", "dist", "capn.js")
    : "/usr/lib/node_modules/capn-hook/dist/capn.js";
  if (fs.existsSync(globalNpm)) return globalNpm;
  return null;
}

const entry = findCapnEntry();
if (!entry) {
  console.error("capnHarness: capn-hook not found. Install with `npm install -g capn-hook` or `npm i -D capn-hook`.");
  process.exit(2);
}

// The capn-hook entry imports ./run.ts which calls main() on import; args come
// from process.argv. Re-exec the real CLI in-process with our argv so exit
// codes, stdout/stderr routing, and the store all behave exactly as production.
process.argv = [process.argv[0], entry, ...process.argv.slice(2)];

const capnDir = path.join(process.cwd(), ".capn");
fs.mkdirSync(path.join(capnDir, "qmd"), { recursive: true });
// Standardized lexical recall: deterministic latency, no embedding model needed.
fs.writeFileSync(path.join(capnDir, "config.json"), `${JSON.stringify({ embedding: false })}\n`, "utf8");

await import(pathToFileURL(entry).href);