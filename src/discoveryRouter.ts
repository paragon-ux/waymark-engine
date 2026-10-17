import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { classifyTokenShape, rankFzf } from "./fuzzyMatcher.js";
import { queryStructural, queryFuzzyCandidates } from "./codedbAdapter.js";
import { PrefixTrie } from "./prefixTrie.js";
import { tryDaemonResolvePath } from "./daemon.js";
import { ensureStateDir, stateDir, MEMORY_STORE_LABEL } from "./stateDir.js";
import {
  AskHitResult,
  AskJunctionResult,
  AskMissResult,
  AskOptions,
  AskResult,
  DevDiagnostics,
  DiscoveryTier,
  FuzzyCandidate,
  FuzzyScoreResult,
  JunctionOption,
  WaymarkError,
  LiteralMatch,
  LiteralMatchKind,
} from "./types.js";

export type { LiteralMatch, LiteralMatchKind };

export { classifyTokenShape };

export interface AstIntent {
  requiresParser: boolean;
  tool: "trace_path" | "search_graph" | "get_architecture";
  functionName?: string;
  query?: string;
  /** search_graph: a dotted query never widens to its bare name (`mutex.lock` stays `mutex.lock`). */
  strictQualified?: boolean;
}

// ---------------------------------------------------------------------------
// Tier 2: literal filename / path router (deterministic, zero-dependency)
//
// Bridges the filename blind spot inherited from BM25 tokenization: a bare
// literal like "sample.ts", "src/api/webhooks.ts", ".gitignore", or "Dockerfile"
// never reaches the statistical engine. Matching is a fail-closed rule cascade
// (never guess on ambiguity) over an in-memory, memoized path array.
// ---------------------------------------------------------------------------

const LITERAL_EXTENSIONS = new Set<string>([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "cts", "mts", "py", "pyi", "ipynb",
  "go", "rs", "java", "kt", "kts", "scala", "c", "h", "cpp", "hpp", "cc",
  "cxx", "m", "cs", "rb", "php", "swift", "sh", "bash", "zsh", "fish", "ps1",
  "bat", "cmd", "lua", "zig", "dart", "el", "ex", "exs", "elm", "ml", "mli",
  "res", "sol", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg",
  "conf", "properties", "editorconfig", "md", "mdx", "rst", "txt", "adoc",
  "css", "scss", "sass", "less", "svg", "xml", "html", "graphql", "gql",
  "proto", "prisma", "csv", "tsv", "tf", "tfvars", "hcl", "mod", "sum", "lock",
  "mk", "sql",
]);

const NO_EXT_FILENAMES = new Set<string>([
  "dockerfile", "makefile", "jenkinsfile", "procfile", "justfile",
]);

export interface LiteralIntent {
  isLiteral: boolean;
  normalized: string;
  isExplicitPath: boolean;
  /**
   * A literal that is also a qualified identifier (`mutex.lock`, `response.json`, `db.sql`):
   * its "extension" may be a method name, so when no file matches, the router looks it up as a symbol.
   */
  couldBeSymbol: boolean;
}

const DOTTED_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+(?:\(\))?$/u;

export function detectLiteralIntent(question: string): LiteralIntent {
  const q = question.trim().replace(/^['"`]+|['"`]+$/g, "");
  const normalized = q.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();

  const hasSep = normalized.includes("/");
  const hasExplicitPrefix = q.startsWith("./") || q.startsWith(".\\") || q.startsWith("/");
  const extMatch = lower.match(/\.([a-z0-9]+)[?!.,;)]*$/);
  const hasExt = extMatch !== null && LITERAL_EXTENSIONS.has(extMatch[1] ?? "");
  const leadingDot = lower.startsWith(".");
  const noExt = NO_EXT_FILENAMES.has(lower);

  const isExplicitPath = hasSep || hasExplicitPrefix;
  const isLiteral = hasSep || hasExt || leadingDot || noExt;

  return { isLiteral, normalized, isExplicitPath, couldBeSymbol: isLiteral && !isExplicitPath && hasExt && DOTTED_IDENTIFIER.test(q) };
}

export function detectAstIntent(question: string): AstIntent {
  const q = question.trim();
  const lower = q.toLowerCase();

  // 1. Architecture / Entrypoints intent
  const isNarrativeQuestion =
    /^(explain|describe|how|why|tell\s+me)\b/i.test(q) ||
    (/^what\s+is\b/i.test(q) && !/(?:entry\s*point|main\s+entry|architecture)/i.test(q));

  const architectureMatch =
    (!isNarrativeQuestion &&
      (
        lower === "architecture" ||
        lower === "architecture?" ||
        /\b(repo|codebase|project|system)\s+architecture\b/i.test(q) ||
        /\b(show|get|display|dump)\s+(the\s+)?architecture\b/i.test(q) ||
        lower.includes("entrypoint") ||
        lower.includes("entry point") ||
        lower.includes("hotspots") ||
        lower.includes("high-level structure") ||
        lower.includes("overview of the repo") ||
        lower.includes("project topology")
      )) ||
    /\bwhat\s+(is|are)\s+(the\s+)?(main\s+)?entry\s*points?\b/i.test(q);

  if (architectureMatch) {
    return { requiresParser: true, tool: "get_architecture" };
  }

  // 2. Call-graph / Tracing intent
  const traceMatch =
    lower.includes("who calls") ||
    lower.includes("callers of") ||
    lower.includes("callees of") ||
    lower.includes("trace path") ||
    lower.includes("trace ") ||
    lower.includes("what calls") ||
    /\bwhat does \w+ call\b/i.test(lower) ||
    lower.includes("which functions call") ||
    lower.includes("call hierarchy");

  if (traceMatch) {
    const tokens = q.match(/[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g) || [];
    const stopWords = new Set([
      "who", "calls", "call", "what", "which", "functions", "trace", "path",
      "of", "in", "to", "the", "and", "is", "where", "function", "method", "does"
    ]);
    const candidates = tokens.filter(t => !stopWords.has(t.toLowerCase()) && t.length > 1);
    const rawTarget = candidates[candidates.length - 1] ?? candidates[0] ?? q;
    // A dotted name keeps its qualifier (`WaymarkDaemon.start`); queryStructural
    // drops it only when codedb has no such qualified name (`path.join`).
    const functionName = rawTarget.replace(/[?().]+$/g, "");

    return {
      requiresParser: true,
      tool: "trace_path",
      functionName,
    };
  }

  // 3. Symbol / Definition / Line range intent
  const symbolMatch =
    lower.includes("where is method") ||
    lower.includes("where is function") ||
    lower.includes("where is class") ||
    lower.includes("where is interface") ||
    lower.includes("find method") ||
    lower.includes("find function") ||
    lower.includes("definition of") ||
    lower.includes("declaration of") ||
    lower.includes("implementation of") ||
    lower.includes("declared in") ||
    lower.includes("defined in") ||
    lower.includes("line numbers of") ||
    lower.includes("ast node") ||
    lower.includes("method signature") ||
    lower.includes("find symbol") ||
    lower.includes("locate symbol") ||
    // A qualified name (`WaymarkDaemon.start`) is a symbol too.
    /\bwhere\s+is\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s+(declared|defined|implemented|located)\b/i.test(q) ||
    /\bwhere\s+is\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)\s*\??$/i.test(q) ||
    /\b(declared|defined|implemented)\s+in\b/i.test(q) ||
    /\b(declaration|definition|implementation)\s+of\b/i.test(q);

  if (symbolMatch) {
    const tokens = q.match(/[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g) || [];
    const stopWords = new Set([
      "where", "is", "are", "method", "function", "class", "interface", "definition", "declaration",
      "implementation", "of", "declared", "defined", "implemented", "located", "in", "the", "find",
      "symbol", "lines", "numbers", "locate", "signature"
    ]);
    const candidates = tokens.filter(t => !stopWords.has(t.toLowerCase()) && t.length > 1);
    const queryTerm = candidates[0] ?? q;

    return {
      requiresParser: true,
      tool: "search_graph",
      query: queryTerm.replace(/[?().]+$/g, ""),
    };
  }

  // 4. Bare identifier or method syntax (e.g. "computeSha256", "EventStore.verifyChain")
  // Exclude literal filenames and paths (e.g. "embed.go", "package.json", "src/foo.ts")
  const literalIntent = detectLiteralIntent(q);
  if (!literalIntent.isLiteral && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?(?:\(\))?\??$/.test(q)) {
    return {
      requiresParser: true,
      tool: "search_graph",
      query: q.replace(/[?().]+$/g, ""),
    };
  }

  return { requiresParser: false, tool: "search_graph" };
}

/** Directories skipped at any depth: dependencies, build output, and tool state. */
const SKIP_DIRS_ANY_DEPTH = new Set<string>([
  "node_modules", "dist", "out", "build", "coverage", "__pycache__", "venv", ".venv",
  ".git", ".capn", ".waymark", ".next", ".nuxt", ".qmd", ".codex", ".zed",
  // Tool state that never belongs in path results: upstream codedb, the codedb-core
  // fork, the capn-hook fork default store, and Claude Code, whose .claude/worktrees
  // holds whole checkouts that would make every basename ambiguous.
  ".codedb", ".codedb-core", ".capn-hook", ".claude",
]);

/**
 * Scratch and tool folders skipped only at the repository root. Nested folders with these names
 * (`src/waymark`, `src/claude`, `src/eval`) are ordinary source and stay visible.
 */
const SKIP_DIRS_ROOT_ONLY = new Set<string>([
  "next", "nuxt", "capn", "waymark", "qmd", "claude", "codex", "zed",
  "eval", "experiments", "evidence", "sandbox", "scratch", "tmp", "vendor",
]);

export function isSkippedDir(name: string, depth: number): boolean {
  return SKIP_DIRS_ANY_DEPTH.has(name) || (depth === 0 && SKIP_DIRS_ROOT_ONLY.has(name));
}

function canonicalRoot(r: string): string {
  return path.resolve(r).replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
}

let pathCache: { root: string; at: number; paths: string[] } | null = null;
let pathTrieCache: { root: string; at: number; trie: PrefixTrie } | null = null;

export function invalidatePathsCache(): void {
  const root = pathCache?.root || pathTrieCache?.root;
  if (root) {
    try { fs.unlinkSync(getCacheFilePath(root)); } catch {}
  }
  pathCache = null;
  pathTrieCache = null;
}

export function getRepoPrefixTrie(root: string, maxAgeMs = 60_000): PrefixTrie {
  const normRoot = canonicalRoot(root);
  if (pathTrieCache && pathTrieCache.root === normRoot && Date.now() - pathTrieCache.at < maxAgeMs) {
    return pathTrieCache.trie;
  }
  const paths = collectRepoPaths(root, maxAgeMs);
  const trie = new PrefixTrie(paths, Date.now());
  pathTrieCache = { root: normRoot, at: Date.now(), trie };
  return trie;
}

function getCacheFilePath(root: string): string {
  return path.join(stateDir(root), "paths.v3.cache");
}

export function collectRepoPaths(root: string, maxAgeMs = 60_000): string[] {
  const normRoot = canonicalRoot(root);
  if (pathCache && pathCache.root === normRoot && Date.now() - pathCache.at < maxAgeMs) {
    return pathCache.paths;
  }

  const cacheFile = getCacheFilePath(root);
  try {
    if (fs.existsSync(cacheFile)) {
      const stat = fs.statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < maxAgeMs) {
        const content = fs.readFileSync(cacheFile, "utf8");
        const lines = content.split("\n").filter(Boolean);
        if (lines.length > 0) {
          pathCache = { root: normRoot, at: stat.mtimeMs, paths: lines };
          return lines;
        }
      }
    }
  } catch {
    // Disk cache read failed; fall back to filesystem walk
  }

  const base = path.resolve(root);
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!isSkippedDir(ent.name, depth)) {
          walk(full, depth + 1);
        }
      } else if (ent.isFile()) {
        if (isSkippedFile(ent.name)) continue;
        out.push(path.relative(base, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(base, 0);

  pathCache = { root: normRoot, at: Date.now(), paths: out };

  try {
    if (process.env.WAYMARK_READ_ONLY !== "1") {
      ensureStateDir(root);
      fs.writeFileSync(cacheFile, out.join("\n"), "utf8");
    }
  } catch {
    // Fail silent if repository is read-only
  }

  return out;
}

function isSkippedFile(name: string): boolean {
  return name === ".DS_Store" || name.endsWith(".log") || name.endsWith(".tsbuildinfo");
}

export interface RepoWalkBudget {
  /** Give up once the walk finds more files than this. */
  maxFiles: number;
  /** Give up once the walk has run longer than this. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export type RepoWalkResult =
  | { complete: true; paths: string[] }
  | { complete: false; reason: "max-files" | "timeout" | "aborted"; scanned: number };

/**
 * Async, budgeted `collectRepoPaths`: same skip rules and path order, but it yields to the
 * event loop between directories and never returns a partial list. A truncated list would
 * make an ambiguous basename look unique, so over budget the walk is abandoned instead.
 * It reads and writes no path cache.
 */
export async function collectRepoPathsBounded(root: string, budget: RepoWalkBudget): Promise<RepoWalkResult> {
  const base = path.resolve(root);
  const deadline = Date.now() + budget.timeoutMs;
  const out: string[] = [];
  // Cast so control-flow analysis does not narrow it to null; the walk closure assigns it.
  let stopped = null as "max-files" | "timeout" | "aborted" | null;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (budget.signal?.aborted) stopped = "aborted";
    else if (Date.now() >= deadline) stopped = "timeout";
    if (stopped) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (stopped) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!isSkippedDir(ent.name, depth)) {
          await walk(full, depth + 1);
        }
      } else if (ent.isFile()) {
        if (isSkippedFile(ent.name)) continue;
        if (out.length >= budget.maxFiles) {
          stopped = "max-files";
          return;
        }
        out.push(path.relative(base, full).replace(/\\/g, "/"));
      }
    }
  };
  await walk(base, 0);
  return stopped ? { complete: false, reason: stopped, scanned: out.length } : { complete: true, paths: out };
}

export function matchLiteralPath(
  rawNormalized: string,
  paths: string[],
  isExplicitPath: boolean = false
): LiteralMatch[] {
  const isExplicit = isExplicitPath || rawNormalized.startsWith("./") || rawNormalized.startsWith(".\\");
  const normalized = rawNormalized.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  const baseName = lower.split("/").pop() ?? "";
  const basenames = paths.filter(
    (p) => (p.split("/").pop() ?? "").toLowerCase() === baseName
  );

  // If a bare basename query has multiple collision candidates across the repository,
  // refuse to arbitrarily select the root-level file unless explicitly qualified with ./
  if (!isExplicit && !normalized.includes("/") && basenames.length > 1) {
    return [];
  }

  const exact = paths.filter((p) => p.toLowerCase() === lower);
  if (exact.length > 0) {
    const strict = exact.find((p) => p === normalized);
    return strict
      ? [{ file: strict, kind: "exact" }]
      : exact.map((file) => ({ file, kind: "exact" }));
  }

  if (basenames.length === 1) {
    const file = basenames[0];
    if (file !== undefined) return [{ file, kind: "basename" }];
  }

  const suffixes = paths.filter((p) => p.toLowerCase().endsWith(lower));
  if (suffixes.length === 1) {
    const file = suffixes[0];
    if (file !== undefined) return [{ file, kind: "suffix" }];
  }

  const subs = paths.filter((p) => p.toLowerCase().includes(lower));
  if (subs.length === 1) {
    const file = subs[0];
    if (file !== undefined) return [{ file, kind: "substring" }];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Tier 3 & Discovery Junction (fuzzy ⇄ semantic)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "as", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "and", "or", "but", "not", "if", "then", "else", "when",
  "where", "why", "how", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "too", "very", "can", "will", "just",
  "should", "now", "what", "which", "who", "whom", "this", "that", "these",
  "those", "am", "module", "file", "function", "method", "class", "interface",
  "symbol", "declared", "defined", "implemented", "located", "find", "locate",
  "show", "get", "give", "tell", "me", "code", "work", "works",
  "call", "calls", "caller", "callers", "callee", "callees",
  "trace", "tracing", "hierarchy", "signature",
  "declaration", "declarations", "definition", "definitions",
  "implementation", "implementations", "entrypoint", "entrypoints",
]);

export function extractCandidateTokens(question: string): {
  shape: "identifier-like" | "narrative" | "mixed";
  candidateTokens: string[];
  plainTokens: string[];
} {
  // Preserve internal dots in compound identifiers like EventStore.verifyChain
  const cleaned = question
    .replace(/[?(),;:!'"\[\]{}<>\/\\`]/g, " ")
    .replace(/(?<![A-Za-z0-9_])\.|\.(?![A-Za-z0-9_])/g, " ");

  const rawWords = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);

  const candidateTokens: string[] = [];
  const plainTokens: string[] = [];

  for (const word of rawWords) {
    const shape = classifyTokenShape(word);
    if (shape === "identifier-like") {
      if (!candidateTokens.includes(word)) {
        candidateTokens.push(word);
      }
    } else {
      const lower = word.toLowerCase();
      if (!STOP_WORDS.has(lower) && word.length > 2) {
        if (!plainTokens.includes(word)) {
          plainTokens.push(word);
        }
      }
    }
  }

  const shape: "identifier-like" | "narrative" | "mixed" =
    candidateTokens.length > 0 ? "identifier-like" : "narrative";

  return { shape, candidateTokens, plainTokens };
}

/**
 * The names a file-scoped question filters that file's symbols by: the call-graph or definition
 * target when the question has one, else its identifier-shaped tokens, else its content words.
 * An empty question lists every symbol.
 */
function fileScopeTerms(question: string, astIntent: AstIntent): string[] {
  if (!question.trim()) return [];
  if (astIntent.functionName) return [astIntent.functionName];
  if (astIntent.query) return [astIntent.query];
  const { candidateTokens, plainTokens } = extractCandidateTokens(question);
  if (candidateTokens.length > 0) return candidateTokens;
  if (plainTokens.length > 0) return plainTokens;
  return [question.trim()];
}

export interface DiscoveryRouteContext {
  root: string;
  question: string;
  options?: AskOptions;
  codedbExecutable?: string;
  capnExecutable?: string;
  profile?: string;
  queryCapnMemory: (root: string, executable: string, question: string) => Promise<{ hit: boolean; result: unknown; error?: string; reason?: string; note?: string; pruned?: string[] }>;
  assertLexicalStore?: (root: string) => void;
  overrideCandidates?: FuzzyCandidate[];
}

async function routeDiscoveryCore(ctx: DiscoveryRouteContext): Promise<AskResult> {
  const {
    root,
    question,
    options,
    codedbExecutable,
    capnExecutable = "",
    queryCapnMemory,
    assertLexicalStore,
    overrideCandidates,
  } = ctx;
  if (options?.subsystem?.trim()) {
    throw new WaymarkError("UNSUPPORTED_SUBSYSTEM", "Subsystem-scoped discovery is not supported; query the repository root or omit subsystem.");
  }
  const startTime = performance.now();
  const timings: Record<string, number> = {};
  const isDev = Boolean(options?.dev);
  const recordTiming = isDev || (options?.timing ?? false);
  const autoResolve = options?.autoResolve ?? false;

  // Validate tier override if provided
  let tier: DiscoveryTier = options?.tier ?? "auto";
  if (options?.forceTier) {
    tier = options.forceTier === "fuzzy-lexical" ? "fuzzy" : "capn";
  }

  const validTiers = new Set<DiscoveryTier>(["auto", "ast", "path", "fuzzy", "capn"]);
  if (!validTiers.has(tier)) {
    throw new WaymarkError("INVALID_TIER_OVERRIDE", `Invalid tier: ${String(tier)}. Allowed: auto, ast, path, fuzzy, capn`);
  }

  // Facet routing & Semantic Repo Map status
  let effectiveQuestion = question;
  if (options?.facet) {
    const rawFacet = options.facet.toLowerCase().trim();
    if (rawFacet === "status") {
      const { getSemanticMapStatus } = await import("./semanticMap.js");
      const mapStatus = getSemanticMapStatus(root);
      if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
      return {
        waymark: 1,
        kind: "ask",
        status: "hit",
        provider: "capn-cli",
        confidence: "curated",
        result: mapStatus,
        ...(recordTiming ? { timings } : {}),
      };
    }
    const facetTag = `[FACET:${rawFacet.toUpperCase()}]`;
    effectiveQuestion = question.trim() ? `${facetTag} ${question.trim()}` : facetTag;
    if (tier === "auto") {
      tier = "capn";
    }
  }

  let astIntent = detectAstIntent(question);
  // A bare symbol asked with a traversal option is a call-graph question.
  if (astIntent.tool === "search_graph" && astIntent.query && (options?.depth !== undefined || options?.direction !== undefined)) {
    astIntent = { requiresParser: true, tool: "trace_path", functionName: astIntent.query };
  }

  // A question scoped to one file is answered from that file's symbols, never the whole repository.
  const scopedPath = typeof options?.path === "string" ? options.path.trim() : "";
  if (scopedPath && !options?.facet) {
    const { discoverSymbolsInFile } = await import("./astExtractor.js");
    const tScope0 = performance.now();
    const discovered = await discoverSymbolsInFile(root, scopedPath, options?.language);
    const terms = fileScopeTerms(question, astIntent);
    const symbols = terms.length === 0
      ? discovered.symbols
      : discovered.symbols.filter((s) => terms.some((t) => s.name.toLowerCase().includes(t.toLowerCase())));
    if (recordTiming) {
      timings.ast_ms = Math.round((performance.now() - tScope0) * 100) / 100;
      timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
    }
    if (symbols.length === 0) {
      return {
        waymark: 1,
        kind: "ask",
        status: "miss",
        provider: "codedb",
        missCode: "SYMBOL_NOT_FOUND",
        reason: `No symbols in ${discovered.path} match "${question}"${terms.length > 0 ? ` (terms: ${terms.join(", ")})` : ""}.`,
        matches: [],
        ...(recordTiming ? { timings } : {}),
      };
    }
    return {
      waymark: 1,
      kind: "ask",
      status: "hit",
      provider: "codedb",
      confidence: "exact",
      result: { ...discovered, symbols },
      ...(recordTiming ? { timings } : {}),
    };
  }

  // Tier 1: Structural AST check (codedb)
  const hasStructuralIntent = astIntent.requiresParser;

  if (tier === "auto" || tier === "ast") {
    const tAst0 = performance.now();
    if (hasStructuralIntent || tier === "ast") {
      const structuralIntent = hasStructuralIntent
        ? astIntent
        : { requiresParser: true, tool: "search_graph" as const, query: question };
      const astResult = await queryStructural(
        structuralIntent,
        root,
        codedbExecutable,
        options ? { depth: options.depth, direction: options.direction, excludeTests: options.excludeTests, autoDaemon: options.daemon } : undefined,
      );
      if (recordTiming) timings.ast_ms = Math.round((performance.now() - tAst0) * 100) / 100;

      if (astResult.hit) {
        if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
        return {
          waymark: 1,
          kind: "ask",
          status: "hit",
          provider: "codedb",
          confidence: "exact",
          result: astResult.output,
          ...(recordTiming ? { timings } : {}),
        };
      } else if (astResult.error) {
        return {
          waymark: 1,
          kind: "ask",
          status: "error",
          provider: "codedb",
          errorCode: /ENOENT|not found/iu.test(String(astResult.output)) ? "CODEDB_BINARY_MISSING" : /timeout/iu.test(String(astResult.output)) ? "CODEDB_PROCESS_TIMEOUT" : "CODEDB_PROCESS_ERROR",
          message: String(astResult.output),
          error: String(astResult.output),
          retryable: true,
          ...(recordTiming ? { timings } : {}),
        };
      } else if (tier === "ast") {
        if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
        return {
          waymark: 1,
          kind: "ask",
          status: "miss",
          provider: "codedb",
          missCode: "SYMBOL_NOT_FOUND",
          reason: `No structural symbol or call graph match found for "${question}".`,
          matches: [],
          ...(recordTiming ? { timings } : {}),
        };
      }
    }
  }

  // Tier 2: Literal filename / path check
  if (tier === "auto" || tier === "path") {
    const tPath0 = performance.now();
    const literal = detectLiteralIntent(question);
    if (literal.isLiteral || tier === "path") {
      let matches: LiteralMatch[] | null = null;
      try {
        matches = await tryDaemonResolvePath(root, literal.normalized, literal.isExplicitPath, 300);
      } catch {
        matches = null;
      }
      if (matches === null) {
        const trie = getRepoPrefixTrie(root);
        matches = trie.match(literal.normalized, literal.isExplicitPath);
      }
      if (recordTiming) timings.path_ms = Math.round((performance.now() - tPath0) * 100) / 100;

      if (matches.length > 0) {
        if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
        return {
          waymark: 1,
          kind: "ask",
          status: "hit",
          provider: "literal-path",
          confidence: "exact",
          result: matches.map((m) => `${m.file}\t[${m.kind}]`).join("\n"),
          ...(recordTiming ? { timings } : {}),
        };
      } else if (
        tier === "path" ||
        (tier === "auto" && literal.isLiteral)
      ) {
        const trie = getRepoPrefixTrie(root);
        const collisions = trie.collisions(literal.normalized);
        if (collisions.length > 1) {
          if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
          const files = collisions.map((m) => m.file);
          const kindLabel = collisions[0]?.kind === "basename" ? "basename" : `${collisions[0]?.kind ?? "path"} match`;
          return {
            waymark: 1,
            kind: "ask",
            status: "miss",
            provider: "literal-path",
            missCode: "AMBIGUOUS_PATH_COLLISION",
            reason: `Ambiguous ${kindLabel} collision for "${question}": found ${files.length} candidates (${files.slice(0, 5).join(", ")}${files.length > 5 ? "..." : ""}). Qualify the path explicitly (e.g. ./${files[0] ?? literal.normalized}).`,
            matches: collisions.slice(0, 10),
            ...(recordTiming ? { timings } : {}),
          };
        }
        // `mutex.lock`, `response.json`: no such file, so it is a qualified symbol, not a path.
        if (tier === "auto" && literal.couldBeSymbol) {
          const tSym0 = performance.now();
          const symbolResult = await queryStructural(
            { requiresParser: true, tool: "search_graph", query: question.trim().replace(/\(\)$/u, ""), strictQualified: true },
            root,
            codedbExecutable,
            { autoDaemon: options?.daemon },
          );
          if (recordTiming) timings.ast_ms = Math.round((performance.now() - tSym0) * 100) / 100;
          if (symbolResult.hit) {
            if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
            return {
              waymark: 1,
              kind: "ask",
              status: "hit",
              provider: "codedb",
              confidence: "exact",
              result: symbolResult.output,
              ...(recordTiming ? { timings } : {}),
            };
          }
        }
        if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
        return {
          waymark: 1,
          kind: "ask",
          status: "miss",
          provider: "literal-path",
          missCode: "SYMBOL_NOT_FOUND",
          reason: `No matching path found in repository for "${question}".`,
          matches: [],
          ...(recordTiming ? { timings } : {}),
        };
      }
    }
  }

  // Extract query signals
  const { shape, candidateTokens, plainTokens } = extractCandidateTokens(question);

  const getCandidates = async (token: string): Promise<FuzzyCandidate[]> => {
    if (overrideCandidates && overrideCandidates.length > 0) {
      return overrideCandidates;
    }
    return await queryFuzzyCandidates(token, root, codedbExecutable, { autoDaemon: Boolean(options?.daemon) });
  };

  // Branch 1: Forced Tier fuzzy
  if (tier === "fuzzy") {
    const tFuzzy0 = performance.now();
    const searchTokens = candidateTokens.length > 0 ? candidateTokens : (plainTokens.length > 0 ? plainTokens : [question.trim()]);
    let topFuzzy: FuzzyScoreResult | null = null;
    let matchedToken = "";

    for (const tok of searchTokens) {
      const cands = await getCandidates(tok);
      const scored = rankFzf(tok, cands);
      if (scored.length > 0 && scored[0]) {
        if (!topFuzzy || scored[0].score > topFuzzy.score) {
          topFuzzy = scored[0];
          matchedToken = tok;
        }
      }
    }
    if (recordTiming) timings.fuzzy_ms = Math.round((performance.now() - tFuzzy0) * 100) / 100;
    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;

    if (topFuzzy) {
      const resPayload = {
        name: topFuzzy.candidate.name,
        path: topFuzzy.candidate.path,
        line: topFuzzy.candidate.line,
        kind: topFuzzy.candidate.kind,
        score: topFuzzy.score,
        matchRanges: topFuzzy.matchRanges,
      };

      if (autoResolve) {
        return {
          waymark: 1,
          kind: "ask",
          status: "hit",
          provider: "fuzzy-lexical",
          confidence: "approximate",
          result: resPayload,
          ...(recordTiming ? { timings } : {}),
        };
      }

      const executedOption: JunctionOption = {
        tier: "fuzzy-lexical",
        recommended: true,
        executed: true,
        confidence: "approximate",
        result: resPayload,
        note: `Fuzzy lexical match for token '${matchedToken}' (tier override).`,
      };
      const alternativeOption: JunctionOption = {
        tier: "capn-cli",
        recommended: false,
        executed: false,
        result: null,
        note: "Not queried automatically — bypassed by forceTier.",
        continuation: {
          tool: "waymark_ask",
          args: { question, tier: "capn" },
          cliCommand: `waymark-ask "${question}" --tier capn`,
        },
      };

      return {
        waymark: 1,
        kind: "ask",
        status: "junction",
        query: question,
        signal: { shape, candidateTokens },
        options: [executedOption, alternativeOption],
        executedOption,
        alternativeOption,
        chartHint: "This answer can be charted with waymark_memory(action: \"chart\") (CLI: waymark-chart) regardless of which option resolved it.",
        recommendation: `Recommended tier: fuzzy-lexical. Found match '${topFuzzy.candidate.name}' in ${topFuzzy.candidate.path}:${topFuzzy.candidate.line}.`,
        tip: `To search charted semantic memory instead: waymark-ask "${question}" --tier capn`,
        ...(recordTiming ? { timings } : {}),
      };
    }

    return {
      waymark: 1,
      kind: "ask",
      status: "miss",
      provider: "fuzzy-lexical",
      missCode: "SYMBOL_NOT_FOUND",
      reason: `No fuzzy lexical match found for "${question}".`,
      matches: [],
      ...(recordTiming ? { timings } : {}),
    };
  }

  // Branch 2: Forced Tier capn
  if (tier === "capn") {
    const tCapn0 = performance.now();
    const capnRes = await queryCapnMemory(root, capnExecutable, effectiveQuestion);
    if (recordTiming) timings.capn_ms = Math.round((performance.now() - tCapn0) * 100) / 100;
    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;

    // A facet question scoped to a file only accepts a charted answer that cites that file.
    if (capnRes.hit && scopedPath) {
      const cited = (capnRes.result as { files?: unknown } | null)?.files;
      const wanted = scopedPath.replace(/\\/g, "/").replace(/^\.\//u, "");
      if (!Array.isArray(cited) || !cited.some((f) => typeof f === "string" && f.replace(/\\/g, "/") === wanted)) {
        return {
          waymark: 1,
          kind: "ask",
          status: "miss",
          provider: "capn-cli",
          missCode: "NO_CHARTED_MEMORY",
          reason: `Charted memory for "${effectiveQuestion}" does not cite ${wanted}.`,
          matches: [],
          ...(recordTiming ? { timings } : {}),
        };
      }
    }

    if (capnRes.hit) {
      if (autoResolve) {
        return {
          waymark: 1,
          kind: "ask",
          status: "hit",
          provider: "capn-cli",
          confidence: "curated",
          result: capnRes.result,
          ...(recordTiming ? { timings } : {}),
        };
      }

      const executedOption: JunctionOption = {
        tier: "capn-cli",
        recommended: true,
        executed: true,
        confidence: "curated",
        result: capnRes.result,
        note: "Queried charted memory via tier override.",
      };
      const alternativeOption: JunctionOption = {
        tier: "fuzzy-lexical",
        recommended: false,
        executed: false,
        result: null,
        note: "Not queried automatically — bypassed by forceTier.",
        continuation: {
          tool: "waymark_ask",
          args: { question, tier: "fuzzy" },
          cliCommand: `waymark-ask "${question}" --tier fuzzy`,
        },
      };

      return {
        waymark: 1,
        kind: "ask",
        status: "junction",
        query: question,
        signal: { shape, candidateTokens },
        options: [executedOption, alternativeOption],
        executedOption,
        alternativeOption,
        chartHint: "This answer can be charted with waymark_memory(action: \"chart\") (CLI: waymark-chart) regardless of which option resolved it.",
        recommendation: `Recommended tier: capn-cli. Queried charted memory for "${question}".`,
        tip: `To search code symbols fuzzily instead: waymark-ask "${question}" --tier fuzzy`,
        ...(recordTiming ? { timings } : {}),
      };
    }

    return {
      waymark: 1,
      kind: "ask",
      status: "miss",
      provider: "capn-cli",
      missCode: capnRes.reason === "STORE_UNINITIALIZED" || capnRes.reason === "CAPN_NON_DETERMINISTIC_MODE"
        ? capnRes.reason
        : "NO_CHARTED_MEMORY",
      reason: capnRes.reason === "STORE_UNINITIALIZED"
        ? capnRes.note || `Repository consensus memory is not initialized (${MEMORY_STORE_LABEL} missing). Run waymark_memory(action: "init") (CLI: waymark memory init) to enable Tier 4.`
        : (capnRes.reason === "CAPN_NON_DETERMINISTIC_MODE"
          ? capnRes.note || "Capn store is in embedding mode. Re-initialize with deterministic lexical mode."
          : `No charted memory found for "${question}".`),
      matches: [],
      ...(recordTiming ? { timings } : {}),
    };
  }

  // Branch 3: Auto Mode (Discovery Junction Cascade)
  // Stage 1: Identifier-shaped tokens -> fuzzy first
  let bestFuzzyResult: FuzzyScoreResult | null = null;
  let matchedToken = "";
  let fuzzyRanInStage1 = false;

  if (candidateTokens.length > 0) {
    const tFuzzy0 = performance.now();
    fuzzyRanInStage1 = true;
    for (const token of candidateTokens) {
      const cands = await getCandidates(token);
      const scored = rankFzf(token, cands);
      if (scored.length > 0 && scored[0] && scored[0].score >= 60) {
        if (hasStructuralIntent && astIntent.tool === "trace_path") {
          const kind = scored[0].candidate.kind?.toLowerCase();
          if (kind && kind !== "function" && kind !== "method") {
            continue;
          }
        }
        if (!bestFuzzyResult || scored[0].score > bestFuzzyResult.score) {
          bestFuzzyResult = scored[0];
          matchedToken = token;
        }
      }
    }
    if (recordTiming) timings.fuzzy_ms = Math.round((performance.now() - tFuzzy0) * 100) / 100;
  }

  if (bestFuzzyResult) {
    // Stage 1 Hit!
    const resPayload = {
      name: bestFuzzyResult.candidate.name,
      path: bestFuzzyResult.candidate.path,
      line: bestFuzzyResult.candidate.line,
      kind: bestFuzzyResult.candidate.kind,
      score: bestFuzzyResult.score,
      matchRanges: bestFuzzyResult.matchRanges,
    };

    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;

    if (autoResolve) {
      return {
        waymark: 1,
        kind: "ask",
        status: "hit",
        provider: "fuzzy-lexical",
        confidence: "approximate",
        result: resPayload,
        ...(recordTiming ? { timings } : {}),
      };
    }

    const executedOption: JunctionOption = {
      tier: "fuzzy-lexical",
      recommended: true,
      executed: true,
      confidence: "approximate",
      result: resPayload,
      note: `Best match for identifier-shaped token '${matchedToken}'.`,
    };
    const alternativeOption: JunctionOption = {
      tier: "capn-cli",
      recommended: false,
      executed: false,
      result: null,
      note: "Not queried automatically — available on request via forceTier.",
      continuation: {
        tool: "waymark_ask",
        args: { question, tier: "capn" },
        cliCommand: `waymark-ask "${question}" --tier capn`,
      },
    };

    return {
      waymark: 1,
      kind: "ask",
      status: "junction",
      query: question,
      signal: { shape: "identifier-like", candidateTokens },
      options: [executedOption, alternativeOption],
      executedOption,
      alternativeOption,
      chartHint: "This answer can be charted with waymark_memory(action: \"chart\") (CLI: waymark-chart) regardless of which option resolved it.",
      recommendation: `Recommended tier: fuzzy-lexical. Found match '${bestFuzzyResult.candidate.name}' in ${bestFuzzyResult.candidate.path}:${bestFuzzyResult.candidate.line}.`,
      tip: `To query charted semantic memory instead: waymark-ask "${question}" --tier capn`,
      ...(recordTiming ? { timings } : {}),
    };
  }

  // Stage 2: No identifier-shaped tokens or fuzzy below threshold -> semantic recommendation executes eagerly
  const tCapn0 = performance.now();
  const capnRes = await queryCapnMemory(root, capnExecutable, effectiveQuestion);
  if (recordTiming) timings.capn_ms = Math.round((performance.now() - tCapn0) * 100) / 100;

  if (capnRes.hit) {
    // Stage 2 Hit!
    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;

    if (autoResolve) {
      return {
        waymark: 1,
        kind: "ask",
        status: "hit",
        provider: "capn-cli",
        confidence: "curated",
        result: capnRes.result,
        ...(recordTiming ? { timings } : {}),
      };
    }

    const note = candidateTokens.length > 0
      ? "Fuzzy search for identifier token(s) scored below threshold; queried charted memory directly."
      : "No identifier-shaped tokens found; queried charted memory directly.";

    const executedOption: JunctionOption = {
      tier: "capn-cli",
      recommended: true,
      executed: true,
      confidence: "curated",
      result: capnRes.result,
      note,
    };
    const alternativeOption: JunctionOption = {
      tier: "fuzzy-lexical",
      recommended: false,
      executed: fuzzyRanInStage1,
      result: null,
      note: candidateTokens.length > 0
        ? "Fuzzy match scored below confidence threshold."
        : "No identifier-shaped tokens to score.",
      continuation: {
        tool: "waymark_ask",
        args: { question, tier: "fuzzy" },
        cliCommand: `waymark-ask "${question}" --tier fuzzy`,
      },
    };

    return {
      waymark: 1,
      kind: "ask",
      status: "junction",
      query: question,
      signal: { shape, candidateTokens },
      options: [executedOption, alternativeOption],
      executedOption,
      alternativeOption,
      chartHint: "This answer can be charted with waymark_memory(action: \"chart\") (CLI: waymark-chart) regardless of which option resolved it.",
      recommendation: `Recommended tier: capn-cli. Queried charted memory.`,
      tip: `To search code symbols fuzzily instead: waymark-ask "${question}" --tier fuzzy`,
      ...(recordTiming ? { timings } : {}),
    };
  }

  // If the query had explicit call-graph trace intent (e.g. "Who calls <X>?", "Callees of <X>"),
  // and both Tier 1 AST structural and Tier 4 Capn memory missed, fail closed.
  // Stage 3 exhaustive fuzzy pass on plain narrative words cannot answer call-graph relationships.
  if (hasStructuralIntent && astIntent.tool === "trace_path") {
    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
    return {
      waymark: 1,
      kind: "ask",
      status: "miss",
      provider: "codedb",
      missCode: "SYMBOL_NOT_FOUND",
      reason: `No structural symbol or call graph match found for "${question}".`,
      matches: [],
      ...(recordTiming ? { timings } : {}),
    };
  }

  // If the query was an explicit narrative/conceptual question (e.g. "How does the sandbox work?", "Explain the system"),
  // and Tier 4 Capn memory had no charted answer, do NOT run exhaustive fuzzy search across individual stop words
  // (which matches arbitrary symbols like 'ModelAlien' or 'doctor.rs'). Fail closed with clear guidance.
  const isNarrativeQuery =
    /^(explain|describe|how|why|tell\s+me)\b/i.test(question.trim()) ||
    /\b(how\s+does|how\s+do|how\s+can|how\s+to|what\s+does|explain\s+how)\b/i.test(question.trim());

  if (isNarrativeQuery) {
    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;
    return {
      waymark: 1,
      kind: "ask",
      status: "miss",
      provider: "capn-cli",
      missCode: "NO_CHARTED_MEMORY",
      reason: `No charted consensus memory found for architectural question: "${question}". Run 'waymark memory bootstrap' to collect unverified source excerpts, verify them, then chart supported claims with 'waymark memory chart'.`,
      matches: [],
      ...(recordTiming ? { timings } : {}),
    };
  }

  // Stage 3: Both Stage 1 and Stage 2 missed -> Exhaustive fuzzy on plain tokens
  const tExhaustive0 = performance.now();
  let exhaustiveHit: FuzzyScoreResult | null = null;
  let exhaustiveToken = "";
  const triedTokens: string[] = [];

  for (const tok of plainTokens) {
    triedTokens.push(tok);
    const candidates = await getCandidates(tok);
    const scored = rankFzf(tok, candidates);
    if (scored.length > 0 && scored[0] && scored[0].score >= 60) {
      if (!exhaustiveHit || scored[0].score > exhaustiveHit.score) {
        exhaustiveHit = scored[0];
        exhaustiveToken = tok;
      }
    }
  }

  if (recordTiming) {
    timings.fuzzy_ms = (timings.fuzzy_ms ?? 0) + Math.round((performance.now() - tExhaustive0) * 100) / 100;
  }

  if (exhaustiveHit) {
    // Stage 3 Hit!
    const resPayload = {
      name: exhaustiveHit.candidate.name,
      path: exhaustiveHit.candidate.path,
      line: exhaustiveHit.candidate.line,
      kind: exhaustiveHit.candidate.kind,
      score: exhaustiveHit.score,
      matchRanges: exhaustiveHit.matchRanges,
    };

    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;

    if (autoResolve) {
      return {
        waymark: 1,
        kind: "ask",
        status: "hit",
        provider: "fuzzy-lexical",
        confidence: "approximate",
        result: resPayload,
        ...(recordTiming ? { timings } : {}),
      };
    }

    const executedOption: JunctionOption = {
      tier: "fuzzy-lexical",
      recommended: true,
      executed: true,
      confidence: "approximate",
      result: resPayload,
      note: `Matched via exhaustive fuzzy pass on token '${exhaustiveToken}'. Tokens tried: ${triedTokens.join(", ")}.`,
    };
    const alternativeOption: JunctionOption = {
      tier: "capn-cli",
      recommended: false,
      executed: true,
      result: null,
      note: "No charted answer found in semantic memory.",
    };

    return {
      waymark: 1,
      kind: "ask",
      status: "junction",
      query: question,
      signal: { shape, candidateTokens },
      options: [executedOption, alternativeOption],
      executedOption,
      alternativeOption,
      chartHint: "This answer can be charted with waymark_memory(action: \"chart\") (CLI: waymark-chart) regardless of which option resolved it.",
      recommendation: `Recommended tier: fuzzy-lexical. Matched '${exhaustiveHit.candidate.name}' via exhaustive fuzzy pass on '${exhaustiveToken}'.`,
      tip: `To chart this answer for fast retrieval next time: waymark-chart --question "${question}" --answer "<details>" --files "${exhaustiveHit.candidate.path}"`,
      ...(recordTiming ? { timings } : {}),
    };
  }

  // All tiers exhausted
  if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;

  return {
    waymark: 1,
    kind: "ask",
    status: "miss",
    provider: "none",
    missCode: "JUNCTION_EXHAUSTED",
    reason: `No matches found across discovery tiers (structural, literal, fuzzy, or semantic) for "${question}".`,
    matches: [],
    ...(recordTiming ? { timings } : {}),
  };
}

export async function routeDiscovery(ctx: DiscoveryRouteContext): Promise<AskResult> {
  const isDev = Boolean(ctx.options?.dev);
  const startedAt = performance.now();
  let res: AskResult;
  // capn deletes stale entries while it answers; the result names them instead of losing them silently.
  let memoryPruned: string[] | undefined;
  const tracked: DiscoveryRouteContext = {
    ...ctx,
    queryCapnMemory: async (root, executable, question) => {
      const answer = await ctx.queryCapnMemory(root, executable, question);
      if (answer.pruned && answer.pruned.length > 0) memoryPruned = answer.pruned;
      return answer;
    },
  };
  try {
    res = await routeDiscoveryCore(tracked);
    if (memoryPruned && res.status !== "error") res = { ...res, memoryPruned };
  } catch (error) {
    const code = error instanceof WaymarkError ? error.code : "UNEXPECTED_ERROR";
    if (code !== "UNSUPPORTED_SUBSYSTEM" && !code.startsWith("CODEDB_")) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const isCodedb = code.startsWith("CODEDB_");
    res = {
      waymark: 1,
      kind: "ask",
      status: "error",
      provider: isCodedb ? "codedb" : "waymark-engine",
      errorCode: code,
      message,
      error: message,
      retryable: code === "CODEDB_PROCESS_ERROR" || code === "CODEDB_PROCESS_TIMEOUT",
    };
  }
  let finalRes: AskResult = res;

  if (isDev) {
    const tiers: string[] = [];
    if (res.timings) {
      if (res.timings.ast_ms !== undefined) tiers.push("ast");
      if (res.timings.path_ms !== undefined) tiers.push("path");
      if (res.timings.fuzzy_ms !== undefined) tiers.push("fuzzy");
      if (res.timings.capn_ms !== undefined) tiers.push("capn");
    }
    const dev: DevDiagnostics = {
      tiersEvaluated: tiers.length > 0 ? tiers : (res.provider ? [res.provider] : ["unknown"]),
      timingBreakdownMs: res.timings || {},
      daemonIpcUsed: Boolean(process.env.WAYMARK_AUTO_DAEMON === "1" || ctx.options?.daemon),
      invariantsPassed: true,
    };
    finalRes = { ...res, dev };
  }

  try {
    const { logAskTelemetry } = await import("./sessionLogger.js");
    const caller = process.env.WAYMARK_MCP_SESSION === "1" ? "mcp" : (process.env.WAYMARK_REPL_SESSION === "1" ? "repl" : "cli");
    logAskTelemetry(ctx.root, ctx.question, finalRes, Math.max(1, finalRes.timings?.total_ms ?? (performance.now() - startedAt)), caller);
  } catch {
    // Fail silent
  }

  return finalRes;
}
