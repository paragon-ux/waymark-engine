import fs from "node:fs";
import path from "node:path";
import { resolveRepositoryFile, sha256 } from "./paths.js";
import { memoryStoreDir } from "./stateDir.js";

export interface ParsedCapnEntry {
  id: string;
  at?: string;
  files: string[];
  /** The SHA-256 capn recorded for each backing file when the entry was charted. */
  fileHashes: Record<string, string>;
  question: string;
  details: string;
}

/** A frontmatter file key, unquoted the way capn quotes keys holding `:` or a leading `"`. */
function parseFileLine(line: string): { file: string; hash: string } | null {
  const body = line.trim();
  if (body.startsWith('"')) {
    for (let index = 1; index < body.length; index++) {
      if (body[index] === '"' && body[index - 1] !== "\\") {
        let file: string;
        try {
          file = JSON.parse(body.slice(0, index + 1)) as string;
        } catch {
          file = body.slice(1, index);
        }
        const rest = body.slice(index + 1).replace(/^:\s*/u, "");
        return file ? { file, hash: rest.trim() } : null;
      }
    }
    return null;
  }
  const colon = body.lastIndexOf(": ") !== -1 ? body.lastIndexOf(": ") : body.indexOf(":");
  if (colon === -1) return null;
  const file = body.slice(0, colon).trim();
  return file ? { file, hash: body.slice(colon + 1).trim() } : null;
}

/** Parse one capn entry file; CRLF line endings (a Windows checkout) parse like LF. */
export function parseChartedEntry(raw: string, fallbackId: string): ParsedCapnEntry | null {
  const content = raw.replace(/\r\n/gu, "\n");
  if (!content.startsWith("---\n")) return null;
  const closeIdx = content.indexOf("\n---\n", 4);
  if (closeIdx === -1) return null;

  const frontmatter = content.slice(4, closeIdx);
  const body = content.slice(closeIdx + 5);

  let id = fallbackId;
  let at: string | undefined;
  const files: string[] = [];
  const fileHashes: Record<string, string> = {};
  let inFilesSection = false;

  for (const line of frontmatter.split("\n")) {
    if (line.startsWith("id: ")) {
      id = line.slice(4).trim();
      inFilesSection = false;
    } else if (line.startsWith("at: ")) {
      at = line.slice(4).trim();
      inFilesSection = false;
    } else if (line.startsWith("files:")) {
      inFilesSection = true;
    } else if (inFilesSection && line.startsWith("  ")) {
      const parsed = parseFileLine(line);
      if (parsed) {
        files.push(parsed.file);
        fileHashes[parsed.file] = parsed.hash;
      }
    } else if (line.trim().length > 0) {
      inFilesSection = false;
    }
  }

  let question = "";
  let details = "";
  const trimmedBody = body.trim();
  if (trimmedBody.startsWith("# ")) {
    const firstNewline = trimmedBody.indexOf("\n");
    if (firstNewline !== -1) {
      question = trimmedBody.slice(2, firstNewline).trim();
      details = trimmedBody.slice(firstNewline + 1).trim();
    } else {
      question = trimmedBody.slice(2).trim();
    }
  } else {
    question = trimmedBody;
  }

  return { id, at, files, fileHashes, question, details };
}

/**
 * Charted entries read straight from the memory store's entries directory, newest first
 * (by `at`; an entry without a timestamp sorts last). Synchronous and subprocess-free.
 */
export function readChartedEntries(root: string): ParsedCapnEntry[] {
  const entriesDir = path.join(memoryStoreDir(root), "entries");
  if (!fs.existsSync(entriesDir)) return [];

  const entries: ParsedCapnEntry[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(entriesDir);
  } catch {
    return [];
  }
  for (const file of names) {
    if (!file.endsWith(".md")) continue;
    try {
      const parsed = parseChartedEntry(fs.readFileSync(path.join(entriesDir, file), "utf8"), path.basename(file, ".md"));
      if (parsed) entries.push(parsed);
    } catch {
      // Skip unreadable files
    }
  }
  return entries.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id));
}

export interface EntryFreshness {
  fresh: boolean;
  /** Cited files that are gone or are not regular files inside the repository. */
  missingFiles: string[];
  /** Cited files whose contents changed since the entry was charted. capn deletes such entries on its next read. */
  staleFiles: string[];
}

/**
 * The freshness capn applies (every cited file exists and still hashes to its recorded SHA-256).
 * A file recorded without a hash, as a hand-written entry may be, is checked for existence only.
 */
export function entryFreshness(root: string, entry: ParsedCapnEntry): EntryFreshness {
  const missingFiles: string[] = [];
  const staleFiles: string[] = [];
  for (const file of entry.files) {
    let real: string;
    try {
      real = resolveRepositoryFile(root, file).real;
    } catch {
      missingFiles.push(file);
      continue;
    }
    const recorded = entry.fileHashes[file];
    if (!recorded || !/^[0-9a-f]{64}$/u.test(recorded)) continue;
    try {
      if (sha256(fs.readFileSync(real)) !== recorded) staleFiles.push(file);
    } catch {
      missingFiles.push(file);
    }
  }
  return { fresh: missingFiles.length === 0 && staleFiles.length === 0, missingFiles, staleFiles };
}

/** Entries capn will delete on its next `ask`, `list`, or `chart`, because a backing file changed or vanished. */
export function staleChartedEntries(root: string): Array<ParsedCapnEntry & EntryFreshness> {
  return readChartedEntries(root)
    .map((entry) => ({ ...entry, ...entryFreshness(root, entry) }))
    .filter((entry) => !entry.fresh);
}
