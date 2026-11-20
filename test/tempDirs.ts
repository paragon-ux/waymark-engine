import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { closeAllResidentClients } from "../src/residentCodedb.js";

const trackedDirs = new Set<string>();

export function cleanupTrackedDirs(): void {
  closeAllResidentClients();
  for (const dir of trackedDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // best-effort temp cleanup
    }
  }
  trackedDirs.clear();
}

// Register cleanup at module top-level (so node:test binds it to the file's root suite)
// and also on process exit as a fail-safe for any dirs created outside a test hook.
after(cleanupTrackedDirs);
process.once("exit", cleanupTrackedDirs);

export function mkTrackedTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackedDirs.add(dir);
  return dir;
}
