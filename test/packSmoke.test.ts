import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("Packaging smoke test: npm pack and install --ignore-scripts in temp dir extracts AST symbols across formats", () => {
  const repoRoot = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-pack-smoke-"));
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

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
    const installDir = path.join(tempDir, "consumer");
    fs.mkdirSync(installDir);
    fs.writeFileSync(path.join(installDir, "package.json"), JSON.stringify({ name: "smoke-consumer", private: true }), "utf8");

    execFileSync(npmCmd, ["install", "--ignore-scripts", tgzPath], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
      shell: process.platform === "win32",
    });

    // 3. Create test fixtures in installDir
    fs.writeFileSync(path.join(installDir, "fixture.json"), JSON.stringify({ name: "smoke", port: 3000 }), "utf8");
    fs.writeFileSync(path.join(installDir, "fixture.toml"), "[server]\nport = 8080\n", "utf8");
    fs.writeFileSync(path.join(installDir, "fixture.yml"), "name: pipeline\non: push\n", "utf8");
    fs.writeFileSync(path.join(installDir, "fixture.sh"), "#!/usr/bin/env bash\nAPP=test\n", "utf8");

    // 4. Run binary via node directly from installed node_modules
    const cliPath = path.join(installDir, "node_modules", "waymark-engine", "dist", "src", "cli.js");
    assert.ok(fs.existsSync(cliPath), `CLI must exist at ${cliPath}`);

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

    // Test YAML outline
    const yamlOut = execFileSync(process.execPath, [cliPath, "ask", "--path", "fixture.yml", "--outline", "--plain"], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.match(yamlOut, /name: config_block/);

    // Test Bash outline
    const bashOut = execFileSync(process.execPath, [cliPath, "ask", "--path", "fixture.sh", "--outline", "--plain"], {
      cwd: installDir,
      windowsHide: true,
      encoding: "utf8",
    });
    assert.match(bashOut, /APP: variable/);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  }
});
