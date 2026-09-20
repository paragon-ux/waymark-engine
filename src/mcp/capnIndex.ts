#!/usr/bin/env node
import { CAPN_RESOURCES, McpServer } from "./server.js";
import { CAPN_TOOLS } from "./capnTools.js";

const server = new McpServer({
  name: "capn-mcp",
  version: "1.3.0",
  tools: CAPN_TOOLS,
  resources: CAPN_RESOURCES,
  prompts: [],
});

server.runStdio().catch((error) => {
  process.stderr.write(`Capn MCP server error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
