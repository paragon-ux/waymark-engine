#!/usr/bin/env node
import { CAPN_PROMPTS, CAPN_RESOURCES, McpServer } from "./server.js";
import { CAPN_TOOLS } from "./capnTools.js";

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

// Tools default `root` to the working directory, so `--root` moves it for MCP hosts that cannot set a cwd.
const root = rootArgument(process.argv.slice(2));
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
