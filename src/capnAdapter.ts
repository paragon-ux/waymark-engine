import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { AdapterProfile, PublicationResult, WaymarkError, AskOptions, AskResult } from "./types.js";
import { collectRepoPaths, detectAstIntent, detectLiteralIntent, matchLiteralPath, routeDiscovery } from "./discoveryRouter.js";
import { queryStructural } from "./codedbAdapter.js";
import { resolveWindowsExecutable } from "./executable.js";

export { resolveWindowsExecutable };

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2000;
const MAX_OUTPUT_LARGE = 8000;

interface CommandSpec {
  file: string;
  args: string[];
}

function digestOutput(value: string, maximum = MAX_OUTPUT): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function uniqueFiles(files: readonly string[]): string[] {
  const selected = [...new Set(files)].sort();
  if (selected.some((file) => file.includes(","))) throw new WaymarkError("CAPN_UNSAFE_PATH", "Capn's public CLI cannot encode a file path containing a comma");
  return selected;
}

function quoteCmdArgument(value: string): string {
  if (value.length === 0) return '""';
  if (/[\r\n%"]/u.test(value)) throw new WaymarkError("CAPN_UNSAFE_ARGUMENT", "Capn batch adapters reject percent signs, quotes, and newlines; use a direct executable for those values");
  if (/^[A-Za-z0-9_./\\:@+=,-]+$/u.test(value)) return value;
  return `"${value.replace(/["^&|<>]/gu, "^$&")}"`;
}

/**
 * Resolve the bundled `@paragon-ux/capn-hook` CLI entry (dist/capn.js) from the
 * installed dependency. Deterministic and PATH-independent: the lexical-only
 * fork is pinned as a runtime dependency, so the semantic phase never depends
 * on which `capn` happens to be on PATH.
 */
function bundledCapnEntry(): string | null {
  try {
    const pkg = require.resolve("@paragon-ux/capn-hook/package.json");
    return path.join(path.dirname(pkg), "dist", "capn.js");
  } catch {
    return null;
  }
}

interface ResolvedCapnCommand {
  file: string;
  prefix: string[];
  viaCmdShim: boolean;
}

/**
 * Resolve how to invoke capn:
 *  1. explicit executable (flag/env WAYMARK_CAPN_EXECUTABLE) — PATH/.cmd rules apply;
 *  2. the bundled @paragon-ux/capn-hook dist entry, run with this Node process
 *     (no PATH, no shell shims);
 *  3. `capn` on PATH as a last resort.
 */
export function resolveCapnCommand(executable?: string): ResolvedCapnCommand {
  const override = (executable && executable.trim()) || process.env.WAYMARK_CAPN_EXECUTABLE;
  if (override) {
    const resolved = resolveWindowsExecutable(override);
    const ext = path.extname(resolved).toLowerCase();
    return { file: resolved, prefix: [], viaCmdShim: ext === ".cmd" || ext === ".bat" };
  }
  const bundled = bundledCapnEntry();
  if (bundled) {
    return { file: process.execPath, prefix: [bundled], viaCmdShim: false };
  }
  const resolved = resolveWindowsExecutable("capn");
  const ext = path.extname(resolved).toLowerCase();
  return { file: resolved, prefix: [], viaCmdShim: ext === ".cmd" || ext === ".bat" };
}

async function execute(root: string, command: ResolvedCapnCommand, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = [...command.prefix, ...args];
  if (process.platform === "win32" && command.viaCmdShim) {
    const commandLine = [command.file, ...fullArgs].map(quoteCmdArgument).join(" ");
    return await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", commandLine], {
      cwd: root,
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
  }
  return await execFileAsync(command.file, fullArgs, {
    cwd: root,
    windowsHide: true,
    shell: false,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
}

export function capnChartArgs(question: string, answer: string, files: readonly string[]): string[] {
  // capn-hook >= 0.2: the answer moved from a positional to --details.
  return ["chart", question, ...uniqueFiles(files).flatMap((file) => ["--files", file]), "--details", answer];
}

function capnConfigPath(root: string): string {
  return path.join(root, ".capn", "config.json");
}

/**
 * Read the Capn store config. Returns null when the store has not been
 * initialized. Capn itself treats a missing config as embedding mode — the
 * engine refuses that mode, so it must be surfaced here.
 */
export function readCapnConfig(root: string): { embedding: boolean } | null {
  try {
    const raw = fs.readFileSync(capnConfigPath(root), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { embedding: parsed.embedding !== false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new WaymarkError("CAPN_CONFIG_CORRUPT", `Capn store config is not readable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fail closed on the QMD hybrid path. Semantic recall must be lexical-only
 * (`capn init --no-embedding`, or any capn init from the lexical-only fork):
 * the embedding path downloads Qwen-family models (300MB-2GB) and is
 * non-deterministic — exactly what the engine excludes from its answer path.
 * The codedb structural phase never needs this check; only the Capn fallback does.
 */
export function assertLexicalStore(root: string): void {
  const config = readCapnConfig(root);
  if (config === null) {
    throw new WaymarkError(
      "CAPN_STORE_UNINITIALIZED",
      "Capn store is not initialized. Run `capn init` (the lexical-only @paragon-ux/capn-hook) in the repository first — the engine requires deterministic lexical (BM25) recall.",
      2,
    );
  }
  if (config.embedding !== false) {
    throw new WaymarkError(
      "CAPN_NON_DETERMINISTIC_MODE",
      "Capn store is in embedding (QMD hybrid) mode. Re-initialize with the lexical-only @paragon-ux/capn-hook — the engine requires deterministic lexical recall.",
      2,
    );
  }
}

/**
 * Chart a question + answer (+ optional file references) into Capn memory.
 * Profile "none" disables publication (deterministic no-op for tests and
 * offline use); "capn-cli" invokes the Capn CLI (bundled fork preferred).
 */
export async function publish(
  root: string,
  profile: AdapterProfile,
  executable: string,
  question: string,
  answer: string,
  files: readonly string[],
): Promise<PublicationResult> {
  const selectedFiles = uniqueFiles(files);
  if (profile === "none") return { published: false, adapter: profile, output: "publication disabled" };

  assertLexicalStore(root);
  const args = capnChartArgs(question, answer, selectedFiles);
  try {
    const result = await execute(root, resolveCapnCommand(executable), args);
    return { published: true, adapter: profile, output: digestOutput(result.stdout || result.stderr || "capn chart completed") };
  } catch (error) {
    if (error instanceof WaymarkError) {
      return { published: false, adapter: profile, output: "", error: `${error.code}: ${error.message}` };
    }
    const candidate = error as { message?: string; stdout?: string; stderr?: string; code?: string | number };
    const detail = candidate.stderr || candidate.stdout || candidate.message || "Capn publication failed";
    return {
      published: false,
      adapter: profile,
      output: "",
      error: digestOutput(`${candidate.code ?? "CAPN_ERROR"}: ${detail}`),
    };
  }
}

async function queryCapnMemory(
  root: string,
  executable: string,
  question: string,
): Promise<{ hit: boolean; result: unknown; error?: string }> {
  try {
    const result = await execute(root, resolveCapnCommand(executable), ["ask", question]);
    const stdout = (result.stdout || "").trim();
    if (stdout && !stdout.startsWith("No charted answer.")) {
      try {
        const parsed: unknown = JSON.parse(stdout);
        return { hit: true, result: parsed };
      } catch {
        return { hit: true, result: digestOutput(stdout) };
      }
    }
    return { hit: false, result: null };
  } catch (error) {
    const candidate = error as { message?: string; stderr?: string; stdout?: string; code?: string | number };
    const combined = `${candidate.stdout || ""}\n${candidate.stderr || ""}`;
    if (combined.includes("No charted answer.")) {
      return { hit: false, result: null };
    }
    return {
      hit: false,
      result: null,
      error: digestOutput(`${candidate.code ?? "CAPN_ERROR"}: ${candidate.stderr || candidate.message || "Capn ask failed"}`),
    };
  }
}

/**
 * The multi-tier discovery router: structural questions (who calls / where is /
 * entrypoints) are answered by the deterministic codedb CLI; literal paths short-circuit;
 * fuzzy lexical and charted memory form the Discovery Junction.
 * A clean miss is a miss — the router never guesses.
 */
export async function ask(
  root: string,
  profile: AdapterProfile,
  executable: string,
  question: string,
  options?: AskOptions,
): Promise<AskResult | Record<string, unknown>> {
  if (profile === "none") return { waymark: 1, kind: "ask", provider: "none", status: "miss", matches: [] };

  return await routeDiscovery({
    root,
    question,
    options,
    capnExecutable: executable,
    profile,
    queryCapnMemory,
    assertLexicalStore,
  });
}

// ---------------------------------------------------------------------------
// Full wrapped Capn command surface (the lexical-only fork's CLI): bounded
// output, typed envelopes, same fail-closed posture.
// ---------------------------------------------------------------------------

async function runCapnSimple(root: string, executable: string, args: readonly string[]): Promise<{ ok: boolean; exitCode: number; output: string }> {
  try {
    const result = await execute(root, resolveCapnCommand(executable), args);
    return { ok: true, exitCode: 0, output: digestOutput(result.stdout || result.stderr || "", MAX_OUTPUT_LARGE) };
  } catch (error) {
    const candidate = error as { message?: string; stdout?: string; stderr?: string; code?: string | number };
    const detail = candidate.stderr || candidate.stdout || candidate.message || "capn command failed";
    return {
      ok: false,
      exitCode: typeof candidate.code === "number" ? candidate.code : 1,
      output: digestOutput(detail, MAX_OUTPUT_LARGE),
    };
  }
}

/** Delete one chart entry by id. */
export async function unchart(root: string, executable: string, id: string): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable, ["unchart", id]);
  return { waymark: 1, kind: "unchart", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

/** Delete every chart entry backed by one file. */
export async function bust(root: string, executable: string, file: string): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable, ["bust", file]);
  return { waymark: 1, kind: "bust", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

/** Delete every chart entry whose backing files changed or vanished. */
export async function prune(root: string, executable: string): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable, ["prune"]);
  return { waymark: 1, kind: "prune", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

/** List charted entries, human-readable. */
export async function listEntries(root: string, executable: string): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable, ["list"]);
  return { waymark: 1, kind: "list", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

/** Print the ask-first charting contract. */
export async function context(root: string, executable: string): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable, ["context"]);
  const routingHints = [
    "<waymark-engine>",
    "waymark-ask routes questions in two phases. Use exact phrasing for the symbolic (codedb) phase:",
    "",
    "  Symbolic (exact codedb match, resolved call graph):",
    "    \"Who calls <name>?\" / \"Callers of <name>\" / \"Callees of <name>\" / \"Trace <name>\"",
    "    \"What calls <name>?\" / \"Which functions call <name>?\" / \"Call hierarchy for <name>\"",
    "    \"Where is <name> declared?\" / \"Where is <name> defined?\" / \"Where is <name> implemented?\"",
    "    \"Definition of <name>\" / \"Declaration of <name>\" / \"Implementation of <name>\"",
    "    \"Find method <name>\" / \"Find function <name>\" / \"Find symbol <name>\"",
    "    \"Line numbers of <name>\" / \"Method signature of <name>\" / \"Locate symbol <name>\"",
    "    \"Entrypoints\" / \"Architecture\" / \"Overview of the repo\" / \"Hotspots\"",
    "",
    "  Semantic (BM25, charted memory):",
    "    Any conceptual question, e.g. \"How does authentication work?\"",
    "",
    "  <name> must be an exact identifier (case-sensitive). If no codedb hit, the query falls",
    "  through to semantic. Use waymark-context to see this contract again.",
    "</waymark-engine>",
    "",
  ].join("\n");
  return { waymark: 1, kind: "context", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: routingHints + result.output } : { error: result.output }) };
}

/** Initialize the repository's Capn lexical store using the bundled fork. */
export async function initCapn(root: string, executable?: string): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable ?? "", ["init"]);
  return { waymark: 1, kind: "init", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}
