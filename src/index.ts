// Public library API of the Waymark Engine.
// One import surface for consumers: `import { ask, discoverSymbolsInFile, verifyHop } from "waymark-engine";`

export { ask, initCapn, publish, capnChartArgs, resolveWindowsExecutable, resolveCapnCommand, assertLexicalStore, readCapnConfig, unchart, bust, prune, listEntries, context } from "./capnAdapter.js";

export { detectAstIntent, type AstIntent } from "./discoveryRouter.js";
export { queryStructural, resolveCodedbCommand } from "./codedbAdapter.js";
export { discoverSymbolsInFile, type SymbolDiscoveryResult, type StructuredSymbol } from "./astExtractor.js";
export { verifyHop } from "./integrity.js";
export { anchorForRange, normalizeRange, repoRoot, sha256, structuralSignature, normalizeSpan } from "./paths.js";
export { WaymarkError, type AdapterProfile, type HopRecord, type PublicationResult, type HopCheck, type LineRange, type LineRangeLike } from "./types.js";
