import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getResidentClient, type CodedbRun } from "./residentCodedb.js";
import { resolveCodedbCommand, clearFuzzyCandidateCache } from "./codedbAdapter.js";
import { PrefixTrie } from "./prefixTrie.js";
import { collectRepoPaths, invalidatePathsCache } from "./discoveryRouter.js";
import { clearTreeSitterFileCache } from "./treeSitterIndex.js";
import { WaymarkError, type LiteralMatch } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const REGISTRY_LOCK_STALE_MS = 10_000;
const REGISTRY_LOCK_TIMEOUT_MS = 2_000;
const SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  try {
    Atomics.wait(SLEEP_BUFFER, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // fallback
    }
  }
}

function ensurePrivateRuntimeDir(dir: string, platform = process.platform): string {
  if (platform === "win32") {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const target = dir.length > 1 ? dir.replace(/\/+$/u, "") : dir;
  if (target === "/") {
    throw new WaymarkError("UNSAFE_RUNTIME_DIR", "Refusing to use filesystem root as daemon runtime directory: /", 2);
  }

  let stat: fs.Stats | null = null;
  let existed = true;
  try {
    stat = fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    existed = false;
  }

  if (!stat) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(target);
  }

  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new WaymarkError("UNSAFE_RUNTIME_DIR", `Refusing to use symlink or non-directory daemon runtime directory: ${target}`, 2);
  }

  const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) {
    throw new WaymarkError("UNSAFE_RUNTIME_DIR", `Refusing to use daemon runtime directory owned by uid ${stat.uid} (expected ${expectedUid}): ${target}`, 2);
  }

  if ((!existed && (stat.mode & 0o777) !== 0o700) || (stat.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(target, 0o700);
    } catch {
      throw new WaymarkError("UNSAFE_RUNTIME_DIR", `Unable to enforce 0700 permissions on daemon runtime directory: ${target}`, 2);
    }
    const recheck = fs.lstatSync(target);
    if (
      recheck.isSymbolicLink() ||
      !recheck.isDirectory() ||
      (expectedUid !== null && recheck.uid !== expectedUid) ||
      (recheck.mode & 0o077) !== 0
    ) {
      throw new WaymarkError("UNSAFE_RUNTIME_DIR", `Daemon runtime directory remains unsafe or group/world-accessible: ${target}`, 2);
    }
  }

  return target;
}

const POSIX_SOCKET_PATH_LIMIT = 100; // Stay strictly under macOS's 104-byte Unix socket sun_path limit (103 + NUL)
const SAMPLE_DAEMON_SOCKET_NAME = `wm-${"0".repeat(16)}.sock`;

function fitsPosixSocketPath(dir: string): boolean {
  return Buffer.byteLength(path.posix.join(dir, SAMPLE_DAEMON_SOCKET_NAME), "utf8") < POSIX_SOCKET_PATH_LIMIT;
}

/**
 * Resolve and validate the per-user private runtime directory (`0700` on POSIX)
 * for daemon Unix domain sockets, PID files, and daemon registry persistence.
 */
export function getDaemonRuntimeDir(platform = process.platform): string {
  if (platform === "win32") {
    const base = process.env.WAYMARK_RUNTIME_DIR?.trim() || path.join(os.tmpdir(), "waymark");
    return ensurePrivateRuntimeDir(base, platform);
  }

  const explicit = process.env.WAYMARK_RUNTIME_DIR?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!fitsPosixSocketPath(resolved)) {
      const sockBytes = Buffer.byteLength(path.posix.join(resolved, SAMPLE_DAEMON_SOCKET_NAME), "utf8");
      throw new WaymarkError(
        "UNSAFE_RUNTIME_DIR",
        `Refusing WAYMARK_RUNTIME_DIR whose POSIX Unix socket path would be ${sockBytes} bytes (must be < ${POSIX_SOCKET_PATH_LIMIT} bytes): ${resolved}`,
        2,
      );
    }
    return ensurePrivateRuntimeDir(resolved, platform);
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg && path.isAbsolute(xdg)) {
    const xdgDir = path.resolve(xdg);
    const xdgCandidate = path.join(xdgDir, "waymark");
    if (fitsPosixSocketPath(xdgCandidate)) {
      try {
        const xdgStat = fs.lstatSync(xdgDir);
        if (xdgStat.isDirectory() && !xdgStat.isSymbolicLink() && xdgStat.uid === uid && (xdgStat.mode & 0o077) === 0) {
          return ensurePrivateRuntimeDir(xdgCandidate, platform);
        }
      } catch (err) {
        if (err instanceof WaymarkError) throw err;
        // fall back to os.tmpdir() per-uid directory
      }
    }
  }

  const tmpBase = os.tmpdir();
  if (path.isAbsolute(tmpBase)) {
    const tmpCandidate = path.join(path.resolve(tmpBase), `waymark-${uid}`);
    if (fitsPosixSocketPath(tmpCandidate)) {
      return ensurePrivateRuntimeDir(tmpCandidate, platform);
    }
  }

  return ensurePrivateRuntimeDir(path.posix.join("/tmp", `waymark-${uid}`), platform);
}

function atomicWritePrivateFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmpPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeFileSync(fd, content, "utf-8");
    fs.closeSync(fd);
    fd = null;
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(tmpPath, 0o600);
      } catch {
        // ignore
      }
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function canonicalRoot(root: string, platform = process.platform): string {
  let canonical = path.resolve(root);
  try { canonical = fs.realpathSync.native(canonical); } catch {}
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

export interface DaemonRegistryEntry {
  root: string;
  pid: number;
  address: string;
  startedAt: number;
}

export function getDaemonAddress(root: string): string {
  const canonical = canonicalRoot(root);
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  if (process.platform === "win32") {
    return path.join("\\\\.\\pipe", `waymark-${hash}`);
  }
  return path.join(getDaemonRuntimeDir(), `wm-${hash}.sock`);
}

/**
 * Informational PID record, always in the per-user private runtime directory beside the socket
 * and registry. Never used to choose a process to kill (audit finding F-01).
 */
export function getPidFilePath(root: string): string {
  const canonical = canonicalRoot(root);
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return path.join(getDaemonRuntimeDir(), `wm-${hash}.pid`);
}

function getRegistryFilePath(): string {
  return path.join(getDaemonRuntimeDir(), "waymark-daemons.json");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function withRegistryLock<T>(fn: () => T): T {
  const regPath = getRegistryFilePath();
  const lockPath = `${regPath}.lock`;
  const ownerToken = crypto.randomBytes(8).toString("hex");
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
  let acquired = false;
  try {
    while (!acquired) {
      try {
        const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: ownerToken, createdAt: Date.now() }), "utf-8");
        } finally {
          fs.closeSync(fd);
        }
        acquired = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          const st = fs.lstatSync(lockPath);
          const raw = fs.readFileSync(lockPath, "utf-8");
          let stale = Date.now() - st.mtimeMs > REGISTRY_LOCK_STALE_MS;
          if (!stale && raw.trim().length > 0) {
            try {
              const parsed = JSON.parse(raw) as { pid?: unknown };
              if (typeof parsed.pid === "number" && parsed.pid !== process.pid && !isPidAlive(parsed.pid)) {
                stale = true;
              }
            } catch {
              // ignore partial lock write
            }
          }
          if (stale) {
            const recheckRaw = fs.readFileSync(lockPath, "utf-8");
            if (recheckRaw === raw) {
              const staleTmp = `${lockPath}.stale.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
              fs.renameSync(lockPath, staleTmp);
              try { fs.unlinkSync(staleTmp); } catch {}
              continue;
            }
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          // Best-effort proceed rather than hanging CLI shutdown forever
          break;
        }
        sleepSync(10);
      }
    }
    return fn();
  } finally {
    if (acquired) {
      try {
        const current = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { token?: unknown };
        if (current.token === ownerToken) {
          fs.unlinkSync(lockPath);
        }
      } catch {}
    }
  }
}

export function readRegistry(): Record<string, DaemonRegistryEntry> {
  const regPath = getRegistryFilePath();
  try {
    const stat = fs.lstatSync(regPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return {};
    return JSON.parse(fs.readFileSync(regPath, "utf-8"));
  } catch {
    return {};
  }
}

export function writeRegistry(registry: Record<string, DaemonRegistryEntry>): void {
  const regPath = getRegistryFilePath();
  try {
    atomicWritePrivateFile(regPath, JSON.stringify(registry, null, 2));
  } catch {
    // non-fatal
  }
}

export function registerDaemon(root: string, pid: number, address: string): void {
  withRegistryLock(() => {
    const reg = readRegistry();
    const canonical = canonicalRoot(root);
    reg[canonical] = { root: path.resolve(root), pid, address, startedAt: Date.now() };
    writeRegistry(reg);
  });
}

export function unregisterDaemon(root: string): void {
  withRegistryLock(() => {
    const reg = readRegistry();
    const canonical = canonicalRoot(root);
    if (reg[canonical]) {
      delete reg[canonical];
      writeRegistry(reg);
    }
  });
}

/** Lists all running Waymark daemons across the system. */
export async function listActiveDaemons(): Promise<Array<DaemonRegistryEntry & { uptime: number; active: boolean }>> {
  const reg = readRegistry();
  const activeList: Array<DaemonRegistryEntry & { uptime: number; active: boolean }> = [];
  const staleKeys: string[] = [];

  for (const [key, entry] of Object.entries(reg)) {
    const ping = await tryDaemonPing(entry.root, 300);
    if (ping && ping.ok) {
      activeList.push({
        ...entry,
        uptime: ping.uptime ?? Math.floor((Date.now() - entry.startedAt) / 1000),
        active: true,
      });
    } else {
      staleKeys.push(key);
    }
  }

  if (staleKeys.length > 0) {
    withRegistryLock(() => {
      const latest = readRegistry();
      let changed = false;
      for (const key of staleKeys) {
        if (latest[key] && latest[key]?.pid === reg[key]?.pid) {
          delete latest[key];
          changed = true;
        }
      }
      if (changed) writeRegistry(latest);
    });
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

/** Invalidate in-memory AST index, path trie, and caches on the running daemon. */
export async function tryDaemonReload(
  root: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; status?: string } | null> {
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
      socket.write(JSON.stringify({ action: "invalidate_paths" }) + "\n");
    });
  });
}

/** Query resident daemon to resolve literal path via its persistent in-memory PrefixTrie (LEDGER-09 / DOD-12). */
export async function tryDaemonResolvePath(
  root: string,
  query: string,
  isExplicitPath = false,
  timeoutMs = 1000,
): Promise<LiteralMatch[] | null> {
  const address = getDaemonAddress(root);

  return new Promise<LiteralMatch[] | null>((resolve) => {
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
            if (parsed.ok && Array.isArray(parsed.matches)) {
              resolve(parsed.matches);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          } finally {
            socket.end();
          }
        }
      });
      socket.write(JSON.stringify({ action: "resolve_path", query, isExplicitPath }) + "\n");
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

  // A PID file cannot establish process identity; never kill from it.
  if (options?.force) {
      return false;
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
    args.push("--idle-timeout-ms", String(idleTimeoutMs));
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
  private prefixTrie: PrefixTrie | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number;
  private isStopping = false;
  private serving = false;
  private readonly onProcessExit = () => this.stop();

  constructor(root: string, idleTimeoutMs = 600_000) {
    let canonical = path.resolve(root);
    try { canonical = fs.realpathSync.native(canonical); } catch {}
    this.root = canonical;
    this.address = getDaemonAddress(this.root);
    this.pidFile = getPidFilePath(this.root);
    this.idleTimeoutMs = idleTimeoutMs;
  }

  getPrefixTrie(): PrefixTrie {
    if (!this.prefixTrie) {
      const paths = collectRepoPaths(this.root);
      this.prefixTrie = new PrefixTrie(paths, Date.now());
    }
    return this.prefixTrie;
  }

  invalidatePrefixTrie(): void {
    this.prefixTrie = null;
  }

  private idleDeadline = 0;

  private resetIdle(): void {
    if (this.idleTimeoutMs <= 0 || !Number.isFinite(this.idleTimeoutMs)) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleDeadline = Date.now() + this.idleTimeoutMs;
    const arm = (): void => {
      const remaining = this.idleDeadline - Date.now();
      if (remaining <= 0) {
        this.stop();
        if (process.argv.includes("--worker")) process.exit(0);
        return;
      }
      const delay = Math.min(remaining, MAX_NODE_TIMEOUT_MS);
      this.idleTimer = setTimeout(arm, delay);
      this.idleTimer.unref();
    };
    arm();
  }

  private reloadInFlight: Promise<void> | null = null;

  /** Reload both the in-memory PrefixTrie and resident codedb AST index after edits. */
  async reload(): Promise<void> {
    if (this.reloadInFlight) {
      await this.reloadInFlight;
      return;
    }
    const run = (async () => {
      this.invalidatePrefixTrie();
      invalidatePathsCache();
      clearFuzzyCandidateCache();
      clearTreeSitterFileCache();

      const command = resolveCodedbCommand();
      const prev = this.residentClient;
      try {
        prev?.close();
      } catch {
        // ignore
      }

      this.residentClient = getResidentClient(this.root, command);
      await this.residentClient.send(["tree", "--json"]).catch(() => null);
      try {
        this.getPrefixTrie();
      } catch {
        // non-fatal
      }
    })();
    this.reloadInFlight = run;
    try {
      await run;
    } finally {
      if (this.reloadInFlight === run) {
        this.reloadInFlight = null;
      }
    }
  }

  /**
   * Starts serving the root. Resolves false without listening when another daemon already
   * answers for it, or when `signal` aborts before the listener opens. `paths` seeds the
   * prefix trie so a caller that already walked the tree skips the synchronous walk.
   */
  async start(options: { paths?: string[]; signal?: AbortSignal } = {}): Promise<boolean> {
    const active = await tryDaemonPing(this.root, 300);
    if (active && active.ok) {
      return false;
    }

    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(this.address);
      } catch {
        // ignore ENOENT
      }
    }

    const command = resolveCodedbCommand();
    this.residentClient = getResidentClient(this.root, command);

    // Warm up resident client and prefix trie
    if (options.paths) this.prefixTrie = new PrefixTrie(options.paths, Date.now());
    await this.residentClient.send(["tree", "--json"]).catch(() => null);
    try {
      this.getPrefixTrie();
    } catch {
      // non-fatal
    }
    if (options.signal?.aborted || this.isStopping) return false;

    this.server = net.createServer((socket) => {
      this.resetIdle();
      const rl = readline.createInterface({ input: socket });

      rl.on("line", async (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const req = JSON.parse(trimmed) as { action: string; args?: string[]; query?: string; isExplicitPath?: boolean };
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
            if (this.reloadInFlight) await this.reloadInFlight;
            if (!this.residentClient) {
              socket.write(JSON.stringify({ ok: false, payload: null, error: "Resident codedb client unavailable" }) + "\n");
            } else {
              const res = await this.residentClient.send(req.args);
              socket.write(JSON.stringify(res) + "\n");
            }
          } else if (req.action === "resolve_path" && typeof req.query === "string") {
            const trie = this.getPrefixTrie();
            const matches = trie.match(req.query, Boolean(req.isExplicitPath));
            socket.write(JSON.stringify({ ok: true, matches }) + "\n");
          } else if (req.action === "invalidate_paths" || req.action === "reload") {
            await this.reload();
            socket.write(JSON.stringify({ ok: true, status: "reloaded" }) + "\n");
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
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(this.address, 0o600);
      } catch {
        // ignore
      }
    }
    this.serving = true;

    try {
      atomicWritePrivateFile(this.pidFile, String(process.pid));
    } catch {
      // non-fatal
    }

    registerDaemon(this.root, process.pid, this.address);
    this.resetIdle();

    process.once("exit", this.onProcessExit);
    return true;
  }

  /** Safe on a daemon that never started serving: the registry entry and PID file are only removed if this instance owns them. */
  stop(): void {
    if (this.isStopping) return;
    this.isStopping = true;

    process.removeListener("exit", this.onProcessExit);

    if (this.serving) unregisterDaemon(this.root);

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
      if (this.serving && fs.existsSync(this.pidFile)) {
        fs.unlinkSync(this.pidFile);
      }
    } catch {
      // ignore
    }

    if (this.serving && process.platform !== "win32") {
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

  const idleMsIndex = process.argv.indexOf("--idle-timeout-ms");
  const idleSecIndex = process.argv.indexOf("--idle-timeout");
  let idleMs = 600_000;
  if (idleMsIndex !== -1 && process.argv[idleMsIndex + 1] !== undefined) {
    const parsed = Number(process.argv[idleMsIndex + 1]);
    if (Number.isFinite(parsed) && parsed >= 0) idleMs = parsed;
  } else if (idleSecIndex !== -1 && process.argv[idleSecIndex + 1] !== undefined) {
    const parsed = Number(process.argv[idleSecIndex + 1]);
    if (Number.isFinite(parsed) && parsed >= 0) idleMs = parsed * 1000;
  }

  const daemon = new WaymarkDaemon(targetRoot, idleMs);
  const shutdown = (code: number) => {
    daemon.stop();
    process.exit(code);
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  daemon.start().catch((err) => {
    try {
      const errLog = path.join(getDaemonRuntimeDir(), "worker-err.log");
      atomicWritePrivateFile(errLog, `${new Date().toISOString()} [${targetRoot}]\n${String(err?.stack || err)}\n`);
    } catch {
      // ignore
    }
    process.exit(1);
  });
}
