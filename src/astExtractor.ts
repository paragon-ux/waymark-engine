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

export async function discoverSymbolsInFile(
  repoRoot: string,
  rawPath: string,
  requestedLanguage?: string,
): Promise<SymbolDiscoveryResult> {
  const storedPath = normalizeRelativePath(rawPath);
  const language = resolveStructuredLanguage(storedPath, requestedLanguage);
  const file = readFileText(repoRoot, storedPath);

  if (file.bytes.byteLength > MAX_SYMBOL_DISCOVERY_FILE_BYTES) {
    throw new WaymarkError("FILE_TOO_LARGE", `Discovery only accepts files up to ${MAX_SYMBOL_DISCOVERY_FILE_BYTES} bytes`, 2);
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
  } catch {
    throw new WaymarkError("PARSE_ERROR", `Unable to parse ${language} source: ${storedPath}`, 2);
  }
  if (tree.rootNode.hasError) {
    throw new WaymarkError("PARSE_ERROR", `Malformed ${language} source: ${storedPath}`, 2);
  }

  return {
    ok: true,
    path: storedPath,
    language,
    symbols: collectStructuredSymbols(tree.rootNode),
  };
}
