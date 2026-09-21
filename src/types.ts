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
