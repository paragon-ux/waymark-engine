import { execFileSync } from "node:child_process";
import { resolveCodedbCommand } from "../src/codedbAdapter.js";

process.env.CODEDB_ALLOW_TEMP = process.env.CODEDB_ALLOW_TEMP ?? "1";

/** True when a codedb binary is resolvable and runnable. */
export function hasCodedb(): boolean {
  try {
    const cmd = resolveCodedbCommand("");
    execFileSync(cmd.file, [...cmd.prefix, "--version"], { windowsHide: true, timeout: 10_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Skip predicate for node:test — `false` runs, a string skips with a reason. */
export function skipCodedb(): false | string {
  return hasCodedb() ? false : "codedb binary not available (set WAYMARK_CODEDB_EXECUTABLE)";
}
