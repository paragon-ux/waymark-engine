import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { ask } from "./capnAdapter.js";
import { queryMultiSymbols } from "./codedbAdapter.js";
import { discoverSymbolsInFile, discoverSymbolsInRepo } from "./astExtractor.js";
import { anchorForRange, repoRoot } from "./paths.js";
import { autoStartDaemon, tryDaemonPing, stopDaemon, restartDaemon } from "./daemon.js";
import { renderPlainText } from "./renderPlainText.js";
import { runBaselineSearch, computeBaselineComparison } from "./baselineSearch.js";
import { runManifestEvaluation, executePromptTest } from "./evaluator.js";
import { AskResult, DiscoveryTier } from "./types.js";
import { resolveSessionLogPath, SessionTelemetryEvent } from "./sessionLogger.js";

export interface ReplOptions {
  rootDir?: string;
  plain?: boolean;
  dev?: boolean;
  manifestPath?: string;
  live?: boolean;
  sessionPath?: string;
  port?: number;
}

/**
 * Start the interactive Waymark REPL attached to the resident background daemon or live observer.
 */
export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const root = options.rootDir ? path.resolve(options.rootDir) : repoRoot();

  if (options.live) {
    await startLiveReplObserver(options);
    return;
  }

  let devMode = options.dev ?? true;
  let plainMode = options.plain ?? false;
  process.env.WAYMARK_REPL_SESSION = "1";

  // Enforce resident daemon requirement
  process.stdout.write(`Connecting to Waymark resident daemon for: ${root} ...\n`);
  const online = await autoStartDaemon(root, 15_000);
  if (!online) {
    process.stderr.write(`[REPL Error] Unable to connect or auto-start background daemon for: ${root}\n`);
    process.exit(1);
  }

  const ping = await tryDaemonPing(root, 1000);
  const pidStr = ping?.pid ? `PID: ${ping.pid}` : "PID: active";
  const uptimeStr = ping?.uptime !== undefined ? `Uptime: ${ping.uptime}s` : "";

  process.stdout.write(
    [
      "===================================================================",
      "  Waymark Diagnostic REPL (Resident Mode)",
      `  Daemon: CONNECTED (${pidStr} | ${uptimeStr})`,
      `  Root:   ${root}`,
      `  Dev:    ${devMode ? "ENABLED (--dev)" : "DISABLED"} | Plain: ${plainMode ? "ENABLED (--plain)" : "DISABLED"}`,
      "  Type 'help' for available commands, 'exit' or Ctrl+D to quit.",
      "===================================================================\n\n",
    ].join("\n")
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "waymark> ",
  });

  rl.prompt();

  rl.on("line", async (lineStr: string) => {
    const line = lineStr.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    try {
      await handleReplCommand(line, root, {
        dev: devMode,
        plain: plainMode,
        setDev: (val: boolean) => { devMode = val; },
        setPlain: (val: boolean) => { plainMode = val; },
        manifestPath: options.manifestPath,
      });
    } catch (err: any) {
      process.stdout.write(`Error: ${err?.message || err}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.stdout.write("\nExiting Waymark REPL.\n");
    process.exit(0);
  });
}

/**
 * Handle a single REPL command line.
 */
async function handleReplCommand(
  line: string,
  root: string,
  ctx: {
    dev: boolean;
    plain: boolean;
    setDev: (val: boolean) => void;
    setPlain: (val: boolean) => void;
    manifestPath?: string;
  }
): Promise<void> {
  const parts = line.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const cmd = parts[0]?.toLowerCase();
  const rawArgs = parts.slice(1).map((a) => (a.startsWith('"') && a.endsWith('"') ? a.slice(1, -1) : a));

  if (cmd === "exit" || cmd === "quit") {
    process.stdout.write("Goodbye.\n");
    process.exit(0);
  }

  if (cmd === "clear") {
    process.stdout.write("\x1Bc");
    return;
  }

  if (cmd === "help") {
    process.stdout.write(
      [
        "Waymark REPL Commands:",
        "  ask <question> [--tier auto|ast|path|fuzzy|capn] [--depth <n>] [--direction callers|callees|both]",
        "  symbols <sym1> [sym2 ...]       Query batch symbols across repository",
        "  discover [--path <p>] [--query <q>] Extract single-file or repo-wide symbols",
        "  anchor <file> <start> <end>     Compute SHA-256 range anchor via anchorForRange",
        "  verify-anchor <file> <start> <end> <hash> Check anchor integrity and drift",
        "  baseline <query>                Run naive lexical regex search benchmark",
        "  compare <query>                 Compare Waymark vs baseline search (noise & speed)",
        "  manifest [--path <p>] [--category <c>] [--id <i>] Run prompt test battery",
        "  daemon [status|ping|restart|stop] Control resident background daemon",
        "  dev [on|off]                    Toggle dev mode diagnostics (default: on)",
        "  plain [on|off]                  Toggle plain text output format (default: off)",
        "  clear                           Clear screen",
        "  exit | quit                     Exit REPL",
      ].join("\n") + "\n"
    );
    return;
  }

  if (cmd === "dev") {
    const arg = rawArgs[0]?.toLowerCase();
    if (arg === "on" || arg === "true") {
      ctx.setDev(true);
      process.stdout.write("Dev mode: ENABLED\n");
    } else if (arg === "off" || arg === "false") {
      ctx.setDev(false);
      process.stdout.write("Dev mode: DISABLED\n");
    } else if (!arg) {
      const next = !ctx.dev;
      ctx.setDev(next);
      process.stdout.write(`Dev mode: ${next ? "ENABLED" : "DISABLED"}\n`);
    } else {
      process.stdout.write(`Dev mode is currently: ${ctx.dev ? "ENABLED" : "DISABLED"}\n`);
    }
    return;
  }

  if (cmd === "plain") {
    const arg = rawArgs[0]?.toLowerCase();
    if (arg === "on" || arg === "true") {
      ctx.setPlain(true);
      process.stdout.write("Plain text mode: ENABLED\n");
    } else if (arg === "off" || arg === "false") {
      ctx.setPlain(false);
      process.stdout.write("Plain text mode: DISABLED\n");
    } else if (!arg) {
      const next = !ctx.plain;
      ctx.setPlain(next);
      process.stdout.write(`Plain text mode: ${next ? "ENABLED" : "DISABLED"}\n`);
    } else {
      process.stdout.write(`Plain text mode is currently: ${ctx.plain ? "ENABLED" : "DISABLED"}\n`);
    }
    return;
  }

  if (cmd === "daemon") {
    const sub = rawArgs[0]?.toLowerCase() || "status";
    if (sub === "status" || sub === "ping") {
      const ping = await tryDaemonPing(root, 1000);
      if (ping?.ok) {
        process.stdout.write(`Resident daemon is RUNNING. PID: ${ping.pid}, Uptime: ${ping.uptime}s\n`);
      } else {
        process.stdout.write(`Resident daemon is OFFLINE.\n`);
      }
    } else if (sub === "restart") {
      process.stdout.write("Restarting resident daemon ...\n");
      const ok = await restartDaemon(root);
      process.stdout.write(ok ? "Resident daemon restarted successfully.\n" : "Failed to restart daemon.\n");
    } else if (sub === "stop") {
      const ok = await stopDaemon(root);
      process.stdout.write(ok ? "Resident daemon stopped.\n" : "Failed to stop daemon.\n");
    }
    return;
  }

  if (cmd === "anchor") {
    const filePath = rawArgs[0];
    const startLine = parseInt(rawArgs[1] || "1", 10);
    const endLine = parseInt(rawArgs[2] || String(startLine), 10);
    if (!filePath) {
      process.stdout.write("Usage: anchor <file> <startLine> <endLine>\n");
      return;
    }
    const anchor = anchorForRange(root, filePath, { start: startLine, end: endLine });
    process.stdout.write(
      [
        `File:            ${filePath}`,
        `Range:           ${startLine}-${endLine} (${anchor.spanLineCount} lines)`,
        `Normalized Hash: ${anchor.normalizedSpanHash}`,
        `File SHA-256:    ${anchor.fileSha256}`,
      ].join("\n") + "\n"
    );
    return;
  }

  if (cmd === "verify-anchor") {
    const filePath = rawArgs[0];
    const startLine = parseInt(rawArgs[1] || "1", 10);
    const endLine = parseInt(rawArgs[2] || String(startLine), 10);
    const expectedHash = rawArgs[3];
    if (!filePath || !expectedHash) {
      process.stdout.write("Usage: verify-anchor <file> <startLine> <endLine> <expectedHash>\n");
      return;
    }
    try {
      const anchor = anchorForRange(root, filePath, { start: startLine, end: endLine });
      if (anchor.normalizedSpanHash === expectedHash) {
        process.stdout.write(`✓ Anchor VERIFIED: hash matches exactly (${anchor.normalizedSpanHash})\n`);
      } else {
        process.stdout.write(`✗ Anchor DRIFT / MISMATCH:\n  Expected: ${expectedHash}\n  Actual:   ${anchor.normalizedSpanHash}\n`);
      }
    } catch (err: any) {
      process.stdout.write(`✗ Verification failed: ${err.message}\n`);
    }
    return;
  }

  if (cmd === "baseline") {
    const query = rawArgs.join(" ");
    if (!query) {
      process.stdout.write("Usage: baseline <query>\n");
      return;
    }
    const res = runBaselineSearch(query, root);
    process.stdout.write(
      [
        `Baseline Search (${res.tool}):`,
        `  Query:          "${query}"`,
        `  Duration:       ${res.duration_ms}ms`,
        `  Total Matches:  ${res.total_matches} in ${res.matching_files_count} files`,
        `  Est. Tokens:    ~${res.estimated_tokens}`,
      ].join("\n") + "\n"
    );
    return;
  }

  if (cmd === "compare") {
    const query = rawArgs.join(" ");
    if (!query) {
      process.stdout.write("Usage: compare <query>\n");
      return;
    }
    const startW = performance.now();
    const waymarkRes = (await ask(root, "capn-cli", "", query, { dev: true })) as AskResult;
    const durW = Math.round((performance.now() - startW) * 100) / 100;
    const plainW = renderPlainText(waymarkRes);
    const tokensW = Math.ceil(plainW.length / 4);

    const baseline = runBaselineSearch(query, root);
    const comp = computeBaselineComparison(
      query,
      waymarkRes.provider || "none",
      durW,
      waymarkRes.status === "hit" ? 1 : 0,
      tokensW,
      baseline
    );

    process.stdout.write(
      [
        "================ Comparative Diagnostic Report ================",
        `Query:                   "${query}"`,
        `Waymark Status:          ${waymarkRes.status} (${waymarkRes.provider || "none"})`,
        `Waymark Latency:         ${comp.waymark_duration_ms}ms`,
        `Waymark Tokens:          ~${comp.waymark_tokens} tokens`,
        "---------------------------------------------------------------",
        `Baseline Tool:           ${baseline.tool}`,
        `Baseline Latency:        ${baseline.duration_ms}ms`,
        `Baseline Matches:        ${baseline.total_matches} (${baseline.matching_files_count} files)`,
        `Baseline Tokens:         ~${baseline.estimated_tokens} tokens`,
        "---------------------------------------------------------------",
        `Noise Reduction Ratio:   ${Math.round(comp.noise_reduction_ratio * 1000) / 10}%`,
        `Token Savings:           ${Math.round(comp.token_savings_pct * 1000) / 10}%`,
        `Speedup:                 ${comp.speedup_factor}x`,
        "===============================================================\n",
      ].join("\n")
    );
    return;
  }

  if (cmd === "manifest") {
    let manifestPath = ctx.manifestPath || path.join(root, "docs", "prompts", "CATALOGUE_MANIFEST.jsonl");
    let category: string | undefined;
    let id: string | undefined;

    for (let i = 0; i < rawArgs.length; i++) {
      if (rawArgs[i] === "--path" && rawArgs[i + 1]) {
        manifestPath = path.resolve(rawArgs[i + 1]!);
        i++;
      } else if (rawArgs[i] === "--category" && rawArgs[i + 1]) {
        category = rawArgs[i + 1]!;
        i++;
      } else if (rawArgs[i] === "--id" && rawArgs[i + 1]) {
        id = rawArgs[i + 1]!;
        i++;
      }
    }

    process.stdout.write(`Running manifest evaluation: ${manifestPath}\n`);
    const scoreboard = await runManifestEvaluation({
      manifestPath,
      category,
      id,
      rootDir: root,
      onProgress: (rep, idx, total) => {
        const mark = rep.passed ? "✓" : "✗";
        process.stdout.write(`  ${mark} [${rep.id}] ${rep.name} (${rep.duration_ms}ms) -> ${rep.actual_status}\n`);
      },
    });

    process.stdout.write(
      [
        "\n================ Prompt Battery Scoreboard ================",
        `Total Executed:          ${scoreboard.total}`,
        `Passed:                  ${scoreboard.passed} (${Math.round((scoreboard.passed / scoreboard.total) * 100)}%)`,
        `Failed:                  ${scoreboard.failed}`,
        `Average Latency:         ${scoreboard.average_duration_ms}ms`,
        `Average Noise Reduction: ${scoreboard.average_noise_reduction_pct}%`,
        `Average Token Savings:   ${scoreboard.average_token_savings_pct}%`,
        "Line Drift Status:",
        `  Verified Exact:        ${scoreboard.line_drift.verified_exact}`,
        `  Verified Drifted:      ${scoreboard.line_drift.verified_drifted}`,
        `  Stale/Modified:        ${scoreboard.line_drift.stale_or_modified}`,
        "===========================================================\n",
      ].join("\n")
    );
    return;
  }

  if (cmd === "symbols") {
    if (rawArgs.length === 0) {
      process.stdout.write("Usage: symbols <symbol1> [symbol2 ...]\n");
      return;
    }
    const res = await queryMultiSymbols(root, rawArgs);
    if (ctx.plain) {
      process.stdout.write(renderPlainText(res) + "\n");
    } else {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    }
    return;
  }

  if (cmd === "discover") {
    let filePath: string | undefined;
    let query: string | undefined;

    for (let i = 0; i < rawArgs.length; i++) {
      if (rawArgs[i] === "--path" && rawArgs[i + 1]) {
        filePath = rawArgs[i + 1]!;
        i++;
      } else if (rawArgs[i] === "--query" && rawArgs[i + 1]) {
        query = rawArgs[i + 1]!;
        i++;
      }
    }

    if (filePath) {
      const res = await discoverSymbolsInFile(root, path.resolve(root, filePath), undefined, query);
      if (ctx.plain) {
        process.stdout.write(renderPlainText(res) + "\n");
      } else {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      }
    } else if (query) {
      const res = await discoverSymbolsInRepo(root, query);
      if (ctx.plain) {
        process.stdout.write(renderPlainText(res) + "\n");
      } else {
        process.stdout.write(JSON.stringify(res, null, 2) + "\n");
      }
    } else {
      process.stdout.write("Usage: discover [--path <file>] [--query <name>]\n");
    }
    return;
  }

  if (cmd === "ask") {
    let question = "";
    let tier: DiscoveryTier | undefined;
    let depth: number | undefined;
    let direction: "callers" | "callees" | "both" | undefined;
    let excludeTests = false;

    const qParts: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
      const a = rawArgs[i];
      if (a === "--tier" && rawArgs[i + 1]) {
        tier = rawArgs[i + 1] as DiscoveryTier;
        i++;
      } else if (a === "--depth" && rawArgs[i + 1]) {
        depth = parseInt(rawArgs[i + 1]!, 10);
        i++;
      } else if (a === "--direction" && rawArgs[i + 1]) {
        direction = rawArgs[i + 1] as any;
        i++;
      } else if (a === "--exclude-tests") {
        excludeTests = true;
      } else if (!a?.startsWith("--")) {
        qParts.push(a!);
      }
    }

    question = qParts.join(" ");
    if (!question) {
      process.stdout.write("Usage: ask <question> [--tier <tier>] [--depth <n>] [--direction <dir>]\n");
      return;
    }

    const res = (await ask(root, "capn-cli", "", question, {
      tier,
      depth,
      direction,
      excludeTests,
      dev: ctx.dev,
    })) as AskResult;

    if (ctx.plain) {
      process.stdout.write(renderPlainText(res) + "\n");
    } else {
      process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    }

    if (ctx.dev && (res as any).dev) {
      const d = (res as any).dev;
      process.stdout.write(
        `\n[dev diagnostics] Tiers: [${(d.tiersEvaluated || []).join(" -> ")}] | IPC: ${d.daemonIpcUsed ? "daemon" : "in-process"} | Invariants: ${d.invariantsPassed ? "OK" : "FAILED"}\n`
      );
    }
    return;
  }

  // Fallback: If command not recognized, treat entire line as an `ask` query!
  const res = (await ask(root, "capn-cli", "", line, { dev: ctx.dev })) as AskResult;
  if (ctx.plain) {
    process.stdout.write(renderPlainText(res) + "\n");
  } else {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  }
}

/**
 * Execute a scripted set of commands non-interactively (e.g. from file or stdin).
 */
export async function runReplScript(scriptPath: string, rootDir?: string): Promise<void> {
  const root = rootDir ? path.resolve(rootDir) : repoRoot();
  const content = fs.readFileSync(path.resolve(scriptPath), "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));

  let dev = true;
  let plain = false;

  for (const line of lines) {
    await handleReplCommand(line, root, {
      dev,
      plain,
      setDev: (v) => { dev = v; },
      setPlain: (v) => { plain = v; },
    });
  }
}

export function formatLiveEvent(ev: SessionTelemetryEvent): string {
  const time = ev.timestamp ? ev.timestamp.split("T")[1]?.slice(0, 8) : "";
  const lines: string[] = [];
  lines.push(`\x1b[1m[${time}]\x1b[0m \x1b[36mAGENT QUERY:\x1b[0m "${ev.query}"`);
  lines.push(` ├─ \x1b[33mSource:\x1b[0m ${ev.caller.toUpperCase()} | \x1b[33mStatus:\x1b[0m ${ev.status.toUpperCase()}`);
  lines.push(` ├─ \x1b[35mTier Traversal:\x1b[0m ${ev.tierRoute}`);
  if (ev.matchedPath) {
    const loc = `${ev.matchedPath}${ev.matchedLine ? `:${ev.matchedLine}` : ""}`;
    const scoreStr = ev.score !== undefined ? ` (score: ${ev.score})` : "";
    lines.push(` ├─ \x1b[32mMatch:\x1b[0m ${ev.matchedSymbol ? `${ev.matchedSymbol} -> ` : ""}${loc}${scoreStr}`);
  }
  const payloadTok = ev.payloadTokens ?? 0;
  const fullTok = ev.fullFileTokensEquivalent ?? 1420;
  lines.push(` ├─ \x1b[34mPayload:\x1b[0m ~${payloadTok} tokens | Full-file equivalent: ~${fullTok} tokens`);
  const savings = ev.tokensSavedPct !== undefined ? `${ev.tokensSavedPct}%` : `${Math.max(0, Math.round((1 - payloadTok / fullTok) * 100))}%`;
  const timings = ev.timingBreakdown ? Object.entries(ev.timingBreakdown).map(([k, v]) => `${k.replace("_ms", "")}: ${v}ms`).join(", ") : "";
  const timingSuffix = timings ? ` (${timings})` : "";
  lines.push(` └─ \x1b[32mLatency:\x1b[0m ${ev.latencyMs}ms${timingSuffix} | \x1b[1mToken Savings: ${savings}\x1b[0m`);
  lines.push("--------------------------------------------------------------------------------");
  return lines.join("\n");
}

export interface SessionSummaryStats {
  total: number;
  hits: number;
  junctions: number;
  misses: number;
  totalTokens: number;
  savedTokens: number;
  totalLatencyMs: number;
  hitRatePct: number;
  avgLatencyMs: number;
  netSavingsPct: number;
}

export function computeSessionStats(events: SessionTelemetryEvent[]): SessionSummaryStats {
  const stats = {
    total: 0,
    hits: 0,
    misses: 0,
    junctions: 0,
    totalTokens: 0,
    savedTokens: 0,
    totalLatencyMs: 0,
  };
  for (const ev of events) {
    stats.total++;
    if (ev.status === "hit") stats.hits++;
    else if (ev.status === "junction") stats.junctions++;
    else stats.misses++;
    stats.totalTokens += ev.payloadTokens || 0;
    stats.savedTokens += Math.max(0, (ev.fullFileTokensEquivalent || 1420) - (ev.payloadTokens || 0));
    stats.totalLatencyMs += ev.latencyMs || 0;
  }
  const hitRatePct = stats.total > 0 ? Math.round((stats.hits / stats.total) * 1000) / 10 : 0;
  const avgLatencyMs = stats.total > 0 ? Math.round(stats.totalLatencyMs / stats.total) : 0;
  const totalFull = stats.totalTokens + stats.savedTokens;
  const netSavingsPct = totalFull > 0 ? Math.round((stats.savedTokens / totalFull) * 1000) / 10 : 0;
  return {
    ...stats,
    hitRatePct,
    avgLatencyMs,
    netSavingsPct,
  };
}

export function formatSessionSummary(stats: SessionSummaryStats): string {
  const totalFull = stats.totalTokens + stats.savedTokens;
  return [
    "--------------------------------------------------------------------------------",
    "  LIVE SESSION TELEMETRY SUMMARY",
    `  Total Queries:     ${stats.total} (Hits: ${stats.hits}, Junctions: ${stats.junctions}, Misses: ${stats.misses})`,
    `  Hit Rate:          ${stats.hitRatePct}%`,
    `  Avg Query Latency: ${stats.avgLatencyMs}ms`,
    `  Prompt Tokens:     ${stats.totalTokens} tokens consumed`,
    `  Full-File Equiv:   ${totalFull} tokens`,
    `  Net Token Savings: ${stats.netSavingsPct}%`,
    "--------------------------------------------------------------------------------",
  ].join("\n");
}

export function getLiveDashboardHtml(): string {
  const candidates = [
    path.join(import.meta.dirname, "viewer.html"),
    path.join(import.meta.dirname, "../src/viewer.html"),
    path.join(repoRoot(), "src", "viewer.html"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  return "<!DOCTYPE html><html><body><h1>Waymark Live Monitor</h1><p>viewer.html not found.</p></body></html>";
}

export async function startLiveReplObserver(options: ReplOptions = {}): Promise<void> {
  const root = options.rootDir ? path.resolve(options.rootDir) : repoRoot();
  const sessionPath = resolveSessionLogPath(root, options.sessionPath);
  const webPort = options.port || (process.env.WAYMARK_LIVE_PORT ? parseInt(process.env.WAYMARK_LIVE_PORT, 10) : undefined);

  // Ensure file and directory exist
  const dir = path.dirname(sessionPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(sessionPath)) {
    fs.writeFileSync(sessionPath, "", "utf8");
  }

  const sseClients = new Set<http.ServerResponse>();
  let httpServer: http.Server | undefined;
  const recentEvents: SessionTelemetryEvent[] = [];

  const stats = {
    total: 0,
    hits: 0,
    misses: 0,
    junctions: 0,
    totalTokens: 0,
    savedTokens: 0,
    totalLatencyMs: 0,
  };

  const getComputedStats = () => {
    const hitRate = stats.total > 0 ? Math.round((stats.hits / stats.total) * 1000) / 10 : 0;
    const avgLatency = stats.total > 0 ? Math.round(stats.totalLatencyMs / stats.total) : 0;
    const totalFull = stats.totalTokens + stats.savedTokens;
    const savingsPct = totalFull > 0 ? Math.round((stats.savedTokens / totalFull) * 1000) / 10 : 0;
    return {
      ...stats,
      hitRatePct: hitRate,
      avgLatencyMs: avgLatency,
      netSavingsPct: savingsPct,
    };
  };

  if (webPort) {
    httpServer = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });
        res.write(`event: init\ndata: ${JSON.stringify({
          repo: path.basename(root),
          root,
          stats: getComputedStats(),
          events: recentEvents.slice(-25),
        })}\n\n`);
        sseClients.add(res);
        res.on("close", () => {
          sseClients.delete(res);
        });
        return;
      }
      if (url.pathname === "/api/stats") {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(getComputedStats()));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(getLiveDashboardHtml());
    });

    httpServer.listen(webPort, "0.0.0.0", () => {
      // server active
    });
  }

  const printHeader = () => {
    process.stdout.write("\x1Bc"); // ANSI clear screen
    process.stdout.write(
      [
        "================================================================================",
        "  WAYMARK ENGINE LIVE AGENT MONITOR  |  PDLt-Style Observer",
        `  Session:    ${path.relative(root, sessionPath) || sessionPath}`,
        `  Repo:       ${root}`,
        ...(webPort ? [`  Web Viewer: http://localhost:${webPort}`] : []),
        "  Status:     LISTENING (press 'q' to quit, 'c' to clear, 's' for session stats)",
        "================================================================================\n",
      ].join("\n")
    );
  };

  printHeader();

  let fileOffset = 0;

  // Process existing lines if any
  try {
    const existing = fs.readFileSync(sessionPath, "utf8");
    fileOffset = Buffer.byteLength(existing, "utf8");
    const lines = existing.split("\n").filter((l) => l.trim().length > 0);
    for (const l of lines) {
      try {
        const ev = JSON.parse(l) as SessionTelemetryEvent;
        stats.total++;
        if (ev.status === "hit") stats.hits++;
        else if (ev.status === "junction") stats.junctions++;
        else stats.misses++;
        stats.totalTokens += ev.payloadTokens || 0;
        stats.savedTokens += Math.max(0, (ev.fullFileTokensEquivalent || 1420) - (ev.payloadTokens || 0));
        stats.totalLatencyMs += ev.latencyMs || 0;
        recentEvents.push(ev);
      } catch {}
    }
    if (lines.length > 0) {
      const recent = lines.slice(-5);
      process.stdout.write(`\x1b[2m--- Last ${recent.length} recent events from session ---\x1b[0m\n`);
      for (const l of recent) {
        try {
          const ev = JSON.parse(l) as SessionTelemetryEvent;
          process.stdout.write(formatLiveEvent(ev) + "\n");
        } catch {}
      }
    }
  } catch {}

  // Poll for newly appended lines
  let isChecking = false;
  const pollInterval = setInterval(() => {
    if (isChecking) return;
    isChecking = true;
    try {
      if (!fs.existsSync(sessionPath)) {
        isChecking = false;
        return;
      }
      const stat = fs.statSync(sessionPath);
      if (stat.size > fileOffset) {
        const fd = fs.openSync(sessionPath, "r");
        const bytesToRead = stat.size - fileOffset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, fileOffset);
        fs.closeSync(fd);
        fileOffset = stat.size;

        const chunk = buf.toString("utf8");
        const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
        for (const l of lines) {
          try {
            const ev = JSON.parse(l) as SessionTelemetryEvent;
            stats.total++;
            if (ev.status === "hit") stats.hits++;
            else if (ev.status === "junction") stats.junctions++;
            else stats.misses++;
            stats.totalTokens += ev.payloadTokens || 0;
            stats.savedTokens += Math.max(0, (ev.fullFileTokensEquivalent || 1420) - (ev.payloadTokens || 0));
            stats.totalLatencyMs += ev.latencyMs || 0;

            recentEvents.push(ev);
            if (recentEvents.length > 100) recentEvents.shift();

            process.stdout.write(formatLiveEvent(ev) + "\n");

            if (sseClients.size > 0) {
              const queryPayload = `event: query\ndata: ${JSON.stringify(ev)}\n\n`;
              const statsPayload = `event: stats\ndata: ${JSON.stringify(getComputedStats())}\n\n`;
              for (const client of sseClients) {
                try {
                  client.write(queryPayload);
                  client.write(statsPayload);
                } catch {}
              }
            }
          } catch {}
        }
      } else if (stat.size < fileOffset) {
        // Truncated / restarted log
        fileOffset = 0;
      }
    } catch {
      // Ignore transient read errors
    } finally {
      isChecking = false;
    }
  }, 250);

  // Setup stdin controls
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (key: string) => {
        if (key === "\u0003" || key.toLowerCase() === "q") {
          cleanup();
        } else if (key.toLowerCase() === "c") {
          printHeader();
        } else if (key.toLowerCase() === "s") {
          const hitRate = stats.total > 0 ? Math.round((stats.hits / stats.total) * 1000) / 10 : 0;
          const avgLatency = stats.total > 0 ? Math.round(stats.totalLatencyMs / stats.total) : 0;
          const totalFull = stats.totalTokens + stats.savedTokens;
          const savingsPct = totalFull > 0 ? Math.round((stats.savedTokens / totalFull) * 1000) / 10 : 0;
          const summary = formatSessionSummary({
            ...stats,
            hitRatePct: hitRate,
            avgLatencyMs: avgLatency,
            netSavingsPct: savingsPct,
          });
          process.stdout.write(`\n${summary}\n`);
        }
      });
    } catch {}
  }

  const cleanup = () => {
    clearInterval(pollInterval);
    if (httpServer) {
      try { httpServer.close(); } catch {}
    }
    process.stdout.write("\nExiting Live Agent Monitor.\n");
    process.exit(0);
  };

  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

