#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AdapterProfile, WaymarkError, DiscoveryTier } from "./types.js";
import { repoRoot } from "./paths.js";
import { ask as capnAsk, initCapn, migrateMemoryStore, publish, unchart, bust, prune, listEntries, context } from "./capnAdapter.js";
import { renderPlainText } from "./renderPlainText.js";
import { SUPPORTED_STRUCTURED_LANGUAGES } from "./astExtractor.js";

import { PACKAGE_VERSION } from "./mcp/server.js";

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
}

const HELP_TOKENS = new Set(["help", "--help", "-h", "--h", "-help"]);
const VERSION_TOKENS = new Set(["version", "--version", "-v", "--v", "-V", "-version"]);

export function isHelpToken(token: string | undefined): boolean {
  return token !== undefined && HELP_TOKENS.has(token);
}

export function isVersionToken(token: string | undefined): boolean {
  return token !== undefined && VERSION_TOKENS.has(token);
}

export function formatHelpText(): string {
  const langs = SUPPORTED_STRUCTURED_LANGUAGES.join("|");
  return [
    `waymark-engine v${PACKAGE_VERSION} — AST structural, path, fuzzy & consensus-memory code discovery`,
    "",
    "Usage:",
    "  waymark <command> [options]",
    "  waymark-engine [--root <dir>]          Start stdio MCP server (or pass any CLI command/flag)",
    "",
    "Commands:",
    "  ask <question>                         Query 4-tier discovery router (AST -> Path -> Fuzzy -> Memory)",
    "  symbols <s1> [s2 ...]                  Batch-resolve multiple symbol definitions across the repository",
    "  discover-symbols                       Extract single-file AST outline (--path) or repo symbols (--query)",
    "  memory <action>                        Manage consensus memory & Semantic Repo Map:",
    "                                           init | status | bootstrap | chart | heal | export",
    "                                           list | unchart | bust | prune | context | evict | close",
    "  map [status|show|heal|export]          Inspect, repair, or export the 5-facet Semantic Repo Map",
    "  bootstrap                              Collect read-only unverified drafts for missing/drifted map facets",
    "  init                                   Initialize lexical BM25 memory store in .waymark/memory",
    "  chart                                  Publish a verified architectural finding to consensus memory",
    "  unchart <id>                           Delete a charted memory entry by hex ID",
    "  bust <file>                            Invalidate charted entries backing a modified file",
    "  prune                                  Prune stale memory entries whose backing files changed",
    "  list                                   List all charted consensus memory entries",
    "  context                                Print the Waymark agent query & charting contract",
    "  daemon <action>                        Manage resident background daemon:",
    "                                           start | stop | restart | reload | status | list | ping | run",
    "  mcp                                    Start the stdio Model Context Protocol (MCP) server",
    "  repl                                   Start interactive diagnostic REPL or run evaluation manifest",
    "  help                                   Show this help message",
    "  version                                Show package version",
    "",
    "Standalone Wrapper Binaries:",
    "  waymark-engine | waymark-mcp | waymark | waymark-init | waymark-ask | waymark-discover",
    "  waymark-symbols | waymark-chart | waymark-unchart | waymark-bust | waymark-prune",
    "  waymark-list | waymark-context | waymark-bootstrap | waymark-map | waymark-daemon | waymark-repl",
    "",
    "Flags:",
    "  -h, --h, --help                        Show help message (routes from any command)",
    "  -v, -V, --v, --version                 Show package version (routes from any command)",
    "  --root <dir>                           Target repository root directory (default: current repo)",
    "  -p, --plain                            Emit token-minimal plain text output",
    "  -j, --json                             Emit structured JSON output",
    "  --path <file>                          File path for AST outline, scoped symbol query, or daemon root",
    "  --outline                              Emit structural AST coordinate map outline of --path",
    "  -q, --query <text>                     Symbol name or substring filter (alias for question)",
    "  -s, --symbol <name>                    Target symbol identifier",
    "  --symbols <a,b,...>                    Comma-separated symbol list for batch AST lookup",
    `  --language <lang>                      Source language override (${langs})`,
    "  -t, --tier <tier>                      Force discovery tier: auto | ast | path | fuzzy | capn",
    "  --depth <1-5>                          Call-graph traversal depth (default: 1)",
    "  --direction <dir>                      Call-graph direction: callers | callees | both (default: both)",
    "  --exclude-tests                        Filter test files (*_test.*, *.spec.*, test/*) from call graphs",
    "  --auto-resolve                         Collapse Discovery Junctions to top recommendation",
    "  -d, --daemon                           Route query through resident in-memory daemon",
    "  -b, --timing                           Include high-resolution per-tier execution timings",
    "  --dev                                  Include diagnostic tier trace and invariant checks",
    "  --facet <id>                           Target facet: lifecycle|data_state|boundaries|invariants|failure|status",
    "  --action <action>                      Explicit memory action override",
    "  --question <text>                      Question or topic to chart (1-240 chars)",
    "  --answer <text>                        Verified answer to chart (1-4000 chars; prefix 'not_applicable' if N/A)",
    "  --files <a,b,...>                      Comma-separated repository-relative backing files for chart",
    "  --file <path>                          Repository-relative file path for memory bust or repl script",
    "  --id <id>                              Memory entry hex ID (for unchart) or evaluation test ID (for repl)",
    "  --if-exists                            Succeed idempotently if uncharted entry ID is already absent",
    "  --dry-run                              Report drifted facets that heal would unchart without removing them",
    "  --format <md|json>                     Output format for memory/map export (default: md)",
    "  --all                                  Release all resident codedb instances across roots (for evict/close)",
    "  --idle-timeout <sec>                   Daemon inactivity timeout in seconds (default: 600)",
    "  --force                                Force-terminate daemon if graceful IPC stop fails",
    "  --profile <capn-cli|none>              Memory adapter profile (default: capn-cli)",
    "  --capn-executable <path>               Custom capn binary path override",
    "  --manifest <file>                      Evaluation manifest JSONL path (for repl)",
    "  --category <name>                      Filter evaluation manifest by category (for repl)",
    "  --live                                 Enable live telemetry mode in repl",
    "  --session <file>                       Session log path in repl",
    "  --port <number>                        Viewer HTTP port in repl",
    "",
    "Environment Variables:",
    "  WAYMARK_CAPN_PROFILE                   Adapter profile override (capn-cli | none, default: capn-cli)",
    "  WAYMARK_CAPN_EXECUTABLE                Custom capn executable path (default: bundled lexical capn-hook)",
    "  WAYMARK_MCP_WARM                       Set to 0 to disable automatic MCP background root warm-up",
    "  WAYMARK_DISABLE_RESIDENT               Set to 1 to disable resident codedb processes",
  ].join("\n");
}

const VALUE_FLAGS = new Set([
  "profile", "path", "language", "capn-executable", "question", "answer", "files",
  "tier", "t", "format", "idle-timeout", "query", "symbol", "symbols", "q", "s",
  "depth", "direction", "manifest", "category", "id", "file", "facet", "action", "subsystem",
  "root", "session", "port", "from",
]);

const BOOLEAN_FLAGS = new Set([
  "timing", "b", "json", "j", "plain", "p", "auto-resolve", "if-exists", "force", "daemon", "d",
  "exclude-tests", "dev", "dry-run", "live", "all", "outline", "help", "h", "version", "v", "V",
]);

function normalizeBooleanFlag(flag: string): string {
  if (flag === "b") return "timing";
  if (flag === "j") return "json";
  if (flag === "p") return "plain";
  if (flag === "d") return "daemon";
  if (flag === "h" || flag === "help") return "help";
  if (flag === "v" || flag === "V" || flag === "version") return "version";
  return flag;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current) continue;

    if (current.startsWith("--")) {
      const flag = current.slice(2);
      if (BOOLEAN_FLAGS.has(flag)) {
        values.set(normalizeBooleanFlag(flag), "true");
        continue;
      }
      if (!VALUE_FLAGS.has(flag)) throw new WaymarkError("UNKNOWN_OPTION", `Unknown option --${flag}`);
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new WaymarkError("MISSING_OPTION_VALUE", `Option --${flag} requires a value`);
      values.set(flag, value);
      index += 1;
      continue;
    }

    if (current.startsWith("-") && current.length > 1) {
      const flag = current.slice(1);
      if (BOOLEAN_FLAGS.has(flag)) {
        values.set(normalizeBooleanFlag(flag), "true");
        continue;
      }
      if (flag === "t") {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) throw new WaymarkError("MISSING_OPTION_VALUE", `Option -t requires a value`);
        values.set("tier", value);
        index += 1;
        continue;
      }
      if (flag === "q") {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) throw new WaymarkError("MISSING_OPTION_VALUE", `Option -q requires a value`);
        values.set("query", value);
        index += 1;
        continue;
      }
      if (flag === "s") {
        const value = args[index + 1];
        if (!value || value.startsWith("-")) throw new WaymarkError("MISSING_OPTION_VALUE", `Option -s requires a value`);
        values.set("symbol", value);
        index += 1;
        continue;
      }
      throw new WaymarkError("UNKNOWN_OPTION", `Unknown option -${flag}`);
    }

    positionals.push(current);
  }
  return { positionals, values };
}

function requiredValue(parsed: ParsedArgs, name: string): string {
  const value = parsed.values.get(name);
  if (!value) throw new WaymarkError("MISSING_ARGUMENT", `Missing --${name}`);
  return value;
}

function boundedText(value: string, maximum: number, label: string, allowEmpty = false): string {
  if ((!allowEmpty && value.length === 0) || Array.from(value).length > maximum) {
    throw new WaymarkError("TEXT_LIMIT", `${label} must contain ${allowEmpty ? "at most" : "1 to"} ${maximum} characters`);
  }
  return value;
}

function writeAllSync(fd: number, payload: Buffer): void {
  let offset = 0;
  while (offset < payload.length) {
    offset += fs.writeSync(fd, payload, offset, payload.length - offset);
  }
}

function output(value: unknown, options?: { json?: boolean; plain?: boolean }): void {
  if (typeof value === "string" && !options?.json) {
    try {
      writeAllSync(1, Buffer.from(`${value}\n`, "utf8"));
    } catch {
      process.stdout.write(`${value}\n`);
    }
    return;
  }

  if (options?.plain) {
    const text = renderPlainText(value);
    try {
      writeAllSync(1, Buffer.from(`${text}\n`, "utf8"));
    } catch {
      process.stdout.write(`${text}\n`);
    }
    return;
  }

  try {
    writeAllSync(1, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
  } catch {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  }
}

function errorOutput(error: unknown): CommandResult {
  if (error instanceof WaymarkError) {
    return { value: { waymark: 1, kind: "error", ok: false, code: error.code, message: error.message }, exitCode: error.exitCode };
  }
  const message = error instanceof Error ? error.message : "Unexpected error";
  return { value: { waymark: 1, kind: "error", ok: false, code: "UNEXPECTED_ERROR", message }, exitCode: 1 };
}

interface CommandResult {
  value: unknown;
  exitCode?: number;
}

function resolveProfile(parsed: ParsedArgs): AdapterProfile {
  const value = parsed.values.get("profile") ?? process.env.WAYMARK_CAPN_PROFILE ?? "capn-cli";
  return value === "none" ? "none" : "capn-cli";
}

function resolveCapnExecutable(parsed: ParsedArgs): string {
  // Empty string = auto-resolution: the bundled @paragon-ux/capn-hook CLI when
  // installed, otherwise `capn` on PATH.
  return parsed.values.get("capn-executable") ?? process.env.WAYMARK_CAPN_EXECUTABLE ?? "";
}

async function runCommand(command: string, rawArgs: readonly string[]): Promise<CommandResult> {
  const suppression = process.env.WAYMARK_HOOK_DISABLED === "1"
    ? "WAYMARK_HOOK_DISABLED"
    : process.env.WAYMARK_HOOK_DEPTH === "1"
      ? "WAYMARK_HOOK_DEPTH"
      : undefined;
  if (suppression) return { value: { waymark: 1, kind: "suppressed", ok: true, reason: suppression } };

  const wantsJson = rawArgs.includes("--json") || rawArgs.includes("-j");
  if (isVersionToken(command) || rawArgs.some((arg) => isVersionToken(arg))) {
    return {
      value: wantsJson
        ? { waymark: 1, kind: "version", ok: true, name: "waymark-engine", version: PACKAGE_VERSION }
        : `waymark-engine v${PACKAGE_VERSION}`,
    };
  }
  if (isHelpToken(command) || rawArgs.some((arg) => isHelpToken(arg))) {
    return {
      value: wantsJson
        ? { waymark: 1, kind: "help", ok: true, name: "waymark-engine", version: PACKAGE_VERSION, help: formatHelpText() }
        : formatHelpText(),
    };
  }

  const parsed = parseArgs(rawArgs);
  if (parsed.values.get("subsystem")?.trim()) {
    throw new WaymarkError("UNSUPPORTED_SUBSYSTEM", "Subsystem-scoped operations are not supported; query the repository root or omit --subsystem.");
  }
  const root = parsed.values.get("root") ? path.resolve(parsed.values.get("root")!) : repoRoot();


  if (command === "init") {
    const res = await initCapn(root, resolveCapnExecutable(parsed));
    return { value: res, exitCode: res.ok ? 0 : (res.exitCode as number | undefined) ?? 1 };
  }

  if (command === "discover-symbols") {
    const rawPath = parsed.values.get("path") ?? (parsed.positionals.length > 0 && !parsed.values.has("query") && !parsed.values.has("symbol") ? parsed.positionals[0] : undefined);
    const query = parsed.values.get("query") ?? parsed.values.get("symbol") ?? (rawPath ? undefined : parsed.positionals[0]);
    const { discoverSymbolsInFile, discoverSymbolsInRepo } = await import("./astExtractor.js");

    if (rawPath) {
      return { value: await discoverSymbolsInFile(root, rawPath, parsed.values.get("language"), query) };
    }
    if (query) {
      return { value: await discoverSymbolsInRepo(root, query) };
    }
    throw new WaymarkError("MISSING_ARGUMENT", "discover-symbols requires --path or --query");
  }

  if (command === "symbols") {
    let symbolsList: string[] = [];
    if (parsed.values.has("symbols")) {
      symbolsList = parsed.values.get("symbols")!.split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (parsed.positionals.length > 0) {
      symbolsList.push(...parsed.positionals.map((s) => s.trim()).filter(Boolean));
    }
    if (symbolsList.length === 0) {
      throw new WaymarkError("MISSING_ARGUMENT", "symbols command requires at least one symbol identifier");
    }
    const { queryMultiSymbols } = await import("./codedbAdapter.js");
    return { value: await queryMultiSymbols(root, symbolsList) };
  }

  if (command === "repl") {
    const { startRepl, runReplScript } = await import("./repl.js");
    const scriptFile = parsed.values.get("file");
    const manifestFile = parsed.values.get("manifest");
    const plain = parsed.values.has("plain");
    const dev = parsed.values.has("dev");
    const live = parsed.values.has("live");
    const sessionPath = parsed.values.get("session");

    if (scriptFile) {
      await runReplScript(scriptFile, root);
      return { value: { ok: true } };
    }

    if (manifestFile) {
      const { runManifestEvaluation } = await import("./evaluator.js");
      const category = parsed.values.get("category");
      const id = parsed.values.get("id");
      const scoreboard = await runManifestEvaluation({
        manifestPath: path.resolve(root, manifestFile),
        category,
        id,
        rootDir: root,
        onProgress: (rep) => {
          const mark = rep.passed ? "✓" : "✗";
          process.stdout.write(`  ${mark} [${rep.id}] ${rep.name} (${rep.duration_ms}ms) -> ${rep.actual_status}\n`);
        },
      });
      return { value: scoreboard, exitCode: scoreboard.failed > 0 ? 1 : 0 };
    }

    const portStr = parsed.values.get("port");
    const port = portStr ? parseInt(portStr, 10) : undefined;

    await startRepl({ rootDir: root, plain, dev, live, sessionPath, port });
    return { value: null };
  }

  if (command === "ask") {
    if (parsed.values.has("symbols")) {
      const symbolsList = parsed.values.get("symbols")!.split(",").map((s) => s.trim()).filter(Boolean);
      const { queryMultiSymbols } = await import("./codedbAdapter.js");
      return { value: await queryMultiSymbols(root, symbolsList) };
    }
    const rawPath = parsed.values.get("path");
    const rawFacet = parsed.values.get("facet");
    const isOutline = parsed.values.has("outline");
    const posText = parsed.positionals.join(" ").trim();
    if ((rawPath && !posText && !rawFacet) || (isOutline && rawPath)) {
      const queryToUse = parsed.values.get("query") ?? parsed.values.get("symbol") ?? (posText || undefined);
      const requestedLang = parsed.values.get("language");
      // With or without --outline, a file outline shares one envelope: 0 matching symbols is a miss.
      const { ask } = await import("./capnAdapter.js");
      const profile = (parsed.values.get("profile") as AdapterProfile) ?? "none";
      const executable = parsed.values.get("capn-executable") ?? "";
      const res = await ask(root, profile, executable, queryToUse ?? "", { path: rawPath, outline: true, language: requestedLang });
      if (parsed.values.has("plain")) {
        const { renderPlainText } = await import("./renderPlainText.js");
        return { value: renderPlainText(res) };
      }
      if (res.status === "hit") {
        return { value: res.result };
      }
      return { value: res };
    }
    if (rawFacet === "status") {
      const { getSemanticMapStatus } = await import("./semanticMap.js");
      return { value: getSemanticMapStatus(root) };
    }
    const question = boundedText(posText, 240, "question", Boolean(rawFacet));
    const rawTier = parsed.values.get("tier");
    const tier = rawTier as DiscoveryTier | undefined;
    const timing = parsed.values.has("timing");
    const autoResolve = parsed.values.has("auto-resolve");
    const daemon = parsed.values.has("daemon");
    const excludeTests = parsed.values.has("exclude-tests");
    const dev = parsed.values.has("dev");
    const rawDepth = parsed.values.get("depth");
    const depth = rawDepth ? parseInt(rawDepth, 10) : undefined;
    const rawDirection = parsed.values.get("direction");
    const direction = (rawDirection === "callers" || rawDirection === "callees" || rawDirection === "both")
      ? rawDirection
      : undefined;

    return {
      value: await capnAsk(
        root,
        resolveProfile(parsed),
        resolveCapnExecutable(parsed),
        question,
        { tier, timing: timing || dev, autoResolve, daemon, depth, direction, excludeTests, dev, facet: rawFacet, path: rawPath },
      ),
    };
  }

  if (command === "memory") {
    const action = parsed.positionals[0] || parsed.values.get("action") || "list";
    const executable = resolveCapnExecutable(parsed);
    const profile = resolveProfile(parsed);

    if (action === "chart") {
      const question = parsed.values.get("question") ?? (parsed.positionals[1] ? parsed.positionals.slice(1).join(" ") : "");
      const { chartMemoryEntry } = await import("./semanticMap.js");
      const result = await chartMemoryEntry(root, profile, executable, {
        question,
        answer: requiredValue(parsed, "answer"),
        facet: parsed.values.get("facet"),
        files: (parsed.values.get("files") ?? "").split(",").map((f) => f.trim()).filter(Boolean),
      });
      return { value: result, exitCode: result.published === false && profile === "capn-cli" ? 3 : 0 };
    }

    if (action === "bootstrap") {
      const { bootstrapSemanticMap } = await import("./semanticMap.js");
      const subsystem = parsed.values.get("subsystem");
      const res = await bootstrapSemanticMap(root, { subsystem, executable });
      return { value: res, exitCode: res.ok ? 0 : 1 };
    }

    if (action === "status") {
      const { getSemanticMapStatus } = await import("./semanticMap.js");
      return { value: getSemanticMapStatus(root) };
    }

    if (action === "bust") {
      const file = parsed.positionals[1] ?? parsed.values.get("file");
      if (!file) throw new WaymarkError("MISSING_ARGUMENT", "memory bust requires a repository-relative path");
      return { value: await bust(root, executable, file) };
    }

    if (action === "prune") {
      return { value: await prune(root, executable) };
    }

    if (action === "list") {
      return { value: await listEntries(root, executable) };
    }

    if (action === "unchart") {
      const id = parsed.positionals[1] ?? parsed.values.get("id");
      if (!id) throw new WaymarkError("MISSING_ARGUMENT", "memory unchart requires an id");
      const ifExists = parsed.values.has("if-exists");
      const res = await unchart(root, executable, id, ifExists);
      const exitCode = res.exitCode as number | undefined ?? (res.ok ? 0 : 1);
      return { value: res, exitCode };
    }

    if (action === "init") {
      const res = await initCapn(root, executable);
      return { value: res, exitCode: res.ok ? 0 : (res.exitCode as number | undefined) ?? 1 };
    }

    // Internal maintainer command, deliberately left out of help and docs.
    if (action === "migrate") {
      const res = await migrateMemoryStore(root, executable, parsed.values.get("from"));
      return { value: res, exitCode: res.ok ? 0 : (res.exitCode as number | undefined) ?? 1 };
    }

    if (action === "context") {
      return { value: await context(root, executable) };
    }

    if (action === "heal") {
      const { healSemanticMap } = await import("./semanticMap.js");
      const subsystem = parsed.values.get("subsystem");
      const res = await healSemanticMap(root, { dryRun: parsed.values.has("dry-run"), subsystem, executable });
      return { value: res, exitCode: res.ok ? 0 : 1 };
    }

    if (action === "export") {
      const { getSemanticMapStatus, renderSemanticMapExport } = await import("./semanticMap.js");
      const status = getSemanticMapStatus(root);
      const format = parsed.values.get("format") || "md";
      if (format === "json") {
        return { value: status };
      }
      return { value: renderSemanticMapExport(status) };
    }

    if (action === "evict" || action === "close") {
      const { closeResidentClient, closeAllResidentClients } = await import("./residentCodedb.js");
      const target = parsed.positionals[1] || root;
      if (parsed.values.has("all")) {
        closeAllResidentClients();
        return { value: { waymark: 1, kind: action, ok: true, all: true, message: "Closed all resident codedb instances." } };
      }
      const closed = closeResidentClient(target);
      return { value: { waymark: 1, kind: action, ok: true, closed, root: target } };
    }

    throw new WaymarkError("UNKNOWN_COMMAND", `Unknown memory action: ${action}. Use chart, bootstrap, bust, prune, list, unchart, init, context, status, heal, export, evict, or close.`);
  }

  if (command === "bootstrap") {
    return await runCommand("memory", ["bootstrap", ...rawArgs]);
  }

  if (command === "map") {
    const subAction = parsed.positionals[0] || "status";
    if (subAction === "status") {
      const { getSemanticMapStatus } = await import("./semanticMap.js");
      return { value: getSemanticMapStatus(root) };
    }
    if (subAction === "show") {
      const { getSemanticMapStatus } = await import("./semanticMap.js");
      const status = getSemanticMapStatus(root);
      const targetFacet = parsed.positionals[1]?.toLowerCase();
      const facetObj = targetFacet ? (status.facets as Record<string, unknown>)[targetFacet] : undefined;
      if (facetObj) {
        return { value: facetObj };
      }
      return { value: status };
    }
    if (subAction === "heal") {
      const { healSemanticMap } = await import("./semanticMap.js");
      const res = await healSemanticMap(root, { dryRun: parsed.values.has("dry-run"), executable: resolveCapnExecutable(parsed) });
      return { value: res, exitCode: res.ok ? 0 : 1 };
    }
    if (subAction === "export") {
      const { getSemanticMapStatus, renderSemanticMapExport } = await import("./semanticMap.js");
      const status = getSemanticMapStatus(root);
      const format = parsed.values.get("format") || "md";
      if (format === "json") {
        return { value: status };
      }
      return { value: renderSemanticMapExport(status) };
    }
    throw new WaymarkError("UNKNOWN_COMMAND", `Unknown map subcommand: ${subAction}. Use status, show, heal, or export.`);
  }

  if (command === "chart") {
    const question = boundedText(requiredValue(parsed, "question"), 240, "question");
    const answer = boundedText(requiredValue(parsed, "answer"), 4000, "answer");
    const files = (parsed.values.get("files") ?? "").split(",").map((file) => file.trim()).filter(Boolean);
    const profile = resolveProfile(parsed);
    const result = await publish(root, profile, resolveCapnExecutable(parsed), question, answer, files);
    return { value: result, exitCode: result.published === false && profile === "capn-cli" ? 3 : 0 };
  }

  if (command === "unchart") {
    const id = parsed.positionals[0];
    if (!id) throw new WaymarkError("MISSING_ARGUMENT", "unchart requires an id");
    const ifExists = parsed.values.has("if-exists");
    const res = await unchart(root, resolveCapnExecutable(parsed), id, ifExists);
    const exitCode = res.exitCode as number | undefined ?? (res.ok ? 0 : 1);
    return { value: res, exitCode };
  }

  if (command === "bust") {
    const file = parsed.positionals[0];
    if (!file) throw new WaymarkError("MISSING_ARGUMENT", "bust requires a repository-relative path");
    return { value: await bust(root, resolveCapnExecutable(parsed), file) };
  }

  if (command === "prune") {
    return { value: await prune(root, resolveCapnExecutable(parsed)) };
  }

  if (command === "list") {
    return { value: await listEntries(root, resolveCapnExecutable(parsed)) };
  }

  if (command === "context") {
    return { value: await context(root, resolveCapnExecutable(parsed)) };
  }

  if (command === "mcp") {
    const { McpServer } = await import("./mcp/server.js");
    // Tools default `root` to the working directory; keep it in step with the server root.
    process.chdir(root);
    const server = new McpServer({ root });
    await server.runStdio();
    return { value: null };
  }

  if (command === "daemon") {
    const action = parsed.positionals[0] || "status";
    const targetRoot = parsed.values.get("path") || root;
    const force = parsed.values.has("force");
    const idleSec = parsed.values.get("idle-timeout") ? parseInt(parsed.values.get("idle-timeout")!, 10) : undefined;
    const idleMs = idleSec !== undefined ? idleSec * 1000 : undefined;
    const { autoStartDaemon, stopDaemon, restartDaemon, tryDaemonPing, listActiveDaemons, WaymarkDaemon, getDaemonAddress } = await import("./daemon.js");

    if (action === "start") {
      const active = await tryDaemonPing(targetRoot, 300);
      if (active && active.ok) {
        return {
          value: {
            waymark: 1,
            kind: "daemon",
            action: "start",
            ok: true,
            status: "already_running",
            pid: active.pid,
            uptime: active.uptime,
            root: targetRoot,
            address: getDaemonAddress(targetRoot),
          },
        };
      }
      const started = await autoStartDaemon(targetRoot, 20_000, idleMs);
      const ping = await tryDaemonPing(targetRoot, 1000);
      return {
        value: {
          waymark: 1,
          kind: "daemon",
          action: "start",
          ok: started,
          status: started ? "running" : "failed",
          pid: ping?.pid,
          root: targetRoot,
          address: getDaemonAddress(targetRoot),
        },
      };
    }

    if (action === "stop") {
      const stopped = await stopDaemon(targetRoot, { force });
      return {
        value: {
          waymark: 1,
          kind: "daemon",
          action: "stop",
          ok: stopped,
          status: stopped ? "stopped" : "not_running",
          root: targetRoot,
        },
      };
    }

    if (action === "restart") {
      const restarted = await restartDaemon(targetRoot, { force, idleTimeoutMs: idleMs });
      const ping = await tryDaemonPing(targetRoot, 1000);
      return {
        value: {
          waymark: 1,
          kind: "daemon",
          action: "restart",
          ok: restarted,
          status: restarted ? "running" : "failed",
          pid: ping?.pid,
          root: targetRoot,
          address: getDaemonAddress(targetRoot),
        },
      };
    }

    if (action === "reload") {
      const { tryDaemonReload } = await import("./daemon.js");
      const { invalidatePathsCache } = await import("./discoveryRouter.js");
      invalidatePathsCache();
      const reloaded = await tryDaemonReload(targetRoot);
      return {
        value: {
          waymark: 1,
          kind: "daemon",
          action: "reload",
          ok: Boolean(reloaded && reloaded.ok),
          status: reloaded?.ok ? "reloaded" : "not_running",
          root: targetRoot,
        },
      };
    }

    if (action === "status") {
      const active = await tryDaemonPing(targetRoot, 500);
      return {
        value: {
          waymark: 1,
          kind: "daemon",
          action: "status",
          ok: Boolean(active && active.ok),
          status: active?.ok ? "running" : "stopped",
          pid: active?.pid,
          uptime: active?.uptime,
          root: targetRoot,
          address: getDaemonAddress(targetRoot),
        },
      };
    }

    if (action === "list") {
      const daemons = await listActiveDaemons();
      return {
        value: {
          waymark: 1,
          kind: "daemon",
          action: "list",
          ok: true,
          daemons,
        },
      };
    }

    if (action === "ping") {
      const active = await tryDaemonPing(targetRoot, 500);
      return {
        value: {
          waymark: 1,
          kind: "daemon",
          action: "ping",
          ok: Boolean(active && active.ok),
          status: active?.ok ? "pong" : "unreachable",
          pid: active?.pid,
          uptime: active?.uptime,
          root: targetRoot,
        },
        exitCode: active?.ok ? 0 : 1,
      };
    }

    if (action === "run") {
      const daemon = new WaymarkDaemon(targetRoot, idleMs);
      await daemon.start();
      return { value: null };
    }

    throw new WaymarkError("UNKNOWN_COMMAND", `Unknown daemon action: ${action}. Use start, stop, restart, reload, status, list, ping, or run.`);
  }

  throw new WaymarkError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}

/**
 * Run one CLI command with its raw argv and exit with the command's status code.
 * Exported for the explicit wrapper bins (waymark-ask / waymark-discover /
 * waymark-chart) so each action is one process without subcommand parsing.
 */
export async function runCli(command: string, args: readonly string[]): Promise<void> {
  const isJson = args.includes("--json") || args.includes("-j");
  const isPlain = args.includes("--plain") || args.includes("-p");
  try {
    const result = await runCommand(command, args);
    if (result.value !== null) {
      output(result.value, { json: isJson, plain: isPlain });
      // web-tree-sitter's Emscripten runtime leaves teardown hooks on the event loop
      // after any parse; a graceful drain adds seconds of 0%-CPU latency per one-shot
      // CLI call. All output is flushed synchronously by this point, so hard-exit
      // with the intended code.
      process.exit(result.exitCode ?? 0);
    }
  } catch (error) {
    const result = errorOutput(error);
    output(result.value, { json: isJson, plain: isPlain });
    process.exit(result.exitCode ?? 1);
  }
}

async function main(): Promise<void> {
  await runCli(process.argv[2] ?? "help", process.argv.slice(3));
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const scriptPath = fs.realpathSync.native(process.argv[1]);
    const modulePath = fs.realpathSync.native(fileURLToPath(import.meta.url));
    if (scriptPath === modulePath) return true;
  } catch {
    // Fallback if realpathSync throws
  }
  return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

if (isDirectExecution()) await main();
