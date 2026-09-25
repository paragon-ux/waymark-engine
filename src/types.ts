export type AdapterProfile = "capn-cli" | "none";

export type VerificationStatus = "FRESH" | "MOVED" | "STALE";

export interface LineRange {
  start: number;
  end: number;
}

export type LineRangeLike =
  | LineRange
  | { startLine: number; endLine: number }
  | { start: { line: number }; end: { line: number } }
  | { [key: string]: unknown };

export interface StructuralSignature {
  firstHash: string;
  lastHash: string;
  firstTokensPrefix: string[];
  lastTokensPrefix: string[];
}

export interface HopRecord {
  index: number;
  path: string;
  label: string;
  inference: string;
  range: LineRange;
  fileSha256: string;
  normalizedSpanHash: string;
  normalizedSpanLen: number;
  spanLineCount: number;
  structuralSignature: StructuralSignature;
}

export interface HopCheck {
  index: number;
  path: string;
  status: VerificationStatus;
  originalRange: LineRange;
  resolvedRange?: LineRange;
  reason?: string;
  currentFileSha256?: string;
}

export interface PublicationResult {
  published: boolean;
  adapter: AdapterProfile;
  output: string;
  error?: string;
}

export class WaymarkError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = "WaymarkError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Tier 3 & Discovery Junction Types
// ---------------------------------------------------------------------------

export type TokenShape = "identifier-like" | "plain";

export type DiscoveryTier = "auto" | "ast" | "path" | "fuzzy" | "capn";

export interface FuzzyCandidate {
  name: string;
  path: string;
  line: number;
  kind?: string;
  container?: string;
}

export interface FuzzyScoreResult {
  candidate: FuzzyCandidate;
  score: number;
  matchRanges: [number, number][];
}

export interface FuzzyMatcherOptions {
  threshold?: number;
  maxResults?: number;
  callerPath?: string;
}

export type WaymarkErrorCode =
  | "CAPN_STORE_UNINITIALIZED"
  | "CAPN_NON_DETERMINISTIC_MODE"
  | "CODEDB_BINARY_MISSING"
  | "CODEDB_PROCESS_TIMEOUT"
  | "INVALID_TIER_OVERRIDE"
  | "CALL_GRAPH_DISCONNECTED"
  | "AMBIGUOUS_DROPPED_EDGES"
  | "UNEXPECTED_ERROR";

export type WaymarkMissCode =
  | "SYMBOL_NOT_FOUND"
  | "NO_CHARTED_MEMORY"
  | "JUNCTION_EXHAUSTED"
  | "TIER_FORCED_MISS";

export interface JunctionContinuation {
  tool: "waymark_ask";
  args: {
    question: string;
    tier: DiscoveryTier;
  };
  cliCommand: string;
}

export interface JunctionOption {
  tier: "fuzzy-lexical" | "capn-cli";
  recommended: boolean;
  executed: boolean;
  confidence?: "exact" | "approximate" | "curated";
  result: unknown;
  note: string;
  continuation?: JunctionContinuation;
}

export interface AskHitResult {
  waymark: 1;
  kind: "ask";
  status: "hit";
  provider: "codedb" | "literal-path" | "capn-cli" | "fuzzy-lexical";
  confidence: "exact" | "approximate" | "curated";
  result: unknown;
  timings?: Record<string, number>;
}

export interface AskJunctionResult {
  waymark: 1;
  kind: "ask";
  status: "junction";
  provider?: "waymark-engine";
  query: string;
  signal: {
    shape: "identifier-like" | "narrative" | "mixed";
    candidateTokens: string[];
  };
  options: JunctionOption[];
  executedOption: JunctionOption;
  alternativeOption: JunctionOption;
  chartHint: string;
  recommendation?: string;
  tip?: string;
  timings?: Record<string, number>;
}

export interface AskMissResult {
  waymark: 1;
  kind: "ask";
  status: "miss";
  provider: "waymark-engine" | "codedb" | "literal-path" | "capn-cli" | "none" | "fuzzy-lexical";
  missCode: WaymarkMissCode;
  reason: string;
  matches: never[];
  timings?: Record<string, number>;
}

export interface AskErrorResult {
  waymark: 1;
  kind: "ask";
  status: "error";
  provider: "codedb" | "capn-cli" | "waymark-engine";
  errorCode: WaymarkErrorCode | string;
  message: string;
  error?: string;
  retryable: boolean;
  timings?: Record<string, number>;
}

export type AskResult =
  | AskHitResult
  | AskJunctionResult
  | AskMissResult
  | AskErrorResult;

export interface AskOptions {
  tier?: DiscoveryTier;
  forceTier?: "fuzzy-lexical" | "capn-cli";
  autoResolve?: boolean;
  timing?: boolean;
}
