import { spawn } from "node:child_process";

const cp = spawn(process.execPath, ["dist/src/mcp/capnIndex.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env }
});

cp.stdout.on("data", (d) => console.log("STDOUT:\n" + d.toString()));
cp.stderr.on("data", (d) => console.log("STDERR:\n" + d.toString()));
cp.on("exit", (code) => console.log("EXIT:", code));

cp.stdin.write(JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "glama", version: "1.0.0" }
  }
}) + "\n");

setTimeout(() => {
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list", params: {} }) + "\n");
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "prompts/list", params: {} }) + "\n");
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "prompts/get", params: { name: "explore-subsystem", arguments: { query: "auth" } } }) + "\n");
  cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "waymark://manifest" } }) + "\n");
}, 200);

setTimeout(() => {
  cp.kill();
}, 1000);
