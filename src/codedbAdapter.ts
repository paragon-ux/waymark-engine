import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import type { AstIntent } from "./discoveryRouter.js";
import { resolveWindowsExecutable } from "./executable.js";
import type { FuzzyCandidate } from "./types.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

export interface ResolvedCodedbCommand {
  file: string;
  prefix: string[];
  viaCmdShim: boolean;
}

/** Resolve the bundled `@paragon-ux/codedb-core` binary, if installed. */
function bundledCodedbBinary(): string | null {
  try {
    const mod = require("@paragon-ux/codedb-core") as { codedbBinaryPath: () => string | null };
    return mod.codedbBinaryPath();
  } catch {
    return null;
  }
}

/**
 * Resolve how to invoke codedb:
 *  1. explicit executable (flag/env WAYMARK_CODEDB_EXECUTABLE);
 *  2. the bundled @paragon-ux/codedb-core binary (deterministic, PATH-independent);
 *  3. `codedb` on PATH as a last resort.
 */
export function resolveCodedbCommand(executable?: string): ResolvedCodedbCommand {
  const override = (executable && executable.trim()) || process.env.WAYMARK_CODEDB_EXECUTABLE;
  if (override) {
    const resolved = resolveWindowsExecutable(override);
    const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
    return { file: resolved, prefix: [], viaCmdShim: ext === "cmd" || ext === "bat" };
  }
  const bundled = bundledCodedbBinary();
  if (bundled) {
    return { file: bundled, prefix: [], viaCmdShim: false };
  }
  const resolved = resolveWindowsExecutable("codedb");
  const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
  return { file: resolved, prefix: [], viaCmdShim: ext === "cmd" || ext === "bat" };
}

interface CodedbJson {
  ok: boolean;
  tool?: string;
  ambiguous?: boolean;
  symbol_exists?: boolean;
  dropped_ambiguous_callers?: number;
  dropped_ambiguous_callees?: number;
  count?: number;
  path?: string;
  language?: string;
  line_count?: number;
  results?: unknown[];
  symbols?: unknown[];
  files?: unknown[];
  callers?: { count?: number; results?: unknown[] } | unknown[];
  callees?: { count?: number; results?: unknown[] } | unknown[];
}

interface CodedbRun {
  ok: boolean;
  payload: CodedbJson | null;
  error: string;
}

async function execute(root: string, command: ResolvedCodedbCommand, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = [...command.prefix, ...args];
  return await execFileAsync(command.file, fullArgs, {
    cwd: root,
    windowsHide: true,
    shell: false,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CODEDB_QUIET: "1" },
  });
}

/** Run one codedb query with `--json` and return the parsed payload. */
async function runJson(root: string, command: ResolvedCodedbCommand, args: readonly string[]): Promise<CodedbRun> {
  try {
    const result = await execute(root, command, args);
    const stdout = (result.stdout || "").trim();
    const lines = stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    const jsonLine = lines[lines.length - 1] ?? "";
    if (!jsonLine.startsWith("{")) {
      return { ok: false, payload: null, error: (result.stderr || stdout || "codedb produced no JSON").trim() };
    }
    const payload = JSON.parse(jsonLine) as CodedbJson;
    if (payload.ok !== true) return { ok: false, payload, error: "codedb reported failure" };
    return { ok: true, payload, error: "" };
  } catch (error) {
    const candidate = error as { message?: string; stderr?: string; stdout?: string };
    return { ok: false, payload: null, error: candidate.stderr || candidate.stdout || candidate.message || "codedb failed" };
  }
}

interface Neighbor {
  path: string;
  name: string;
  line: number;
  kind?: string;
}

interface SymbolHit {
  path: string;
  line: number;
  kind: string;
  name: string;
}

/**
 * Answer a structural intent with the deterministic codedb CLI. `trace_path`
 * uses the resolved fail-closed call graph (via single-pass `neighbors`);
 * `search_graph` resolves symbol definitions; `get_architecture` reports repo
 * topology. A clean miss returns `hit: false` — never a guess.
 */
export async function queryStructural(
  intent: AstIntent,
  root: string,
  executable?: string,
): Promise<{ hit: boolean; output: string }> {
  const command = resolveCodedbCommand(executable);

  if (intent.tool === "get_architecture") {
    const tree = await runJson(root, command, ["tree", "--json"]);
    if (!tree.ok || !tree.payload) return { hit: false, output: tree.error };
    const files = (tree.payload.files ?? []) as Array<{ path: string; language: string; line_count: number; sym_count: number }>;
    const totalSymbols = files.reduce((n, f) => n + (f.sym_count ?? 0), 0);
    let out = `total_files: ${files.length}\n`;
    out += `total_symbols: ${totalSymbols}\n`;
    for (const f of files) {
      out += `  ${f.path} ${f.language} ${f.line_count} lines ${f.sym_count} symbols\n`;
    }
    return { hit: true, output: out.trim() };
  }

  if (intent.tool === "trace_path") {
    const fn = intent.functionName || "";
    // Priority: Try single-pass `neighbors` command first
    const nRun = await runJson(root, command, ["neighbors", fn, "--json"]);
    if (nRun.ok && nRun.payload) {
      if (nRun.payload.ambiguous === true) {
        const cands = (nRun.payload.results as Neighbor[] | undefined) ?? [];
        let out = `function: ${fn}\n`;
        out += `ambiguous: true\n`;
        out += `candidates (${cands.length}):\n`;
        for (const c of cands) {
          out += `  ${c.path}:${c.line} ${c.kind ?? "function"} ${c.name}\n`;
        }
        return { hit: true, output: out.trim() };
      }

      if (nRun.payload.symbol_exists === false) {
        return { hit: false, output: `Function or method "${fn}" not found.` };
      }

      const callersData = nRun.payload.callers;
      const calleesData = nRun.payload.callees;
      const callerItems = (Array.isArray(callersData) ? callersData : (callersData as { results?: Neighbor[] })?.results) ?? [];
      const calleeItems = (Array.isArray(calleesData) ? calleesData : (calleesData as { results?: Neighbor[] })?.results) ?? [];
      const callerNames = callerItems.map((r: any) => r.name);
      const calleeNames = calleeItems.map((r: any) => r.name);

      let out = `function: ${fn}\n`;
      out += `direction: both\n`;
      out += `callees_total: ${calleeNames.length}\n`;
      out += `callees: ${calleeNames.length > 0 ? calleeNames.join(", ") : "None"}\n`;
      out += `callers_total: ${callerNames.length}\n`;
      out += `callers: ${callerNames.length > 0 ? callerNames.join(", ") : "None"}\n`;
      return { hit: true, output: out.trim() };
    }

    // Fallback for legacy codedb without `neighbors`
    const callers = await runJson(root, command, ["callers", fn, "--json"]);
    const callees = await runJson(root, command, ["callees", fn, "--json"]);

    if (callers.payload?.ambiguous === true || callees.payload?.ambiguous === true) {
      const source = callers.payload?.ambiguous === true ? callers.payload : callees.payload;
      const cands = (source?.results as Neighbor[] | undefined) ?? [];
      let out = `function: ${fn}\n`;
      out += `ambiguous: true\n`;
      out += `candidates (${cands.length}):\n`;
      for (const c of cands) {
        out += `  ${c.path}:${c.line} ${c.kind ?? "function"} ${c.name}\n`;
      }
      return { hit: true, output: out.trim() };
    }

    const callerNames = (callers.payload?.results as Neighbor[] | undefined)?.map((r) => r.name) ?? [];
    const calleeNames = (callees.payload?.results as Neighbor[] | undefined)?.map((r) => r.name) ?? [];

    if (callerNames.length === 0 && calleeNames.length === 0) {
      const symbol = await runJson(root, command, ["symbol", fn, "--json"]);
      const symbolCount = (symbol.payload?.results as unknown[] | undefined)?.length ?? 0;
      if (symbolCount === 0) {
        return { hit: false, output: `Function or method "${fn}" not found.` };
      }
    }

    let out = `function: ${fn}\n`;
    out += `direction: both\n`;
    out += `callees_total: ${calleeNames.length}\n`;
    out += `callees: ${calleeNames.length > 0 ? calleeNames.join(", ") : "None"}\n`;
    out += `callers_total: ${callerNames.length}\n`;
    out += `callers: ${callerNames.length > 0 ? callerNames.join(", ") : "None"}\n`;
    return { hit: true, output: out.trim() };
  }

  // search_graph
  const query = intent.query || "";
  const symbol = await runJson(root, command, ["symbol", query, "--json"]);
  const results = (symbol.payload?.results as SymbolHit[] | undefined) ?? [];
  if (results.length === 0) {
    return { hit: false, output: "results: 0" };
  }
  let out = `total: ${results.length}\nresults: ${results.length} (cols: qn label file lines)\n`;
  for (const r of results) {
    out += `  ${r.name} ${r.kind} ${r.path} ${r.line}\n`;
  }
  return { hit: true, output: out.trim() };
}

/**
 * Retrieve candidate symbols from codedb for fuzzy ranking.
 */
export async function queryFuzzyCandidates(
  token: string,
  root: string,
  executable?: string,
): Promise<FuzzyCandidate[]> {
  const command = resolveCodedbCommand(executable);
  const res = await runJson(root, command, ["symbol", token, "--fuzzy", "--max-results", "100", "--json"]);
  if (!res.ok || !res.payload?.results) return [];
  const hits = res.payload.results as Array<{ name: string; path: string; line: number; kind?: string }>;
  return hits.map((h) => ({
    name: h.name,
    path: h.path,
    line: h.line,
    kind: h.kind,
  }));
}
