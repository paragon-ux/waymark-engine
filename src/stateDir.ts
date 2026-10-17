import fs from "node:fs";
import path from "node:path";

/**
 * Waymark-owned on-disk state. Everything Waymark writes inside a repository
 * lives under `.waymark/`: never under `.capn/`, which belongs to upstream capn
 * stores that Waymark must neither read nor modify.
 */
export const STATE_DIR_NAME = ".waymark";

/** Root of Waymark's per-repository state: `<root>/.waymark`. */
export function stateDir(root: string): string {
  return path.join(root, STATE_DIR_NAME);
}

/**
 * The Tier 4 memory store (charted entries, store config, lexical index).
 * Every Waymark reference to the store resolves through this helper, and every
 * capn invocation receives it as `--store-dir`.
 */
export function memoryStoreDir(root: string): string {
  return path.join(stateDir(root), "memory");
}

/** Display form of the memory store location for user-facing messages. */
export const MEMORY_STORE_LABEL = `${STATE_DIR_NAME}/memory`;

/**
 * Where Waymark 3.x and earlier put the memory store. Only the internal
 * `memory migrate` command reads it, and nothing ever writes it: the folder
 * name belongs to upstream capn.
 */
export const LEGACY_STORE_DIR_NAME = ".capn";

/**
 * Create `.waymark/` with a `.gitignore` of `*`, so Waymark state never shows
 * up as untracked in the user's repository. An existing `.gitignore` is kept.
 */
export function ensureStateDir(root: string): string {
  const dir = stateDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) {
    try {
      fs.writeFileSync(ignore, "*\n", { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return dir;
}
