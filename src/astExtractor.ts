import Parser from "web-tree-sitter";
import MarkdownIt from "markdown-it";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { normalizeRelativePath, readFileText } from "./paths.js";
import { WaymarkError } from "./types.js";

const require = createRequire(import.meta.url);

export type StructuredLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "json"
  | "toml"
  | "yaml"
  | "bash"
  | "markdown";

export type StructuredSymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "type"
  | "struct"
  | "enum"
  | "trait"
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
  ".jsonc": "json",
  ".json5": "json",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdx": "markdown",
};

const STRUCTURED_LANGUAGE_WASM: Partial<Record<StructuredLanguage, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  json: "tree-sitter-json.wasm",
  toml: "tree-sitter-toml.wasm",
  yaml: "tree-sitter-yaml.wasm",
  bash: "tree-sitter-bash.wasm",
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

function extractMarkdownSymbols(text: string): StructuredSymbol[] {
  const md = new MarkdownIt({ html: true });
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

  const symbols: StructuredSymbol[] = [];

  for (let i = 0; i < headings.length; i++) {
    const current = headings[i]!;
    const nextEqualOrHigher = headings.slice(i + 1).find((h) => h.level <= current.level);
    const endLine = nextEqualOrHigher ? Math.max(current.startLine, nextEqualOrHigher.startLine - 1) : totalLines;

    symbols.push({
      name: `${"#".repeat(current.level)} ${current.title}`,
      kind: "section",
      start: { line: current.startLine, column: 0 },
      end: { line: endLine, column: 0 },
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
        const rawKey = keyNode ? keyNode.text.replace(/^"|"$/g, "") : "<unknown>";
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
              const subKey = subKeyNode ? subKeyNode.text.replace(/^"|"$/g, "") : "<unknown>";
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

function collectTomlSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];
  for (const child of rootNode.namedChildren) {
    if (child.type === "table") {
      const headerNode = child.namedChildren.find((n: any) => n.type.includes("header") || n.type === "bare_key" || n.type === "dotted_key");
      const tableName = headerNode ? headerNode.text.replace(/^\[|\]$/g, "").trim() : child.namedChildren[0]?.text || "table";
      symbols.push({
        name: `[${tableName}]`,
        kind: "config_block",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
      for (const inner of child.namedChildren) {
        if (inner.type === "pair") {
          const keyNode = inner.childForFieldName("key") || inner.namedChildren[0];
          if (keyNode) {
            symbols.push({
              name: `${tableName}.${keyNode.text.trim()}`,
              kind: "config_block",
              start: { line: inner.startPosition.row + 1, column: inner.startPosition.column },
              end: { line: inner.endPosition.row + 1, column: inner.endPosition.column },
            });
          }
        }
      }
    } else if (child.type === "table_array_element") {
      const headerNode = child.namedChildren[0];
      const name = headerNode ? headerNode.text.replace(/^\[\[|\]\]$/g, "").trim() : "array";
      symbols.push({
        name: `[[${name}]]`,
        kind: "config_block",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
    } else if (child.type === "pair") {
      const keyNode = child.childForFieldName("key") || child.namedChildren[0];
      symbols.push({
        name: keyNode ? keyNode.text.trim() : "<key>",
        kind: "constant",
        start: { line: child.startPosition.row + 1, column: child.startPosition.column },
        end: { line: child.endPosition.row + 1, column: child.endPosition.column },
      });
    }
  }
  return symbols;
}

function findYamlBlockMapping(node: any): any {
  if (node.type === "block_mapping") return node;
  for (const child of node.namedChildren) {
    const res = findYamlBlockMapping(child);
    if (res) return res;
  }
  return null;
}

function collectYamlSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];
  const rootMapping = findYamlBlockMapping(rootNode);
  if (rootMapping) {
    for (const child of rootMapping.namedChildren) {
      if (child.type === "block_mapping_pair") {
        const keyNode = child.childForFieldName("key");
        const valNode = child.childForFieldName("value");
        const keyName = keyNode ? keyNode.text.trim() : "<key>";
        symbols.push({
          name: keyName,
          kind: "config_block",
          start: { line: child.startPosition.row + 1, column: child.startPosition.column },
          end: { line: child.endPosition.row + 1, column: child.endPosition.column },
        });
        const subMapping = valNode ? findYamlBlockMapping(valNode) : null;
        if (subMapping && subMapping.namedChildren.length <= 50) {
          for (const subChild of subMapping.namedChildren) {
            if (subChild.type === "block_mapping_pair") {
              const subKeyNode = subChild.childForFieldName("key");
              const subKeyName = subKeyNode ? subKeyNode.text.trim() : "<key>";
              symbols.push({
                name: `${keyName}.${subKeyName}`,
                kind: "config_block",
                start: { line: subChild.startPosition.row + 1, column: subChild.startPosition.column },
                end: { line: subChild.endPosition.row + 1, column: subChild.endPosition.column },
              });
            }
          }
        }
      }
    }
  }
  return symbols;
}

function collectBashSymbols(rootNode: any): StructuredSymbol[] {
  const symbols: StructuredSymbol[] = [];
  function walk(node: any): void {
    if (node.type === "function_definition") {
      const nameNode = node.childForFieldName("name");
      symbols.push({
        name: nameNode ? nameNode.text : "<function>",
        kind: "function",
        start: { line: node.startPosition.row + 1, column: node.startPosition.column },
        end: { line: node.endPosition.row + 1, column: node.endPosition.column },
      });
    } else if (node.type === "variable_assignment") {
      const nameNode = node.childForFieldName("name");
      const name = nameNode ? nameNode.text : node.text.split("=")[0];
      if (name && name.trim()) {
        symbols.push({
          name: name.trim(),
          kind: "variable",
          start: { line: node.startPosition.row + 1, column: node.startPosition.column },
          end: { line: node.endPosition.row + 1, column: node.endPosition.column },
        });
      }
    }
    for (const child of node.namedChildren) {
      walk(child);
    }
  }
  walk(rootNode);
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

  const run = await runJson(repoRoot, command, ["symbol", query, "--json"]);
  if (!run.ok || !run.payload) throw new WaymarkError("CODEDB_PROCESS_ERROR", run.error || "codedb symbol lookup failed", 2);
  const results = Array.isArray(run.payload.results) ? run.payload.results : [];
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
          symbols = collectStructuredSymbols(tree.rootNode);
        }
        result = {
          ok: true,
          path: storedPath,
          language,
          symbols,
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
  }

  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    result.symbols = result.symbols.filter((s) => s.name.toLowerCase().includes(q));
  }

  return result;
}
