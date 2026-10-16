// Test support for the capn store-dir contract (docs/memory-store.md): Waymark
// passes `--root <dir> --store-dir <dir>` before every capn subcommand. Until
// the bundled @paragon-ux/capn-hook accepts those flags, end-to-end tests run
// the bundled fork through capnContractHarness.js, which applies the contract
// in memory. Once the fork ships the flags, these helpers use it directly.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { capnStoreArgs } from "../src/capnAdapter.js";
import { ensureStateDir } from "../src/stateDir.js";

const require = createRequire(import.meta.url);

export const CAPN_CONTRACT_HARNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "capnContractHarness.js");

export function bundledForkEntry(): string {
  const pkg = require.resolve("@paragon-ux/capn-hook/package.json");
  return path.join(path.dirname(pkg), "dist", "capn.js");
}

export function forkSourceSupportsStoreDir(source: string): boolean {
  return source.includes("store-dir");
}

export function bundledForkSupportsStoreDir(): boolean {
  return forkSourceSupportsStoreDir(fs.readFileSync(bundledForkEntry(), "utf8"));
}

/** The capn entry tests should run: the bundled fork once it honors the contract, else the harness. */
export function contractCapnEntry(): string {
  return bundledForkSupportsStoreDir() ? bundledForkEntry() : CAPN_CONTRACT_HARNESS;
}

/** Route Waymark's capn invocations in this test process (and its children) through the contract. */
export function useCapnStoreContract(): void {
  if (!bundledForkSupportsStoreDir()) process.env.WAYMARK_CAPN_EXECUTABLE = CAPN_CONTRACT_HARNESS;
}

/** Synchronous `waymark init` equivalent for test fixtures. */
export function initMemoryStoreSync(repo: string): void {
  ensureStateDir(repo);
  execFileSync(process.execPath, [contractCapnEntry(), ...capnStoreArgs(repo), "init"], { cwd: repo });
}
