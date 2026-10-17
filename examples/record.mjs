#!/usr/bin/env node
// Re-records the examples. Starts the built MCP server on a repository and makes the
// prompt and tool calls each example shows, in order, then prints every result as JSON.
//
//   npm run build
//   node examples/record.mjs <repository root> > recording.json
//
// The charts land in that repository's .waymark/memory. Record on a checkout with no
// charts yet (for example a fresh `git worktree add`), or bootstrap starts further along.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? ".");
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/src/mcp/capnIndex.js");

const chart = (facet, question, answer, files) => ({ action: "chart", facet, question, answer, files });

const EXAMPLES = {
  "architectural-map": [
    ["prompts/get", { name: "architectural-map", arguments: { topic: "capnStoreArgs" } }],
    ["waymark_ask", { question: "capnStoreArgs", plain: true }],
    // A bare symbol with depth or direction is traced as a call graph.
    ["waymark_ask", { query: "capnStoreArgs", depth: 4, direction: "callers", exclude_tests: true, plain: true }],
    ["waymark_ask", { query: "capnStoreArgs", depth: 2, direction: "callees", plain: true }],
    ["waymark_memory", chart(
      "boundaries",
      "How does every capn invocation get --root and --store-dir?",
      "capnStoreArgs(root) returns [\"--root\", realpath(root), \"--store-dir\", memoryStoreDir(realpath)]. Its only caller, execute(), puts them before the subcommand and spawns capn with that realpath as cwd. All capn traffic goes through execute: publish (chart), queryCapnMemory (Tier 4 recall), runCapnSimple (init, list, context, bust, prune, unchart). A \"Usage:\" reply becomes CAPN_STORE_DIR_UNSUPPORTED.",
      ["src/capnAdapter.ts", "src/stateDir.ts"],
    )],
    ["waymark_ask", { question: "how does capn get its store dir?", tier: "capn" }],
  ],
  "explore-subsystem": [
    ["prompts/get", { name: "explore-subsystem", arguments: { query: "getResidentClient" } }],
    ["waymark_ask", { question: "getResidentClient", plain: true }],
    ["waymark_ask", { query: "getResidentClient", depth: 2, direction: "both", exclude_tests: true, plain: true }],
    ["waymark_ask", { question: "getResidntClient", auto_resolve: false, plain: true }],
    ["waymark_ask", { path: "src/residentCodedb.ts", outline: true, plain: true }],
    ["waymark_memory", chart(
      "lifecycle",
      "How many resident codedb processes does Waymark keep, and when do they exit?",
      "getResidentClient keeps one codedb per (lower-cased root, executable) in a per-process registry. It caps the registry at WAYMARK_MAX_RESIDENT_CLIENTS (default 2) and evicts the least recently used. runJson uses it after trying the daemon socket, and WaymarkDaemon.start shares the same client. A client closes after 60 s idle (WAYMARK_IDLE_TIMEOUT), or on exit, SIGINT or SIGTERM. WAYMARK_DISABLE_RESIDENT=1 forces one-shot runs.",
      ["src/residentCodedb.ts", "src/codedbAdapter.ts", "src/daemon.ts"],
    )],
  ],
  "bootstrap-semantic-map": [
    ["prompts/get", { name: "bootstrap-semantic-map", arguments: {} }],
    ["waymark_memory", { action: "status", plain: true }],
    ["waymark_memory", { action: "bootstrap", plain: true }],
    ["waymark_memory", chart(
      "data_state",
      "Where does Waymark store its state, cache, and memory on disk?",
      "Only under .waymark/ (stateDir): the lexical memory store in .waymark/memory (memoryStoreDir), the Tier 2 path cache in .waymark/paths.v3.cache, and opt-in telemetry in .waymark/sessions/active.jsonl. ensureStateDir writes .waymark/.gitignore as *. The daemon socket, PID record and waymark-daemons.json registry live in os.tmpdir(), never in the repository.",
      ["src/stateDir.ts", "src/discoveryRouter.ts", "src/sessionLogger.ts", "src/daemon.ts"],
    )],
    ["waymark_memory", chart(
      "invariants",
      "How does Waymark stop a chart or hop from citing a file outside the repository?",
      "resolveRepositoryFile normalizes the path against the root and throws INVALID_PATH if it escapes, FILE_MISSING if absent, SYMLINK_ESCAPE if its realpath leaves the real root, and NOT_REGULAR_FILE for anything but a file. publish, verifyHop, readFileBytes and the Semantic Repo Map status and bootstrap all call it, so charts can only cite real files inside the repository.",
      ["src/paths.ts", "src/capnAdapter.ts", "src/integrity.ts"],
    )],
    ["waymark_memory", chart(
      "failure",
      "How does Tier 4 memory fail closed when the store is missing or not lexical?",
      "publish runs init when config.json is missing, then assertLexicalStore throws CAPN_STORE_UNINITIALIZED or CAPN_NON_DETERMINISTIC_MODE (embedding store). Recall never throws: queryCapnMemory returns STORE_UNINITIALIZED or CAPN_NON_DETERMINISTIC_MODE, and routeDiscoveryCore turns that into status \"miss\" with that missCode, otherwise NO_CHARTED_MEMORY. A capn without --store-dir is refused with CAPN_STORE_DIR_UNSUPPORTED.",
      ["src/capnAdapter.ts", "src/discoveryRouter.ts"],
    )],
    ["waymark_memory", { action: "status", plain: true }],
    ["waymark_memory", { action: "export", format: "md" }],
  ],
};

const child = spawn(process.execPath, [server], {
  cwd: root,
  stdio: ["pipe", "pipe", "inherit"],
  // No background daemon: every call takes the same path an agent's first call would.
  env: { ...process.env, WAYMARK_MCP_WARM: "0" },
});
const pending = new Map();
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  const message = JSON.parse(line);
  pending.get(message.id)?.(message);
  pending.delete(message.id);
});
let nextId = 1;
function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "waymark-examples", version: "1" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

const recording = {};
for (const [example, steps] of Object.entries(EXAMPLES)) {
  recording[example] = [];
  for (const [call, args] of steps) {
    if (call === "prompts/get") {
      const response = await rpc("prompts/get", args);
      recording[example].push({ call, args, text: response.result?.messages?.[0]?.content?.text ?? response.error });
      continue;
    }
    // Every tool call names the repository, as the examples' calls did.
    const response = await rpc("tools/call", { name: call, arguments: { ...args, root } });
    const text = response.result?.content?.map((part) => part.text).join("\n") ?? JSON.stringify(response.error);
    recording[example].push({ call, args, text });
  }
}

child.stdin.end();
console.log(JSON.stringify(recording, null, 2));
