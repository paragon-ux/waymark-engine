import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { AdapterProfile, PublicationResult, WaymarkError, AskOptions, AskResult } from "./types.js";
import { collectRepoPaths, detectAstIntent, detectLiteralIntent, matchLiteralPath, routeDiscovery } from "./discoveryRouter.js";
import { queryStructural } from "./codedbAdapter.js";
import { resolveWindowsExecutable } from "./executable.js";
import { normalizeRelativePath, resolveRepositoryFile } from "./paths.js";
import { ensureStateDir, memoryStoreDir, LEGACY_STORE_DIR_NAME, MEMORY_STORE_LABEL } from "./stateDir.js";
import { entryFreshness, readChartedEntries, staleChartedEntries } from "./memoryEntries.js";

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

function normalizeFilePath(f: string): string {
  return f.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function uniqueFiles(files: readonly string[]): string[] {
  const selected = [...new Set(files.map(normalizeFilePath))].sort();
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
 *     a `.js`/`.mjs`/`.cjs` entry (for example a local capn-hook checkout's
 *     dist/capn.js) runs with this Node process;
 *  2. the bundled @paragon-ux/capn-hook dist entry, run with this Node process
 *     (no PATH, no shell shims);
 *  3. `capn` on PATH as a last resort.
 */
export function resolveCapnCommand(executable?: string): ResolvedCapnCommand {
  const override = (executable && executable.trim()) || process.env.WAYMARK_CAPN_EXECUTABLE;
  if (override && override !== "capn") {
    if (/\.[cm]?js$/iu.test(override)) {
      return { file: process.execPath, prefix: [path.resolve(override)], viaCmdShim: false };
    }
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

/**
 * Global capn arguments that pin the project root and the Waymark-owned memory
 * store. They precede the subcommand, so a capn without store-dir support sees
 * an unknown command and prints usage before it touches disk.
 */
export function capnStoreArgs(root: string): string[] {
  const resolved = capnRoot(root);
  return ["--root", resolved, "--store-dir", memoryStoreDir(resolved)];
}

/**
 * capn resolves charted files against its working directory and compares them with --root.
 * macOS reports a working directory with symlinks resolved (/var -> /private/var) while
 * Windows keeps a junction as given, so capn gets the resolved root as both --root and cwd.
 */
function capnRoot(root: string): string {
  const absolute = path.resolve(root);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isUsageResponse(error: unknown): boolean {
  const candidate = error as { stdout?: string; stderr?: string };
  return /^\s*Usage:/u.test(candidate.stdout || "") || /^\s*Usage:/u.test(candidate.stderr || "");
}

function storeDirUnsupported(): WaymarkError {
  return new WaymarkError(
    "CAPN_STORE_DIR_UNSUPPORTED",
    `The capn executable does not accept --root/--store-dir, so it could only use the shared ${LEGACY_STORE_DIR_NAME} folder. Waymark refuses to run it; its memory store lives in ${MEMORY_STORE_LABEL}. Upgrade @paragon-ux/capn-hook to a release with store-dir support.`,
    2,
  );
}

async function execute(root: string, command: ResolvedCapnCommand, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const fullArgs = [...command.prefix, ...capnStoreArgs(root), ...args];
  const cwd = capnRoot(root);
  try {
    if (process.platform === "win32" && command.viaCmdShim) {
      const commandLine = [command.file, ...fullArgs].map(quoteCmdArgument).join(" ");
      return await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/v:off", "/s", "/c", commandLine], {
        cwd,
        windowsHide: true,
        shell: false,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      });
    }
    return await execFileAsync(command.file, fullArgs, {
      cwd,
      windowsHide: true,
      shell: false,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
  } catch (error) {
    if (isUsageResponse(error)) throw storeDirUnsupported();
    throw error;
  }
}

export function capnChartArgs(question: string, answer: string, files: readonly string[]): string[] {
  // capn-hook >= 0.2: the answer moved from a positional to --details.
  return ["chart", question, ...uniqueFiles(files).flatMap((file) => ["--files", file]), "--details", answer];
}

function capnConfigPath(root: string): string {
  return path.join(memoryStoreDir(root), "config.json");
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
      `Memory store is not initialized (${MEMORY_STORE_LABEL} missing). Run \`waymark init\` in the repository first — the engine requires deterministic lexical (BM25) recall.`,
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
  // Repo-relative paths only: an absolute path spelled through a symlink would not
  // match the resolved --root that capn compares it against.
  const selectedFiles = uniqueFiles(files.map((file) => normalizeRelativePath(file, root)));
  for (const file of selectedFiles) resolveRepositoryFile(root, file);
  if (profile === "none") return { published: false, adapter: profile, output: "publication disabled" };

  if (readCapnConfig(root) === null) {
    const initialized = await initCapn(root, executable);
    if (!initialized.ok) return { published: false, adapter: profile, output: "", error: String(initialized.error) };
  }
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

/**
 * An entry whose question matches `query` exactly, newest first. Only a fresh entry answers: one
 * whose backing files vanished or changed is left to `capn ask`, which prunes it, so this shortcut
 * never returns an answer capn itself would refuse.
 */
function lookupExactCapnEntry(root: string, query: string): unknown | null {
  try {
    const normQuery = query.trim().toLowerCase().replace(/[?.,!]+$/g, "");
    for (const entry of readChartedEntries(root)) {
      const normCharted = entry.question.toLowerCase().replace(/[?.,!]+$/g, "");
      if (normQuery !== normCharted) continue;
      if (!entryFreshness(root, entry).fresh) continue;
      return {
        id: entry.id,
        question: entry.question,
        files: [...entry.files].sort(),
        score: 100,
        ...(entry.details ? { details: entry.details } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** One line per entry capn is about to prune, for results that would otherwise lose them silently. */
function describeStaleEntries(stale: ReturnType<typeof staleChartedEntries>): string[] {
  return stale.map((entry) => {
    const reasons = [
      ...(entry.missingFiles.length > 0 ? [`missing: ${entry.missingFiles.join(", ")}`] : []),
      ...(entry.staleFiles.length > 0 ? [`changed: ${entry.staleFiles.join(", ")}`] : []),
    ];
    return `${entry.id} "${entry.question}" (${reasons.join("; ")})`;
  });
}

const MEMORY_QUERY_STOPWORDS = new Set([
  "who", "what", "where", "when", "why", "how", "does", "do", "did", "is", "are", "was", "were",
  "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "with", "from", "by", "which", "that",
  "find", "locate", "show", "tell", "me", "please", "function", "method", "class", "symbol", "declared",
  "defined", "implemented", "declaration", "definition", "implementation", "calls", "callers", "callees",
]);

function memoryTerms(value: string): Set<string> {
  return new Set(value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase().match(/[\p{L}\p{N}_]+/gu)
    ?.filter((term) => term.length > 1 && !MEMORY_QUERY_STOPWORDS.has(term)) ?? []);
}

function isRelevantMemoryCandidate(question: string, candidate: Record<string, unknown>): boolean {
  const queryTerms = memoryTerms(question);
  const candidateText = [candidate.question, candidate.details, ...(Array.isArray(candidate.files) ? candidate.files : [])]
    .filter((part): part is string => typeof part === "string").join(" ");
  if (queryTerms.size === 0) return false;
  const answerTerms = memoryTerms(candidateText);
  return [...queryTerms].some((term) => answerTerms.has(term));
}

async function queryCapnMemory(
  root: string,
  executable: string,
  question: string,
): Promise<{ hit: boolean; result: unknown; error?: string; reason?: string; note?: string; pruned?: string[] }> {
  const config = readCapnConfig(root);
  if (config === null) {
    return {
      hit: false,
      result: null,
      reason: "STORE_UNINITIALIZED",
      note: `Repository consensus memory is not initialized (${MEMORY_STORE_LABEL} missing). Run waymark_memory(action: "init") (CLI: waymark memory init) to enable Tier 4.`,
    };
  }
  if (config.embedding !== false) {
    return {
      hit: false,
      result: null,
      reason: "CAPN_NON_DETERMINISTIC_MODE",
      note: "Capn store is in embedding mode. Re-initialize with deterministic lexical mode.",
    };
  }
  const exactHit = lookupExactCapnEntry(root, question);
  if (exactHit !== null) {
    return { hit: true, result: exactHit };
  }
  // `capn ask` deletes every entry whose backing files changed before it answers; name them so
  // the deletion is never silent.
  const stale = describeStaleEntries(staleChartedEntries(root));
  const prunedFields = stale.length > 0 ? { pruned: stale } : {};
  try {
    const result = await execute(root, resolveCapnCommand(executable), ["ask", question]);
    const stdout = (result.stdout || "").trim();
    if (stdout && !stdout.startsWith("No charted answer.")) {
      const candidates = stdout.split(/\r?\n/u).flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
        } catch { return []; }
      });
      const relevant = candidates.find((candidate) => isRelevantMemoryCandidate(question, candidate));
      if (relevant) return { hit: true, result: relevant, ...prunedFields };
    }
    return { hit: false, result: null, ...prunedFields };
  } catch (error) {
    if (error instanceof WaymarkError) {
      return { hit: false, result: null, error: `${error.code}: ${error.message}` };
    }
    const candidate = error as { message?: string; stderr?: string; stdout?: string; code?: string | number };
    const combined = `${candidate.stdout || ""}\n${candidate.stderr || ""}`;
    if (combined.includes("No charted answer.")) {
      return { hit: false, result: null, ...prunedFields };
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
  if (options?.subsystem?.trim() && profile === "none") {
    return {
      waymark: 1,
      kind: "ask",
      status: "error",
      provider: "waymark-engine",
      errorCode: "UNSUPPORTED_SUBSYSTEM",
      message: "Subsystem-scoped discovery is not supported; query the repository root or omit subsystem.",
      retryable: false,
    };
  }
  // A path with no question (or with outline) is a file outline; `question` then filters symbol names.
  if ((options?.path && !question.trim() && !options?.facet) || (options?.outline && options?.path)) {
    const { discoverSymbolsInFile } = await import("./astExtractor.js");
    const symbolsResult = await discoverSymbolsInFile(root, options.path, options.language, question || undefined);
    if (symbolsResult.symbols.length === 0) {
      return {
        waymark: 1,
        kind: "ask",
        status: "miss",
        provider: "codedb",
        missCode: "SYMBOL_NOT_FOUND",
        reason: question
          ? `No matching symbols found in ${options.path} for "${question}".`
          : `No outlineable symbols found in ${options.path}.`,
        matches: [],
      } as AskResult;
    }
    return {
      waymark: 1,
      kind: "ask",
      status: "hit",
      provider: "codedb",
      confidence: "exact",
      result: symbolsResult,
    } as AskResult;
  }
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
    if (error instanceof WaymarkError) {
      return { ok: false, exitCode: error.exitCode, output: `${error.code}: ${error.message}` };
    }
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
export async function unchart(root: string, executable: string, id: string, ifExists: boolean = false): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable, ["unchart", id]);
  if (!result.ok && ifExists && (result.output.toLowerCase().includes("unknown id") || result.output.toLowerCase().includes("not found"))) {
    return {
      waymark: 1,
      kind: "unchart",
      ok: true,
      exitCode: 0,
      output: `Entry ${id} not found (already removed or invalid).`,
    };
  }
  return { waymark: 1, kind: "unchart", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

/** Delete every chart entry backed by one file. */
export async function bust(root: string, executable: string, file: string): Promise<Record<string, unknown>> {
  const normalized = normalizeRelativePath(normalizeFilePath(file), root);
  const result = await runCapnSimple(root, executable, ["bust", normalized]);
  return { waymark: 1, kind: "bust", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

/** Delete every chart entry whose backing files changed or vanished. */
export async function prune(root: string, executable: string): Promise<Record<string, unknown>> {
  const result = await runCapnSimple(root, executable, ["prune"]);
  return { waymark: 1, kind: "prune", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

/** List charted entries, human-readable. */
export async function listEntries(root: string, executable: string): Promise<Record<string, unknown>> {
  if (readCapnConfig(root) === null) {
    return {
      waymark: 1,
      kind: "list",
      ok: true,
      exitCode: 0,
      count: 0,
      entries: [],
      output: `No charted entries (store uninitialized). Run waymark_memory(action: "init") or chart an entry with waymark_memory(action: "chart") (CLI: waymark memory init / waymark memory chart) to create consensus memory.`,
    };
  }
  // `capn list` first deletes every entry whose backing files changed; report which ones.
  const stale = describeStaleEntries(staleChartedEntries(root));
  const result = await runCapnSimple(root, executable, ["list"]);
  const notice = stale.length > 0 ? `Pruned ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} whose backing files changed or vanished:\n${stale.map((line) => `  - ${line}`).join("\n")}\n\n` : "";
  return {
    waymark: 1,
    kind: "list",
    ok: result.ok,
    exitCode: result.exitCode,
    ...(stale.length > 0 ? { pruned: stale } : {}),
    ...(result.ok ? { output: `${notice}${result.output}` } : { error: result.output }),
  };
}

/** Print the ask-first charting contract. */
export async function context(root: string, executable: string): Promise<Record<string, unknown>> {
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
    "  through to semantic. Call waymark_memory(action: \"context\") (CLI: waymark memory context)",
    "  to see this contract again.",
    "</waymark-engine>",
    "",
  ].join("\n");

  if (readCapnConfig(root) === null) {
    return {
      waymark: 1,
      kind: "context",
      ok: true,
      exitCode: 0,
      store: "uninitialized",
      output: routingHints + `Store is currently uninitialized (${MEMORY_STORE_LABEL} missing). Run waymark_memory(action: "init") (CLI: waymark memory init) to enable Tier 4 semantic memory.`,
    };
  }
  const result = await runCapnSimple(root, executable, ["context"]);
  return { waymark: 1, kind: "context", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: routingHints + waymarkChartingContract(result.output) } : { error: result.output }) };
}

/**
 * capn's own contract tells the agent to run `capn ask` / `capn chart`, which without
 * `--store-dir` would write to the shared `.capn` folder instead of Waymark's store. The commands
 * are rewritten to the Waymark calls that pass the store arguments.
 */
export function waymarkChartingContract(capnContext: string): string {
  return capnContext
    .replace(/<capn-hook>/gu, "<waymark-memory>")
    .replace(/<\/capn-hook>/gu, "</waymark-memory>")
    .replace(/Ask the capn first:/gu, "Ask Waymark first:")
    .replace(/when the capn answers/gu, "when Waymark answers")
    .replace(/^(\s*)capn ask "([^"\n]*)"\s*$/gmu, '$1waymark_ask(question: "$2")    (CLI: waymark ask "$2")')
    .replace(
      /^(\s*)capn chart "<question>" --files <comma-separated files backing it> \[--details "<line numbers or gotchas>"\]\s*$/gmu,
      '$1waymark_memory(action: "chart", question: "<question>", answer: "<line numbers or gotchas>", files: [<files backing it>])\n$1(CLI: waymark memory chart --question "<question>" --answer "<details>" --files <comma-separated files>)',
    )
    .replace(/\bcapn chart\b/gu, "waymark_memory(action: \"chart\")")
    .replace(/\bcapn ask\b/gu, "waymark_ask")
    .replace(/--details\b/gu, "answer");
}

/** Initialize the repository's lexical memory store (`.waymark/memory`) using the bundled fork. */
export async function initCapn(root: string, executable?: string): Promise<Record<string, unknown>> {
  ensureStateDir(root);
  const result = await runCapnSimple(root, executable ?? "", ["init"]);
  return { waymark: 1, kind: "init", ok: result.ok, exitCode: result.exitCode, ...(result.ok ? { output: result.output } : { error: result.output }) };
}

const LEGACY_ENTRY_FILE = /^[0-9a-f]{8}\.md$/u;

/**
 * Internal maintainer command (`waymark memory migrate`, not in help or the
 * public API): imports charted entries from a store that an earlier
 * `waymark init` created in the legacy folder. The source is only read: that
 * folder may belong to upstream capn, so nothing in it is moved, modified, or deleted.
 * Fails closed unless the source is a lexical store of capn entries and the
 * Waymark memory store holds no entries yet.
 */
export async function migrateMemoryStore(root: string, executable: string, from = LEGACY_STORE_DIR_NAME): Promise<Record<string, unknown>> {
  const source = path.resolve(root, from);
  const target = memoryStoreDir(root);
  const refuse = (code: string, message: string): Record<string, unknown> =>
    ({ waymark: 1, kind: "migrate", ok: false, exitCode: 2, error: `${code}: ${message} Nothing was copied.` });

  const relativeSource = path.relative(target, source);
  if (relativeSource === "" || (!relativeSource.startsWith("..") && !path.isAbsolute(relativeSource))) {
    return refuse("MIGRATE_SOURCE_INVALID", `${from} is the Waymark memory store itself.`);
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(path.join(source, "config.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return refuse("MIGRATE_SOURCE_NOT_LEXICAL", `${from}/config.json is missing or unreadable, so ${from} is not a store created by waymark init.`);
  }
  if (config.embedding !== false) {
    return refuse("MIGRATE_SOURCE_NOT_LEXICAL", `${from} is not a lexical (embedding: false) store, so it was not created by waymark init.`);
  }
  const sourceEntries = path.join(source, "entries");
  const files = fs.existsSync(sourceEntries) ? fs.readdirSync(sourceEntries).filter((file) => LEGACY_ENTRY_FILE.test(file)).sort() : [];
  const invalid = files.filter((file) => !fs.readFileSync(path.join(sourceEntries, file), "utf8").startsWith("---\ncapn: 1\n"));
  if (invalid.length > 0) {
    return refuse("MIGRATE_SOURCE_INVALID", `${from}/entries holds files that are not capn entries: ${invalid.join(", ")}.`);
  }
  const targetEntries = path.join(target, "entries");
  if (fs.existsSync(targetEntries) && fs.readdirSync(targetEntries).some((file) => file.endsWith(".md"))) {
    return refuse("MIGRATE_DESTINATION_NOT_EMPTY", `${MEMORY_STORE_LABEL} already holds charted entries; migration never merges stores.`);
  }

  const initialized = await initCapn(root, executable);
  if (!initialized.ok) return { ...initialized, kind: "migrate", copied: 0 };
  for (const file of files) {
    fs.copyFileSync(path.join(sourceEntries, file), path.join(targetEntries, file), fs.constants.COPYFILE_EXCL);
  }
  // Re-running init rebuilds the lexical index and file map from the copied entries.
  const reindexed = await runCapnSimple(root, executable, ["init"]);
  return {
    waymark: 1,
    kind: "migrate",
    ok: reindexed.ok,
    exitCode: reindexed.exitCode,
    copied: files.length,
    from: source,
    to: target,
    ...(reindexed.ok
      ? { output: `Copied ${files.length} charted entries from ${from} into ${MEMORY_STORE_LABEL}. ${from} was only read and is unchanged.` }
      : { error: reindexed.output }),
  };
}
