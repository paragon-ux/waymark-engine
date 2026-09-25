import os from "node:os";
import readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import type { ResolvedCodedbCommand } from "./codedbAdapter.js";

export interface CodedbJson {
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

export interface CodedbRun {
  ok: boolean;
  payload: CodedbJson | null;
  error: string;
}

interface QueuedRequest {
  cmd: string;
  resolve: (run: CodedbRun) => void;
  reject: (err: any) => void;
  timer: NodeJS.Timeout;
}

function formatArg(arg: string): string {
  if (/[\s"'\\]/.test(arg)) {
    return JSON.stringify(arg);
  }
  return arg;
}

export class ResidentCodedbClient {
  readonly root: string;
  readonly command: ResolvedCodedbCommand;
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolved = false;
  private queue: QueuedRequest[] = [];
  private current: QueuedRequest | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private stderrBuffer = "";
  private isClosing = false;

  constructor(root: string, command: ResolvedCodedbCommand, idleTimeoutMs = 300_000) {
    this.root = root;
    this.command = command;
    this.idleTimeoutMs = idleTimeoutMs;
  }

  private unrefPipes(): void {
    try {
      (this.proc?.stdout as any)?.unref?.();
      (this.proc?.stderr as any)?.unref?.();
      (this.proc?.stdin as any)?.unref?.();
      this.proc?.unref();
    } catch {
      // unref may not be supported on all streams
    }
  }

  private refPipes(): void {
    try {
      (this.proc?.stdout as any)?.ref?.();
      (this.proc?.stderr as any)?.ref?.();
      (this.proc?.stdin as any)?.ref?.();
      this.proc?.ref();
    } catch {
      // ref may not be supported on all streams
    }
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.close();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;

    this.readyResolved = false;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const defaultThreads = Math.max(1, (os.availableParallelism?.() || os.cpus().length || 2) - 1);
      const maxThreads = process.env.CODEDB_MAX_THREADS || String(defaultThreads);
      const timeoutMs = process.env.WAYMARK_CODEDB_TIMEOUT
        ? parseInt(process.env.WAYMARK_CODEDB_TIMEOUT, 10) || 120_000
        : 120_000;

      const startupTimer = setTimeout(() => {
        if (!this.readyResolved) {
          this.close();
          reject(new Error(`codedb serve startup timed out after ${timeoutMs}ms: ${this.stderrBuffer}`));
        }
      }, timeoutMs);
      startupTimer.unref();

      try {
        const fullArgs = [...this.command.prefix, this.root, "serve"];
        this.proc = spawn(this.command.file, fullArgs, {
          cwd: this.root,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            CODEDB_QUIET: "1",
            CODEDB_MAX_THREADS: maxThreads,
          },
        });
      } catch (err) {
        clearTimeout(startupTimer);
        this.readyPromise = null;
        reject(err);
        return;
      }

      this.proc.on("error", (err) => {
        clearTimeout(startupTimer);
        this.cleanupState(err);
        reject(err);
      });

      this.proc.on("exit", (code, signal) => {
        clearTimeout(startupTimer);
        const err = new Error(`codedb serve exited with code ${code}, signal ${signal}: ${this.stderrBuffer}`);
        this.cleanupState(err);
        if (!this.readyResolved) {
          reject(err);
        }
      });

      this.proc.stderr?.on("data", (chunk: Buffer) => {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-4096);
      });

      this.rl = readline.createInterface({ input: this.proc.stdout! });
      this.rl.on("line", (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (!this.readyResolved) {
          if (trimmed.startsWith("{")) {
            try {
              const parsed = JSON.parse(trimmed) as { status?: string; ok?: boolean };
              if (parsed.status === "ready" || parsed.ok === true) {
                this.readyResolved = true;
                clearTimeout(startupTimer);
                this.unrefPipes();
                resolve();
                this.processQueue();
                return;
              }
            } catch {
              // Non-JSON greeting or status
            }
          }
          return;
        }

        if (trimmed.startsWith("{")) {
          this.handleResponseLine(trimmed);
        }
      });
    });

    return this.readyPromise;
  }

  private cleanupState(err: Error): void {
    this.readyPromise = null;
    this.readyResolved = false;
    this.proc = null;
    this.rl?.close();
    this.rl = null;

    if (this.current) {
      clearTimeout(this.current.timer);
      const cur = this.current;
      this.current = null;
      cur.reject(err);
    }

    const remaining = this.queue.splice(0, this.queue.length);
    for (const item of remaining) {
      clearTimeout(item.timer);
      item.reject(err);
    }
  }

  private processQueue(): void {
    if (this.current || this.queue.length === 0 || !this.readyResolved) return;
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) return;

    this.refPipes();
    this.clearIdleTimer();
    this.current = this.queue.shift()!;

    try {
      this.proc.stdin.write(this.current.cmd + "\n");
    } catch (err) {
      const cur = this.current;
      this.current = null;
      clearTimeout(cur.timer);
      cur.reject(err);
      this.processQueue();
    }
  }

  private handleResponseLine(line: string): void {
    const active = this.current;
    this.current = null;
    if (!active) return;

    clearTimeout(active.timer);
    try {
      const payload = JSON.parse(line) as CodedbJson;
      if (payload.ok !== true) {
        active.resolve({ ok: false, payload, error: "codedb reported failure" });
      } else {
        active.resolve({ ok: true, payload, error: "" });
      }
    } catch (err: any) {
      active.resolve({ ok: false, payload: null, error: err.message || "Failed to parse codedb JSON output" });
    }

    if (this.queue.length > 0) {
      this.processQueue();
    } else {
      this.unrefPipes();
      this.resetIdleTimer();
    }
  }

  async send(args: readonly string[]): Promise<CodedbRun> {
    if (this.isClosing) {
      throw new Error("Resident codedb client is closing");
    }
    await this.ensureStarted();

    const cmd = args.map(formatArg).join(" ");
    const timeoutMs = process.env.WAYMARK_CODEDB_TIMEOUT
      ? parseInt(process.env.WAYMARK_CODEDB_TIMEOUT, 10) || 120_000
      : 120_000;

    return new Promise<CodedbRun>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Query timed out: evict and restart to ensure clean recovery
        if (this.current && this.current.cmd === cmd) {
          this.current = null;
        }
        reject(new Error(`Resident codedb query timed out after ${timeoutMs}ms: ${cmd}`));
        this.close();
      }, timeoutMs);
      timer.unref();

      this.queue.push({ cmd, resolve, reject, timer });
      this.processQueue();
    });
  }

  close(): void {
    if (this.isClosing) return;
    this.isClosing = true;
    this.clearIdleTimer();

    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }

    if (this.proc) {
      try {
        if (this.proc.stdin && this.proc.stdin.writable) {
          this.proc.stdin.end();
        }
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          this.proc?.kill();
        } catch {
          // ignore
        }
        this.proc = null;
      }, 200).unref();
    }

    this.cleanupState(new Error("Resident codedb client closed"));
    this.isClosing = false;
  }

  closeSync(): void {
    this.clearIdleTimer();
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = null;
    }
  }
}

const residentRegistry = new Map<string, ResidentCodedbClient>();

export function getResidentClient(root: string, command: ResolvedCodedbCommand): ResidentCodedbClient {
  const key = `${root}::${command.file}`;
  let client = residentRegistry.get(key);
  if (!client) {
    client = new ResidentCodedbClient(root, command);
    residentRegistry.set(key, client);
  }
  return client;
}

export function closeAllResidentClients(): void {
  for (const client of residentRegistry.values()) {
    client.closeSync();
  }
  residentRegistry.clear();
}

process.once("exit", () => {
  closeAllResidentClients();
});
process.once("SIGINT", () => {
  closeAllResidentClients();
});
process.once("SIGTERM", () => {
  closeAllResidentClients();
});

