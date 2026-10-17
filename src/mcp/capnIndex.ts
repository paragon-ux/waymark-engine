#!/usr/bin/env node
import { CAPN_PROMPTS, CAPN_RESOURCES, McpServer } from "./server.js";
import { CAPN_TOOLS } from "./capnTools.js";
import { isHelpToken, isVersionToken, runCli } from "../cli.js";

const CLI_SUBCOMMANDS = new Set([
  "ask", "symbols", "discover-symbols", "memory", "map", "bootstrap",
  "init", "chart", "unchart", "bust", "prune", "list", "context", "daemon", "repl",
]);

/** `--root <path>` or `--root=<path>`; `null` when the flag is given without a value. */
function rootArgument(argv: readonly string[]): string | null | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--root=")) return arg.slice("--root=".length) || null;
    if (arg === "--root") {
      const value = argv[i + 1];
      return value && !value.startsWith("--") ? value : null;
    }
  }
  return undefined;
}

const rawArgs = process.argv.slice(2);

if (rawArgs.some((arg) => isVersionToken(arg))) {
  await runCli("version", rawArgs);
} else if (rawArgs.some((arg) => isHelpToken(arg))) {
  await runCli("help", rawArgs);
} else if (rawArgs[0] && CLI_SUBCOMMANDS.has(rawArgs[0])) {
  await runCli(rawArgs[0], rawArgs.slice(1));
} else {
  // Tools default `root` to the working directory, so `--root` moves it for MCP hosts that cannot set a cwd.
  const root = rootArgument(rawArgs);
  if (root !== undefined) {
    try {
      if (root === null) throw new Error("--root requires a path");
      process.chdir(root);
    } catch (error) {
      process.stderr.write(`Capn MCP server error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  const server = new McpServer({
    name: "waymark-engine",
    tools: CAPN_TOOLS,
    resources: CAPN_RESOURCES,
    prompts: CAPN_PROMPTS,
  });

  server.runStdio().catch((error) => {
    process.stderr.write(`Capn MCP server error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

