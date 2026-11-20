import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

function chmodRecursive(dir: string, writable: boolean): void {
  if (process.platform === "win32") return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (writable) {
        try { fs.chmodSync(full, 0o755); } catch {}
      }
      chmodRecursive(full, writable);
      if (!writable) {
        try { fs.chmodSync(full, 0o555); } catch {}
      }
    } else if (entry.isFile()) {
      try {
        const mode = fs.statSync(full).mode & 0o777;
        fs.chmodSync(full, writable ? (mode | 0o200) : (mode & ~0o222));
      } catch {}
    }
  }
  try { fs.chmodSync(dir, writable ? 0o755 : 0o555); } catch {}
}

test("Packaging smoke test: npm pack and install --ignore-scripts extracts YAML first on read-only node_modules with clean JSON & MCP stdio", () => {
  const repoRoot = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-pack-smoke-"));
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const installDir = path.join(tempDir, "consumer");
  const nodeModulesDir = path.join(installDir, "node_modules");

  try {
    // 1. Run npm pack to create tarball in tempDir
    const packOutput = execFileSync(npmCmd, ["pack", "--pack-destination", tempDir], {
      cwd: repoRoot,
      windowsHide: true,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const tgzName = packOutput.trim().split("\n").pop()?.trim();
    assert.ok(tgzName, "Tarball name must be returned by npm pack");
    const tgzPath = path.join(tempDir, tgzName);
    assert.ok(fs.existsSync(tgzPath), `Tarball must exist at ${tgzPath}`);

    // 2. Initialize minimal project in subfolder and install with --ignore-scripts
    fs.mkdirSync(installDir);
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "smoke-consumer", private: true }), "utf8");

    execFileSync(npmCmd, ["install", "--ignore-scripts", tgzPath], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    // Verify no .js.map files were shipped in dist/src (DEP-004)
    const installedDist = path.join(nodeModulesDir, "waymark-engine", "dist", "src");
    const shippedMaps = fs.readdirSync(installedDist, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".map"));
    assert.deepEqual(shippedMaps, [], `Expected zero .map files in published package, found: ${shippedMaps.join(", ")}`);

    // Verify web-tree-sitter was NOT mutated on disk during --ignore-scripts install
    const wtsFile = path.join(nodeModulesDir, "web-tree-sitter", "tree-sitter.js");
    const wtsBefore = fs.readFileSync(wtsFile, "utf8");
    assert.equal(wtsBefore.includes('wasmImports["_Znwm"]'), false, "web-tree-sitter/tree-sitter.js must start unmutated");

    // Lock node_modules read-only on POSIX to prove pnpm/Nix/read-only-store compatibility (DEP-001)
    chmodRecursive(nodeModulesDir, false);

    // 3. Create test fixtures in installDir
    fs.writeFileSync(path.join(installDir, "fixture.yml"), "name: pipeline\non: push\n", "utf8");
    fs.writeFileSync(path.join(installDir, "fixture.sh"), "#!/usr/bin/env bash\nAPP=test\n", "utf8");
    fs.writeFileSync(path.join(installDir, "fixture.json"), JSON.stringify({ name: "smoke", port: 3000 }), "utf8");
    fs.writeFileSync(path.join(installDir, "fixture.toml"), "[server]\nport = 8080\n", "utf8");

    // 4. Run CLI directly from installed node_modules — YAML FIRST in default strict JSON mode! (RUN-003, TEST-002)
    const cliPath = path.join(installedDist, "cli.js");
    const mcpPath = path.join(installedDist, "mcp", "capnIndex.js");
    assert.ok(fs.existsSync(cliPath), `CLI must exist at ${cliPath}`);
    assert.ok(fs.existsSync(mcpPath), `MCP entrypoint must exist at ${mcpPath}`);

    const yamlJsonRaw = execFileSync(process.execPath, [cliPath, "ask", "--path", "fixture.yml", "--outline"], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
    });
    const yamlParsed = JSON.parse(yamlJsonRaw);
    assert.equal(yamlParsed.ok, true);
    assert.equal(yamlParsed.language, "yaml");
    assert.ok(yamlParsed.symbols.some((s: any) => s.name === "name"), "YAML outline must include 'name'");

    // Test Bash outline in strict JSON mode
    const bashJsonRaw = execFileSync(process.execPath, [cliPath, "ask", "--path", "fixture.sh", "--outline"], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
    });
    const bashParsed = JSON.parse(bashJsonRaw);
    assert.equal(bashParsed.ok, true);
    assert.ok(bashParsed.symbols.some((s: any) => s.name === "APP" && s.kind === "variable"));

    // Test JSON outline
    const jsonOut = execFileSync(process.execPath, [cliPath, "ask", "--path", "fixture.json", "--outline", "--plain"], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.match(jsonOut, /name: config_block/);

    // Test TOML outline
    const tomlOut = execFileSync(process.execPath, [cliPath, "ask", "--path", "fixture.toml", "--outline", "--plain"], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.match(tomlOut, /\[server\]: config_block/);

    // 5. Real waymark-mcp stdio session: every stdout line must parse as strict JSON-RPC (no patch banner noise)
    const mcpInput = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pack-smoke", version: "1.0.0" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "waymark_ask", arguments: { path: "fixture.yml", outline: true, root: installDir } } }),
    ].join("\n") + "\n";

    const mcpRes = spawnSync(process.execPath, [mcpPath], {
      cwd: installDir,
      input: mcpInput,
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
      env: { ...process.env, WAYMARK_MCP_WARM: "0" },
    });
    assert.equal(mcpRes.status, 0, `MCP process failed: ${mcpRes.stderr}`);
    const stdoutLines = mcpRes.stdout.split(/\r?\n/u).filter((l) => l.trim().length > 0);
    assert.equal(stdoutLines.length, 2, `Expected exactly 2 JSON-RPC responses on stdout, got ${stdoutLines.length}: ${mcpRes.stdout}`);
    for (const line of stdoutLines) {
      const msg = JSON.parse(line);
      assert.equal(msg.jsonrpc, "2.0");
    }
    const outlineBody = JSON.parse(JSON.parse(stdoutLines[1]!).result.content[0].text);
    assert.equal(outlineBody.ok, true);
    assert.equal(outlineBody.language, "yaml");

    // Confirm web-tree-sitter/tree-sitter.js remained completely unmutated on disk
    const wtsAfter = fs.readFileSync(wtsFile, "utf8");
    assert.equal(wtsAfter, wtsBefore, "web-tree-sitter/tree-sitter.js must never be mutated in-place");
  } finally {
    try {
      if (fs.existsSync(nodeModulesDir)) chmodRecursive(nodeModulesDir, true);
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
});
