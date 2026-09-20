import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TextDecoder } from "node:util";
import { LineRange, StructuralSignature, WaymarkError } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function sha256(value: Buffer | string): string {
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

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new WaymarkError("INVALID_PATH", "Path must be a nonempty repository-relative path");
  }
  const slashPath = input.replaceAll("\\", "/");
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
  const relative = normalizeRelativePath(storedPath);
  const lexical = path.resolve(root, ...relative.split("/"));
  if (!isInside(root, lexical)) throw new WaymarkError("INVALID_PATH", "Path escapes repository root");
  let real: string;
  try {
    real = fs.realpathSync.native(lexical);
  } catch {
    throw new WaymarkError("FILE_MISSING", `Referenced file is missing: ${relative}`, 2);
  }
  const realRoot = fs.realpathSync.native(root);
  if (!isInside(realRoot, real)) throw new WaymarkError("SYMLINK_ESCAPE", "Referenced symlink escapes repository root", 2);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new WaymarkError("NOT_REGULAR_FILE", `Referenced path is not a regular file: ${relative}`, 2);
  return { lexical, real };
}

export function readFileBytes(root: string, storedPath: string): { path: string; bytes: Buffer } {
  const file = resolveRepositoryFile(root, storedPath);
  return { path: file.real, bytes: fs.readFileSync(file.real) };
}

export function readFileText(root: string, storedPath: string): { path: string; bytes: Buffer; text: string } {
  const result = readFileBytes(root, storedPath);
  try {
    return { ...result, text: decoder.decode(result.bytes) };
  } catch {
    throw new WaymarkError("INVALID_UTF8", `Referenced file is not valid UTF-8: ${storedPath}`, 2);
  }
}

export function normalizedLines(text: string): string[] {
  return text.replace(/\r\n?/gu, "\n").split("\n");
}

export function extractRange(lines: readonly string[], range: LineRange): string {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 1 || range.end < range.start || range.end > lines.length) {
    throw new WaymarkError("INVALID_RANGE", `Invalid line range ${range.start}-${range.end}`);
  }
  return lines.slice(range.start - 1, range.end).join("\n");
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
export function anchorForRange(root: string, storedPath: string, range: LineRange): {
  fileSha256: string;
  normalizedSpanHash: string;
  normalizedSpanLen: number;
  spanLineCount: number;
  structuralSignature: StructuralSignature;
} {
  const file = readFileText(root, storedPath);
  const lines = normalizedLines(file.text);
  const normalized = normalizeSpan(extractRange(lines, range));
  return {
    fileSha256: sha256(file.bytes),
    normalizedSpanHash: sha256(Buffer.from(normalized, "utf8")),
    normalizedSpanLen: Buffer.byteLength(normalized, "utf8"),
    spanLineCount: range.end - range.start + 1,
    structuralSignature: structuralSignature(normalized),
  };
}
