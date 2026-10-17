// Test support for the capn store-dir contract (docs/memory-store.md): Waymark
// passes `--root <dir> --store-dir <dir>` before every capn subcommand, and the
// bundled @paragon-ux/capn-hook (2.0.0 and later) honors them.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { capnStoreArgs } from "../src/capnAdapter.js";
import { ensureStateDir } from "../src/stateDir.js";

const require = createRequire(import.meta.url);

export function bundledForkEntry(): string {
  const pkg = require.resolve("@paragon-ux/capn-hook/package.json");
  return path.join(path.dirname(pkg), "dist", "capn.js");
}

/** Synchronous `waymark init` equivalent for test fixtures. */
export function initMemoryStoreSync(repo: string): void {
  ensureStateDir(repo);
  execFileSync(process.execPath, [bundledForkEntry(), ...capnStoreArgs(repo), "init"], { cwd: repo });
}
