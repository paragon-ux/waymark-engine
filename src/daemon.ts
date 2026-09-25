import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getResidentClient, type CodedbRun } from "./residentCodedb.js";
import { resolveCodedbCommand } from "./codedbAdapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DaemonRegistryEntry {
  root: string;
  pid: number;
  address: string;
  startedAt: number;
}

export function getDaemonAddress(root: string): string {
  const canonical = path.resolve(root).toLowerCase();
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  if (process.platform === "win32") {
    return path.join("\\\\.\\pipe", `waymark-${hash}`);
  }
  return path.join(os.tmpdir(), `waymark-${hash}.sock`);
}

export function getPidFilePath(root: string): string {
  const canonical = path.resolve(root).toLowerCase();
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const capnDir = path.join(root, ".capn");
  if (fs.existsSync(capnDir)) {
    return path.join(capnDir, "daemon.pid");
  }
  return path.join(os.tmpdir(), `waymark-${hash}.pid`);
}

function getRegistryFilePath(): string {
  return path.join(os.tmpdir(), "waymark-daemons.json");
}

export function readRegistry(): Record<string, DaemonRegistryEntry> {
  const regPath = getRegistryFilePath();
  if (!fs.existsSync(regPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(regPath, "utf-8"));
  } catch {
    return {};
  }
}

export function writeRegistry(registry: Record<string, DaemonRegistryEntry>): void {
  const regPath = getRegistryFilePath();
  try {
    fs.writeFileSync(regPath, JSON.stringify(registry, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
}

export function registerDaemon(root: string, pid: number, address: string): void {
  const reg = readRegistry();
  const canonical = path.resolve(root).toLowerCase();
  reg[canonical] = { root: path.resolve(root), pid, address, startedAt: Date.now() };
  writeRegistry(reg);
}

export function unregisterDaemon(root: string): void {
  const reg = readRegistry();
  const canonical = path.resolve(root).toLowerCase();
  if (reg[canonical]) {
    delete reg[canonical];
    writeRegistry(reg);
  }
}

/** Lists all running Waymark daemons across the system. */
export async function listActiveDaemons(): Promise<Array<DaemonRegistryEntry & { uptime: number; active: boolean }>> {
  const reg = readRegistry();
  const activeList: Array<DaemonRegistryEntry & { uptime: number; active: boolean }> = [];
  let modified = false;

  for (const [key, entry] of Object.entries(reg)) {
    const ping = await tryDaemonPing(entry.root, 300);
    if (ping && ping.ok) {
      activeList.push({
        ...entry,
        uptime: ping.uptime ?? Math.floor((Date.now() - entry.startedAt) / 1000),
        active: true,
      });
    } else {
      delete reg[key];
      modified = true;
    }
  }

  if (modified) {
    writeRegistry(reg);
  }

  return activeList;
}

/** Attempt to query the running daemon over IPC. Returns null if daemon is not running. */
export async function tryDaemonQuery(
  root: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<CodedbRun | null> {
  const address = getDaemonAddress(root);

  return new Promise<CodedbRun | null>((resolve) => {
    let settled = false;
    const socket = net.connect(address);

    const connectTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(null);
      }
    }, 150);
    connectTimeout.unref();

    socket.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(connectTimeout);
        socket.destroy();
        resolve(null);
      }
    });

    socket.on("connect", () => {
      clearTimeout(connectTimeout);

      const queryTimeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve({ ok: false, payload: null, error: `Daemon query timed out after ${timeoutMs}ms` });
        }
      }, timeoutMs);
      queryTimeout.unref();

      const rl = readline.createInterface({ input: socket });
      rl.on("line", (line) => {
        if (!settled) {
          settled = true;
          clearTimeout(queryTimeout);
          try {
            const parsed = JSON.parse(line) as CodedbRun;
            resolve(parsed);
          } catch (err: any) {
            resolve({ ok: false, payload: null, error: err.message || "Failed to parse daemon response" });
          } finally {
            socket.end();
          }
        }
      });

      socket.write(JSON.stringify({ action: "query", args }) + "\n");
    });
  });
}

/** Check if daemon is active and responding. */
export async function tryDaemonPing(
  root: string,
  timeoutMs = 1000,
): Promise<{ ok: boolean; status?: string; pid?: number; uptime?: number; root?: string } | null> {
  const address = getDaemonAddress(root);

  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect(address);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(null);
      }
    }, timeoutMs);
    timer.unref();

    socket.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(null);
      }
    });

    socket.on("connect", () => {
      const rl = readline.createInterface({ input: socket });
      rl.on("line", (line) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(line);
            resolve(parsed);
          } catch {
            resolve(null);
          } finally {
            socket.end();
          }
        }
      });
      socket.write(JSON.stringify({ action: "ping" }) + "\n");
    });
  });
}

/** Send stop command to running daemon. Supports --force fallback. */
export async function stopDaemon(root: string, options?: { force?: boolean; timeoutMs?: number }): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 3000;
  const address = getDaemonAddress(root);

  const stoppedGracefully = await new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = net.connect(address);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    }, timeoutMs);
    timer.unref();

    socket.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      }
    });

    socket.on("connect", () => {
      const rl = readline.createInterface({ input: socket });
      rl.on("line", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.end();
          resolve(true);
        }
      });
      socket.write(JSON.stringify({ action: "stop" }) + "\n");
    });
  });

  if (stoppedGracefully) {
    unregisterDaemon(root);
    return true;
  }

  // If force is requested or graceful stop failed, attempt PID kill
  if (options?.force) {
    const pidFile = getPidFilePath(root);
    let pid: number | null = null;
    if (fs.existsSync(pidFile)) {
      try {
        pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      } catch {}
    }
    if (!pid) {
      const reg = readRegistry();
      const canonical = path.resolve(root).toLowerCase();
      pid = reg[canonical]?.pid ?? null;
    }

    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // process may already be dead
      }
    }

    if (fs.existsSync(pidFile)) {
      try { fs.unlinkSync(pidFile); } catch {}
    }
    if (process.platform !== "win32" && fs.existsSync(address)) {
      try { fs.unlinkSync(address); } catch {}
    }
    unregisterDaemon(root);
    return true;
  }

  return false;
}

/** Restarts the resident daemon for a given repository. */
export async function restartDaemon(
  root: string,
  options?: { idleTimeoutMs?: number; force?: boolean },
): Promise<boolean> {
  await stopDaemon(root, { force: options?.force });
  await new Promise((r) => setTimeout(r, 200));
  return await autoStartDaemon(root, 20_000, options?.idleTimeoutMs);
}

/** Auto-starts a background resident daemon if not already running. */
export async function autoStartDaemon(root: string, timeoutMs = 20_000, idleTimeoutMs?: number): Promise<boolean> {
  const ping = await tryDaemonPing(root, 300);
  if (ping && ping.ok) return true;

  const daemonModule = path.resolve(__dirname, "daemon.js");
  const args = [daemonModule, "--root", root, "--worker"];
  if (idleTimeoutMs !== undefined) {
    args.push("--idle-timeout", String(idleTimeoutMs));
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: root,
    env: {
      ...process.env,
      WAYMARK_AUTO_DAEMON: "0", // prevent recursive spawn
      CODEDB_ALLOW_TEMP: process.env.CODEDB_ALLOW_TEMP ?? "1",
    },
  });
  child.unref();

  // Poll until daemon is ready
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    const active = await tryDaemonPing(root, 300);
    if (active && active.ok) {
      return true;
    }
  }

  return false;
}

export class WaymarkDaemon {
  readonly root: string;
  readonly address: string;
  readonly pidFile: string;
  private server: net.Server | null = null;
  private residentClient: ReturnType<typeof getResidentClient> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private isStopping = false;

  constructor(root: string, idleTimeoutMs = 600_000) {
    this.root = path.resolve(root);
    this.address = getDaemonAddress(this.root);
    this.pidFile = getPidFilePath(this.root);
    this.idleTimeoutMs = idleTimeoutMs;
  }

  private resetIdle(): void {
    if (this.idleTimeoutMs <= 0 || !Number.isFinite(this.idleTimeoutMs)) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.stop();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  async start(): Promise<void> {
    const active = await tryDaemonPing(this.root, 300);
    if (active && active.ok) {
      return;
    }

    if (process.platform !== "win32" && fs.existsSync(this.address)) {
      try {
        fs.unlinkSync(this.address);
      } catch {
        // ignore
      }
    }

    const command = resolveCodedbCommand();
    this.residentClient = getResidentClient(this.root, command);

    // Warm up resident client
    await this.residentClient.send(["tree", "--json"]).catch(() => null);

    this.server = net.createServer((socket) => {
      this.resetIdle();
      const rl = readline.createInterface({ input: socket });

      rl.on("line", async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const req = JSON.parse(trimmed) as { action: string; args?: string[] };
          if (req.action === "ping") {
            socket.write(
              JSON.stringify({
                ok: true,
                status: "pong",
                pid: process.pid,
                uptime: process.uptime(),
                root: this.root,
                address: this.address,
              }) + "\n",
            );
          } else if (req.action === "stop") {
            socket.write(JSON.stringify({ ok: true, status: "stopping" }) + "\n");
            setTimeout(() => {
              this.stop();
              if (process.argv.includes("--worker")) process.exit(0);
            }, 50);
          } else if (req.action === "query" && Array.isArray(req.args)) {
            const res = await this.residentClient!.send(req.args);
            socket.write(JSON.stringify(res) + "\n");
          } else {
            socket.write(JSON.stringify({ ok: false, payload: null, error: `Unknown action: ${req.action}` }) + "\n");
          }
        } catch (err: any) {
          socket.write(JSON.stringify({ ok: false, payload: null, error: err.message || "Failed to process request" }) + "\n");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.address, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });

    try {
      fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
      fs.writeFileSync(this.pidFile, String(process.pid), "utf-8");
    } catch {
      // non-fatal
    }

    registerDaemon(this.root, process.pid, this.address);
    this.resetIdle();

    const cleanup = () => this.stop();
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
    process.once("exit", cleanup);
  }

  stop(): void {
    if (this.isStopping) return;
    this.isStopping = true;

    unregisterDaemon(this.root);

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    try {
      this.residentClient?.close();
    } catch {
      // ignore
    }

    if (this.server) {
      try {
        this.server.close();
      } catch {
        // ignore
      }
      this.server = null;
    }

    try {
      if (fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch {
      // ignore
    }

    if (process.platform !== "win32") {
      try {
        if (fs.existsSync(this.address)) {
          fs.unlinkSync(this.address);
        }
      } catch {
        // ignore
      }
    }
  }
}

// Direct worker execution
if (process.argv.includes("--worker")) {
  const rootIndex = process.argv.indexOf("--root");
  const argRoot = rootIndex !== -1 ? process.argv[rootIndex + 1] : undefined;
  const targetRoot = argRoot || process.cwd();

  const idleIndex = process.argv.indexOf("--idle-timeout");
  const idleArg = idleIndex !== -1 ? process.argv[idleIndex + 1] : undefined;
  const idleMs = idleArg ? parseInt(idleArg, 10) * 1000 : 600_000;

  const daemon = new WaymarkDaemon(targetRoot, idleMs);
  daemon.start().catch((err) => {
    try {
      fs.writeFileSync(path.join(targetRoot, "scratch", "worker-err.txt"), String(err?.stack || err), "utf-8");
    } catch {}
    process.exit(1);
  });
}
