import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { AdapterProfile, PublicationResult, WaymarkError } from "./types.js";
import { detectAstIntent, queryWasmAst } from "./discoveryRouter.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 2000;

interface CommandSpec {
  file: string;
  args: string[];
}

function digestOutput(value: string): string {
  return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT)}…`;
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

export function resolveWindowsExecutable(executable: string): string {
  if (path.extname(executable).toLowerCase() === ".cmd" || path.extname(executable).toLowerCase() === ".bat") return executable;
  try {
    const output = execFileSync("where.exe", [executable], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const candidates = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const executableHit = candidates.find((c) => {
      const ext = path.extname(c).toLowerCase();
      return ext === ".cmd" || ext === ".bat" || ext === ".exe";
    });
    return executableHit ?? candidates[0] ?? executable;
  } catch {
    return executable;
  }
}

function commandSpec(executable: string, args: readonly string[]): CommandSpec {
  if (process.platform !== "win32") return { file: executable, args: [...args] };
  const resolved = resolveWindowsExecutable(executable);
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== ".cmd" && extension !== ".bat") return { file: resolved, args: [...args] };
  const commandLine = [resolved, ...args].map(quoteCmdArgument).join(" ");
  return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/v:off", "/s", "/c", commandLine] };
}

async function execute(root: string, executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  const spec = commandSpec(executable, args);
  return await execFileAsync(spec.file, spec.args, {
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

/**
 * Chart a question + answer (+ optional file references) into Capn memory.
 * Profile "none" disables publication (deterministic no-op for tests and
 * offline use); "capn-cli" invokes the real capn-hook CLI.
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

  if (!executable || executable.includes("\0")) throw new WaymarkError("CAPN_CONFIG_INVALID", "Capn executable is invalid");
  const args = capnChartArgs(question, answer, selectedFiles);
  try {
    const result = await execute(root, executable, args);
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
 * The two-phase discovery router: structural questions (who calls / where is /
 * entrypoints) are answered by the in-process Tree-sitter WASM AST; everything
 * else falls through to Capn's charted semantic memory. A clean miss is a miss —
 * the router never guesses.
 */
export async function ask(
  root: string,
  profile: AdapterProfile,
  executable: string,
  question: string,
): Promise<Record<string, unknown>> {
  if (profile === "none") return { waymark: 1, kind: "ask", provider: "none", status: "miss", matches: [] };

  const intent = detectAstIntent(question);

  // Structural AST query -> in-process Tree-sitter WASM, no external process.
  if (intent.requiresParser) {
    const astResult = await queryWasmAst(intent, root);
    if (astResult.hit) {
      return {
        waymark: 1,
        kind: "ask",
        provider: "wasm-ast",
        status: "hit",
        result: digestOutput(astResult.output),
      };
    }
  }

  // Semantic fallback: Capn charted memory via executable.
  try {
    const result = await execute(root, executable, ["ask", question]);
    const stdout = (result.stdout || "").trim();
    if (stdout && !stdout.startsWith("No charted answer.")) {
      try {
        const parsed: unknown = JSON.parse(stdout);
        return { waymark: 1, kind: "ask", provider: "capn-cli", status: "hit", result: parsed };
      } catch {
        return { waymark: 1, kind: "ask", provider: "capn-cli", status: "hit", result: digestOutput(stdout) };
      }
    }
    return { waymark: 1, kind: "ask", provider: "capn-cli", status: "miss", matches: [] };
  } catch (error) {
    const candidate = error as { message?: string; stderr?: string; stdout?: string; code?: string | number };
    const combined = `${candidate.stdout || ""}\n${candidate.stderr || ""}`;
    if (combined.includes("No charted answer.")) {
      return { waymark: 1, kind: "ask", provider: "capn-cli", status: "miss", matches: [] };
    }
    return {
      waymark: 1,
      kind: "ask",
      provider: "capn-cli",
      status: "error",
      error: digestOutput(`${candidate.code ?? "CAPN_ERROR"}: ${candidate.stderr || candidate.message || "Capn ask failed"}`),
    };
  }
}
