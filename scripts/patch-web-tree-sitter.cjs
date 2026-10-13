const fs = require("node:fs");
const path = require("node:path");

function findTreeSitterJs() {
  try {
    const entry = require.resolve("web-tree-sitter");
    if (fs.existsSync(entry)) return entry;
  } catch {
    // ignore
  }

  const candidate = path.resolve(__dirname, "..", "node_modules", "web-tree-sitter", "tree-sitter.js");
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function patchWebTreeSitter() {
  const filePath = findTreeSitterJs();
  if (!filePath) {
    console.log("[patch-web-tree-sitter] web-tree-sitter not found, skipping patch.");
    return;
  }

  let code = fs.readFileSync(filePath, "utf8");
  if (code.includes('wasmImports["_Znwm"]')) {
    console.log("[patch-web-tree-sitter] web-tree-sitter already patched.");
    return;
  }

  const anchor = 'var _free = Module["_free"] = a0 => (_free = Module["_free"] = wasmExports["free"])(a0);';
  const anchorIndex = code.indexOf(anchor);

  if (anchorIndex === -1) {
    console.warn("[patch-web-tree-sitter] Warning: Could not find anchor in web-tree-sitter/tree-sitter.js to patch C++ scanner symbols.");
    return;
  }

  const patch = `
          wasmImports["_Znwm"] = (size) => _malloc(size);
          wasmImports["_ZdlPv"] = (ptr) => _free(ptr);
          wasmImports["_ZNKSt3__220__vector_base_commonILb1EE20__throw_length_errorEv"] = () => { throw new Error("vector length error"); };
          wasmImports["memcpy"] = (dest, src, count) => _memcpy(dest, src, count);
          wasmImports["abort"] = () => { throw new Error("abort"); };
          wasmImports["isalpha"] = (c) => ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) ? 1 : 0;
          wasmImports["iswdigit"] = (c) => (c >= 48 && c <= 57) ? 1 : 0;
          wasmImports["iswalpha"] = (c) => ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) ? 1 : 0;
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

  const insertPos = anchorIndex + anchor.length;
  code = code.slice(0, insertPos) + patch + code.slice(insertPos);
  fs.writeFileSync(filePath, code, "utf8");
  console.log("[patch-web-tree-sitter] Successfully patched web-tree-sitter for C++ scanners.");
}

patchWebTreeSitter();
