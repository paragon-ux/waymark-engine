import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Resolve a Windows executable reference to an actual path: `.cmd`/`.bat`
 * shims are used verbatim, otherwise `where.exe` resolves the name and the
 * first `.exe`/`.cmd`/`.bat` hit wins. Non-Windows hosts return the input
 * unchanged.
 */
export function resolveWindowsExecutable(executable: string): string {
  if (path.extname(executable).toLowerCase() === ".cmd" || path.extname(executable).toLowerCase() === ".bat") return executable;
  if (process.platform !== "win32") return executable;
  // Already a path (absolute or with a separator): `where.exe` treats these as
  // glob patterns and errors with "Invalid pattern", so resolve nothing.
  if (path.isAbsolute(executable) || executable.includes("/") || executable.includes("\\")) return executable;
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
