const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const ANCHOR = 'var _free = Module["_free"] = a0 => (_free = Module["_free"] = wasmExports["free"])(a0);';

// Preserve standard ASCII-only isalpha ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)).
// Upgrade iswalpha to test Unicode code points (\p{L}) for wide-character external scanners.
const SCANNER_PATCH = `
          wasmImports["_Znwm"] = (size) => _malloc(size);
          wasmImports["_ZdlPv"] = (ptr) => _free(ptr);
          wasmImports["_ZNKSt3__220__vector_base_commonILb1EE20__throw_length_errorEv"] = () => { throw new Error("vector length error"); };
          wasmImports["memcpy"] = (dest, src, count) => _memcpy(dest, src, count);
          wasmImports["abort"] = () => { throw new Error("abort"); };
          wasmImports["isalpha"] = (c) => ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) ? 1 : 0;
          wasmImports["iswdigit"] = (c) => (c >= 48 && c <= 57) ? 1 : 0;
          wasmImports["iswalpha"] = (c) => {
            if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 1;
            if (c > 127) {
              try {
                return /\\p{L}/u.test(String.fromCodePoint(c)) ? 1 : 0;
              } catch {
                return 0;
              }
            }
            return 0;
          };
          wasmImports["strcmp"] = (s1, s2) => {
            let i = 0;
            while (true) {
              const b1 = HEAPU8[s1 + i];
              const b2 = HEAPU8[s2 + i];
              if (b1 !== b2) return b1 - b2;
              if (b1 === 0) return 0;
              i++;
            }
          };`;

function findTreeSitterJs() {
  try {
    const entry = require.resolve("web-tree-sitter");
    if (fs.existsSync(entry)) return entry;
  } catch {
    // ignore
  }

  let currentDir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(currentDir, "node_modules", "web-tree-sitter", "tree-sitter.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(currentDir);
    if (parent === currentDir) break;
    currentDir = parent;
  }
  return null;
}

function applyWebTreeSitterPatch(code) {
  if (code.includes('wasmImports["_Znwm"]')) {
    return { ok: true, alreadyPatched: true, code };
  }
  const anchorIndex = code.indexOf(ANCHOR);
  if (anchorIndex === -1) {
    return { ok: false, alreadyPatched: false, code };
  }
  const insertPos = anchorIndex + ANCHOR.length;
  return {
    ok: true,
    alreadyPatched: false,
    code: code.slice(0, insertPos) + SCANNER_PATCH + code.slice(insertPos),
  };
}

let cachedPatchedModule = null;

/**
 * Load web-tree-sitter in memory with C++ external scanner WASM imports injected,
 * without mutating node_modules on disk and without writing anything to stdout.
 */
function loadPatchedWebTreeSitter() {
  if (cachedPatchedModule) return cachedPatchedModule;

  const filePath = findTreeSitterJs();
  if (!filePath) {
    throw new Error("web-tree-sitter module not found");
  }
  const rawCode = fs.readFileSync(filePath, "utf8");
  const patched = applyWebTreeSitterPatch(rawCode);
  if (!patched.ok) {
    throw new Error("Could not locate wasmImports anchor in web-tree-sitter/tree-sitter.js");
  }

  const mod = { exports: {} };
  const localRequire = createRequire(filePath);
  const dir = path.dirname(filePath);
  const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${patched.code}\n})`;
  const factory = vm.runInThisContext(wrapped, { filename: filePath });
  factory(mod.exports, localRequire, mod, filePath, dir);
  cachedPatchedModule = mod.exports;
  return cachedPatchedModule;
}

/**
 * Read-only verification that web-tree-sitter is installed and compatible with the
 * in-memory C++ scanner import shim. Never writes to node_modules or stdout.
 */
function checkWebTreeSitter(isStrict = false) {
  const filePath = findTreeSitterJs();
  if (!filePath) {
    if (isStrict) {
      console.error("[patch-web-tree-sitter] FATAL: web-tree-sitter module not found.");
      process.exit(1);
    }
    return false;
  }

  let code;
  try {
    code = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (isStrict) {
      console.error(`[patch-web-tree-sitter] FATAL: Failed to read ${filePath}:`, err);
      process.exit(1);
    }
    return false;
  }

  const patched = applyWebTreeSitterPatch(code);
  if (!patched.ok) {
    if (isStrict) {
      console.error("[patch-web-tree-sitter] FATAL: Could not find anchor in web-tree-sitter/tree-sitter.js for C++ scanner symbols.");
      console.error("[patch-web-tree-sitter] C++ external scanners (YAML, Bash) cannot link without this shim.");
      process.exit(1);
    }
    return false;
  }

  return true;
}

if (require.main === module) {
  const isStrict = process.argv.includes("--strict") || process.argv.includes("--check");
  checkWebTreeSitter(isStrict);
}

module.exports = {
  applyWebTreeSitterPatch,
  checkWebTreeSitter,
  loadPatchedWebTreeSitter,
  patchWebTreeSitter: checkWebTreeSitter,
};
