import fs from "node:fs";
import path from "node:path";

export interface AstIntent {
  requiresParser: boolean;
  tool: "trace_path" | "search_graph" | "get_architecture";
  functionName?: string;
  query?: string;
}

export function detectAstIntent(question: string): AstIntent {
  const q = question.trim();
  const lower = q.toLowerCase();

  // 1. Architecture / Entrypoints intent
  if (
    lower.includes("entrypoint") ||
    lower.includes("entry point") ||
    lower.includes("architecture") ||
    lower.includes("hotspots") ||
    lower.includes("high-level structure") ||
    lower.includes("overview of the repo") ||
    lower.includes("project topology")
  ) {
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
  if (/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)?(?:\(\))?\??$/.test(q)) {
    return {
      requiresParser: true,
      tool: "search_graph",
      query: q.replace(/[?().]+$/g, ""),
    };
  }

  return { requiresParser: false, tool: "search_graph" };
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
}

export function detectLiteralIntent(question: string): LiteralIntent {
  const q = question.trim().replace(/^['"`]+|['"`]+$/g, "");
  const normalized = q.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();

  const hasSep = normalized.includes("/");
  const extMatch = lower.match(/\.([a-z0-9]+)[?!.,;)]*$/);
  const hasExt = extMatch !== null && LITERAL_EXTENSIONS.has(extMatch[1] ?? "");
  const leadingDot = lower.startsWith(".");
  const noExt = NO_EXT_FILENAMES.has(lower);

  return { isLiteral: hasSep || hasExt || leadingDot || noExt, normalized };
}

const SKIP_DIRS = new Set<string>([
  "node_modules", "dist", "out", "build", "coverage", "next", "nuxt",
  "capn", "waymark", "qmd", "claude", "codex", "zed",
  "eval", "experiments", "evidence", "sandbox", "tmp", "vendor", "venv",
  "__pycache__",
]);

let pathCache: { root: string; at: number; paths: string[] } | null = null;

export function collectRepoPaths(root: string, maxAgeMs = 30_000): string[] {
  if (pathCache && pathCache.root === root && Date.now() - pathCache.at < maxAgeMs) {
    return pathCache.paths;
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

  pathCache = { root, at: Date.now(), paths: out };
  return out;
}

export type LiteralMatchKind = "exact" | "basename" | "suffix" | "substring";

export interface LiteralMatch {
  file: string;
  kind: LiteralMatchKind;
}

export function matchLiteralPath(normalized: string, paths: string[]): LiteralMatch[] {
  const lower = normalized.toLowerCase();

  const exact = paths.filter((p) => p.toLowerCase() === lower);
  if (exact.length > 0) {
    const strict = exact.find((p) => p === normalized);
    return strict
      ? [{ file: strict, kind: "exact" }]
      : exact.map((file) => ({ file, kind: "exact" }));
  }

  const baseName = lower.split("/").pop() ?? "";
  const basenames = paths.filter(
    (p) => (p.split("/").pop() ?? "").toLowerCase() === baseName
  );
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