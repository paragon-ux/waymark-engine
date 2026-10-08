// Public library API of the Waymark Engine.
// One import surface for consumers: `import { ask, discoverSymbolsInFile, verifyHop } from "waymark-engine";`

export { ask, initCapn, publish, capnChartArgs, resolveWindowsExecutable, resolveCapnCommand, assertLexicalStore, readCapnConfig, unchart, bust, prune, listEntries, context } from "./capnAdapter.js";
export { renderPlainText, renderCallGraph, formatTimings } from "./renderPlainText.js";
export {
  SEMANTIC_FACETS,
  ALL_FACET_IDS,
  getSemanticMapStatus,
  renderSemanticMapStatus,
  bootstrapSemanticMap,
  validateFacetBackingFiles,
  readChartedEntries,
  type SemanticFacetId,
  type FacetDefinition,
  type FacetStatus,
  type SemanticMapStatus,
  type BootstrapResult,
  type ParsedCapnEntry,
} from "./semanticMap.js";
export {
  CANONICAL_MCP_TOOLS,
  WAYMARK_TOOLS,
  CAPN_TOOLS,
  waymarkAskTool,
  waymarkMemoryTool,
  waymarkChartTool,
  discoverSymbolsTool,
  waymarkUnchartTool,
  waymarkBustTool,
  waymarkPruneTool,
  waymarkListTool,
  waymarkContextTool,
  waymarkDaemonStatusTool,
  waymarkInitTool,
} from "./mcp/capnTools.js";

export { detectAstIntent, detectLiteralIntent, collectRepoPaths, getRepoPrefixTrie, invalidatePathsCache, matchLiteralPath, extractCandidateTokens, routeDiscovery, type AstIntent, type DiscoveryRouteContext } from "./discoveryRouter.js";
export { PrefixTrie, PrefixTrieNode } from "./prefixTrie.js";
export { tryDaemonResolvePath, tryDaemonReload } from "./daemon.js";
export { classifyTokenShape, scoreFzf, rankFzf, tracebackFzf, normalizeScore, SCORE_MATCH, SCORE_GAP_START, SCORE_GAP_EXTENSION, BONUS_BOUNDARY, BONUS_CAMEL_123, BONUS_CONSECUTIVE, BONUS_FIRST_CHAR_MULTIPLIER } from "./fuzzyMatcher.js";
export { queryStructural, queryMultiHopCallGraph, queryFuzzyCandidates, queryMultiSymbols, isTestFile, resolveCodedbCommand, type MultiSymbolQueryResult, type MultiSymbolResultItem, type MultiSymbolResultItem as MultiSymbolItem } from "./codedbAdapter.js";
export { discoverSymbolsInFile, discoverSymbolsInRepo, type SymbolDiscoveryResult, type StructuredSymbol, type StructuredSymbolKind, type RepoSymbolDiscoveryResult, type RepoSymbolHit } from "./astExtractor.js";
export { verifyHop } from "./integrity.js";
export { anchorForRange, normalizeRange, repoRoot, sha256, structuralSignature, normalizeSpan } from "./paths.js";
export { startRepl, runReplScript, type ReplOptions } from "./repl.js";
export { executePromptTest, runManifestEvaluation, loadManifest, type PromptTestRecord, type PromptStep, type TestDiagnosticReport, type ManifestEvaluationScoreboard, type LineDriftInfo } from "./evaluator.js";
export { runBaselineSearch, computeBaselineComparison, type BaselineSearchResult, type BaselineComparison, type BaselineMatch } from "./baselineSearch.js";
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
  type CallGraphData,
  type CallGraphHopNode,
} from "./types.js";
