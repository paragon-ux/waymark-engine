import os from "node:os";
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

import { getResidentClient, type CodedbJson, type CodedbRun } from "./residentCodedb.js";
import { tryDaemonQuery, autoStartDaemon } from "./daemon.js";

export type { CodedbJson, CodedbRun };

async function executeCold(root: string, command: ResolvedCodedbCommand, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = [...command.prefix, ...args];
  const timeoutMs = process.env.WAYMARK_CODEDB_TIMEOUT
    ? parseInt(process.env.WAYMARK_CODEDB_TIMEOUT, 10) || 120_000
    : 120_000;
  const defaultThreads = Math.max(1, (os.availableParallelism?.() || os.cpus().length || 2) - 1);
  const maxThreads = process.env.CODEDB_MAX_THREADS || String(defaultThreads);
  return await execFileAsync(command.file, fullArgs, {
    cwd: root,
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      CODEDB_QUIET: "1",
      CODEDB_MAX_THREADS: maxThreads,
    },
  });
}

/** Cold execution fallback: spawns a one-shot codedb process. */
async function runJsonCold(root: string, command: ResolvedCodedbCommand, args: readonly string[]): Promise<CodedbRun> {
  try {
    const result = await executeCold(root, command, args);
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

/** Run one codedb query with `--json`, preferring resident daemon/client with cold fallback. */
export async function runJson(root: string, command: ResolvedCodedbCommand, args: readonly string[]): Promise<CodedbRun> {
  // 1. Explicit escape hatch to force one-shot cold execute
  if (process.env.WAYMARK_DISABLE_RESIDENT === "1") {
    return await runJsonCold(root, command, args);
  }

  // 2. Query active daemon if running
  try {
    const daemonRes = await tryDaemonQuery(root, args);
    if (daemonRes !== null) {
      return daemonRes;
    }
  } catch {
    // Daemon unreachable; continue
  }

  // 3. Only auto-start daemon if explicitly opted-in via env or flag (default is OFF)
  // Preserves zero-background-daemon invariant for standard CLI commands.
  const explicitAutoDaemon = process.env.WAYMARK_AUTO_DAEMON === "1" || process.env.WAYMARK_DAEMON === "1";
  if (explicitAutoDaemon && !command.prefix.length) {
    try {
      const started = await autoStartDaemon(root, 15_000);
      if (started) {
        const daemonRes = await tryDaemonQuery(root, args);
        if (daemonRes !== null) {
          return daemonRes;
        }
      }
    } catch {
      // Auto-start failed; continue
    }
  }

  // 4. In-process resident client (for tests, programmatic ask() callers, or single processes)
  try {
    const client = getResidentClient(root, command);
    return await client.send(args);
  } catch {
    // Resident client failed; fail-closed fallback to cold execution
    return await runJsonCold(root, command, args);
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

const HIGH_COLLISION_NAMES = new Set([
  "new", "init", "close", "run", "start", "stop", "reset",
  "get", "set", "create", "update", "delete", "destroy",
  "handle", "register", "string", "error", "write", "read",
  "execute", "process", "build", "parse", "format", "render",
  "load", "save", "flush", "clear", "open", "connect", "disconnect",
]);

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

    // Fast-path ambiguity & existence check for bare identifiers (LEDGER-07)
    // If a bare identifier has >= 25 candidate definitions across the repo, return ambiguity immediately
    // rather than spending 25+ seconds computing and deduplicating massive caller sets.
    if (!fn.includes(".") && !fn.includes(":")) {
      const symRun = await runJson(root, command, ["symbol", fn, "--json"]);
      if (symRun.ok && symRun.payload) {
        const cands = (symRun.payload.results as Neighbor[] | undefined) ?? [];
        if (cands.length >= 25) {
          let out = `function: ${fn}\n`;
          out += `ambiguous: true\n`;
          out += `candidates (${cands.length}):\n`;
          for (const c of cands) {
            out += `  ${c.path}:${c.line} ${c.kind ?? "function"} ${c.name}\n`;
          }
          return { hit: true, output: out.trim() };
        }
        if (cands.length === 0) {
          return { hit: false, output: `Function or method "${fn}" not found.` };
        }
      }
    }

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

const fuzzyCandidateCache = new Map<string, { at: number; candidates: FuzzyCandidate[] }>();

/**
 * Retrieve candidate symbols from codedb for fuzzy ranking.
 */
export async function queryFuzzyCandidates(
  token: string,
  root: string,
  executable?: string,
): Promise<FuzzyCandidate[]> {
  const cacheKey = `${root}::${token}`;
  const cached = fuzzyCandidateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60_000) {
    return cached.candidates;
  }
  const command = resolveCodedbCommand(executable);
  const res = await runJson(root, command, ["symbol", token, "--fuzzy", "--max-results", "100", "--json"]);
  if (!res.ok || !res.payload?.results) return [];
  const hits = res.payload.results as Array<{ name: string; path: string; line: number; kind?: string }>;
  const candidates = hits.map((h) => ({
    name: h.name,
    path: h.path,
    line: h.line,
    kind: h.kind,
  }));
  fuzzyCandidateCache.set(cacheKey, { at: Date.now(), candidates });
  return candidates;
}
