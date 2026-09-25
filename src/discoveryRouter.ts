import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { classifyTokenShape, rankFzf } from "./fuzzyMatcher.js";
import { queryStructural, queryFuzzyCandidates } from "./codedbAdapter.js";
import {
  AskHitResult,
  AskJunctionResult,
  AskMissResult,
  AskOptions,
  AskResult,
  DiscoveryTier,
  FuzzyCandidate,
  FuzzyScoreResult,
  JunctionOption,
  WaymarkError,
} from "./types.js";

export { classifyTokenShape };

export interface AstIntent {
  requiresParser: boolean;
  tool: "trace_path" | "search_graph" | "get_architecture";
  functionName?: string;
  query?: string;
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
}

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

  return { isLiteral: hasSep || hasExt || leadingDot || noExt, normalized, isExplicitPath };
}

export function detectAstIntent(question: string): AstIntent {
  const q = question.trim();
  const lower = q.toLowerCase();

  // 1. Architecture / Entrypoints intent
  const isNarrativeQuestion =
    /^(explain|describe|how|why|what\s+is|tell\s+me)\b/i.test(q);

  const architectureMatch =
    !isNarrativeQuestion &&
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
    );

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
    lower.includes("which functions call") ||
    lower.includes("call hierarchy");

  if (traceMatch) {
    const tokens = q.match(/[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g) || [];
    const stopWords = new Set([
      "who", "calls", "call", "what", "which", "functions", "trace", "path",
      "of", "in", "to", "the", "and", "is", "where", "function", "method"
    ]);
    const candidates = tokens.filter(t => !stopWords.has(t.toLowerCase()) && t.length > 1);
    const rawTarget = candidates[candidates.length - 1] ?? candidates[0] ?? q;
    const functionName = rawTarget.replace(/[?().]+$/g, "").replace(/^.*\.([A-Za-z0-9_]+)$/, "$1");

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
    /\bwhere\s+is\s+([A-Za-z0-9_]+)\s+(declared|defined|implemented|located)\b/i.test(q) ||
    /\bwhere\s+is\s+([A-Za-z0-9_]+)\s*\??$/i.test(q) ||
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

const SKIP_DIRS = new Set<string>([
  "node_modules", "dist", "out", "build", "coverage", "next", "nuxt",
  "capn", "waymark", "qmd", "claude", "codex", "zed",
  "eval", "experiments", "evidence", "sandbox", "tmp", "vendor", "venv",
  "__pycache__",
]);

function canonicalRoot(r: string): string {
  return path.resolve(r).replace(/^[a-zA-Z]:/, (m) => m.toLowerCase());
}

let pathCache: { root: string; at: number; paths: string[] } | null = null;

function getCacheFilePath(root: string): string {
  if (fs.existsSync(path.join(root, ".capn"))) {
    return path.join(root, ".capn", "paths.cache");
  }
  return path.join(root, ".waymark", "paths.cache");
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
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!(ent.name.startsWith(".") || SKIP_DIRS.has(ent.name))) {
          walk(full);
        }
      } else if (ent.isFile()) {
        if (ent.name === ".DS_Store") continue;
        if (ent.name.endsWith(".log") || ent.name.endsWith(".tsbuildinfo")) continue;
        out.push(path.relative(base, full).replace(/\\/g, "/"));
      }
    }
  };
  walk(base);

  pathCache = { root: normRoot, at: Date.now(), paths: out };

  try {
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cacheFile, out.join("\n"), "utf8");
  } catch {
    // Fail silent if repository is read-only
  }

  return out;
}

export type LiteralMatchKind = "exact" | "basename" | "suffix" | "substring";

export interface LiteralMatch {
  file: string;
  kind: LiteralMatchKind;
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

export interface DiscoveryRouteContext {
  root: string;
  question: string;
  options?: AskOptions;
  codedbExecutable?: string;
  capnExecutable?: string;
  profile?: string;
  queryCapnMemory: (root: string, executable: string, question: string) => Promise<{ hit: boolean; result: unknown; error?: string }>;
  assertLexicalStore?: (root: string) => void;
  overrideCandidates?: FuzzyCandidate[];
}

export async function routeDiscovery(ctx: DiscoveryRouteContext): Promise<AskResult> {
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
  const startTime = performance.now();
  const timings: Record<string, number> = {};
  const recordTiming = options?.timing ?? false;
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

  // Tier 1: Structural AST check (codedb)
  const astIntent = detectAstIntent(question);
  const hasStructuralIntent = astIntent.requiresParser;

  if (tier === "auto" || tier === "ast") {
    const tAst0 = performance.now();
    if (hasStructuralIntent || tier === "ast") {
      const structuralIntent = hasStructuralIntent
        ? astIntent
        : { requiresParser: true, tool: "search_graph" as const, query: question };
      const astResult = await queryStructural(structuralIntent, root, codedbExecutable);
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
      const paths = collectRepoPaths(root);
      const matches = matchLiteralPath(literal.normalized, paths, literal.isExplicitPath);
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
    return await queryFuzzyCandidates(token, root, codedbExecutable);
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
        chartHint: "This answer can be charted with waymark-chart regardless of which option resolved it.",
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
    if (assertLexicalStore) assertLexicalStore(root);
    const capnRes = await queryCapnMemory(root, capnExecutable, question);
    if (recordTiming) timings.capn_ms = Math.round((performance.now() - tCapn0) * 100) / 100;
    if (recordTiming) timings.total_ms = Math.round((performance.now() - startTime) * 100) / 100;

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
        chartHint: "This answer can be charted with waymark-chart regardless of which option resolved it.",
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
      missCode: "NO_CHARTED_MEMORY",
      reason: `No charted memory found for "${question}".`,
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
      chartHint: "This answer can be charted with waymark-chart regardless of which option resolved it.",
      recommendation: `Recommended tier: fuzzy-lexical. Found match '${bestFuzzyResult.candidate.name}' in ${bestFuzzyResult.candidate.path}:${bestFuzzyResult.candidate.line}.`,
      tip: `To query charted semantic memory instead: waymark-ask "${question}" --tier capn`,
      ...(recordTiming ? { timings } : {}),
    };
  }

  // Stage 2: No identifier-shaped tokens or fuzzy below threshold -> semantic recommendation executes eagerly
  const tCapn0 = performance.now();
  if (assertLexicalStore) assertLexicalStore(root);
  const capnRes = await queryCapnMemory(root, capnExecutable, question);
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
      chartHint: "This answer can be charted with waymark-chart regardless of which option resolved it.",
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
      chartHint: "This answer can be charted with waymark-chart regardless of which option resolved it.",
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