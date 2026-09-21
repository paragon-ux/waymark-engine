#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AdapterProfile, WaymarkError } from "./types.js";
import { repoRoot } from "./paths.js";
import { ask as capnAsk, initCapn, publish, unchart, bust, prune, listEntries, context } from "./capnAdapter.js";
import { discoverSymbolsInFile } from "./astExtractor.js";

interface ParsedArgs {
  positionals: string[];
  values: Map<string, string>;
}

const VALUE_FLAGS = new Set(["profile", "path", "language", "capn-executable", "question", "answer", "files"]);

function parseArgs(args: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current?.startsWith("--")) {
      if (current !== undefined) positionals.push(current);
      continue;
    }
    const flag = current.slice(2);
    if (!VALUE_FLAGS.has(flag)) throw new WaymarkError("UNKNOWN_OPTION", `Unknown option --${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new WaymarkError("MISSING_OPTION_VALUE", `Option --${flag} requires a value`);
    values.set(flag, value);
    index += 1;
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

function output(value: unknown): void {
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
  const parsed = parseArgs(rawArgs);
  const root = repoRoot();

  if (command === "help" || command === "--help" || command === "-h") {
    return {
      value: [
        "Waymark discovery engine (symbolic + semantic routing)",
        "  init [--capn-executable <path>] (initialize lexical Capn store)",
        "  discover-symbols --path <repository-relative-file> [--language typescript|python]",
        "  ask <question> [--profile capn-cli|none] [--capn-executable <path>]",
        "  chart --question <q> --answer <a> --files <a,b> [--profile capn-cli|none] [--capn-executable <path>]",
        "  unchart <id> | bust <path> | prune | list | context",
        "  mcp (starts the stdio MCP discovery server)",
        "",
        "Explicit wrappers (same engine, one command per action):",
        "  waymark-init | waymark-ask | waymark-discover | waymark-chart | waymark-unchart",
        "  waymark-bust | waymark-prune | waymark-list | waymark-context | waymark-mcp",
        "",
        "Env: WAYMARK_CAPN_PROFILE (capn-cli|none, default capn-cli), WAYMARK_CAPN_EXECUTABLE (optional override; default: bundled lexical-only capn-hook)",
      ].join("\n"),
    };
  }

  if (command === "init") {
    return { value: await initCapn(root, resolveCapnExecutable(parsed)) };
  }

  if (command === "discover-symbols") {
    const storedPath = requiredValue(parsed, "path");
    return { value: await discoverSymbolsInFile(root, storedPath, parsed.values.get("language")) };
  }

  if (command === "ask") {
    const question = boundedText(parsed.positionals.join(" "), 240, "question");
    return { value: await capnAsk(root, resolveProfile(parsed), resolveCapnExecutable(parsed), question) };
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
    return { value: await unchart(root, resolveCapnExecutable(parsed), id) };
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
    const server = new McpServer();
    await server.runStdio();
    return { value: null };
  }

  throw new WaymarkError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}

/**
 * Run one CLI command with its raw argv and exit with the command's status code.
 * Exported for the explicit wrapper bins (waymark-ask / waymark-discover /
 * waymark-chart) so each action is one process without subcommand parsing.
 */
export async function runCli(command: string, args: readonly string[]): Promise<void> {
  try {
    const result = await runCommand(command, args);
    if (result.value !== null) output(result.value);
    // web-tree-sitter's Emscripten runtime leaves teardown hooks on the event loop
    // after any parse; a graceful drain adds seconds of 0%-CPU latency per one-shot
    // CLI call. All output is flushed synchronously by this point, so hard-exit
    // with the intended code.
    process.exit(result.exitCode ?? 0);
  } catch (error) {
    const result = errorOutput(error);
    output(result.value);
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
