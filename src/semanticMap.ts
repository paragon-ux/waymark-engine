import fs from "node:fs";
import path from "node:path";
import { resolveRepositoryFile } from "./paths.js";
import { memoryStoreDir, MEMORY_STORE_LABEL } from "./stateDir.js";
import { AdapterProfile, WaymarkError } from "./types.js";
import { entryFreshness, readChartedEntries } from "./memoryEntries.js";
import { publish, unchart } from "./capnAdapter.js";

export type SemanticFacetId =
  | "lifecycle"
  | "data_state"
  | "boundaries"
  | "invariants"
  | "failure";

export interface FacetDefinition {
  id: SemanticFacetId;
  tag: string;
  name: string;
  canonicalQuestion: string;
  description: string;
  targetFilesSummary: string;
  /** Lowercase word prefixes that mark a source line as evidence for this facet. */
  evidenceKeywords: string[];
}

export const SEMANTIC_FACETS: Record<SemanticFacetId, FacetDefinition> = {
  lifecycle: {
    id: "lifecycle",
    tag: "[FACET:LIFECYCLE]",
    name: "Entrypoints & Runtime Lifecycle",
    canonicalQuestion: "[FACET:LIFECYCLE] What are the primary executable entrypoints, daemon lifecycles, and bootstrapping sequences?",
    description: "Executable wrappers, daemon servers, root index modules, bootstrap sequence.",
    targetFilesSummary: "bin/*, src/index.ts, src/cli.ts, src/daemon.ts",
    evidenceKeywords: ["main", "start", "stop", "boot", "init", "launch", "spawn", "listen", "serve", "shutdown", "close", "exit", "argv", "daemon", "lifecycle", "warm", "run"],
  },
  data_state: {
    id: "data_state",
    tag: "[FACET:DATA_STATE]",
    name: "Data Flow & Storage",
    canonicalQuestion: "[FACET:DATA_STATE] How is data, state, or cache stored, synchronized, and persisted on disk?",
    description: "Storage adapters, SQLite databases, file caches, state stores, migrations.",
    targetFilesSummary: "src/capnAdapter.ts, database schemas, cache managers",
    evidenceKeywords: ["store", "cache", "persist", "state", "save", "write", "load", "disk", "dir", "mkdir", "fs", "db", "database", "sqlite", "sql", "schema", "migrat", "memory"],
  },
  boundaries: {
    id: "boundaries",
    tag: "[FACET:BOUNDARIES]",
    name: "Cross-Boundary Glue",
    canonicalQuestion: "[FACET:BOUNDARIES] What boundary protocols (Named Pipes, Unix Sockets, HTTP, RPC, SQL) connect internal modules or external services?",
    description: "Boundary protocols, IPC bridges, API endpoints, protocol clients.",
    targetFilesSummary: "src/daemon.ts, src/mcp/*, IPC bridges",
    evidenceKeywords: ["socket", "pipe", "http", "rpc", "jsonrpc", "ipc", "net", "server", "client", "request", "response", "protocol", "stdio", "stdin", "stdout", "connect", "exec", "spawn", "port", "endpoint", "fetch", "url", "mcp"],
  },
  invariants: {
    id: "invariants",
    tag: "[FACET:INVARIANTS]",
    name: "Chesterton's Fences & Non-Obvious Rules",
    canonicalQuestion: "[FACET:INVARIANTS] What non-obvious security, path normalization, or OS-specific invariants must not be violated?",
    description: "Path normalizers, platform guards, security sanitizers, fail-closed checks.",
    targetFilesSummary: "src/paths.ts, src/integrity.ts",
    evidenceKeywords: ["normalize", "resolve", "realpath", "symlink", "canonical", "escape", "contain", "inside", "outside", "relative", "absolute", "platform", "win", "posix", "sanitize", "valid", "assert", "guard", "invariant", "integrity", "verify", "reject", "forbid", "safe"],
  },
  failure: {
    id: "failure",
    tag: "[FACET:FAILURE]",
    name: "Fail-Closed & Error Recovery",
    canonicalQuestion: "[FACET:FAILURE] How does the system fail closed on misses and recover from uninitialized, corrupted, or degraded states?",
    description: "Fail-closed policy, error registries, typed exception classes, recovery fallback.",
    targetFilesSummary: "src/types.ts, error handlers",
    evidenceKeywords: ["err", "throw", "catch", "fail", "recover", "fallback", "retry", "miss", "reject", "abort", "timeout", "degrad", "corrupt", "invalid", "uninitiali", "exception", "panic", "fatal"],
  },
};

export const ALL_FACET_IDS: SemanticFacetId[] = [
  "lifecycle",
  "data_state",
  "boundaries",
  "invariants",
  "failure",
];

export { readChartedEntries } from "./memoryEntries.js";
export type { ParsedCapnEntry } from "./memoryEntries.js";

/**
 * True when a charted answer declares the facet not applicable with an explicit marker: a
 * `status: not_applicable` line, or an answer that opens with `not_applicable` (`not_applicable:
 * no daemon here`). Prose that merely mentions the identifier does not count.
 */
export function isNotApplicableAnswer(text: string): boolean {
  const trimmed = text.trim();
  // Quotes are spelled \x22/\x27: codedb-core 2.1.1 reads a quote inside a regex literal as a
  // string opener and stretches this function to the end of the file in the call graph.
  return /^\s*status\s*:\s*[\x22\x27]?not_applicable[\x22\x27]?\s*$/imu.test(trimmed)
    || /^\[?not_applicable\]?(?:\s*$|\s*[:\-—.]|\s+-\s)/iu.test(trimmed);
}

export interface FacetStatus {
  id: SemanticFacetId;
  name: string;
  tag: string;
  status: "active" | "missing" | "drifted" | "not_applicable";
  entryId?: string;
  question?: string;
  details?: string;
  files: string[];
  missingFiles?: string[];
  /** Cited files whose contents changed since charting; capn deletes the entry on its next read. */
  staleFiles?: string[];
  rationale?: string;
}

export interface SemanticMapStatus {
  waymark: 1;
  kind: "semantic_map";
  status: "healthy" | "incomplete" | "drifted" | "empty" | "uninitialized";
  completion: string;
  activeCount: number;
  totalFacets: 5;
  percentage: number;
  facets: Record<SemanticFacetId, FacetStatus>;
  missing: SemanticFacetId[];
  drifted: SemanticFacetId[];
  message?: string;
}

/**
 * Validate that an active facet cites at least 1 repository file and all cited files exist.
 * Anti-Hallucination Guardrail #1.
 */
export function validateFacetBackingFiles(root: string, files: string[], isNotApplicable = false): void {
  if (!files || files.length === 0) {
    throw new WaymarkError(
      "INVALID_BACKING_FILES",
      `Anti-Hallucination Guard: Every ${isNotApplicable ? "not_applicable entry" : "active facet"} MUST cite at least 1 repository file.`
    );
  }

  const invalid: string[] = [];
  for (const relFile of files) {
    try { resolveRepositoryFile(root, relFile); } catch { invalid.push(relFile); }
  }

  if (invalid.length > 0) {
    throw new WaymarkError(
      "INVALID_BACKING_FILES",
      `Anti-Hallucination Guard: Backing file(s) must be regular files inside the repository: ${invalid.join(", ")}`
    );
  }
}

/**
 * Inspect the health, completion percentage, and anchor drift of the Semantic Repo Map.
 */
export function getSemanticMapStatus(root: string): SemanticMapStatus {
  const capnConfig = path.join(memoryStoreDir(root), "config.json");
  if (!fs.existsSync(capnConfig)) {
    const emptyFacets = {} as Record<SemanticFacetId, FacetStatus>;
    for (const fid of ALL_FACET_IDS) {
      emptyFacets[fid] = {
        id: fid,
        name: SEMANTIC_FACETS[fid].name,
        tag: SEMANTIC_FACETS[fid].tag,
        status: "missing",
        files: [],
      };
    }
    return {
      waymark: 1,
      kind: "semantic_map",
      status: "uninitialized",
      completion: "0/5",
      activeCount: 0,
      totalFacets: 5,
      percentage: 0,
      facets: emptyFacets,
      missing: [...ALL_FACET_IDS],
      drifted: [],
      message: `Consensus memory store (${MEMORY_STORE_LABEL}) is uninitialized. Run 'waymark memory init' (MCP: waymark_memory(action: "init")) to initialize it; bootstrap only collects unverified source-evidence drafts.`,
    };
  }

  const entries = readChartedEntries(root);
  const facets = {} as Record<SemanticFacetId, FacetStatus>;
  const missing: SemanticFacetId[] = [];
  const drifted: SemanticFacetId[] = [];
  let activeCount = 0;

  for (const fid of ALL_FACET_IDS) {
    const def = SEMANTIC_FACETS[fid];
    const tagUpper = def.tag.toUpperCase();

    // Match by [FACET:<ID>] in question; entries are newest first, so a re-charted facet wins.
    const matchedEntry = entries.find((e) => e.question.toUpperCase().includes(tagUpper));

    if (!matchedEntry) {
      facets[fid] = {
        id: fid,
        name: def.name,
        tag: def.tag,
        status: "missing",
        files: [],
      };
      missing.push(fid);
      continue;
    }

    const isNotApplicable = isNotApplicableAnswer(matchedEntry.details);

    // Backing files must exist and still hash to what capn recorded; capn prunes a changed one.
    const { missingFiles, staleFiles } = entryFreshness(root, matchedEntry);

    if (matchedEntry.files.length === 0 || missingFiles.length > 0 || staleFiles.length > 0) {
      facets[fid] = {
        id: fid,
        name: def.name,
        tag: def.tag,
        status: "drifted",
        entryId: matchedEntry.id,
        question: matchedEntry.question,
        details: matchedEntry.details,
        files: matchedEntry.files,
        missingFiles,
        ...(staleFiles.length > 0 ? { staleFiles } : {}),
      };
      drifted.push(fid);
    } else if (isNotApplicable) {
      facets[fid] = {
        id: fid,
        name: def.name,
        tag: def.tag,
        status: "not_applicable",
        entryId: matchedEntry.id,
        question: matchedEntry.question,
        details: matchedEntry.details,
        files: matchedEntry.files,
      };
      activeCount += 1;
    } else {
      facets[fid] = {
        id: fid,
        name: def.name,
        tag: def.tag,
        status: "active",
        entryId: matchedEntry.id,
        question: matchedEntry.question,
        details: matchedEntry.details,
        files: matchedEntry.files,
      };
      activeCount += 1;
    }
  }

  const completion = `${activeCount}/5`;
  const percentage = Math.round((activeCount / 5) * 100);

  let overallStatus: "healthy" | "incomplete" | "drifted" | "empty" = "healthy";
  if (drifted.length > 0) {
    overallStatus = "drifted";
  } else if (activeCount === 5) {
    overallStatus = "healthy";
  } else if (activeCount === 0) {
    overallStatus = "empty";
  } else {
    overallStatus = "incomplete";
  }

  return {
    waymark: 1,
    kind: "semantic_map",
    status: overallStatus,
    completion,
    activeCount,
    totalFacets: 5,
    percentage,
    facets,
    missing,
    drifted,
  };
}

/**
 * Render token-minimal plain text formatted Semantic Map health.
 */
export function renderSemanticMapStatus(status: SemanticMapStatus, options?: { recommendation?: boolean }): string {
  const lines: string[] = [];
  lines.push(`[semantic-map: ${status.completion} facets active (${status.percentage}%)]`);

  for (const fid of ALL_FACET_IDS) {
    const f = status.facets[fid];
    if (f.status === "active") {
      const filesDesc = f.files.length > 0 ? ` (${f.files.join(", ")})` : "";
      lines.push(`- ${fid}: active${filesDesc}`);
    } else if (f.status === "not_applicable") {
      lines.push(`- ${fid}: not_applicable (${f.files.join(", ")})`);
    } else if (f.status === "drifted") {
      const reasons = [
        ...(f.missingFiles && f.missingFiles.length > 0 ? [`[missing: ${f.missingFiles.join(", ")}]`] : []),
        ...(f.staleFiles && f.staleFiles.length > 0 ? [`[changed: ${f.staleFiles.join(", ")}]`] : []),
      ];
      lines.push(`- ${fid}: drifted ${reasons.length > 0 ? reasons.join(" ") : "[no files cited]"}`);
    } else {
      lines.push(`- ${fid}: missing`);
    }
  }

  if (options?.recommendation === false) {
    // The caller prints its own next step (bootstrap and heal output).
  } else if (status.status === "uninitialized") {
    lines.push(`Recommendation: Run 'waymark memory init' (MCP: waymark_memory(action: "init")) to initialize lexical recall; bootstrap only collects unverified drafts.`);
  } else if (status.status === "drifted") {
    lines.push(`Recommendation: Run 'waymark memory heal' (MCP: waymark_memory(action: "heal")) to prune drifted facets and collect replacement drafts, verify them, then chart supported claims with 'waymark memory chart' (MCP: waymark_memory(action: "chart", facet: "<id>")).`);
  } else if (status.status !== "healthy") {
    lines.push(`Recommendation: Run 'waymark memory bootstrap' (MCP: waymark_memory(action: "bootstrap")) to collect unverified drafts, verify them, then chart supported claims with 'waymark memory chart' (MCP: waymark_memory(action: "chart", facet: "<id>")).`);
  }

  return lines.join("\n");
}

export interface ScaffoldedFacetDraft {
  id: SemanticFacetId;
  question: string;
  answer: string;
  files: string[];
  status: "draft";
  evidence: Array<{ file: string; line: number; excerpt: string }>;
}

export interface BootstrapResult {
  waymark: 1;
  kind: "bootstrap";
  ok: boolean;
  status: SemanticMapStatus;
  scaffolded: ScaffoldedFacetDraft[];
  published: false;
  chartErrors?: string[];
}

const MAX_DRAFT_EVIDENCE = 6;
const MAX_EXCERPT_LENGTH = 240;
/** Most candidate files a facet draft cites. */
const MAX_DRAFT_FILES = 3;
/** Most source files bootstrap reads when it ranks candidates. */
const MAX_SCANNED_SOURCES = 400;
const MAX_SCANNED_BYTES = 256 * 1024;

/** Imports, re-exports, and module headers: they name dependencies but show no behavior. */
const IMPORT_LINE = /^(?:import\b|export\s+(?:type\s+)?[*{]|from\s+\S+\s+import\b|use\s|package\s|#include\b|(?:const|let|var)\s+[^=]+=\s*require\s*\(|require\s*\()/u;
const COMMENT_LINE = /^(?:\/\/|\/\*|\*|#|"""|''')/u;
/** Declarations a file exposes to other modules (TypeScript/JavaScript, Python, Go, Rust). */
const EXPORTED_DECLARATION = [
  /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\b|class\b|interface\b|type\b|enum\b|const\b|let\b|var\b)/u,
  /^\s*(?:module\.)?exports\b/u,
  /^(?:async\s+)?def\s+[A-Za-z]|^class\s+[A-Za-z]/u,
  /^func\s+(?:\([^)]*\)\s*)?[A-Z]|^type\s+[A-Z]/u,
  /^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\b/u,
];

/** Lowercase words of a line, with camelCase and snake_case identifiers split apart. */
function lineWords(line: string): string[] {
  return (line.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/gu) ?? []).map((word) => word.toLowerCase());
}

function countChar(text: string, char: string): number {
  return text.split(char).length - 1;
}

interface EvidenceLine {
  line: number;
  excerpt: string;
  hits: number;
  score: number;
}

/**
 * A line's code with its regex, string, and template literals blanked, so a keyword spelled inside
 * a literal (an error message, a keyword table, a pattern) is not evidence. Quotes are written as
 * \x22/\x27/\x60 because codedb-core 2.1.1 misreads a quote inside a regex literal.
 */
function codeOnly(line: string): string {
  return line
    .replace(/(^|[=(:,[!&|?;{}]|\breturn)\s*\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\])+\/[a-z]*/gu, "$1 ")
    .replace(/\x22(?:\\.|[^\x22\\])*\x22|\x27(?:\\.|[^\x27\\])*\x27|\x60(?:\\.|[^\x60\\])*\x60/gu, " ");
}

/** Every code line of a file that names a facet keyword or is an exported declaration. */
function scanFacetLines(text: string, keywords: string[]): EvidenceLine[] {
  const matches: EvidenceLine[] = [];
  const seen = new Set<string>();
  let importCloser: string | undefined;
  text.split(/\r?\n/u).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (importCloser) {
      if (trimmed.includes(importCloser)) importCloser = undefined;
      return;
    }
    if (!trimmed || COMMENT_LINE.test(trimmed)) return;
    if (IMPORT_LINE.test(trimmed)) {
      // A multi-line import list is skipped until it closes.
      if (countChar(trimmed, "{") > countChar(trimmed, "}")) importCloser = "}";
      else if (countChar(trimmed, "(") > countChar(trimmed, ")")) importCloser = ")";
      return;
    }
    const words = lineWords(codeOnly(trimmed));
    const hits = keywords.filter((keyword) => words.some((word) => word.startsWith(keyword))).length;
    const exported = EXPORTED_DECLARATION.some((pattern) => pattern.test(raw));
    if (hits === 0 && !exported) return;
    const excerpt = trimmed.slice(0, MAX_EXCERPT_LENGTH);
    if (seen.has(excerpt)) return;
    seen.add(excerpt);
    matches.push({ line: index + 1, excerpt, hits, score: hits + (exported ? 2 : 0) });
  });
  return matches;
}

/**
 * Picks the lines of a file that bear on a facet: the lines naming the most facet keywords,
 * exported declarations first among equals. A file with no keyword line falls back to its
 * exported declarations. Imports, comments, and blank lines never count as evidence.
 * Returns at most `limit` lines, in file order.
 */
function selectFacetEvidence(lines: EvidenceLine[], limit: number): Array<{ line: number; excerpt: string }> {
  const keywordLines = lines.filter((match) => match.hits > 0);
  return (keywordLines.length > 0 ? keywordLines : lines)
    .slice()
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, limit)
    .sort((a, b) => a.line - b.line)
    .map(({ line, excerpt }) => ({ line, excerpt }));
}

/**
 * File-name hints per facet, matched against the words of a path (`src/stateDir.ts` -> src, state,
 * dir). A hinted file ranks higher, and is a candidate even without keyword lines.
 */
const FACET_PATH_HINTS: Record<SemanticFacetId, Set<string>> = {
  lifecycle: new Set(["bin", "cmd", "index", "main", "cli", "app", "daemon", "start", "boot", "bootstrap", "entry", "lifecycle"]),
  data_state: new Set(["store", "stores", "storage", "db", "database", "cache", "state", "persist", "persistence", "repo", "repository", "model", "models", "schema", "migration", "migrations", "memory"]),
  boundaries: new Set(["server", "client", "api", "ipc", "rpc", "http", "https", "socket", "daemon", "mcp", "route", "routes", "router", "handler", "handlers", "transport", "protocol", "net", "bridge", "gateway"]),
  invariants: new Set(["path", "paths", "integrity", "security", "valid", "validate", "validation", "validator", "validators", "guard", "guards", "sanitize", "sanitizer", "auth", "util", "utils", "normalize", "invariant", "invariants"]),
  failure: new Set(["error", "errors", "exception", "exceptions", "types", "fail", "failure", "retry", "recover", "recovery", "fallback"]),
};
/** How many keyword lines a file named for the facet is worth. */
const PATH_HINT_WEIGHT = 3;

function pathHinted(fid: SemanticFacetId, file: string): boolean {
  const hints = FACET_PATH_HINTS[fid];
  return lineWords(file.slice(0, file.length - path.extname(file).length)).some((word) => hints.has(word));
}

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt",
  ".rb", ".php", ".cs", ".swift", ".c", ".h", ".cpp", ".hpp", ".cc", ".scala", ".lua", ".zig", ".ex", ".exs",
  ".sol", ".sh", ".bash",
]);

function isTestSource(file: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec|testing|benchmarks?|benches|examples|fixtures|testdata)\//iu.test(file)
    || /(?:[._-]test|[._-]spec|[._-]bench)\.[^/]+$/iu.test(file);
}

/** Entry files the package manifest names (`main`, `module`, every `bin`, string `exports`), in that order. */
function manifestEntries(root: string): string[] {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];
  let pkg: { main?: unknown; bin?: unknown; exports?: unknown; module?: unknown };
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return [];
  }
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") out.push(value.replace(/^\.\//u, ""));
    else if (value && typeof value === "object") for (const inner of Object.values(value)) add(inner);
  };
  add(pkg.main);
  add(pkg.module);
  add(pkg.bin);
  add(pkg.exports);
  return [...new Set(out)];
}

interface CandidateFile {
  file: string;
  text: string;
  depth: number;
  isEntry: boolean;
}

/**
 * The repository's own source files, entry files first: manifest entries, conventional entry
 * names, then every other non-test source file by depth. Test files and dependency or build
 * folders never qualify.
 */
async function collectCandidateSources(root: string, isRepositoryFile: (file: string) => boolean): Promise<CandidateFile[]> {
  const { collectRepoPaths } = await import("./discoveryRouter.js");
  const conventional = ["src/index.ts", "src/cli.ts", "src/main.ts", "index.ts", "index.js", "main.go", "app.py", "main.py", "src/lib.rs", "src/main.rs"];
  const entries = [...manifestEntries(root), ...conventional].filter(isRepositoryFile);
  const entrySet = new Set(entries);
  const sources = collectRepoPaths(root)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()) && !file.endsWith(".d.ts") && !isTestSource(file))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  const ordered = [...new Set([...entries, ...sources])].slice(0, MAX_SCANNED_SOURCES);
  const out: CandidateFile[] = [];
  for (const file of ordered) {
    if (!isRepositoryFile(file)) continue;
    try {
      const real = resolveRepositoryFile(root, file).real;
      if (fs.statSync(real).size > MAX_SCANNED_BYTES) continue;
      out.push({ file, text: fs.readFileSync(real, "utf8"), depth: file.split("/").length, isEntry: entrySet.has(file) });
    } catch {
      // unreadable: not a candidate
    }
  }
  return out;
}

/**
 * Up to MAX_DRAFT_FILES files for a facet. Files whose code names the facet's keywords win, the
 * most keyword lines first, with a file named for the facet worth PATH_HINT_WEIGHT more (an entry
 * file breaks ties). With no keyword line anywhere, files named for the facet are cited by their
 * exported declarations, or, when no file is named for it, the entry files.
 */
function rankFacetFiles(fid: SemanticFacetId, sources: CandidateFile[]): Array<{ file: string; lines: EvidenceLine[] }> {
  const keywords = SEMANTIC_FACETS[fid].evidenceKeywords;
  const scanned = sources.map((source) => {
    const lines = scanFacetLines(source.text, keywords);
    const keywordLines = lines.filter((line) => line.hits > 0).length;
    const hinted = pathHinted(fid, source.file);
    return { ...source, lines, keywordLines, hinted, rank: keywordLines + (hinted ? PATH_HINT_WEIGHT : 0) };
  });
  const byKeywords = scanned
    .filter((s) => s.keywordLines > 0)
    .sort((a, b) =>
      b.rank - a.rank
      || Number(b.hinted) - Number(a.hinted)
      || Number(b.isEntry) - Number(a.isEntry)
      || a.depth - b.depth
      || a.file.localeCompare(b.file));
  if (byKeywords.length > 0) return byKeywords.slice(0, MAX_DRAFT_FILES);
  const hinted = scanned.filter((s) => s.hinted && s.lines.length > 0);
  return (hinted.length > 0 ? hinted : scanned.filter((s) => s.isEntry && s.lines.length > 0)).slice(0, MAX_DRAFT_FILES);
}

/** Drafts for `facets`, each citing the facet's best candidate files and their evidence lines. */
async function scaffoldFacetDrafts(root: string, facets: SemanticFacetId[]): Promise<ScaffoldedFacetDraft[]> {
  if (facets.length === 0) return [];
  const isRepositoryFile = (file: string): boolean => {
    try { resolveRepositoryFile(root, file); return true; } catch { return false; }
  };
  const sources = await collectCandidateSources(root, isRepositoryFile);
  const scaffolded: ScaffoldedFacetDraft[] = [];
  // Collect evidence only; filenames and package metadata do not establish architecture.
  for (const fid of facets) {
    const def = SEMANTIC_FACETS[fid];
    const ranked = rankFacetFiles(fid, sources);
    const perFile = Math.ceil(MAX_DRAFT_EVIDENCE / Math.max(1, ranked.length));
    const evidence = ranked
      .flatMap(({ file, lines }) => selectFacetEvidence(lines, perFile).map((line) => ({ file, ...line })))
      .slice(0, MAX_DRAFT_EVIDENCE);
    // A candidate file with nothing relevant to the facet is not cited.
    const files = ranked.map((r) => r.file).filter((file) => evidence.some((line) => line.file === file));
    if (evidence.length > 0) {
      scaffolded.push({
        id: fid,
        question: def.canonicalQuestion,
        answer: "Unverified draft. Review the cited source excerpts and replace this note before charting.",
        files,
        status: "draft",
        evidence,
      });
    }
  }
  return scaffolded;
}

/**
 * Collects source excerpts as unverified candidates for every missing or drifted facet. Read-only:
 * it never charts, prunes, or writes a memory entry. Only an agent or developer can validate the
 * excerpts and chart an architectural claim.
 */
export async function bootstrapSemanticMap(
  root: string,
  options?: { subsystem?: string; executable?: string }
): Promise<BootstrapResult> {
  if (options?.subsystem?.trim()) throw new WaymarkError("UNSUPPORTED_SUBSYSTEM", "Subsystem-scoped semantic maps are not supported; bootstrap the repository root or omit --subsystem.");

  const currentStatus = getSemanticMapStatus(root);
  const scaffolded = await scaffoldFacetDrafts(root, [...currentStatus.missing, ...currentStatus.drifted]);

  return {
    waymark: 1,
    kind: "bootstrap",
    ok: true,
    status: getSemanticMapStatus(root),
    scaffolded,
    published: false,
  };
}

export interface HealResult {
  waymark: 1;
  kind: "heal";
  ok: boolean;
  dryRun: boolean;
  /** Drifted facet entries removed (or, with dryRun, that would be removed). */
  pruned: Array<{ facet: SemanticFacetId; id: string; missingFiles: string[]; staleFiles: string[] }>;
  status: SemanticMapStatus;
  scaffolded: ScaffoldedFacetDraft[];
  published: false;
  errors?: string[];
}

/**
 * Repairs the map's drift: unchart each drifted facet entry (its backing files vanished or
 * changed, so it no longer answers), then collect replacement drafts for every missing or drifted
 * facet. With `dryRun`, reports what would be uncharted and changes nothing. Never charts a claim.
 */
export async function healSemanticMap(
  root: string,
  options?: { dryRun?: boolean; subsystem?: string; executable?: string }
): Promise<HealResult> {
  if (options?.subsystem?.trim()) throw new WaymarkError("UNSUPPORTED_SUBSYSTEM", "Subsystem-scoped semantic maps are not supported; heal the repository root or omit --subsystem.");
  const dryRun = Boolean(options?.dryRun);
  const before = getSemanticMapStatus(root);
  const pruned: HealResult["pruned"] = [];
  const errors: string[] = [];
  for (const fid of before.drifted) {
    const facet = before.facets[fid];
    if (!facet.entryId) continue;
    if (!dryRun) {
      const removed = await unchart(root, options?.executable ?? "", facet.entryId, true);
      if (!removed.ok) {
        errors.push(`${fid} (${facet.entryId}): ${String(removed.error ?? removed.output ?? "unchart failed")}`);
        continue;
      }
    }
    pruned.push({ facet: fid, id: facet.entryId, missingFiles: facet.missingFiles ?? [], staleFiles: facet.staleFiles ?? [] });
  }
  const scaffolded = await scaffoldFacetDrafts(root, [...before.missing, ...before.drifted]);
  return {
    waymark: 1,
    kind: "heal",
    ok: errors.length === 0,
    dryRun,
    pruned,
    status: getSemanticMapStatus(root),
    scaffolded,
    published: false,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/** Longest charted question and answer, shared by the CLI and MCP chart paths. */
export const MAX_CHART_QUESTION_CHARS = 240;
export const MAX_CHART_ANSWER_CHARS = 4000;

const FACET_TAG = /\[FACET:([^\]]*)\]/giu;

/**
 * The charted question with exactly one canonical `[FACET:<ID>]` tag, and that facet. A `facet`
 * argument and a tag embedded in the question are matched case-insensitively and must name the
 * same facet from ALL_FACET_IDS.
 */
export function normalizeFacetQuestion(question: string, facet?: string): { question: string; facet?: SemanticFacetId } {
  const embedded = [...question.matchAll(FACET_TAG)].map((m) => (m[1] ?? "").trim().toLowerCase());
  const requested = facet?.trim().toLowerCase() || undefined;
  const named = [...new Set([...(requested ? [requested] : []), ...embedded])];
  for (const id of named) {
    if (!ALL_FACET_IDS.includes(id as SemanticFacetId)) {
      throw new WaymarkError("INVALID_ARGUMENT", `Unknown facet "${id}". Allowed facets: ${ALL_FACET_IDS.join(", ")}.`);
    }
  }
  if (named.length > 1) {
    throw new WaymarkError("INVALID_ARGUMENT", `A chart entry belongs to one facet; got ${named.join(", ")}.`);
  }
  const id = named[0] as SemanticFacetId | undefined;
  const bare = question.replace(FACET_TAG, " ").replace(/\s+/gu, " ").trim();
  if (!id) return { question: bare };
  return { question: `${SEMANTIC_FACETS[id].tag} ${bare}`.trim(), facet: id };
}

function boundedChartText(value: string, maximum: number, label: string): string {
  if (value.length === 0 || Array.from(value).length > maximum) {
    throw new WaymarkError("TEXT_LIMIT", `${label} must contain 1 to ${maximum} characters`);
  }
  return value;
}

export interface ChartMemoryResult {
  waymark: 1;
  kind: "chart";
  published: boolean;
  adapter: AdapterProfile;
  output: string;
  error?: string;
  question: string;
  facet?: SemanticFacetId;
  /** Earlier entries for the same facet that this chart replaced. */
  replaced?: string[];
}

/**
 * Chart one entry the way both `waymark memory chart` and `waymark_memory(action: "chart")` do:
 * bounded text, a validated facet tag, backing files that exist inside the repository, and, for a
 * facet, the facet's earlier entries uncharted once the new entry is published, so the map holds
 * one answer per facet.
 */
export async function chartMemoryEntry(
  root: string,
  profile: AdapterProfile,
  executable: string,
  input: { question: string; answer: string; facet?: string; files: string[] },
): Promise<ChartMemoryResult> {
  const normalized = normalizeFacetQuestion(input.question.trim(), input.facet);
  const bareQuestion = normalized.question.replace(FACET_TAG, "").trim();
  // A facet tag alone is a valid question; otherwise the question text is bounded like the CLI.
  if (!normalized.facet || bareQuestion) boundedChartText(bareQuestion, MAX_CHART_QUESTION_CHARS, "question");
  const answer = boundedChartText(input.answer.trim(), MAX_CHART_ANSWER_CHARS, "answer");
  const question = normalized.question;

  // Anti-Hallucination Guard for facets
  if (normalized.facet) validateFacetBackingFiles(root, input.files, isNotApplicableAnswer(answer));

  const result = await publish(root, profile, executable, question, answer, input.files);
  const base: ChartMemoryResult = {
    waymark: 1,
    kind: "chart",
    published: result.published,
    adapter: result.adapter,
    output: result.output,
    ...(result.error ? { error: result.error } : {}),
    question,
    ...(normalized.facet ? { facet: normalized.facet } : {}),
  };
  if (!result.published || !normalized.facet) return base;

  const tag = SEMANTIC_FACETS[normalized.facet].tag.toUpperCase();
  const previous = readChartedEntries(root).filter((e) => e.question.toUpperCase().includes(tag) && e.question !== question);
  const replaced: string[] = [];
  for (const entry of previous) {
    const removed = await unchart(root, executable, entry.id, true);
    if (removed.ok) replaced.push(entry.id);
  }
  return replaced.length > 0 ? { ...base, replaced } : base;
}

/** The Markdown architecture report of `waymark memory export` / `waymark_memory(action: "export")`. */
export function renderSemanticMapExport(status: SemanticMapStatus): string {
  const lines = [
    `# Architecture Consensus Map`,
    `**Generated by Waymark Engine** | Status: ${status.status} (${status.completion} facets active)`,
    "",
  ];
  for (const [id, f] of Object.entries(status.facets)) {
    lines.push(`## Facet: ${f.name} (\`${id}\`)`);
    lines.push(`- **Status**: ${f.status}`);
    lines.push(`- **Files**: ${f.files.join(", ") || "None"}`);
    if (f.details) {
      lines.push("");
      lines.push(f.details);
      lines.push("");
    }
  }
  return lines.join("\n");
}
