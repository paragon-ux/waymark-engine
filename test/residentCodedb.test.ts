import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCodedbCommand } from "../src/codedbAdapter.js";
import { getResidentClient, closeAllResidentClients } from "../src/residentCodedb.js";
import { WaymarkDaemon, tryDaemonPing, tryDaemonQuery, stopDaemon } from "../src/daemon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

test("ResidentCodedbClient executes queries rapidly via resident stdio", async (t) => {
  const command = resolveCodedbCommand();
  const client = getResidentClient(repoRoot, command);

  // First query warms up the client
  const start1 = performance.now();
  const res1 = await client.send(["symbol", "verifyHop", "--json"]);
  const dur1 = performance.now() - start1;

  assert.equal(res1.ok, true);
  assert.ok(res1.payload?.count && res1.payload.count >= 1);

  // Subsequent warm query must execute in low single-digit milliseconds
  const start2 = performance.now();
  const res2 = await client.send(["symbol", "verifyHop", "--json"]);
  const dur2 = performance.now() - start2;

  assert.equal(res2.ok, true);
  assert.ok(dur2 < 100, `Expected warm query under 100ms, got ${dur2}ms`);

  // Verify tree command
  const resTree = await client.send(["tree", "--json"]);
  assert.equal(resTree.ok, true);
  assert.ok(Array.isArray(resTree.payload?.files));

  closeAllResidentClients();
});

test("WaymarkDaemon and IPC bridge handle start, ping, query, and stop", async (t) => {
  const daemon = new WaymarkDaemon(repoRoot);
  await daemon.start();

  try {
    // 1. Verify ping responds
    const ping = await tryDaemonPing(repoRoot, 2000);
    assert.ok(ping);
    assert.equal(ping.ok, true);
    assert.equal(typeof ping.pid, "number");

    // 2. Query over IPC pipe
    const start = performance.now();
    const qRes = await tryDaemonQuery(repoRoot, ["symbol", "verifyHop", "--json"], 5000);
    const dur = performance.now() - start;

    assert.ok(qRes);
    assert.equal(qRes.ok, true);
    assert.ok(qRes.payload?.count && qRes.payload.count >= 1);
    assert.ok(dur < 150, `Expected IPC query under 150ms, got ${dur}ms`);
  } finally {
    daemon.stop();
  }

  // Verify ping fails after daemon stopped
  const postPing = await tryDaemonPing(repoRoot, 500);
  assert.equal(postPing, null);
});
