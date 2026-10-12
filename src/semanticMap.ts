import fs from "node:fs";
import path from "node:path";
import { repoRoot, resolveRepositoryFile } from "./paths.js";
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
}

export const SEMANTIC_FACETS: Record<SemanticFacetId, FacetDefinition> = {
  lifecycle: {
    id: "lifecycle",
    tag: "[FACET:LIFECYCLE]",
    name: "Entrypoints & Runtime Lifecycle",
    canonicalQuestion: "[FACET:LIFECYCLE] What are the primary executable entrypoints, daemon lifecycles, and bootstrapping sequences?",
    description: "Executable wrappers, daemon servers, root index modules, bootstrap sequence.",
    targetFilesSummary: "bin/*, src/index.ts, src/cli.ts, src/daemon.ts",
  },
  data_state: {
    id: "data_state",
    tag: "[FACET:DATA_STATE]",
    name: "Data Flow & Storage",
    canonicalQuestion: "[FACET:DATA_STATE] How is data, state, or cache stored, synchronized, and persisted on disk?",
    description: "Storage adapters, SQLite databases, file caches, state stores, migrations.",
    targetFilesSummary: "src/capnAdapter.ts, database schemas, cache managers",
  },
  boundaries: {
    id: "boundaries",
    tag: "[FACET:BOUNDARIES]",
    name: "Cross-Boundary Glue",
    canonicalQuestion: "[FACET:BOUNDARIES] What boundary protocols (Named Pipes, Unix Sockets, HTTP, RPC, SQL) connect internal modules or external services?",
    description: "Boundary protocols, IPC bridges, API endpoints, protocol clients.",
    targetFilesSummary: "src/daemon.ts, src/mcp/*, IPC bridges",
  },
  invariants: {
    id: "invariants",
    tag: "[FACET:INVARIANTS]",
    name: "Chesterton's Fences & Non-Obvious Rules",
    canonicalQuestion: "[FACET:INVARIANTS] What non-obvious security, path normalization, or OS-specific invariants must not be violated?",
    description: "Path normalizers, platform guards, security sanitizers, fail-closed checks.",
    targetFilesSummary: "src/paths.ts, src/integrity.ts",
  },
  failure: {
    id: "failure",
    tag: "[FACET:FAILURE]",
    name: "Fail-Closed & Error Recovery",
    canonicalQuestion: "[FACET:FAILURE] How does the system fail closed on misses and recover from uninitialized, corrupted, or degraded states?",
    description: "Fail-closed policy, error registries, typed exception classes, recovery fallback.",
    targetFilesSummary: "src/types.ts, error handlers",
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
 * Directly read charted entries from .capn/entries directory.
 * Fast, synchronous, zero-subprocess overhead.
 */
export function readChartedEntries(root: string): ParsedCapnEntry[] {
  const entriesDir = path.join(root, ".capn", "entries");
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
  const capnConfig = path.join(root, ".capn", "config.json");
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
      message: "Consensus memory store (.capn) is uninitialized. Run 'waymark memory init' or 'waymark memory bootstrap'.",
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

  if (status.status !== "healthy") {
    lines.push(`Recommendation: Run 'waymark memory bootstrap' or chart missing facets via 'waymark memory chart'.`);
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
    const files = candidates[fid].filter(isRepositoryFile);
    const evidence = files.flatMap((file) => {
      const text = fs.readFileSync(resolveRepositoryFile(root, file).real, "utf8");
      return text.split(/\r?\n/u).flatMap((line, index) => line.trim() ? [{ file, line: index + 1, excerpt: line.trim().slice(0, 240) }] : []).slice(0, 3);
    }).slice(0, 6);
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
