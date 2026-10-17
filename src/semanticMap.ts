import fs from "node:fs";
import path from "node:path";
import { repoRoot, resolveRepositoryFile } from "./paths.js";
import { memoryStoreDir, MEMORY_STORE_LABEL } from "./stateDir.js";
import { WaymarkError } from "./types.js";

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

export interface ParsedCapnEntry {
  id: string;
  at?: string;
  files: string[];
  question: string;
  details: string;
}

/**
 * Directly read charted entries from the memory store's entries directory.
 * Fast, synchronous, zero-subprocess overhead.
 */
export function readChartedEntries(root: string): ParsedCapnEntry[] {
  const entriesDir = path.join(memoryStoreDir(root), "entries");
  if (!fs.existsSync(entriesDir)) return [];

  const entries: ParsedCapnEntry[] = [];
  try {
    const files = fs.readdirSync(entriesDir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const fullPath = path.join(entriesDir, file);
      try {
        const content = fs.readFileSync(fullPath, "utf8");
        if (!content.startsWith("---\n")) continue;
        const closeIdx = content.indexOf("\n---\n", 4);
        if (closeIdx === -1) continue;

        const frontmatter = content.slice(4, closeIdx);
        const body = content.slice(closeIdx + 5);

        let id = path.basename(file, ".md");
        let at: string | undefined;
        const fileList: string[] = [];

        const fmLines = frontmatter.split("\n");
        let inFilesSection = false;

        for (const line of fmLines) {
          if (line.startsWith("id: ")) {
            id = line.slice(4).trim();
          } else if (line.startsWith("at: ")) {
            at = line.slice(4).trim();
          } else if (line.startsWith("files:")) {
            inFilesSection = true;
          } else if (inFilesSection) {
            if (line.startsWith("  ")) {
              const trimmed = line.trim();
              const colonIdx = trimmed.indexOf(":");
              if (colonIdx !== -1) {
                let filePath = trimmed.slice(0, colonIdx).trim();
                if (filePath.startsWith('"') && filePath.endsWith('"')) {
                  try {
                    filePath = JSON.parse(filePath);
                  } catch {
                    filePath = filePath.slice(1, -1);
                  }
                }
                if (filePath) fileList.push(filePath);
              }
            } else if (line.trim().length > 0) {
              inFilesSection = false;
            }
          }
        }

        // Parse Question and Details from body
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

        entries.push({
          id,
          at,
          files: fileList,
          question,
          details,
        });
      } catch {
        // Skip unparseable files
      }
    }
  } catch {
    return [];
  }
  return entries;
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
      message: `Consensus memory store (${MEMORY_STORE_LABEL}) is uninitialized. Run 'waymark memory init' to initialize it; bootstrap only collects unverified source-evidence drafts.`,
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

    // Match by [FACET:<ID>] in question
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

    const detailsLower = matchedEntry.details.toLowerCase();
    const isNotApplicable =
      detailsLower.includes("status: not_applicable") ||
      detailsLower.includes("status: 'not_applicable'") ||
      detailsLower.includes('status: "not_applicable"') ||
      detailsLower.includes("not_applicable");

    // Check backing files
    const missingFiles: string[] = [];
    for (const f of matchedEntry.files) {
      try { resolveRepositoryFile(root, f); } catch { missingFiles.push(f); }
    }

    if (matchedEntry.files.length === 0 || missingFiles.length > 0) {
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
export function renderSemanticMapStatus(status: SemanticMapStatus): string {
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
      const missingDesc = f.missingFiles && f.missingFiles.length > 0 ? ` [missing: ${f.missingFiles.join(", ")}]` : " [no files cited]";
      lines.push(`- ${fid}: drifted${missingDesc}`);
    } else {
      lines.push(`- ${fid}: missing`);
    }
  }

  if (status.status === "uninitialized") {
    lines.push(`Recommendation: Run 'waymark memory init' to initialize lexical recall; bootstrap only collects unverified drafts.`);
  } else if (status.status !== "healthy") {
    lines.push(`Recommendation: Run 'waymark memory bootstrap' to collect unverified drafts, verify them, then chart supported claims with 'waymark memory chart'.`);
  }

  return lines.join("\n");
}

export interface BootstrapResult {
  waymark: 1;
  kind: "bootstrap";
  ok: boolean;
  dryRun: boolean;
  status: SemanticMapStatus;
  scaffolded: Array<{
    id: SemanticFacetId;
    question: string;
    answer: string;
    files: string[];
    status: "draft";
    evidence: Array<{ file: string; line: number; excerpt: string }>;
  }>;
  published: false;
  chartErrors?: string[];
}

const MAX_DRAFT_EVIDENCE = 6;
const MAX_EXCERPT_LENGTH = 240;

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

/**
 * Picks the lines of a file that bear on a facet: the lines naming the most facet keywords,
 * exported declarations first among equals. A file with no keyword line falls back to its
 * exported declarations. Imports, comments, and blank lines never count as evidence.
 * Returns at most `limit` lines, in file order.
 */
function selectFacetEvidence(text: string, keywords: string[], limit: number): Array<{ line: number; excerpt: string }> {
  const matches: Array<{ line: number; excerpt: string; hits: number; score: number }> = [];
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
    const words = lineWords(trimmed);
    const hits = keywords.filter((keyword) => words.some((word) => word.startsWith(keyword))).length;
    const exported = EXPORTED_DECLARATION.some((pattern) => pattern.test(raw));
    if (hits === 0 && !exported) return;
    const excerpt = trimmed.slice(0, MAX_EXCERPT_LENGTH);
    if (seen.has(excerpt)) return;
    seen.add(excerpt);
    matches.push({ line: index + 1, excerpt, hits, score: hits + (exported ? 2 : 0) });
  });
  const keywordLines = matches.filter((match) => match.hits > 0);
  return (keywordLines.length > 0 ? keywordLines : matches)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, limit)
    .sort((a, b) => a.line - b.line)
    .map(({ line, excerpt }) => ({ line, excerpt }));
}

/**
 * Collects source excerpts as unverified candidates. Only an agent or developer
 * can validate these excerpts and chart an architectural claim.
 */
export async function bootstrapSemanticMap(
  root: string,
  options?: { dryRun?: boolean; subsystem?: string; executable?: string }
): Promise<BootstrapResult> {
  const dryRun = Boolean(options?.dryRun);
  const executable = options?.executable ?? "";
  if (options?.subsystem?.trim()) throw new WaymarkError("UNSUPPORTED_SUBSYSTEM", "Subsystem-scoped semantic maps are not supported; bootstrap the repository root or omit --subsystem.");

  const isRepositoryFile = (file: string): boolean => {
    try { resolveRepositoryFile(root, file); return true; } catch { return false; }
  };

  const currentStatus = getSemanticMapStatus(root);
  const missingFacets = currentStatus.missing;

  // Pass 1: Harvest repository metadata & inspect file layout
  let pkgInfo: { name?: string; description?: string; main?: string; bin?: Record<string, string> | string } = {};
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      pkgInfo = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      // Ignore JSON error
    }
  }

  const candidateEntries = [
    pkgInfo.main,
    typeof pkgInfo.bin === "string" ? pkgInfo.bin : (pkgInfo.bin ? Object.values(pkgInfo.bin)[0] : undefined),
    "src/index.ts",
    "src/cli.ts",
    "src/main.ts",
    "index.ts",
    "main.go",
    "app.py",
    "src/lib.rs",
  ].filter((f): f is string => typeof f === "string" && isRepositoryFile(f));

  const candidateStorage = [
    "src/capnAdapter.ts",
    "src/storage.ts",
    "src/db.ts",
    "src/database.ts",
    "src/store.ts",
  ].filter(isRepositoryFile);

  const candidateBoundaries = [
    "src/daemon.ts",
    "src/mcp/server.ts",
    "src/server.ts",
    "src/ipc.ts",
    "src/api.ts",
  ].filter(isRepositoryFile);

  const candidateInvariants = [
    "src/paths.ts",
    "src/integrity.ts",
    "src/security.ts",
    "src/utils.ts",
  ].filter(isRepositoryFile);

  const candidateFailures = [
    "src/types.ts",
    "src/errors.ts",
    "src/error.ts",
  ].filter(isRepositoryFile);

  const candidates: Record<SemanticFacetId, string[]> = {
    lifecycle: candidateEntries.length ? candidateEntries.slice(0, 3) : (isRepositoryFile("package.json") ? ["package.json"] : []),
    data_state: candidateStorage.length ? candidateStorage.slice(0, 3) : (isRepositoryFile("package.json") ? ["package.json"] : []),
    boundaries: candidateBoundaries.length ? candidateBoundaries.slice(0, 3) : (isRepositoryFile("package.json") ? ["package.json"] : []),
    invariants: candidateInvariants.length ? candidateInvariants.slice(0, 3) : candidateEntries.slice(0, 2),
    failure: candidateFailures.length ? candidateFailures.slice(0, 3) : candidateEntries.slice(0, 2),
  };
  const scaffolded: BootstrapResult["scaffolded"] = [];

  // Collect evidence only; filenames and package metadata do not establish architecture.
  for (const fid of missingFacets) {
    const def = SEMANTIC_FACETS[fid];
    const candidateFiles = [...new Set(candidates[fid])].filter(isRepositoryFile);
    const perFile = Math.ceil(MAX_DRAFT_EVIDENCE / Math.max(1, candidateFiles.length));
    const evidence = candidateFiles.flatMap((file) => {
      const text = fs.readFileSync(resolveRepositoryFile(root, file).real, "utf8");
      return selectFacetEvidence(text, def.evidenceKeywords, perFile).map((line) => ({ file, ...line }));
    }).slice(0, MAX_DRAFT_EVIDENCE);
    // A candidate file with nothing relevant to the facet is not cited.
    const files = candidateFiles.filter((file) => evidence.some((line) => line.file === file));
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

  const updatedStatus = getSemanticMapStatus(root);

  return {
    waymark: 1,
    kind: "bootstrap",
    ok: true,
    dryRun,
    status: updatedStatus,
    scaffolded,
    published: false,
  };
}
