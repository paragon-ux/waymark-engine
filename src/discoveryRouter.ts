import { extractAstFromRepo, type AstExtractionResult } from "./astExtractor.js";

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
    lower.includes("definition of") ||
    lower.includes("declared in") ||
    lower.includes("line numbers of") ||
    lower.includes("ast node") ||
    lower.includes("method signature") ||
    lower.includes("find symbol") ||
    lower.includes("locate symbol");

  if (symbolMatch) {
    const tokens = q.match(/[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*/g) || [];
    const stopWords = new Set([
      "where", "is", "method", "function", "class", "interface", "definition",
      "of", "declared", "in", "the", "find", "symbol", "lines", "numbers", "locate"
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

let cachedAst: AstExtractionResult | null = null;
let lastAstScanTime = 0;
let lastCachedRoot = "";

export async function getOrRefreshAst(root: string, maxAgeMs = 30_000): Promise<AstExtractionResult> {
  const now = Date.now();
  if (!cachedAst || lastCachedRoot !== root || now - lastAstScanTime > maxAgeMs) {
    cachedAst = await extractAstFromRepo(root);
    lastAstScanTime = now;
    lastCachedRoot = root;
  }
  return cachedAst;
}

export async function queryWasmAst(
  intent: AstIntent,
  root: string
): Promise<{ hit: boolean; output: string }> {
  try {
    const ast = await getOrRefreshAst(root);

    if (intent.tool === "get_architecture") {
      const entrypoints = ast.symbols.filter(s => {
        const callers = ast.callersMap.get(s.name) || [];
        return callers.length === 0 && (s.kind === "Function" || s.kind === "Method");
      });
      let out = `total_nodes: ${ast.symbols.length}\n`;
      out += `entry_points: ${entrypoints.length}\n`;
      for (const ep of entrypoints) {
        out += `  ${ep.qualifiedName} ${ep.kind} ${ep.file}:${ep.startLine}-${ep.endLine}\n`;
      }
      return { hit: true, output: out.trim() };
    }

    if (intent.tool === "trace_path") {
      const fn = intent.functionName || "";
      const callers = ast.callersMap.get(fn) || [];
      const callees = ast.calleesMap.get(fn) || [];

      if (callers.length === 0 && callees.length === 0) {
        const sym = ast.symbols.find(s => s.name.toLowerCase() === fn.toLowerCase());
        if (!sym) {
          return { hit: false, output: `Function or method "${fn}" not found in AST.` };
        }
      }

      let out = `function: ${fn}\n`;
      out += `direction: both\n`;
      out += `callees_total: ${callees.length}\n`;
      out += `callees: ${callees.length > 0 ? callees.join(", ") : "None"}\n`;
      out += `callers_total: ${callers.length}\n`;
      out += `callers: ${callers.length > 0 ? callers.join(", ") : "None"}\n`;
      return { hit: true, output: out.trim() };
    }

    // Symbol Search
    const queryTerm = (intent.query || "").toLowerCase();
    const matched = ast.symbols.filter(s =>
      s.name.toLowerCase().includes(queryTerm) ||
      s.qualifiedName.toLowerCase().includes(queryTerm)
    );

    if (matched.length === 0) {
      return { hit: false, output: `results: 0` };
    }

    let out = `total: ${matched.length}\nresults: ${matched.length} (cols: qn label file lines)\n`;
    for (const m of matched) {
      out += `  ${m.qualifiedName} ${m.kind} ${m.file} ${m.startLine}-${m.endLine}\n`;
    }
    return { hit: true, output: out.trim() };
  } catch (error) {
    return { hit: false, output: error instanceof Error ? error.message : String(error) };
  }
}