#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { AdapterProfile, WaymarkError } from "./types.js";
import { repoRoot } from "./paths.js";
import { ask as capnAsk, publish } from "./capnAdapter.js";
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
  return parsed.values.get("capn-executable") ?? process.env.WAYMARK_CAPN_EXECUTABLE ?? "capn";
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
        "  discover-symbols --path <repository-relative-file> [--language typescript|python]",
        "  ask <question> [--profile capn-cli|none] [--capn-executable <path>]",
        "  chart --question <q> --answer <a> --files <a,b> [--profile capn-cli|none] [--capn-executable <path>]",
        "  mcp (starts the stdio MCP discovery server)",
        "",
        "Env: WAYMARK_CAPN_PROFILE (capn-cli|none, default capn-cli), WAYMARK_CAPN_EXECUTABLE (default 'capn')",
      ].join("\n"),
    };
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

  if (command === "mcp") {
    const { McpServer } = await import("./mcp/server.js");
    const server = new McpServer();
    await server.runStdio();
    return { value: null };
  }

  throw new WaymarkError("UNKNOWN_COMMAND", `Unknown command: ${command}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  const args = process.argv.slice(3);
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) await main();
