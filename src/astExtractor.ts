import Parser from "web-tree-sitter";
import MarkdownIt from "markdown-it";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { normalizeRelativePath, readFileText } from "./paths.js";
import { WaymarkError } from "./types.js";

const require = createRequire(import.meta.url);

export const SUPPORTED_STRUCTURED_LANGUAGES = [
  "typescript",
  "javascript",
  "python",
  "json",
  "toml",
  "yaml",
  "bash",
  "markdown",
  "csharp",
  "scala",
  "lua",
  "zig",
  "elixir",
  "solidity",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "ruby",
  "swift",
  "kotlin",
  "php",
] as const;

export type StructuredLanguage = (typeof SUPPORTED_STRUCTURED_LANGUAGES)[number];

export type StructuredSymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "struct"
  | "enum"
  | "trait"
  | "record"
  | "constructor"
  | "property"
  | "contract"
  | "import"
  | "constant"
  | "variable"
  | "section"
  | "heading"
  | "config_block"
  | "table";

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
// (e.g. it omits Python classes, mis-names `export interface`, over-indexes .js
// local variables, and skips .mjs/.cjs/.mts/.cts). Repo-wide call graph and symbol
// search run through codedb (see codedbAdapter.ts).

const STRUCTURED_EXTENSIONS: Record<string, StructuredLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".json": "json",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
  ".cs": "csharp",
  ".scala": "scala",
  ".lua": "lua",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".sol": "solidity",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".rb": "ruby",
  ".swift": "swift",
  ".kt": "kotlin",
  ".php": "php",
};

const STRUCTURED_LANGUAGE_WASM: Partial<Record<StructuredLanguage, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  json: "tree-sitter-json.wasm",
  toml: "tree-sitter-toml.wasm",
  yaml: "tree-sitter-yaml.wasm",
  bash: "tree-sitter-bash.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  scala: "tree-sitter-scala.wasm",
  lua: "tree-sitter-lua.wasm",
  zig: "tree-sitter-zig.wasm",
  elixir: "tree-sitter-elixir.wasm",
  solidity: "tree-sitter-solidity.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  java: "tree-sitter-java.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  swift: "tree-sitter-swift.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  php: "tree-sitter-php.wasm",
};

let parserInitialized = false;
let patchVerified = false;
const loadedLanguages: Map<string, unknown> = new Map();

function ensureWebTreeSitterPatched(): void {
  if (patchVerified) return;
  patchVerified = true;
  try {
    const treeSitterPath = require.resolve("web-tree-sitter");
    const code = fs.readFileSync(treeSitterPath, "utf8");
    if (!code.includes('wasmImports["_Znwm"]')) {
      try {
        const patchScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scripts/patch-web-tree-sitter.cjs");
        if (fs.existsSync(patchScript)) {
          const { patchWebTreeSitter } = require(patchScript);
          patchWebTreeSitter(false);
        }
      } catch {
        console.warn("[waymark] Warning: web-tree-sitter C++ scanner patch was not applied (e.g. pnpm or --ignore-scripts). Run 'node scripts/patch-web-tree-sitter.cjs' to enable YAML parsing.");
      }
    }
  } catch {
    // ignore
  }
}

export async function initParser(): Promise<void> {
  if (!parserInitialized) {
    ensureWebTreeSitterPatched();
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
    // fallback to directory walk
  }

  // Walk up ancestor directories to handle hoisted or virtual node_modules
  try {
    let currentDir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(currentDir, "node_modules", "tree-sitter-wasms", "out", wasmName);
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }
  } catch {
    // ignore
  }

  const fallback = path.resolve(process.cwd(), "node_modules", "tree-sitter-wasms", "out", wasmName);
  if (fs.existsSync(fallback)) return fallback;
  return null;
}

function decodePropertyKey(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
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

  if (requested && !STRUCTURED_LANGUAGE_WASM[requested] && requested !== "markdown") {
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

function extractDeclaratorName(node: any): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "field_identifier" || node.type === "type_identifier") {
    return node.text;
  }
  const nameNode = node.childForFieldName("declarator") || node.childForFieldName("name");
  if (nameNode) return extractDeclaratorName(nameNode);
  for (const c of node.namedChildren) {
    const res = extractDeclaratorName(c);
    if (res) return res;
  }
  return null;
}

function extractElixirCall(node: any): { kind: StructuredSymbolKind; name: string } | null {
  const target = node.childForFieldName("target") || node.namedChildren[0];
  if (!target || target.type !== "identifier") return null;
  const verb = target.text;
  const args = node.childForFieldName("arguments") || node.namedChildren[1];
  if (!args) return null;

  if (verb === "defmodule") {
    const alias = args.namedChildren.find((c: any) => c.type === "alias" || c.type === "identifier");
    return alias ? { kind: "class", name: alias.text } : null;
  }
  if (verb === "defprotocol") {
    const alias = args.namedChildren.find((c: any) => c.type === "alias" || c.type === "identifier");
    return alias ? { kind: "interface", name: alias.text } : null;
  }
  if (verb === "defimpl") {
    const alias = args.namedChildren.find((c: any) => c.type === "alias" || c.type === "identifier");
    return alias ? { kind: "class", name: alias.text } : null;
  }
  if (["def", "defp", "defmacro", "defmacrop"].includes(verb)) {
    const inner = args.namedChildren[0];
    if (inner?.type === "call") {
      const fnName = inner.namedChildren[0]?.text;
      return fnName ? { kind: "function", name: fnName } : null;
    }
    if (inner?.type === "identifier") {
      return { kind: "function", name: inner.text };
    }
  }
  return null;
}

function collectStructuredSymbols(rootNode: any, language?: StructuredLanguage): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];

  function walk(node: any, currentClass: string | null = null): void {
    let nextClass = currentClass;

    if (node.type === "call" && (language === "elixir" || !language)) {
      const elx = extractElixirCall(node);
      if (elx) {
        const kind: StructuredSymbolKind = currentClass && elx.kind === "function" ? "method" : elx.kind;
        symbols.push(structuredSymbol(node, kind, elx.name));
        if (["class", "interface"].includes(elx.kind)) nextClass = elx.name;
      }
    } else if (node.type === "class_declaration" || node.type === "class_definition" || node.type === "class") {
      let kind: StructuredSymbolKind = "class";
      const nodeText: string = node.text || "";
      if (language === "swift" || (!language && (nodeText.startsWith("struct ") || nodeText.startsWith("enum ")))) {
        if (nodeText.startsWith("struct")) kind = "struct";
        else if (nodeText.startsWith("enum")) kind = "enum";
      } else if (language === "kotlin" || (!language && (nodeText.includes("interface ") || nodeText.includes("enum ")))) {
        if (nodeText.includes("interface")) kind = "interface";
        else if (nodeText.includes("enum")) kind = "enum";
      }
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, kind, name));
        nextClass = name;
      }
    } else if (node.type === "interface_declaration" || node.type === "protocol_declaration") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "interface", name));
        nextClass = name;
      }
    } else if (node.type === "trait_definition" || node.type === "trait_item" || node.type === "trait_declaration") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "trait", name));
        nextClass = name;
      }
    } else if (node.type === "impl_item") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) nextClass = typeNode.text;
    } else if (node.type === "struct_declaration" || node.type === "struct_item" || node.type === "struct_specifier") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "struct", name));
        nextClass = name;
      }
    } else if (node.type === "class_specifier") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "class", name));
        nextClass = name;
      }
    } else if (node.type === "enum_declaration" || node.type === "enum_item" || node.type === "enum_specifier") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) symbols.push(structuredSymbol(node, "enum", name));
    } else if (node.type === "record_declaration") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "record", name));
        nextClass = name;
      }
    } else if (node.type === "contract_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "contract", name));
        nextClass = name;
      }
    } else if (node.type === "module" || node.type === "object_declaration" || node.type === "object_definition") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "type_identifier" || c.type === "identifier")?.text;
      if (name) {
        symbols.push(structuredSymbol(node, "class", name));
        nextClass = name;
      }
    } else if (node.type === "constructor_declaration") {
      const name = node.childForFieldName("name")?.text || currentClass || "constructor";
      symbols.push(structuredSymbol(node, "constructor", name));
    } else if (node.type === "init_declaration") {
      symbols.push(structuredSymbol(node, "constructor", "init"));
    } else if (node.type === "constructor_definition") {
      symbols.push(structuredSymbol(node, "constructor", "constructor"));
    } else if (node.type === "property_declaration") {
      const name = node.childForFieldName("name")?.text ||
        node.namedChildren.find((c: any) => c.type === "identifier" || c.type === "variable_declaration")?.text;
      if (name) symbols.push(structuredSymbol(node, "property", name));
    } else if (node.type === "variable_declaration" && (language === "zig" || !language)) {
      const id = node.namedChildren.find((c: any) => c.type === "identifier");
      const hasStruct = node.namedChildren.some((c: any) => c.type === "struct_declaration");
      const hasEnum = node.namedChildren.some((c: any) => c.type === "enum_declaration");
      if (id && hasStruct) {
        symbols.push(structuredSymbol(node, "struct", id.text));
        nextClass = id.text;
      } else if (id && hasEnum) {
        symbols.push(structuredSymbol(node, "enum", id.text));
      }
    } else if (node.type === "type_spec" && (language === "go" || !language)) {
      const name = node.childForFieldName("name")?.text;
      const typeChild = node.childForFieldName("type");
      if (name && typeChild) {
        let kind: StructuredSymbolKind = "type";
        if (typeChild.type === "struct_type") kind = "struct";
        else if (typeChild.type === "interface_type") kind = "interface";
        symbols.push(structuredSymbol(node, kind, name));
        if (kind === "struct" || kind === "interface") nextClass = name;
      }
    } else if (node.type === "type_item" || node.type === "type_alias_declaration") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(structuredSymbol(node, "type", name));
    } else if (
      node.type === "method_declaration" ||
      node.type === "method_definition" ||
      node.type === "method" ||
      node.type === "singleton_method"
    ) {
      const name = node.childForFieldName("name")?.text || extractDeclaratorName(node);
      if (name) symbols.push(structuredSymbol(node, "method", name));
    } else if (
      node.type === "function_declaration" ||
      node.type === "function_definition" ||
      node.type === "function_item" ||
      node.type === "local_function_definition_statement" ||
      node.type === "function_definition_statement"
    ) {
      const name = node.childForFieldName("name")?.text ||
        extractDeclaratorName(node) ||
        node.namedChildren.find((c: any) => c.type === "simple_identifier" || c.type === "identifier")?.text;
      if (name) symbols.push(structuredSymbol(node, currentClass ? "method" : "function", name));
    } else if (node.type === "modifier_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) symbols.push(structuredSymbol(node, "method", name));
    } else if (node.type === "declaration" || node.type === "field_declaration") {
      const fnDecl = node.namedChildren.find((c: any) => c.type === "function_declarator");
      if (fnDecl) {
        const name = extractDeclaratorName(fnDecl);
        if (name) {
          symbols.push(structuredSymbol(node, name === currentClass ? "constructor" : "method", name));
        }
      }
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

let mdParserInstance: InstanceType<typeof MarkdownIt> | null = null;
function getMarkdownParser(): InstanceType<typeof MarkdownIt> {
  if (!mdParserInstance) {
    mdParserInstance = new MarkdownIt({ html: true });
  }
  return mdParserInstance;
}

function extractMarkdownSymbols(text: string): StructuredSymbol[] {
  const md = getMarkdownParser();
  const tokens = md.parse(text, {});
  const totalLines = text.split(/\r?\n/).length;

  interface HeadingItem {
    title: string;
    level: number;
    startLine: number;
  }

  const headings: HeadingItem[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.type === "heading_open") {
      const level = parseInt(token.tag.slice(1), 10) || 1;
      const inlineToken = tokens[i + 1];
      const title = inlineToken?.content?.trim() || "";
      const startLine = token.map ? token.map[0] + 1 : 1;
      headings.push({ title, level, startLine });
    }
  }

  const endLines: number[] = new Array(headings.length).fill(totalLines);
  const stack: { level: number; index: number }[] = [];
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    while (stack.length > 0 && stack[stack.length - 1]!.level >= current.level) {
      const top = stack.pop()!;
      endLines[top.index] = Math.max(headings[top.index]!.startLine, current.startLine - 1);
    }
    stack.push({ level: current.level, index: i });
  }

  const symbols: StructuredSymbol[] = [];

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    symbols.push({
      name: `${"#".repeat(current.level)} ${current.title}`,
      kind: "section",
      start: { line: current.startLine, column: 0 },
      end: { line: endLines[i] ?? totalLines, column: 0 },
    });
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.type === "table_open" && token.map) {
      const startLine = token.map[0] + 1;
      const endLine = token.map[1];
      symbols.push({
        name: `Table (L${startLine}-L${endLine})`,
        kind: "table",
        start: { line: startLine, column: 0 },
        end: { line: endLine, column: 0 },
      });
    }
  }

  symbols.sort((a, b) => a.start.line - b.start.line);
  return symbols;
}

function collectJsonSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];
  const rootObj = rootNode.namedChildren.find((c: any) => c.type === "object");
  if (rootObj) {
    for (const pair of rootObj.namedChildren) {
      if (pair.type === "pair") {
        const keyNode = pair.childForFieldName("key");
        const valNode = pair.childForFieldName("value");
        const rawKey = keyNode ? decodePropertyKey(keyNode.text) : "<unknown>";
        symbols.push({
          name: rawKey,
          kind: "config_block",
          start: { line: pair.startPosition.row + 1, column: pair.startPosition.column },
          end: { line: pair.endPosition.row + 1, column: pair.endPosition.column },
        });
        if (valNode?.type === "object" && valNode.namedChildren.length <= 50) {
          for (const subPair of valNode.namedChildren) {
            if (subPair.type === "pair") {
              const subKeyNode = subPair.childForFieldName("key");
              const subKey = subKeyNode ? decodePropertyKey(subKeyNode.text) : "<unknown>";
              symbols.push({
                name: `${rawKey}.${subKey}`,
                kind: "config_block",
                start: { line: subPair.startPosition.row + 1, column: subPair.startPosition.column },
                end: { line: subPair.endPosition.row + 1, column: subPair.endPosition.column },
              });
            }
          }
        }
      }
    }
  }
  return symbols;
}

function extractTomlPairs(containerNode: any, tableName: string, symbols: StructuredSymbol[]): void {
  for (const inner of containerNode.namedChildren) {
    if (inner.type === "pair") {
      const keyNode = inner.childForFieldName("key") || inner.namedChildren[0];
      if (keyNode) {
        const keyName = decodePropertyKey(keyNode.text);
        symbols.push({
          name: `${tableName}.${keyName}`,
          kind: "config_block",
          start: { line: inner.startPosition.row + 1, column: inner.startPosition.column },
          end: { line: inner.endPosition.row + 1, column: inner.endPosition.column },
        });
      }
    }
  }
}

function collectTomlSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];
  for (const child of rootNode.namedChildren) {
    if (child.type === "table") {
      const headerNode = child.namedChildren.find((n: any) => n.type.includes("header") || n.type === "bare_key" || n.type === "dotted_key" || n.type === "quoted_key");
      const rawHeader = headerNode ? headerNode.text.replace(/^\[|\]$/g, "").trim() : child.namedChildren[0]?.text || "table";
      const tableName = decodePropertyKey(rawHeader);
      symbols.push({
        name: `[${tableName}]`,
        kind: "config_block",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
      extractTomlPairs(child, tableName, symbols);
    } else if (child.type === "table_array_element") {
      const headerNode = child.namedChildren[0];
      const rawHeader = headerNode ? headerNode.text.replace(/^\[\[|\]\]$/g, "").trim() : "array";
      const name = decodePropertyKey(rawHeader);
      symbols.push({
        name: `[[${name}]]`,
        kind: "config_block",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
      extractTomlPairs(child, name, symbols);
    } else if (child.type === "pair") {
      const keyNode = child.childForFieldName("key") || child.namedChildren[0];
      symbols.push({
        name: keyNode ? decodePropertyKey(keyNode.text) : "<key>",
        kind: "constant",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
    }
  }
  return symbols;
}

function collectYamlMappingPairs(mappingNode: any, prefix: string, symbols: StructuredSymbol[], depth = 0): void {
  if (depth > 5) return;
  for (const child of mappingNode.namedChildren) {
    if (child.type === "block_mapping_pair" || child.type === "flow_pair") {
      const keyNode = child.childForFieldName("key");
      const valNode = child.childForFieldName("value");
      const rawKey = keyNode ? decodePropertyKey(keyNode.text) : "<key>";
      const fullName = prefix ? `${prefix}.${rawKey}` : rawKey;
      symbols.push({
        name: fullName,
        kind: "config_block",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
      if (valNode && depth < 2) {
        const subMapping = valNode.type === "block_mapping" || valNode.type === "flow_mapping"
          ? valNode
          : valNode.namedChildren?.find((n: any) => n.type === "block_mapping" || n.type === "flow_mapping");
        if (subMapping && subMapping.namedChildren.length <= 50) {
          collectYamlMappingPairs(subMapping, fullName, symbols, depth + 1);
        }
      }
    }
  }
}

function collectYamlSequenceItems(seqNode: any, prefix: string, symbols: StructuredSymbol[]): void {
  let idx = 0;
  for (const item of seqNode.namedChildren) {
    if (item.type === "block_sequence_item" || item.type === "flow_sequence_item") {
      const itemPrefix = prefix ? `${prefix}[${idx}]` : `[${idx}]`;
      symbols.push({
        name: itemPrefix,
        kind: "config_block",
        start: { line: item.startPosition.row + 1, column: item.startPosition.column },
        end: { line: item.endPosition.row + 1, column: item.endPosition.column },
      });
      const innerBlock = item.namedChildren.find((n: any) => n.type === "block_node" || n.type === "block_mapping" || n.type === "flow_mapping");
      const innerMapping = innerBlock?.type === "block_mapping" || innerBlock?.type === "flow_mapping"
        ? innerBlock
        : innerBlock?.namedChildren?.find((n: any) => n.type === "block_mapping" || n.type === "flow_mapping");
      if (innerMapping) {
        collectYamlMappingPairs(innerMapping, itemPrefix, symbols, 1);
      }
      idx++;
    }
  }
}

function collectYamlSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];
  const documents = rootNode.namedChildren.filter((n: any) => n.type === "document");
  const isMultiDoc = documents.length > 1;

  documents.forEach((docNode: any, docIdx: number) => {
    const docPrefix = isMultiDoc ? `doc[${docIdx}]` : "";
    const blockNode = docNode.namedChildren.find((n: any) => n.type === "block_node" || n.type === "flow_node");
    const rootShape = blockNode ? blockNode.namedChildren[0] || blockNode : docNode.namedChildren[0];
    if (!rootShape) return;

    if (rootShape.type === "block_mapping" || rootShape.type === "flow_mapping") {
      collectYamlMappingPairs(rootShape, docPrefix, symbols);
    } else if (rootShape.type === "block_sequence" || rootShape.type === "flow_sequence") {
      collectYamlSequenceItems(rootShape, docPrefix, symbols);
    }
  });

  return symbols;
}

function collectBashSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];
  for (const child of rootNode.namedChildren) {
    if (child.type === "function_definition") {
      const nameNode = child.childForFieldName("name");
      symbols.push({
        name: nameNode ? nameNode.text : "<function>",
        kind: "function",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
    } else if (child.type === "variable_assignment") {
      const nameNode = child.childForFieldName("name");
      const name = nameNode ? nameNode.text : child.text.split("=")[0];
      if (name && name.trim()) {
        symbols.push({
          name: name.trim(),
          kind: "variable",
          start: { line: child.startPosition.row + 1, column: child.startPosition.column },
          end: { line: child.endPosition.row + 1, column: child.endPosition.column },
        });
      }
    }
  }
  return symbols;
}

const CODEDB_OUTLINE_EXTENSIONS = new Set<string>([
  ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx",
  ".rb", ".php", ".swift", ".kt"
]);

async function discoverSymbolsViaCodedbOutline(
  repoRoot: string,
  storedPath: string,
): Promise<SymbolDiscoveryResult> {
  const { resolveCodedbCommand, runJson } = await import("./codedbAdapter.js");
  const command = resolveCodedbCommand();

  try {
    const run = await runJson(repoRoot, command, ["outline", storedPath, "--json"]);
    if (!run.ok) throw new WaymarkError("CODEDB_PROCESS_ERROR", run.error || "codedb outline failed", 2);
    const parsed = run.payload;
    if (!parsed || !Array.isArray(parsed.symbols)) throw new WaymarkError("CODEDB_PROCESS_ERROR", "codedb outline returned an invalid response", 2);
    if (!parsed.language || parsed.language === "unknown") {
      throw new WaymarkError("UNSUPPORTED_LANGUAGE", `Cannot detect a supported discovery language for ${storedPath}`, 2);
    }
    const symbols: StructuredSymbol[] = parsed.symbols
      .filter((s: any) => Boolean(s && s.name))
      .map((s: any) => {
        let kind: StructuredSymbolKind = "function";
        const rawKind = String(s.kind || "").toLowerCase();
        if (rawKind.includes("struct")) kind = "struct";
        else if (rawKind.includes("class")) kind = "class";
        else if (rawKind.includes("method")) kind = "method";
        else if (rawKind.includes("trait")) kind = "trait";
        else if (rawKind.includes("interface")) kind = "interface";
        else if (rawKind.includes("enum")) kind = "enum";
        else if (rawKind.includes("type")) kind = "type";
        else if (rawKind.includes("import") || rawKind.includes("use") || rawKind.includes("include")) kind = "import";
        else if (rawKind.includes("const")) kind = "constant";
        else if (rawKind.includes("var") || rawKind.includes("field") || rawKind.includes("property")) kind = "variable";
        else if (rawKind.includes("func") || rawKind.includes("fn")) kind = "function";

        const cleanName = String(s.name || "").trim().replace(/[\r\n]+$/, "");

        return {
          name: cleanName,
          kind,
          start: { line: s.line_start || 1, column: 0 },
          end: { line: s.line_end || s.line_start || 1, column: 0 },
        };
      })
      .filter((s: StructuredSymbol) => Boolean(s.name));
    return {
      ok: true,
      path: storedPath,
      language: (parsed.language || path.extname(storedPath).replace(".", "")) as any,
      symbols,
    };
  } catch (error) {
    if (error instanceof WaymarkError && error.code.startsWith("CODEDB_")) throw error;
    throw new WaymarkError("UNSUPPORTED_LANGUAGE", `Cannot detect a supported discovery language for ${storedPath}`, 2);
  }
}

/** One call site found by `parseSourceIndex`: `callee(...)`, `object.callee(...)`, or `new callee(...)`. */
export interface SourceCall {
  callee: string;
  /** The receiver text of a member call (`this`, `daemon`, `WaymarkDaemon`), absent for a bare call. */
  receiver?: string;
  line: number;
  column: number;
}

/** The JavaScript/TypeScript grammar for an extension, or undefined when the extension is not JS/TS. */
export function scriptLanguageForPath(storedPath: string): "javascript" | "typescript" | undefined {
  const language = STRUCTURED_EXTENSIONS[path.extname(storedPath).toLowerCase()];
  return language === "javascript" || language === "typescript" ? language : undefined;
}

/**
 * Symbols and call sites of one JavaScript/TypeScript source text. Unlike `discoverSymbolsInFile`
 * it tolerates syntax errors, because the repo-wide fallback index (treeSitterIndex.ts) would
 * rather keep a file's recoverable declarations than drop the file.
 */
export async function parseSourceIndex(text: string, language: "javascript" | "typescript"): Promise<{ symbols: StructuredSymbol[]; calls: SourceCall[] } | null> {
  const wasmName = STRUCTURED_LANGUAGE_WASM[language];
  const grammar = wasmName ? await getLanguageForWasm(wasmName) : null;
  if (!grammar) return null;
  const parser = new Parser();
  let tree: any;
  try {
    parser.setLanguage(grammar as any);
    tree = parser.parse(text);
    const symbols = collectStructuredSymbols(tree.rootNode, language);
    const calls: SourceCall[] = [];
    const visit = (node: any): void => {
      if (node.type === "call_expression") {
        const fn = node.childForFieldName("function");
        if (fn?.type === "identifier") {
          calls.push({ callee: fn.text, line: node.startPosition.row + 1, column: node.startPosition.column });
        } else if (fn?.type === "member_expression") {
          const property = fn.childForFieldName("property");
          const object = fn.childForFieldName("object");
          if (property) {
            calls.push({ callee: property.text, receiver: object?.text, line: node.startPosition.row + 1, column: node.startPosition.column });
          }
        }
      } else if (node.type === "new_expression") {
        const ctor = node.childForFieldName("constructor");
        if (ctor?.type === "identifier") {
          calls.push({ callee: ctor.text, receiver: "new", line: node.startPosition.row + 1, column: node.startPosition.column });
        }
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(tree.rootNode);
    return { symbols, calls };
  } catch {
    return null;
  } finally {
    try { tree?.delete(); } catch { /* ignore */ }
    try { parser.delete(); } catch { /* ignore */ }
  }
}

export interface RepoSymbolHit {
  name: string;
  path: string;
  line: number;
  kind: string;
  detail?: string;
  qualified?: string;
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
  const { resolveCodedbCommand, lookupSymbolDefinitions } = await import("./codedbAdapter.js");
  const command = resolveCodedbCommand();

  // Qualified names (`Class.method`) resolve the way call-graph roots do; a dotted name with no
  // qualified match lists its bare name's definitions.
  const lookup = await lookupSymbolDefinitions(repoRoot, command, query, { widenToBare: true });
  if (!lookup.ok) throw new WaymarkError("CODEDB_PROCESS_ERROR", lookup.error || "codedb symbol lookup failed", 2);
  const results: RepoSymbolHit[] = lookup.hits.map((r) => ({
    name: String(r.name ?? "").replace(/[\r\n]+$/u, ""),
    path: r.path,
    line: r.line,
    kind: r.kind || "symbol",
    ...(r.detail ? { detail: r.detail.replace(/[\r\n]+$/u, "") } : {}),
    ...(r.qualified ? { qualified: r.qualified } : {}),
  }));

  // codedb-core never indexes .mjs/.cjs/.mts/.cts/.toml, so their definitions are merged in.
  if (lookup.source === "codedb") {
    const { lookupFallbackSymbols } = await import("./treeSitterIndex.js");
    const seen = new Set(results.map((r) => `${r.path}:${r.line}`));
    for (const s of await lookupFallbackSymbols(repoRoot, query)) {
      if (seen.has(`${s.path}:${s.line}`)) continue;
      results.push({ name: s.name, path: s.path, line: s.line, kind: s.kind, qualified: s.qualified });
    }
  }
  return {
    ok: true,
    tool: "symbol",
    query,
    count: results.length,
    results,
  };
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

    if (language === "markdown") {
      result = {
        ok: true,
        path: storedPath,
        language,
        symbols: extractMarkdownSymbols(file.text),
      };
    } else {
      let grammar: unknown | null;
      try {
        const wasmName = STRUCTURED_LANGUAGE_WASM[language];
        if (!wasmName) throw new Error(`No wasm configured for ${language}`);
        grammar = await getLanguageForWasm(wasmName);
      } catch (err) {
        if (CODEDB_OUTLINE_EXTENSIONS.has(ext)) {
          try {
            result = await discoverSymbolsViaCodedbOutline(repoRoot, storedPath);
            if (query && query.trim()) {
              const q = query.trim().toLowerCase();
              result.symbols = result.symbols.filter((s) => s.name.toLowerCase().includes(q));
            }
            return result;
          } catch {
            // fall through to PARSER_UNAVAILABLE
          }
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new WaymarkError("PARSER_UNAVAILABLE", `Waymark grammar is unavailable for ${language}: ${detail}`, 2);
      }
      if (!grammar) {
        if (CODEDB_OUTLINE_EXTENSIONS.has(ext)) {
          try {
            result = await discoverSymbolsViaCodedbOutline(repoRoot, storedPath);
            if (query && query.trim()) {
              const q = query.trim().toLowerCase();
              result.symbols = result.symbols.filter((s) => s.name.toLowerCase().includes(q));
            }
            return result;
          } catch {
            // fall through
          }
        }
        throw new WaymarkError("PARSER_UNAVAILABLE", `Waymark grammar is unavailable for ${language}`, 2);
      }

      const parser = new Parser();
      let tree: any;
      try {
        parser.setLanguage(grammar as any);
        tree = parser.parse(file.text);
        if (tree.rootNode.hasError) {
          throw new WaymarkError("PARSE_ERROR", `Malformed ${language} source: ${storedPath}`, 2);
        }
        let symbols: StructuredSymbol[];
        if (language === "json") {
          symbols = collectJsonSymbols(tree.rootNode);
        } else if (language === "toml") {
          symbols = collectTomlSymbols(tree.rootNode);
        } else if (language === "yaml") {
          symbols = collectYamlSymbols(tree.rootNode);
        } else if (language === "bash") {
          symbols = collectBashSymbols(tree.rootNode);
        } else {
          symbols = collectStructuredSymbols(tree.rootNode, language);
        }
        result = {
          ok: true,
          path: storedPath,
          language,
          symbols,
        };
      } catch (err) {
        if (err instanceof WaymarkError) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        throw new WaymarkError("PARSE_ERROR", `Unable to parse ${language} source: ${storedPath}: ${detail}`, 2);
      } finally {
        if (tree) {
          try {
            tree.delete();
          } catch {
            // ignore
          }
        }
        try {
          parser.delete();
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
