// Public library API of the Waymark Engine.
// One import surface for consumers: `import { ask, discoverSymbolsInFile, verifyHop } from "waymark-engine";`

export { ask, initCapn, publish, capnChartArgs, resolveWindowsExecutable, resolveCapnCommand, assertLexicalStore, readCapnConfig, unchart, bust, prune, listEntries, context } from "./capnAdapter.js";

export { detectAstIntent, detectLiteralIntent, collectRepoPaths, matchLiteralPath, extractCandidateTokens, routeDiscovery, type AstIntent, type DiscoveryRouteContext } from "./discoveryRouter.js";
export { classifyTokenShape, scoreFzf, rankFzf, tracebackFzf, normalizeScore, SCORE_MATCH, SCORE_GAP_START, SCORE_GAP_EXTENSION, BONUS_BOUNDARY, BONUS_CAMEL_123, BONUS_CONSECUTIVE, BONUS_FIRST_CHAR_MULTIPLIER } from "./fuzzyMatcher.js";
export { queryStructural, queryFuzzyCandidates, resolveCodedbCommand } from "./codedbAdapter.js";
export { discoverSymbolsInFile, type SymbolDiscoveryResult, type StructuredSymbol } from "./astExtractor.js";
export { verifyHop } from "./integrity.js";
export { anchorForRange, normalizeRange, repoRoot, sha256, structuralSignature, normalizeSpan } from "./paths.js";
export {
  WaymarkError,
  type AdapterProfile,
  type HopRecord,
  type PublicationResult,
  type HopCheck,
  type LineRange,
  type LineRangeLike,
  type AskResult,
  type AskHitResult,
  type AskJunctionResult,
  type AskMissResult,
  type AskErrorResult,
  type AskOptions,
  type DiscoveryTier,
  type JunctionOption,
  type JunctionContinuation,
  type FuzzyCandidate,
  type FuzzyScoreResult,
  type FuzzyMatcherOptions,
  type TokenShape,
  type WaymarkErrorCode,
  type WaymarkMissCode,
} from "./types.js";
