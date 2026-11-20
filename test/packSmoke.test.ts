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

    // 6. Consumer TypeScript compilation check against packed .d.ts files (RAW-SDK-001):
    // strict: true, skipLibCheck: false, types: [] (no @types/node installed in consumer project)
    // across both NodeNext and bundler moduleResolution.
    const consumerTs = [
      'import {',
      '  ask,',
      '  renderPlainText,',
      '  queryMultiSymbols,',
      '  discoverSymbolsInFile,',
      '  scoreFzf,',
      '  rankFzf,',
      '  repoRoot,',
      '  initCapn,',
      '  publish,',
      '  assertLexicalStore,',
      '  anchorForRange,',
      '  verifyHop,',
      '  sha256,',
      '  WaymarkError,',
      '  type HopRecord,',
      '} from "waymark-engine";',
      '',
      'export async function typecheckConsumer(): Promise<void> {',
      '  const root = repoRoot();',
      '  const askRes = await ask(root, "capn-cli", "", "Who calls verifyHop?", { depth: 2, direction: "callers", excludeTests: true });',
      '  const text: string = renderPlainText(askRes);',
      '  const batch = await queryMultiSymbols(root, ["McpServer", "WaymarkDaemon", "PrefixTrie"]);',
      '  const outline = await discoverSymbolsInFile(root, "src/types.ts");',
      '  const score: number = scoreFzf("vrfyHp", "verifyHop");',
      '  const ranked = rankFzf("vrfyHp", [{ name: "verifyHop", path: "src/integrity.ts", line: 66, kind: "function" }]);',
      '  await initCapn(root);',
      '  assertLexicalStore(root);',
      '  const pub = await publish(root, "none", "", "q", "a", ["src/types.ts"]);',
      '  const digest: string = sha256(new Uint8Array([1, 2, 3]));',
      '  const anchor = anchorForRange(root, "src/types.ts", { start: 1, end: 5 });',
      '  const hop: HopRecord = { index: 0, path: "src/types.ts", label: "x", inference: "y", range: { start: 1, end: 5 }, ...anchor };',
      '  const check = verifyHop(root, hop, 50);',
      '  try {',
      '    void [text, batch, outline, score, ranked, pub, digest, check];',
      '  } catch (err) {',
      '    if (err instanceof WaymarkError) { void err.code; void err.exitCode; }',
      '  }',
      '}',
      '',
    ].join("\n");
    fs.writeFileSync(path.join(installDir, "consumer.ts"), consumerTs, "utf8");
    const tscBin = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
    assert.ok(fs.existsSync(tscBin), `Expected typescript compiler at ${tscBin}`);
    for (const [cfgName, moduleOpt, resolutionOpt] of [
      ["tsconfig.nodenext.json", "NodeNext", "NodeNext"],
      ["tsconfig.bundler.json", "ESNext", "bundler"],
    ] as const) {
      fs.writeFileSync(
        path.join(installDir, cfgName),
        JSON.stringify({
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022"],
            module: moduleOpt,
            moduleResolution: resolutionOpt,
            strict: true,
            skipLibCheck: false,
            types: [],
            noEmit: true,
          },
          include: ["consumer.ts"],
        }, null, 2),
        "utf8",
      );
      const tscRes = spawnSync(process.execPath, [tscBin, "-p", cfgName], {
        cwd: installDir,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      });
      assert.equal(
        tscRes.status,
        0,
        `Consumer tsc (${cfgName}, strict + skipLibCheck:false + lib:ES2022 + types:[]) failed:\n${tscRes.stdout}\n${tscRes.stderr}`,
      );
    }

    // Also typecheck every shipped .d.ts file directly under pure ES2022 (no DOM, no @types/node)
    const packedDistSrc = path.join(installDir, "node_modules", "waymark-engine", "dist", "src");
    const collectDts = (dir: string): string[] => {
      const files: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...collectDts(full));
        else if (entry.name.endsWith(".d.ts")) files.push(full);
      }
      return files;
    };
    const allDts = collectDts(packedDistSrc);
    assert.ok(allDts.length > 0, "Expected packed .d.ts files in dist/src");
    fs.writeFileSync(
      path.join(installDir, "tsconfig.all-dts.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          lib: ["ES2022"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          types: [],
          noEmit: true,
        },
        files: allDts,
      }, null, 2),
      "utf8",
    );
    const allDtsRes = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.all-dts.json"], {
      cwd: installDir,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    assert.equal(
      allDtsRes.status,
      0,
      `All-dts pure ES2022 typecheck failed:\n${allDtsRes.stdout}\n${allDtsRes.stderr}`,
    );

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
