import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { TextDecoder, promisify } from "node:util";
import { LineRange, LineRangeLike, StructuralSignature, WaymarkError } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function sha256(value: Uint8Array | string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Resolve the repository root: `git rev-parse --show-toplevel` when inside a Git
 * worktree, otherwise the process cwd. The discovery engine itself needs no Git —
 * the fallback keeps the CLI and library usable outside a repository.
 */
export function repoRoot(cwd = process.cwd()): string {
  try {
    const output = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 5000,
    });
    const root = decoder.decode(output).trim();
    if (!root) throw new Error("empty Git root");
    return fs.realpathSync.native(root);
  } catch {
    return fs.realpathSync.native(cwd);
  }
}

const execFileAsync = promisify(execFile);

/** `repoRoot` without blocking the event loop; rejects when `cwd` does not exist. */
export async function repoRootAsync(cwd = process.cwd()): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "buffer",
      windowsHide: true,
      timeout: 5000,
    });
    const root = decoder.decode(stdout).trim();
    if (!root) throw new Error("empty Git root");
    return await fs.promises.realpath(root);
  } catch {
    return await fs.promises.realpath(cwd);
  }
}

function isLexicallyInside(root: string, candidate: string): boolean {
  const normRoot = path.resolve(root);
  const normCand = path.resolve(candidate);
  const relative = path.relative(normRoot, normCand);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isInside(root: string, candidate: string): boolean {
  let normRoot = path.resolve(root);
  let normCand = path.resolve(candidate);
  try { normRoot = fs.realpathSync.native(normRoot); } catch {}
  try { normCand = fs.realpathSync.native(normCand); } catch {}
  return isLexicallyInside(normRoot, normCand);
}

/**
 * Resolve `targetPath` through the filesystem even when the leaf does not exist
 * (handling symlinked roots such as macOS `/var` -> `/private/var`, escaping
 * symlinked directories with missing leaves, and dangling symlinks).
 */
function resolvePathThroughExistingAncestor(targetPath: string): { resolved: string; exists: boolean } {
  let current = path.resolve(targetPath);
  for (let hop = 0; hop < 16; hop++) {
    try {
      return { resolved: fs.realpathSync.native(current), exists: true };
    } catch {
      // Path does not exist yet or traverses a dangling symlink.
    }

    const trailing: string[] = [];
    let cursor = current;
    let expandedDangling = false;
    while (true) {
      let lstat: fs.Stats | null = null;
      try {
        lstat = fs.lstatSync(cursor);
      } catch {
        // Walk up until an existing ancestor or symlink is found.
      }
      if (lstat !== null) {
        try {
          const realAncestor = fs.realpathSync.native(cursor);
          const combined = trailing.length > 0 ? path.resolve(realAncestor, ...trailing.reverse()) : realAncestor;
          return { resolved: combined, exists: false };
        } catch {
          if (lstat.isSymbolicLink()) {
            let parentReal = path.dirname(cursor);
            try {
              parentReal = fs.realpathSync.native(parentReal);
            } catch {}
            try {
              const linkTarget = fs.readlinkSync(cursor);
              const resolvedLink = path.resolve(parentReal, linkTarget);
              current = trailing.length > 0 ? path.resolve(resolvedLink, ...trailing.reverse()) : resolvedLink;
              expandedDangling = true;
              break;
            } catch {
              return { resolved: current, exists: false };
            }
          }
          return { resolved: current, exists: false };
        }
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return { resolved: current, exists: false };
      }
      trailing.push(path.basename(cursor));
      cursor = parent;
    }
    if (!expandedDangling) break;
  }
  return { resolved: current, exists: false };
}

export function normalizeRelativePath(input: string, root?: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new WaymarkError("INVALID_PATH", "Path must be a nonempty repository-relative path");
  }
  const slashPath = input.replaceAll("\\", "/");
  if (root && (path.isAbsolute(input) || /^[A-Za-z]:/u.test(slashPath) || path.posix.isAbsolute(slashPath))) {
    const lexicalRoot = path.resolve(root);
    const lexicalInput = path.resolve(slashPath);
    const normRoot = resolvePathThroughExistingAncestor(lexicalRoot).resolved;
    const { resolved: normInput } = resolvePathThroughExistingAncestor(lexicalInput);
    if (isInside(normRoot, normInput)) {
      const rel = path.relative(normRoot, normInput).replaceAll("\\", "/");
      return rel === "" ? "." : rel.replace(/^\.\//u, "");
    }
    if (isLexicallyInside(lexicalRoot, lexicalInput) || isLexicallyInside(normRoot, lexicalInput)) {
      throw new WaymarkError("SYMLINK_ESCAPE", "Referenced symlink escapes repository root", 2);
    }
    throw new WaymarkError("INVALID_PATH", `Absolute path "${input}" escapes repository root`);
  }
  if (path.posix.isAbsolute(slashPath) || /^[A-Za-z]:/u.test(slashPath)) {
    throw new WaymarkError("INVALID_PATH", "Absolute paths are not allowed");
  }
  const normalized = path.posix.normalize(slashPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new WaymarkError("INVALID_PATH", "Path traversal is not allowed");
  }
  return normalized.replace(/^\.\//u, "");
}

export function resolveRepositoryFile(root: string, storedPath: string): { lexical: string; real: string } {
  const relative = normalizeRelativePath(storedPath, root);
  const lexical = path.resolve(root, ...relative.split("/"));
  if (!isLexicallyInside(root, lexical)) throw new WaymarkError("INVALID_PATH", "Path escapes repository root");
  const realRoot = resolvePathThroughExistingAncestor(root).resolved;
  let real: string;
  try {
    real = fs.realpathSync.native(lexical);
  } catch {
    const { resolved } = resolvePathThroughExistingAncestor(lexical);
    if (!isLexicallyInside(realRoot, resolved)) {
      throw new WaymarkError("SYMLINK_ESCAPE", "Referenced symlink escapes repository root", 2);
    }
    throw new WaymarkError("FILE_MISSING", `Referenced file is missing: ${relative}`, 2);
  }
  if (!isLexicallyInside(realRoot, real)) throw new WaymarkError("SYMLINK_ESCAPE", "Referenced symlink escapes repository root", 2);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new WaymarkError("NOT_REGULAR_FILE", `Referenced path is not a regular file: ${relative}`, 2);
  return { lexical, real };
}

export function readFileBytes(root: string, storedPath: string, maxBytes?: number): { path: string; bytes: Uint8Array } {
  const file = resolveRepositoryFile(root, storedPath);
  if (maxBytes === undefined) {
    return { path: file.real, bytes: fs.readFileSync(file.real) };
  }
  const fd = fs.openSync(file.real, "r");
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new WaymarkError("NOT_REGULAR_FILE", `Referenced path is not a regular file: ${storedPath}`, 2);
    }
    if (stat.size > maxBytes) {
      throw new WaymarkError("FILE_TOO_LARGE", `Discovery only accepts files up to ${maxBytes} bytes`, 2);
    }
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = Math.min(64 * 1024, limit);
    const scratch = Buffer.allocUnsafe(chunkSize);
    while (total < limit) {
      const toRead = Math.min(chunkSize, limit - total);
      const read = fs.readSync(fd, scratch, 0, toRead, total);
      if (read <= 0) break;
      chunks.push(Buffer.from(scratch.subarray(0, read)));
      total += read;
    }
    if (total > maxBytes) {
      throw new WaymarkError("FILE_TOO_LARGE", `Discovery only accepts files up to ${maxBytes} bytes`, 2);
    }
    return { path: file.real, bytes: chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total) };
  } finally {
    fs.closeSync(fd);
  }
}

export function readFileText(root: string, storedPath: string, maxBytes?: number): { path: string; bytes: Uint8Array; text: string } {
  const result = readFileBytes(root, storedPath, maxBytes);
  try {
    return { ...result, text: decoder.decode(result.bytes) };
  } catch {
    throw new WaymarkError("INVALID_UTF8", `Referenced file is not valid UTF-8: ${storedPath}`, 2);
  }
}

export function normalizedLines(text: string): string[] {
  return text.replace(/\r\n?/gu, "\n").split("\n");
}

export function normalizeRange(input: unknown): LineRange {
  if (!input || typeof input !== "object") {
    throw new WaymarkError("INVALID_RANGE", "Invalid range object");
  }
  const obj = input as Record<string, unknown>;
  const startRaw = obj.start ?? obj.startLine;
  const endRaw = obj.end ?? obj.endLine;

  const start = typeof startRaw === "object" && startRaw !== null && "line" in startRaw
    ? (startRaw as { line: unknown }).line
    : startRaw;
  const end = typeof endRaw === "object" && endRaw !== null && "line" in endRaw
    ? (endRaw as { line: unknown }).line
    : endRaw;

  if (typeof start !== "number" || typeof end !== "number" || !Number.isInteger(start) || !Number.isInteger(end)) {
    throw new WaymarkError("INVALID_RANGE", `Invalid line range ${String(start)}-${String(end)}`);
  }
  return { start, end };
}

export function extractRange(lines: readonly string[], range: LineRange | LineRangeLike): string {
  const normalized = normalizeRange(range);
  if (normalized.start < 1 || normalized.end < normalized.start || normalized.end > lines.length) {
    throw new WaymarkError("INVALID_RANGE", `Invalid line range ${normalized.start}-${normalized.end}`);
  }
  return lines.slice(normalized.start - 1, normalized.end).join("\n");
}

export function normalizeSpan(text: string): string {
  const nfc = text.normalize("NFC").replace(/\r\n?/gu, "\n");
  const lines = nfc.split("\n").map((line) => line.replace(/[ \t]+$/u, ""));
  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  return lines.join("\n");
}

function tokens(line: string): string[] {
  return line.match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function structuralSignature(normalized: string): StructuralSignature {
  const lines = normalized.split("\n");
  const first = lines.find((line) => line.trim() !== "") ?? "";
  const last = [...lines].reverse().find((line) => line.trim() !== "") ?? "";
  return {
    firstHash: sha256(first),
    lastHash: sha256(last),
    firstTokensPrefix: tokens(first).slice(0, 10),
    lastTokensPrefix: tokens(last).slice(0, 10),
  };
}

/**
 * Anchor a repository-relative file range: full-file hash plus a normalized,
 * relocation-tolerant span hash. This is the tamper-evidence primitive — the
 * same one the in-flight continuity ledger used, kept standalone because it is
 * the cheapest way to pin "this span said X" to a later integrity check.
 */
export function anchorForRange(root: string, storedPath: string, range: LineRange | LineRangeLike): {
  fileSha256: string;
  normalizedSpanHash: string;
  normalizedSpanLen: number;
  spanLineCount: number;
  structuralSignature: StructuralSignature;
} {
  const normRange = normalizeRange(range);
  const file = readFileText(root, storedPath);
  const lines = normalizedLines(file.text);
  const normalized = normalizeSpan(extractRange(lines, normRange));
  return {
    fileSha256: sha256(file.bytes),
    normalizedSpanHash: sha256(Buffer.from(normalized, "utf8")),
    normalizedSpanLen: Buffer.byteLength(normalized, "utf8"),
    spanLineCount: normRange.end - normRange.start + 1,
    structuralSignature: structuralSignature(normalized),
  };
}
