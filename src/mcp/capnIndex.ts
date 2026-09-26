#!/usr/bin/env node
import { CAPN_PROMPTS, CAPN_RESOURCES, McpServer } from "./server.js";
import { CAPN_TOOLS } from "./capnTools.js";

const server = new McpServer({
  name: "waymark-engine",
  version: "2.2.0",
  tools: CAPN_TOOLS,
  resources: CAPN_RESOURCES,
  prompts: CAPN_PROMPTS,
});

server.runStdio().catch((error) => {
  process.stderr.write(`Capn MCP server error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
