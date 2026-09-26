import Parser from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { normalizeRelativePath, readFileText } from "./paths.js";
import { WaymarkError } from "./types.js";

const require = createRequire(import.meta.url);

export type StructuredLanguage = "typescript" | "python";
export type StructuredSymbolKind = "class" | "function" | "method" | "interface" | "type";

export interface StructuredSymbolPosition {
  line: number;
  column: number;
}

export interface StructuredSymbol {
  name: string;
  kind: StructuredSymbolKind;
  start: StructuredSymbolPosition;
  end: StructuredSymbolPosition;
}

export interface SymbolDiscoveryResult {
  ok: true;
  path: string;
  language: StructuredLanguage;
  symbols: StructuredSymbol[];
}

export const MAX_SYMBOL_DISCOVERY_FILE_BYTES = 1024 * 1024;

// Precise single-file structured discovery is deliberately kept on web-tree-sitter
// (not the codedb index): codedb's `outline` is a coarse ranking index and does not
// reproduce the class/method/interface/type fidelity this surface guarantees
// (e.g. it omits Python classes and mis-names `export interface`). Repo-wide call
// graph and symbol search now run through codedb (see codedbAdapter.ts).

const STRUCTURED_EXTENSIONS: Record<string, StructuredLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
};

const STRUCTURED_LANGUAGE_WASM: Record<StructuredLanguage, string> = {
  typescript: "tree-sitter-typescript.wasm",
  python: "tree-sitter-python.wasm",
};

let parserInitialized = false;
const loadedLanguages: Map<string, unknown> = new Map();

export async function initParser(): Promise<void> {
  if (!parserInitialized) {
    await Parser.init();
    parserInitialized = true;
  }
}

function resolveWasmPath(wasmName: string): string | null {
  try {
    const pkgPath = require.resolve("tree-sitter-wasms/package.json");
    const outDir = path.join(path.dirname(pkgPath), "out");
    const candidate = path.join(outDir, wasmName);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // fallback to relative search
  }
  const fallback = path.resolve(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmName);
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

async function getLanguageForWasm(wasmName: string): Promise<unknown | null> {
  await initParser();

  if (loadedLanguages.has(wasmName)) {
    return loadedLanguages.get(wasmName);
  }

  const wasmPath = resolveWasmPath(wasmName);
  if (!wasmPath) return null;

  const Lang = await Parser.Language.load(wasmPath);
  loadedLanguages.set(wasmName, Lang);
  return Lang;
}

function resolveStructuredLanguage(storedPath: string, requestedLanguage?: string): StructuredLanguage {
  const detected = STRUCTURED_EXTENSIONS[path.extname(storedPath).toLowerCase()];
  const requested = requestedLanguage?.trim().toLowerCase() as StructuredLanguage | undefined;

  if (requested && !STRUCTURED_LANGUAGE_WASM[requested]) {
    throw new WaymarkError("UNSUPPORTED_LANGUAGE", `Unsupported discovery language: ${requested}`, 2);
  }
  if (requested && detected && requested !== detected) {
    throw new WaymarkError("LANGUAGE_EXTENSION_MISMATCH", `Language ${requested} does not match ${path.extname(storedPath)}`, 2);
  }
  if (requested) return requested;
  if (detected) return detected;
  throw new WaymarkError("UNSUPPORTED_LANGUAGE", `Cannot detect a supported discovery language for ${storedPath}`, 2);
}

function structuredSymbol(
  node: any,
  kind: StructuredSymbolKind,
  name: string,
): StructuredSymbol {
  return {
    name,
    kind,
    // Tree-sitter columns are zero-based UTF-8 byte offsets; end is exclusive.
    start: { line: node.startPosition.row + 1, column: node.startPosition.column },
    end: { line: node.endPosition.row + 1, column: node.endPosition.column },
  };
}

function collectStructuredSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];

  function walk(node: any, currentClass: string | null = null): void {
    let nextClass = currentClass;

    if (node.type === "class_declaration" || node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "class", name));
        nextClass = name;
      }
    } else if (node.type === "interface_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(structuredSymbol(node, "interface", name));
    } else if (node.type === "type_alias_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(structuredSymbol(node, "type", name));
    } else if (node.type === "method_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(structuredSymbol(node, "method", name));
    } else if (node.type === "function_declaration" || node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(structuredSymbol(node, currentClass ? "method" : "function", name));
    } else if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name")?.text;
      const value = node.childForFieldName("value");
      if (name && value && ["arrow_function", "function_expression", "function"].includes(value.type)) {
        symbols.push(structuredSymbol(node, currentClass ? "method" : "function", name));
      }
    }

    for (const child of node.children) walk(child, nextClass);
  }

  walk(rootNode);
  return symbols;
}

const CODEDB_OUTLINE_EXTENSIONS = new Set<string>([
  ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
  ".cs", ".rb", ".php", ".swift", ".kt", ".scala", ".js", ".jsx", ".mjs", ".cjs"
]);

async function discoverSymbolsViaCodedbOutline(
  repoRoot: string,
  storedPath: string,
): Promise<SymbolDiscoveryResult> {
  const { resolveCodedbCommand, runJson } = await import("./codedbAdapter.js");
  const command = resolveCodedbCommand();

  try {
    const run = await runJson(repoRoot, command, ["outline", storedPath, "--json"]);
    const parsed = run.payload;
    if (!run.ok || !parsed || !Array.isArray(parsed.symbols)) {
      return { ok: true, path: storedPath, language: (parsed?.language || "unknown") as any, symbols: [] };
    }
    const symbols: StructuredSymbol[] = parsed.symbols.map((s: any) => {
      let kind: StructuredSymbolKind = "function";
      const rawKind = String(s.kind || "").toLowerCase();
      if (rawKind.includes("class")) kind = "class";
      else if (rawKind.includes("method")) kind = "method";
      else if (rawKind.includes("interface")) kind = "interface";
      else if (rawKind.includes("type")) kind = "type";
      return {
        name: s.name,
        kind,
        start: { line: s.line_start || 1, column: 0 },
        end: { line: s.line_end || s.line_start || 1, column: 0 },
      };
    });
    return {
      ok: true,
      path: storedPath,
      language: (parsed.language || path.extname(storedPath).replace(".", "")) as any,
      symbols,
    };
  } catch {
    throw new WaymarkError("UNSUPPORTED_LANGUAGE", `Cannot detect a supported discovery language for ${storedPath}`, 2);
  }
}

export interface RepoSymbolHit {
  name: string;
  path: string;
  line: number;
  kind: string;
  detail?: string;
}

export interface RepoSymbolDiscoveryResult {
  ok: true;
  tool: "symbol";
  query: string;
  count: number;
  results: RepoSymbolHit[];
}

export async function discoverSymbolsInRepo(
  repoRoot: string,
  query: string,
): Promise<RepoSymbolDiscoveryResult> {
  const { resolveCodedbCommand, runJson } = await import("./codedbAdapter.js");
  const command = resolveCodedbCommand();

  try {
    const run = await runJson(repoRoot, command, ["symbol", query, "--json"]);
    const results = run.ok && run.payload && Array.isArray(run.payload.results) ? run.payload.results : [];
    return {
      ok: true,
      tool: "symbol",
      query,
      count: results.length,
      results: results.map((r: any) => ({
        name: r.name,
        path: r.path,
        line: r.line,
        kind: r.kind || "symbol",
        detail: r.detail,
      })),
    };
  } catch {
    return {
      ok: true,
      tool: "symbol",
      query,
      count: 0,
      results: [],
    };
  }
}

export async function discoverSymbolsInFile(
  repoRoot: string,
  rawPath: string,
  requestedLanguage?: string,
  query?: string,
): Promise<SymbolDiscoveryResult> {
  const storedPath = normalizeRelativePath(rawPath, repoRoot);
  const ext = path.extname(storedPath).toLowerCase();
  const file = readFileText(repoRoot, storedPath);

  if (file.bytes.byteLength > MAX_SYMBOL_DISCOVERY_FILE_BYTES) {
    throw new WaymarkError("FILE_TOO_LARGE", `Discovery only accepts files up to ${MAX_SYMBOL_DISCOVERY_FILE_BYTES} bytes`, 2);
  }

  let result: SymbolDiscoveryResult;

  if (CODEDB_OUTLINE_EXTENSIONS.has(ext) && !STRUCTURED_EXTENSIONS[ext] && !requestedLanguage) {
    result = await discoverSymbolsViaCodedbOutline(repoRoot, storedPath);
  } else {
    let language: StructuredLanguage;
    try {
      language = resolveStructuredLanguage(storedPath, requestedLanguage);
    } catch (err) {
      if (CODEDB_OUTLINE_EXTENSIONS.has(ext)) {
        result = await discoverSymbolsViaCodedbOutline(repoRoot, storedPath);
        if (query && query.trim()) {
          const q = query.trim().toLowerCase();
          result.symbols = result.symbols.filter((s) => s.name.toLowerCase().includes(q));
        }
        return result;
      }
      throw err;
    }

    let grammar: unknown | null;
    try {
      grammar = await getLanguageForWasm(STRUCTURED_LANGUAGE_WASM[language]);
    } catch {
      throw new WaymarkError("PARSER_UNAVAILABLE", `Waymark grammar is unavailable for ${language}`, 2);
    }
    if (!grammar) throw new WaymarkError("PARSER_UNAVAILABLE", `Waymark grammar is unavailable for ${language}`, 2);

    const parser = new Parser();
    let tree: any;
    try {
      parser.setLanguage(grammar as any);
      tree = parser.parse(file.text);
      if (tree.rootNode.hasError) {
        throw new WaymarkError("PARSE_ERROR", `Malformed ${language} source: ${storedPath}`, 2);
      }
      result = {
        ok: true,
        path: storedPath,
        language,
        symbols: collectStructuredSymbols(tree.rootNode),
      };
    } catch (err) {
      if (err instanceof WaymarkError) throw err;
      throw new WaymarkError("PARSE_ERROR", `Unable to parse ${language} source: ${storedPath}`, 2);
    } finally {
      if (tree) {
        try {
          tree.delete();
        } catch {
          // ignore
        }
      }
    }
  }

  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    result.symbols = result.symbols.filter((s) => s.name.toLowerCase().includes(q));
  }

  return result;
}
