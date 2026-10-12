import path from "node:path";
import fs from "node:fs";
import { collectRepoPaths } from "./discoveryRouter.js";
import { WaymarkError } from "./types.js";

export type TopologyCategory =
  | "CORE_SOURCE"
  | "TEST_HARNESS"
  | "RECORDED_WORKSPACES"
  | "BUILD_ARTIFACTS"
  | "DOCS_METADATA"
  | "CONFIG_INFRA"
  | "VENDOR_DEPENDENCIES";

export type ScopeLevel = "wide" | "medium" | "narrow" | "custom";
export type ScopeAction = "analyze" | "set" | "get" | "clear" | "export";

export interface ScopeCategorySummary {
  category: TopologyCategory;
  fileCount: number;
  estimatedTokens: number;
  samplePaths: string[];
}

export interface ScopePresetDefinition {
  name: ScopeLevel;
  label: string;
  description: string;
  recommended?: boolean;
  includePatterns: string[];
  excludePatterns: string[];
}

export interface ScopeAnalysis {
  root: string;
  totalFiles: number;
  totalEstimatedTokens: number;
  categories: Record<TopologyCategory, ScopeCategorySummary>;
  topSubsystems: Array<{ name: string; fileCount: number; category: TopologyCategory }>;
  presets: {
    wide: ScopePresetDefinition;
    medium: ScopePresetDefinition;
    narrow: ScopePresetDefinition;
  };
  interactivePrompt: {
    question: string;
    options: Array<{
      level: ScopeLevel;
      label: string;
      description: string;
      recommended?: boolean;
    }>;
  };
}

export interface ScopeFence {
  sessionId?: string;
  root: string;
  level: ScopeLevel;
  includePatterns: string[];
  excludePatterns: string[];
  createdAt: string;
}

// In-memory session store (concurrency-safe, zero disk mutation)
const sessionFences = new Map<string, ScopeFence>();
let defaultFence: ScopeFence | null = null;

/**
 * Classifies any relative repository path into a universal architectural category.
 */
export function classifyPath(relPath: string): TopologyCategory {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = norm.toLowerCase();
  const parts = lower.split("/");
  const first = parts[0] || "";
  const fileName = parts[parts.length - 1] || "";

  // 1. Vendor & System dependencies
  if (
    first === "node_modules" ||
    first === "vendor" ||
    first === "third_party" ||
    first === ".git" ||
    first === ".capn" ||
    first === ".waymark" ||
    first === ".venv" ||
    first === "venv" ||
    first === "__pycache__"
  ) {
    return "VENDOR_DEPENDENCIES";
  }

  // 2. Automated execution runs, trace recordings, and agent/CI workspaces
  const isExecutionWorkspace =
    first === "runs" ||
    first === "logs" ||
    first === "traces" ||
    first === "sessions" ||
    first === "workspaces" ||
    first === "eval" ||
    first === "evals" ||
    first === "experiments" ||
    first === "evidence" ||
    first === "reports" ||
    first === "results" ||
    first === "recordings" ||
    first === "artifacts" ||
    first === "scratch" ||
    first === "tmp" ||
    first === "temp" ||
    /(?:^|[-_])(runs?|traces?|sessions?|evals?|logs?|results?|recordings?)(?:$|[-_])/i.test(first) ||
    /^run(?:[-_]|\d)/i.test(first);

  if (isExecutionWorkspace) {
    return "RECORDED_WORKSPACES";
  }

  // 3. Build & compilation artifacts
  if (
    first === "dist" ||
    first === "build" ||
    first === "out" ||
    first === "target" ||
    first === ".next" ||
    first === ".nuxt" ||
    first === "coverage" ||
    fileName.endsWith(".tsbuildinfo") ||
    fileName.endsWith(".log")
  ) {
    return "BUILD_ARTIFACTS";
  }

  // 4. Test harness, fixtures & benchmarks
  if (
    first === "test" ||
    first === "tests" ||
    first === "__tests__" ||
    first === "e2e" ||
    first === "e2e-playwright" ||
    first === "benchmarks" ||
    first === "spec" ||
    fileName.endsWith(".test.ts") ||
    fileName.endsWith(".spec.ts") ||
    fileName.endsWith(".test.js") ||
    fileName.endsWith(".spec.js") ||
    fileName.endsWith(".test.mjs") ||
    fileName.endsWith("_test.go") ||
    fileName.endsWith("_test.rs") ||
    fileName.startsWith("test_") ||
    fileName.endsWith("_test.py")
  ) {
    return "TEST_HARNESS";
  }

  // 5. Documentation & metadata
  if (
    first === "docs" ||
    first === "doc" ||
    first === "documentation" ||
    first === "architecture" ||
    first === "specs" ||
    fileName.endsWith(".md") ||
    fileName.endsWith(".mdx") ||
    fileName.endsWith(".rst") ||
    fileName.endsWith(".txt") ||
    fileName.endsWith(".adoc") ||
    fileName === "license" ||
    fileName === "licensing.md" ||
    fileName === "notice.md" ||
    fileName === "changelog.md" ||
    fileName === "contributing.md" ||
    fileName === "readme.md"
  ) {
    return "DOCS_METADATA";
  }

  // 6. Primary source directories (always CORE_SOURCE even if containing embedded config/types)
  if (
    first === "src" ||
    first === "pkg" ||
    first === "lib" ||
    first === "core" ||
    first === "app" ||
    first === "internal"
  ) {
    return "CORE_SOURCE";
  }

  // 7. Configuration & infrastructure
  if (
    fileName.startsWith(".") ||
    fileName === "package.json" ||
    fileName === "tsconfig.json" ||
    fileName === "go.mod" ||
    fileName === "go.sum" ||
    fileName === "cargo.toml" ||
    fileName === "cargo.lock" ||
    fileName === "dockerfile" ||
    fileName === "makefile" ||
    fileName.endsWith(".json") ||
    fileName.endsWith(".yaml") ||
    fileName.endsWith(".yml") ||
    fileName.endsWith(".toml") ||
    fileName.endsWith(".ini") ||
    fileName.endsWith(".cfg")
  ) {
    return "CONFIG_INFRA";
  }

  // 8. Default to core source code
  return "CORE_SOURCE";
}

/**
 * Heuristic token estimation per category:
 * - Recorded workspaces: typically bloated json/session logs (~8,000 tokens/file)
 * - Source code: ~1,500 tokens/file
 * - Test harness: ~1,000 tokens/file
 * - Documentation: ~800 tokens/file
 * - Config: ~300 tokens/file
 * - Build/Vendor: ~5,000 tokens/file
 */
function estimateCategoryTokens(cat: TopologyCategory, count: number): number {
  switch (cat) {
    case "RECORDED_WORKSPACES":
      return count * 8_000;
    case "CORE_SOURCE":
      return count * 1_500;
    case "TEST_HARNESS":
      return count * 1_000;
    case "DOCS_METADATA":
      return count * 800;
    case "BUILD_ARTIFACTS":
      return count * 4_000;
    case "VENDOR_DEPENDENCIES":
      return count * 3_000;
    case "CONFIG_INFRA":
      return count * 300;
  }
}

/**
 * Evaluates whether a relative path matches a glob pattern (supports *, **, exact).
 */
export function matchesPattern(relPath: string, pattern: string): boolean {
  const normPath = relPath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  const normPat = pattern.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

  if (normPat === "**/*" || normPat === "*") return true;

  // Suffix glob: e.g. **/*.test.ts or *.ts
  if (normPat.startsWith("**/*.")) {
    const ext = normPat.slice(4);
    return normPath.endsWith(ext);
  }
  if (normPat.startsWith("*.")) {
    const ext = normPat.slice(1);
    return normPath.endsWith(ext) && !normPath.includes("/");
  }

  // Directory glob: e.g. *runs/**, dist/**
  if (normPat.endsWith("/**")) {
    const prefixPat = normPat.slice(0, -3);
    const firstSegment = normPath.split("/")[0] ?? normPath;
    if (prefixPat.startsWith("*")) {
      const suffix = prefixPat.slice(1);
      if (firstSegment.endsWith(suffix)) return true;
    } else {
      if (normPath === prefixPat || normPath.startsWith(prefixPat + "/")) return true;
    }
  }

  // Directory prefix with trailing slash: e.g. test/
  if (normPat.endsWith("/")) {
    const prefix = normPat.slice(0, -1);
    return normPath.startsWith(prefix + "/");
  }

  // Exact path or basename match
  if (normPath === normPat) return true;
  if (!normPat.includes("/") && normPath.split("/").pop() === normPat) return true;

  return false;
}

/**
 * Checks whether a repository path falls within the active scope fence.
 */
export function isPathInScope(relPath: string, fence: ScopeFence | null): boolean {
  if (!fence) return true;

  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");

  // 1. Explicit exclude patterns take precedence
  for (const pat of fence.excludePatterns) {
    if (matchesPattern(norm, pat)) {
      return false;
    }
  }

  // 2. If includePatterns specified, path must match at least one
  if (fence.includePatterns.length > 0 && !fence.includePatterns.includes("**/*")) {
    let included = false;
    for (const pat of fence.includePatterns) {
      if (matchesPattern(norm, pat)) {
        included = true;
        break;
      }
    }
    return included;
  }

  return true;
}

/**
 * Analyzes repository structure, topology, token gravity, and produces tailored presets.
 */
export function analyzeScope(root: string): ScopeAnalysis {
  const allPaths = collectRepoPaths(root);

  const categories: Record<TopologyCategory, ScopeCategorySummary> = {
    CORE_SOURCE: { category: "CORE_SOURCE", fileCount: 0, estimatedTokens: 0, samplePaths: [] },
    TEST_HARNESS: { category: "TEST_HARNESS", fileCount: 0, estimatedTokens: 0, samplePaths: [] },
    RECORDED_WORKSPACES: { category: "RECORDED_WORKSPACES", fileCount: 0, estimatedTokens: 0, samplePaths: [] },
    BUILD_ARTIFACTS: { category: "BUILD_ARTIFACTS", fileCount: 0, estimatedTokens: 0, samplePaths: [] },
    DOCS_METADATA: { category: "DOCS_METADATA", fileCount: 0, estimatedTokens: 0, samplePaths: [] },
    CONFIG_INFRA: { category: "CONFIG_INFRA", fileCount: 0, estimatedTokens: 0, samplePaths: [] },
    VENDOR_DEPENDENCIES: { category: "VENDOR_DEPENDENCIES", fileCount: 0, estimatedTokens: 0, samplePaths: [] },
  };

  const subsystemCounts = new Map<string, { count: number; categoryCounts: Map<TopologyCategory, number> }>();

  for (const p of allPaths) {
    const cat = classifyPath(p);
    const summary = categories[cat];
    summary.fileCount++;
    if (summary.samplePaths.length < 5) {
      summary.samplePaths.push(p);
    }

    // Tally top-level directory subsystem
    const parts = p.split("/");
    const top = parts.length > 1 ? parts[0]! : (p.includes(".") ? "root" : p);
    let existing = subsystemCounts.get(top);
    if (!existing) {
      existing = { count: 0, categoryCounts: new Map<TopologyCategory, number>() };
      subsystemCounts.set(top, existing);
    }
    existing.count++;
    existing.categoryCounts.set(cat, (existing.categoryCounts.get(cat) ?? 0) + 1);
  }

  let totalTokens = 0;
  for (const cat of Object.keys(categories) as TopologyCategory[]) {
    const s = categories[cat];
    s.estimatedTokens = estimateCategoryTokens(cat, s.fileCount);
    totalTokens += s.estimatedTokens;
  }

  const topSubsystems = Array.from(subsystemCounts.entries())
    .map(([name, val]) => {
      const dominantCategory = Array.from(val.categoryCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "CORE_SOURCE";
      return { name, fileCount: val.count, category: dominantCategory };
    })
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 10);

  // Identify core source root patterns (e.g. "src/**", "pkg/**", "lib/**")
  const sourceFolders = topSubsystems
    .filter((s) => s.category === "CORE_SOURCE" && s.name !== "root")
    .map((s) => `${s.name}/**`);
  const srcIdx = sourceFolders.indexOf("src/**");
  if (srcIdx > 0) {
    sourceFolders.splice(srcIdx, 1);
    sourceFolders.unshift("src/**");
  }
  const primarySourceFolder = sourceFolders[0] ?? "src/**";

  // Dynamically extract detected directories by category from the actual repo structure
  const detectedWorkspaceDirs = topSubsystems
    .filter((s) => s.category === "RECORDED_WORKSPACES" && s.name !== "root")
    .map((s) => `${s.name}/**`);

  const detectedArtifactDirs = topSubsystems
    .filter((s) => s.category === "BUILD_ARTIFACTS" && s.name !== "root")
    .map((s) => `${s.name}/**`);

  const detectedTestDirs = topSubsystems
    .filter((s) => s.category === "TEST_HARNESS" && s.name !== "root")
    .map((s) => `${s.name}/**`);

  const detectedDocDirs = topSubsystems
    .filter((s) => s.category === "DOCS_METADATA" && s.name !== "root")
    .map((s) => `${s.name}/**`);

  // Universal patterns applicable across automated build & test ecosystems
  const universalWorkspaces = [
    "*runs/**",
    "*traces/**",
    "*sessions/**",
    "*logs/**",
    "*evals/**",
    "*results/**",
    "runs/**",
    "traces/**",
    "sessions/**",
    "workspaces/**",
    "eval/**",
    "experiments/**",
  ];

  const universalArtifacts = [
    "dist/**",
    "build/**",
    "out/**",
    "target/**",
    "node_modules/**",
    "vendor/**",
    "**/*.tsbuildinfo",
    "**/*.log",
  ];

  const universalTests = [
    "test/**",
    "tests/**",
    "__tests__/**",
    "e2e/**",
    "benchmarks/**",
    "spec/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*_test.*",
  ];

  const universalDocs = [
    "docs/**",
    "doc/**",
    "documentation/**",
    "architecture/**",
    "**/*.md",
    "**/*.mdx",
  ];

  const commonExcludes = [
    ...new Set([
      ...detectedWorkspaceDirs,
      ...detectedArtifactDirs,
      ...universalWorkspaces,
      ...universalArtifacts,
    ]),
  ];

  // Build tailored presets
  const wide: ScopePresetDefinition = {
    name: "wide",
    label: "Wide (Comprehensive)",
    description: "Includes core source, test suites, and documentation. Strictly excludes recorded workspaces, build outputs, and vendor trees.",
    includePatterns: ["**/*"],
    excludePatterns: commonExcludes,
  };

  const medium: ScopePresetDefinition = {
    name: "medium",
    label: "Medium (Core Source Only)",
    description: "Focuses strictly on application source code. Excludes recorded workspaces, test harnesses, documentation, and build outputs.",
    recommended: true,
    includePatterns: sourceFolders.length > 0 ? sourceFolders : ["src/**", "pkg/**", "lib/**", "*.*"],
    excludePatterns: [
      ...new Set([
        ...commonExcludes,
        ...detectedTestDirs,
        ...detectedDocDirs,
        ...universalTests,
        ...universalDocs,
      ]),
    ],
  };

  const narrow: ScopePresetDefinition = {
    name: "narrow",
    label: "Narrow (Single Subsystem)",
    description: `Strictly isolates primary subsystem '${primarySourceFolder}'. Filters all sibling packages, tests, documentation, and recorded runs.`,
    includePatterns: [primarySourceFolder],
    excludePatterns: [
      ...new Set([
        ...commonExcludes,
        ...detectedTestDirs,
        ...detectedDocDirs,
        ...universalTests,
        ...universalDocs,
      ]),
    ],
  };

  const interactivePrompt = {
    question: `Repository contains ${allPaths.length} files (~${Math.round(totalTokens / 1000)}k estimated tokens). Which scoping boundary should be established?`,
    options: [
      {
        level: "medium" as ScopeLevel,
        label: "(Recommended) Medium: Scope strictly to core source code",
        description: "Excludes test suites, documentation, build outputs, and recorded worker workspaces.",
        recommended: true,
      },
      {
        level: "wide" as ScopeLevel,
        label: "Wide: Include core source, test harness, and architecture documentation",
        description: "Excludes recorded worker workspaces and build outputs.",
      },
      {
        level: "narrow" as ScopeLevel,
        label: `Narrow: Focus strictly on '${primarySourceFolder}' subsystem`,
        description: "Isolates the single highest-gravity module for minimal token overhead.",
      },
    ],
  };

  return {
    root,
    totalFiles: allPaths.length,
    totalEstimatedTokens: totalTokens,
    categories,
    topSubsystems,
    presets: { wide, medium, narrow },
    interactivePrompt,
  };
}

/**
 * Sets an active scope fence in-memory (session-isolated) or globally.
 */
export function setScopeFence(
  root: string,
  level: ScopeLevel,
  options?: {
    sessionId?: string;
    includePatterns?: string[];
    excludePatterns?: string[];
  }
): ScopeFence {
  const analysis = analyzeScope(root);
  let includePatterns: string[] = [];
  let excludePatterns: string[] = [];

  if (level === "wide") {
    includePatterns = analysis.presets.wide.includePatterns;
    excludePatterns = analysis.presets.wide.excludePatterns;
  } else if (level === "medium") {
    includePatterns = analysis.presets.medium.includePatterns;
    excludePatterns = analysis.presets.medium.excludePatterns;
  } else if (level === "narrow") {
    includePatterns = analysis.presets.narrow.includePatterns;
    excludePatterns = analysis.presets.narrow.excludePatterns;
  } else if (level === "custom") {
    includePatterns = options?.includePatterns ?? ["**/*"];
    excludePatterns = options?.excludePatterns ?? [];
  }

  // Merge custom overrides if provided alongside a preset
  if (options?.includePatterns && level !== "custom") {
    includePatterns = [...new Set([...includePatterns, ...options.includePatterns])];
  }
  if (options?.excludePatterns && level !== "custom") {
    excludePatterns = [...new Set([...excludePatterns, ...options.excludePatterns])];
  }

  const fence: ScopeFence = {
    sessionId: options?.sessionId,
    root,
    level,
    includePatterns,
    excludePatterns,
    createdAt: new Date().toISOString(),
  };

  if (options?.sessionId) {
    sessionFences.set(options.sessionId, fence);
  } else {
    defaultFence = fence;
  }

  return fence;
}

/**
 * Retrieves the currently active scope fence.
 */
export function getScopeFence(root: string, sessionId?: string): ScopeFence | null {
  if (sessionId && sessionFences.has(sessionId)) {
    return sessionFences.get(sessionId)!;
  }
  if (defaultFence && defaultFence.root === root) {
    return defaultFence;
  }
  return null;
}

/**
 * Clears an active scope fence.
 */
export function clearScopeFence(sessionId?: string): boolean {
  if (sessionId) {
    return sessionFences.delete(sessionId);
  }
  if (defaultFence) {
    defaultFence = null;
    return true;
  }
  return false;
}

/**
 * Exports gitignore-compatible rules based on active or specified scope.
 */
export function exportScopeIgnore(root: string, fence?: ScopeFence | null): string {
  const active = fence ?? defaultFence ?? setScopeFence(root, "medium");
  const lines: string[] = [
    `# ==============================================================================`,
    `# .waymarkignore - Generated by Waymark Scope Engine`,
    `# Scope Level: ${active.level.toUpperCase()} | Generated: ${active.createdAt}`,
    `# ==============================================================================`,
    ``,
    `# Active Exclude Rules:`,
  ];

  for (const pat of active.excludePatterns) {
    lines.push(pat);
  }

  if (active.includePatterns.length > 0 && !active.includePatterns.includes("**/*")) {
    lines.push(``);
    lines.push(`# Included Scope Boundaries:`);
    for (const inc of active.includePatterns) {
      lines.push(`!${inc}`);
    }
  }

  return lines.join("\n") + "\n";
}

/**
 * Primary dispatch entrypoint for waymark_scope actions.
 */
export async function handleScopeAction(
  root: string,
  args: {
    action: ScopeAction;
    level?: ScopeLevel;
    session_id?: string;
    include?: string[];
    exclude?: string[];
    plain?: boolean;
  }
): Promise<Record<string, unknown>> {
  const { action, level = "medium", session_id, include, exclude } = args;

  if (action === "analyze") {
    const analysis = analyzeScope(root);
    return {
      waymark: 1,
      kind: "scope",
      action: "analyze",
      ok: true,
      analysis,
    };
  }

  if (action === "set") {
    const fence = setScopeFence(root, level, {
      sessionId: session_id,
      includePatterns: include,
      excludePatterns: exclude,
    });
    return {
      waymark: 1,
      kind: "scope",
      action: "set",
      ok: true,
      fence,
      message: `Active scope established at level '${fence.level}'${session_id ? ` for session '${session_id}'` : ""}. ${fence.excludePatterns.length} exclude patterns active.`,
    };
  }

  if (action === "get") {
    const fence = getScopeFence(root, session_id);
    if (!fence) {
      return {
        waymark: 1,
        kind: "scope",
        action: "get",
        ok: true,
        fence: null,
        message: "No active scope fence is currently set (unbounded repository access).",
      };
    }
    return {
      waymark: 1,
      kind: "scope",
      action: "get",
      ok: true,
      fence,
    };
  }

  if (action === "clear") {
    const cleared = clearScopeFence(session_id);
    return {
      waymark: 1,
      kind: "scope",
      action: "clear",
      ok: true,
      cleared,
      message: cleared
        ? `Scope fence cleared${session_id ? ` for session '${session_id}'` : ""}. Unbounded repository access restored.`
        : "No active scope fence was found to clear.",
    };
  }

  if (action === "export") {
    const fence = getScopeFence(root, session_id);
    const content = exportScopeIgnore(root, fence);
    return {
      waymark: 1,
      kind: "scope",
      action: "export",
      ok: true,
      content,
    };
  }

  throw new WaymarkError("UNKNOWN_ACTION", `Unknown scope action: ${action}. Allowed: analyze | set | get | clear | export`);
}
