import fs from "node:fs";
import path from "node:path";
import { discoverSymbolsInFile, parseSourceIndex, scriptLanguageForPath, MAX_SYMBOL_DISCOVERY_FILE_BYTES } from "./astExtractor.js";
import type { SourceCall, StructuredSymbol } from "./astExtractor.js";
import { collectRepoPaths } from "./discoveryRouter.js";
import { resolveRepositoryFile } from "./paths.js";
import type { CallGraphData, CallGraphHopNode } from "./types.js";

/**
 * Repo-wide tree-sitter fallback for the extensions @paragon-ux/codedb-core indexes as
 * `language: "unknown"` with 0 symbols. codedb stays the primary index: these functions only run
 * when codedb has no answer, and they only look at files with these extensions (plus, for callers,
 * JS/TS files that mention the target name). Remove an extension here once codedb-core indexes it.
 */
export const FALLBACK_INDEX_EXTENSIONS = new Set([".mjs", ".cjs", ".mts", ".cts", ".toml"]);

/** Most files the fallback parses for one root; a bigger repository is indexed up to this cap. */
const MAX_INDEXED_FILES = 2000;
/** Call-graph traversal shares codedb's node cap (see queryMultiHopCallGraph). */
const MAX_GRAPH_NODES = 50;

const CONTAINER_KINDS = new Set(["class", "interface", "struct", "trait", "enum", "record", "contract"]);
const CALLABLE_KINDS = new Set(["function", "method", "constructor"]);

export interface IndexedSymbol {
  name: string;
  /** `Class.member` for a member, the dotted key for a TOML key, else the name. */
  qualified: string;
  kind: string;
  path: string;
  line: number;
  endLine: number;
  language: string;
}

interface IndexedCall extends SourceCall {
  path: string;
  /** The innermost callable that contains the call, or undefined at module top level. */
  caller?: IndexedSymbol;
}

interface FileIndex {
  language: string;
  symbols: IndexedSymbol[];
  calls: IndexedCall[];
}

const fileCache = new Map<string, { mtimeMs: number; size: number; index: FileIndex | null }>();
const FILE_CACHE_LIMIT = 5000;

function contains(outer: StructuredSymbol, inner: StructuredSymbol): boolean {
  if (outer === inner) return false;
  const startsBefore = outer.start.line < inner.start.line || (outer.start.line === inner.start.line && outer.start.column <= inner.start.column);
  const endsAfter = outer.end.line > inner.end.line || (outer.end.line === inner.end.line && outer.end.column >= inner.end.column);
  return startsBefore && endsAfter;
}

function containsPosition(symbol: IndexedSymbol, line: number): boolean {
  return symbol.line <= line && symbol.endLine >= line;
}

function qualifySymbols(storedPath: string, language: string, symbols: StructuredSymbol[]): IndexedSymbol[] {
  return symbols.map((symbol) => {
    let qualified = symbol.name;
    if (language === "toml") {
      // `[package]` is the table `package`; `package.name` is a key whose bare name is `name`.
      qualified = symbol.name.replace(/^\[+|\]+$/gu, "");
    } else if (!CONTAINER_KINDS.has(symbol.kind)) {
      const owner = symbols
        .filter((candidate) => CONTAINER_KINDS.has(candidate.kind) && contains(candidate, symbol))
        .sort((a, b) => b.start.line - a.start.line)[0];
      if (owner) qualified = `${owner.name}.${symbol.name}`;
    }
    const name = language === "toml" ? qualified.slice(qualified.lastIndexOf(".") + 1) : symbol.name;
    return { name, qualified, kind: symbol.kind, path: storedPath, line: symbol.start.line, endLine: symbol.end.line, language };
  });
}

async function indexFile(root: string, storedPath: string): Promise<FileIndex | null> {
  let real: string;
  let stat: fs.Stats;
  try {
    real = resolveRepositoryFile(root, storedPath).real;
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  if (stat.size > MAX_SYMBOL_DISCOVERY_FILE_BYTES) return null;
  const cached = fileCache.get(real);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.index;

  let index: FileIndex | null = null;
  const script = scriptLanguageForPath(storedPath);
  try {
    if (script) {
      const parsed = await parseSourceIndex(fs.readFileSync(real, "utf8"), script);
      if (parsed) {
        const symbols = qualifySymbols(storedPath, script, parsed.symbols);
        const callables = symbols.filter((s) => CALLABLE_KINDS.has(s.kind));
        const calls = parsed.calls.map((call) => {
          const caller = callables
            .filter((s) => containsPosition(s, call.line))
            .sort((a, b) => b.line - a.line || a.endLine - b.endLine)[0];
          return { ...call, path: storedPath, ...(caller ? { caller } : {}) };
        });
        index = { language: script, symbols, calls };
      }
    } else if (path.extname(storedPath).toLowerCase() === ".toml") {
      const discovered = await discoverSymbolsInFile(root, storedPath, "toml");
      index = { language: "toml", symbols: qualifySymbols(storedPath, "toml", discovered.symbols), calls: [] };
    }
  } catch {
    index = null;
  }
  fileCache.set(real, { mtimeMs: stat.mtimeMs, size: stat.size, index });
  while (fileCache.size > FILE_CACHE_LIMIT) fileCache.delete(fileCache.keys().next().value!);
  return index;
}

/** Repository files whose extension codedb-core does not index, in walk order. */
export function fallbackIndexPaths(root: string): string[] {
  return collectRepoPaths(root)
    .filter((p) => FALLBACK_INDEX_EXTENSIONS.has(path.extname(p).toLowerCase()))
    .slice(0, MAX_INDEXED_FILES);
}

/** True when the repository holds files that only the fallback index can see. */
export function hasFallbackFiles(root: string): boolean {
  return fallbackIndexPaths(root).length > 0;
}

/** Per-file language and symbol count for the fallback extensions, for `architecture`. */
export async function fallbackFileSummaries(root: string): Promise<Map<string, { language: string; symbols: number }>> {
  const out = new Map<string, { language: string; symbols: number }>();
  for (const p of fallbackIndexPaths(root)) {
    const index = await indexFile(root, p);
    if (index) out.set(p, { language: index.language, symbols: index.symbols.length });
  }
  return out;
}

/** Every symbol defined in a fallback-extension file. */
export async function fallbackSymbols(root: string): Promise<IndexedSymbol[]> {
  const out: IndexedSymbol[] = [];
  for (const p of fallbackIndexPaths(root)) {
    const index = await indexFile(root, p);
    if (index) out.push(...index.symbols);
  }
  return out;
}

/**
 * Definitions named `query` in fallback-extension files. A dotted query matches the qualified
 * name only (`Class.method`, `table.key`); a bare query matches the bare name.
 */
export async function lookupFallbackSymbols(root: string, query: string): Promise<IndexedSymbol[]> {
  const q = query.trim();
  if (!q) return [];
  const symbols = await fallbackSymbols(root);
  return q.includes(".")
    ? symbols.filter((s) => s.qualified === q)
    : symbols.filter((s) => s.name === q);
}

function hopNode(symbol: IndexedSymbol): CallGraphHopNode {
  return { name: symbol.qualified, path: symbol.path, line: symbol.line, kind: symbol.kind === "constructor" ? "method" : symbol.kind };
}

function moduleNode(storedPath: string): CallGraphHopNode {
  return { name: "<module>", path: storedPath, line: 1, kind: "module" };
}

function isTestPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /(?:^|\/)(?:tests?|__tests__|spec|testing|benchmarks?|benches|examples|fixtures|testdata)\//i.test(normalized)
    || /(?:[._-]test|[._-]spec|[._-]bench)\.[^/]+$/i.test(normalized);
}

/** The callable definitions a call site resolves to, or [] when it may reach code outside the index. */
function resolveCall(call: IndexedCall, byName: Map<string, IndexedSymbol[]>): IndexedSymbol[] {
  const named = (byName.get(call.callee) ?? []).filter((s) => CALLABLE_KINDS.has(s.kind) || (call.receiver === "new" && s.kind === "class"));
  if (named.length === 0) return [];
  if (call.receiver === "new") return named.filter((s) => s.kind === "class");
  if (call.receiver === undefined) {
    // A bare call reaches a function, never a method; a same-file definition shadows the rest.
    const functions = named.filter((s) => s.kind === "function");
    const local = functions.filter((s) => s.path === call.path);
    return local.length > 0 ? local : functions.length === 1 ? functions : [];
  }
  if (call.receiver === "this") {
    const owner = call.caller?.qualified.includes(".") ? call.caller.qualified.slice(0, call.caller.qualified.lastIndexOf(".")) : undefined;
    return owner ? named.filter((s) => s.qualified === `${owner}.${call.callee}`) : [];
  }
  const qualifiedHit = named.filter((s) => s.qualified === `${call.receiver}.${call.callee}`);
  if (qualifiedHit.length > 0) return qualifiedHit;
  // An untyped receiver resolves only when one method carries the name.
  const methods = named.filter((s) => s.kind === "method");
  return methods.length === 1 ? methods : [];
}

interface CallIndex {
  byName: Map<string, IndexedSymbol[]>;
  calls: IndexedCall[];
}

/**
 * Definitions come from fallback-extension files. Call sites come from those files and from any
 * JS/TS file whose text mentions one of `names`, since codedb never links a call into a file it
 * does not index.
 */
async function buildCallIndex(root: string, names: Set<string>): Promise<CallIndex> {
  const byName = new Map<string, IndexedSymbol[]>();
  const calls: IndexedCall[] = [];
  const fallback = new Set(fallbackIndexPaths(root));
  for (const p of fallback) {
    const index = await indexFile(root, p);
    if (!index) continue;
    for (const s of index.symbols) {
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }
    calls.push(...index.calls);
  }
  let scanned = fallback.size;
  for (const p of collectRepoPaths(root)) {
    if (scanned >= MAX_INDEXED_FILES) break;
    if (fallback.has(p) || !scriptLanguageForPath(p)) continue;
    let text: string;
    try {
      const real = resolveRepositoryFile(root, p).real;
      if (fs.statSync(real).size > MAX_SYMBOL_DISCOVERY_FILE_BYTES) continue;
      text = fs.readFileSync(real, "utf8");
    } catch {
      continue;
    }
    if (![...names].some((name) => text.includes(name))) continue;
    scanned++;
    const index = await indexFile(root, p);
    if (index) calls.push(...index.calls);
  }
  return { byName, calls };
}

/**
 * Resolved call graph for a definition that only the fallback index holds, in the same shape as
 * `queryMultiHopCallGraph`. Returns null when no fallback-extension file defines `fn`, so the
 * caller keeps its own not-found answer.
 */
export async function fallbackCallGraph(
  root: string,
  fn: string,
  depth = 1,
  direction: "callers" | "callees" | "both" = "both",
  excludeTests = false,
): Promise<CallGraphData | null> {
  const roots = (await lookupFallbackSymbols(root, fn)).filter((s) => CALLABLE_KINDS.has(s.kind));
  if (roots.length !== 1) return null;
  const target = roots[0]!;
  const maxDepth = Math.min(Math.max(1, depth), 5);
  const index = await buildCallIndex(root, new Set([target.name]));

  const key = (n: CallGraphHopNode) => `${n.path}:${n.line}:${n.name}`;
  const visited = new Set<string>([key(hopNode(target))]);
  let totalNodes = 1;
  let truncated = false;
  const symbolOf = new Map<string, IndexedSymbol>([[key(hopNode(target)), target]]);

  const callersOf = (symbol: IndexedSymbol): Array<{ node: CallGraphHopNode; symbol?: IndexedSymbol }> => {
    const out: Array<{ node: CallGraphHopNode; symbol?: IndexedSymbol }> = [];
    for (const call of index.calls) {
      if (call.callee !== symbol.name) continue;
      if (!resolveCall(call, index.byName).includes(symbol)) continue;
      out.push(call.caller ? { node: hopNode(call.caller), symbol: call.caller } : { node: moduleNode(call.path) });
    }
    return out;
  };
  const calleesOf = (symbol: IndexedSymbol): Array<{ node: CallGraphHopNode; symbol?: IndexedSymbol }> => {
    const out: Array<{ node: CallGraphHopNode; symbol?: IndexedSymbol }> = [];
    for (const call of index.calls) {
      if (call.caller !== symbol) continue;
      for (const resolved of resolveCall(call, index.byName)) out.push({ node: hopNode(resolved), symbol: resolved });
    }
    return out;
  };

  const expand = (
    parentSymbol: IndexedSymbol,
    relation: (s: IndexedSymbol) => Array<{ node: CallGraphHopNode; symbol?: IndexedSymbol }>,
  ): CallGraphHopNode[] => {
    const children: CallGraphHopNode[] = [];
    for (const { node, symbol } of relation(parentSymbol)) {
      if (excludeTests && isTestPath(node.path)) continue;
      const k = key(node);
      if (visited.has(k)) continue;
      if (totalNodes >= MAX_GRAPH_NODES) {
        truncated = true;
        break;
      }
      visited.add(k);
      totalNodes++;
      if (symbol) symbolOf.set(k, symbol);
      children.push(node);
    }
    return children;
  };

  const walk = (relationName: "callers" | "callees"): CallGraphHopNode[] => {
    const relation = relationName === "callers" ? callersOf : calleesOf;
    const top = expand(target, relation);
    let level = top;
    for (let d = 2; d <= maxDepth && level.length > 0 && !truncated; d++) {
      const next: CallGraphHopNode[] = [];
      for (const parent of level) {
        if (parent.kind === "module") continue; // a module node has no callers
        const symbol = symbolOf.get(key(parent));
        if (!symbol) continue;
        const children = expand(symbol, relation);
        if (children.length > 0) parent[relationName] = children;
        next.push(...children);
      }
      level = next;
    }
    return top;
  };

  const callers = direction === "callers" || direction === "both" ? walk("callers") : undefined;
  const callees = direction === "callees" || direction === "both" ? walk("callees") : undefined;

  return {
    tool: "call_graph",
    function: fn,
    path: target.path,
    line: target.line,
    kind: target.kind,
    depth: maxDepth,
    direction,
    totalNodes,
    truncated,
    ...(callers ? { callers } : {}),
    ...(callees ? { callees } : {}),
  };
}
