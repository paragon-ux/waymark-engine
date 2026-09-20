import Parser from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { normalizeRelativePath, readFileText } from "./paths.js";
import { WaymarkError } from "./types.js";

const require = createRequire(import.meta.url);

export interface SymbolDefinition {
  name: string;
  qualifiedName: string;
  kind: "Class" | "Method" | "Function" | "Interface" | "Type";
  file: string;
  startLine: number;
  endLine: number;
}

export interface CallRelationship {
  caller: string;
  callee: string;
  file: string;
  line: number;
}

export interface AstExtractionResult {
  symbols: SymbolDefinition[];
  calls: CallRelationship[];
  callersMap: Map<string, string[]>;
  calleesMap: Map<string, string[]>;
  filesParsed: number;
  parseDurationMs: number;
}

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

const EXT_TO_WASM: Record<string, string> = {
  // TypeScript & JavaScript
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  // Python
  ".py": "tree-sitter-python.wasm",
  // Go
  ".go": "tree-sitter-go.wasm",
  // Rust
  ".rs": "tree-sitter-rust.wasm",
  // Java & JVM
  ".java": "tree-sitter-java.wasm",
  ".kt": "tree-sitter-kotlin.wasm",
  ".kts": "tree-sitter-kotlin.wasm",
  ".scala": "tree-sitter-scala.wasm",
  // C, C++, Objective-C
  ".c": "tree-sitter-c.wasm",
  ".h": "tree-sitter-c.wasm",
  ".cpp": "tree-sitter-cpp.wasm",
  ".hpp": "tree-sitter-cpp.wasm",
  ".cc": "tree-sitter-cpp.wasm",
  ".cxx": "tree-sitter-cpp.wasm",
  ".m": "tree-sitter-objc.wasm",
  // C#
  ".cs": "tree-sitter-c_sharp.wasm",
  // Ruby & PHP
  ".rb": "tree-sitter-ruby.wasm",
  ".php": "tree-sitter-php.wasm",
  // Swift
  ".swift": "tree-sitter-swift.wasm",
  // Shell scripts
  ".sh": "tree-sitter-bash.wasm",
  ".bash": "tree-sitter-bash.wasm",
  // Lua
  ".lua": "tree-sitter-lua.wasm",
  // Systems / Functional / Smart Contracts
  ".zig": "tree-sitter-zig.wasm",
  ".dart": "tree-sitter-dart.wasm",
  ".el": "tree-sitter-elisp.wasm",
  ".ex": "tree-sitter-elixir.wasm",
  ".exs": "tree-sitter-elixir.wasm",
  ".elm": "tree-sitter-elm.wasm",
  ".ml": "tree-sitter-ocaml.wasm",
  ".mli": "tree-sitter-ocaml.wasm",
  ".res": "tree-sitter-rescript.wasm",
  ".sol": "tree-sitter-solidity.wasm",
};

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

function resolveWasmPath(wasmName: string, customDir?: string): string | null {
  if (customDir) {
    const candidate = path.join(customDir, wasmName);
    if (fs.existsSync(candidate)) return candidate;
  }
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

async function getLanguageForWasm(wasmName: string, customDir?: string): Promise<unknown> {
  await initParser();

  if (loadedLanguages.has(wasmName)) {
    return loadedLanguages.get(wasmName);
  }

  const wasmPath = resolveWasmPath(wasmName, customDir);
  if (!wasmPath) return null;

  const Lang = await Parser.Language.load(wasmPath);
  loadedLanguages.set(wasmName, Lang);
  return Lang;
}

export async function getLanguageForExtension(ext: string, customDir?: string): Promise<unknown> {
  const wasmName = EXT_TO_WASM[ext.toLowerCase()];
  if (!wasmName) return null;

  return getLanguageForWasm(wasmName, customDir);
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

  let grammar: unknown;
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

export async function extractAstFromRepo(
  repoRoot: string,
  includeDirs: string[] = ["src"]
): Promise<AstExtractionResult> {
  const t0 = performance.now();
  await initParser();
  const parser = new Parser();

  const symbols: SymbolDefinition[] = [];
  const calls: CallRelationship[] = [];
  const callersMap: Map<string, string[]> = new Map();
  const calleesMap: Map<string, string[]> = new Map();

  let filesParsed = 0;

  function scanDir(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "node_modules" && ent.name !== ".git" && ent.name !== "dist" && ent.name !== ".capn" && ent.name !== ".waymark") {
          results.push(...scanDir(full));
        }
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name);
        if (EXT_TO_WASM[ext]) {
          results.push(full);
        }
      }
    }
    return results;
  }

  const allFiles: string[] = [];
  for (const d of includeDirs) {
    allFiles.push(...scanDir(path.join(repoRoot, d)));
  }

  // Load every needed grammar BEFORE parsing. web-tree-sitter compiles a grammar's
  // wasm lazily per Language.load; loading a grammar while parsed trees from another
  // language sit on the heap is pathologically slow on some hosts (observed 3-20s for
  // the python grammar after a single TypeScript parse, vs 5-25ms cold). Concurrent
  // upfront loads cost ~20-50ms total and keep every subsequent parse in the
  // millisecond range regardless of host.
  const neededExts = new Set(allFiles.map((filePath) => path.extname(filePath)));
  await Promise.all([...neededExts].map((ext) => getLanguageForExtension(ext)));

  for (const filePath of allFiles) {
    const ext = path.extname(filePath);
    const lang = await getLanguageForExtension(ext);
    if (!lang) continue;

    parser.setLanguage(lang as any);
    const content = fs.readFileSync(filePath, "utf8");
    const tree = parser.parse(content);
    filesParsed++;

    const relPath = path.relative(repoRoot, filePath).replace(/\\/g, "/");

    function walk(node: any, currentClass: string | null = null, currentFunction: string | null = null): void {
      if (node.type === "class_declaration" || node.type === "class_definition") {
        const nameNode = node.childForFieldName("name");
        const className = nameNode ? nameNode.text : "AnonymousClass";
        symbols.push({
          name: className,
          qualifiedName: `${relPath}:${className}`,
          kind: "Class",
          file: relPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });

        for (const child of node.children) {
          walk(child, className, currentFunction);
        }
        return;
      }

      if (node.type === "interface_declaration") {
        const nameNode = node.childForFieldName("name");
        const interfaceName = nameNode ? nameNode.text : "AnonymousInterface";
        symbols.push({
          name: interfaceName,
          qualifiedName: `${relPath}:${interfaceName}`,
          kind: "Interface",
          file: relPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });

        for (const child of node.children) {
          walk(child, currentClass, currentFunction);
        }
        return;
      }

      if (
        node.type === "method_definition" ||
        node.type === "function_declaration" ||
        node.type === "function_definition"
      ) {
        const nameNode = node.childForFieldName("name");
        const fnName = nameNode ? nameNode.text : "anonymous";
        const kind = currentClass ? "Method" : "Function";
        const qualifiedName = currentClass ? `${currentClass}.${fnName}` : fnName;

        symbols.push({
          name: fnName,
          qualifiedName: `${relPath}:${qualifiedName}`,
          kind,
          file: relPath,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });

        for (const child of node.children) {
          walk(child, currentClass, qualifiedName);
        }
        return;
      }

      if (node.type === "variable_declarator") {
        const nameNode = node.childForFieldName("name");
        const valueNode = node.childForFieldName("value");
        if (
          nameNode &&
          valueNode &&
          (valueNode.type === "arrow_function" ||
            valueNode.type === "function_expression" ||
            valueNode.type === "function")
        ) {
          const fnName = nameNode.text;
          const kind = currentClass ? "Method" : "Function";
          const qualifiedName = currentClass ? `${currentClass}.${fnName}` : fnName;

          symbols.push({
            name: fnName,
            qualifiedName: `${relPath}:${qualifiedName}`,
            kind,
            file: relPath,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
          });

          for (const child of node.children) {
            walk(child, currentClass, qualifiedName);
          }
          return;
        }
      }

      if (node.type === "call_expression" || node.type === "call") {
        const fnNode = node.childForFieldName("function");
        if (fnNode && currentFunction) {
          const rawCall = fnNode.text;
          const calleeBare = rawCall.replace(/^.*\.([A-Za-z0-9_]+)$/, "$1");

          calls.push({
            caller: currentFunction,
            callee: calleeBare,
            file: relPath,
            line: node.startPosition.row + 1,
          });

          const existingCallers = callersMap.get(calleeBare) || [];
          if (!existingCallers.includes(currentFunction)) {
            existingCallers.push(currentFunction);
            callersMap.set(calleeBare, existingCallers);
          }

          const existingCallees = calleesMap.get(currentFunction) || [];
          if (!existingCallees.includes(calleeBare)) {
            existingCallees.push(calleeBare);
            calleesMap.set(currentFunction, existingCallees);
          }
        }
      }

      for (const child of node.children) {
        walk(child, currentClass, currentFunction);
      }
    }

    walk(tree.rootNode);
  }

  const parseDurationMs = performance.now() - t0;
  return {
    symbols,
    calls,
    callersMap,
    calleesMap,
    filesParsed,
    parseDurationMs,
  };
}
