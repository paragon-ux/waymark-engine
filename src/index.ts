// Public library API of the Waymark Engine.
// One import surface for consumers: `import { ask, discoverSymbolsInFile, verifyHop } from "waymark-engine";`

export { ask, publish, capnChartArgs, resolveWindowsExecutable, assertLexicalStore, readCapnConfig } from "./capnAdapter.js";
export { detectAstIntent, queryWasmAst, getOrRefreshAst, type AstIntent } from "./discoveryRouter.js";
export { discoverSymbolsInFile, extractAstFromRepo, type SymbolDiscoveryResult, type StructuredSymbol } from "./astExtractor.js";
export { verifyHop } from "./integrity.js";
export { anchorForRange, repoRoot, sha256, structuralSignature, normalizeSpan } from "./paths.js";
export { WaymarkError, type AdapterProfile, type HopRecord, type PublicationResult, type HopCheck } from "./types.js";
