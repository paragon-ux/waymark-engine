import path from "node:path";
import { FuzzyCandidate, FuzzyScoreResult, FuzzyMatcherOptions, TokenShape } from "./types.js";

// Exact empirical constants from Junegunn Choi's algo.go (fzf)
export const SCORE_MATCH = 16;
export const SCORE_GAP_START = -3;
export const SCORE_GAP_EXTENSION = -1;
export const BONUS_BOUNDARY = 8;
export const BONUS_CAMEL_123 = 7;
export const BONUS_CONSECUTIVE = 4;
export const BONUS_FIRST_CHAR_MULTIPLIER = 2;

function isBoundaryChar(ch: number): boolean {
  // Delimiters: '/', '\\', '_', '-', '.', ':', ' ', '\t'
  return (
    ch === 47 || // /
    ch === 92 || // \
    ch === 95 || // _
    ch === 45 || // -
    ch === 46 || // .
    ch === 58 || // :
    ch === 32 || // space
    ch === 9     // tab
  );
}

function isUpper(ch: number): boolean {
  return ch >= 65 && ch <= 90;
}

function isLower(ch: number): boolean {
  return ch >= 97 && ch <= 122;
}

function isDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57;
}

/**
 * Cheap syntactic token classification.
 * Checks for code-like orthography: camelCase boundary, snake_case underscore, or qualified dot.
 */
export function classifyTokenShape(token: string): TokenShape {
  const trimmed = token.trim();
  if (trimmed.length <= 1) return "plain";

  let hasLower = false;
  let hasUpper = false;
  let hasUnder = false;
  let hasDot = false;

  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code === 95) hasUnder = true;
    else if (code === 46) hasDot = true;
    else if (isLower(code)) hasLower = true;
    else if (isUpper(code)) {
      if (hasLower) return "identifier-like"; // e.g. fooBar
      hasUpper = true;
    }
  }

  if (hasUnder || hasDot) return "identifier-like";
  return "plain";
}

/**
 * Score-only Pass 1: Computes exact fzf score using rolling 1D buffers.
 * Returns -1 if pattern is not a subsequence of target. Zero allocations per call.
 */
export function scoreFzf(pattern: string, target: string): number {
  const pLen = pattern.length;
  const tLen = target.length;
  if (pLen === 0) return 0;
  if (tLen === 0 || pLen > tLen) return -1;

  const pLower = pattern.toLowerCase();
  const tLower = target.toLowerCase();

  // Quick subsequence check
  let pIdx = 0;
  for (let tIdx = 0; tIdx < tLen; tIdx++) {
    if (tLower.charCodeAt(tIdx) === pLower.charCodeAt(pIdx)) {
      pIdx++;
      if (pIdx === pLen) break;
    }
  }
  if (pIdx < pLen) return -1;

  // Smith-Waterman alignment with rolling score row
  // H[j] is score ending at target[j-1], M[j] is score matching target[j-1]
  const H = new Int32Array(tLen + 1);
  const M = new Int32Array(tLen + 1);

  // Precompute contextual bonuses for each character in target
  const bonuses = new Int16Array(tLen);
  let prevChar = 0;
  for (let j = 0; j < tLen; j++) {
    const cur = target.charCodeAt(j);
    if (j === 0 || isBoundaryChar(prevChar)) {
      bonuses[j] = BONUS_BOUNDARY;
    } else if (isUpper(cur) && isLower(prevChar)) {
      bonuses[j] = BONUS_CAMEL_123;
    } else if (isDigit(cur) && !isDigit(prevChar)) {
      bonuses[j] = BONUS_CAMEL_123;
    } else {
      bonuses[j] = 0;
    }
    prevChar = cur;
  }

  // DP alignment
  for (let i = 1; i <= pLen; i++) {
    const pChar = pLower.charCodeAt(i - 1);
    let prevH = 0;
    let maxInRow = -100000;

    for (let j = 1; j <= tLen; j++) {
      const tChar = tLower.charCodeAt(j - 1);
      const tempH = H[j] ?? 0;

      if (pChar === tChar) {
        let score = (i === 1) ? (SCORE_MATCH + (j - 1) * SCORE_GAP_EXTENSION) : (prevH + SCORE_MATCH);
        let bonus = bonuses[j - 1] ?? 0;

        // First character multiplier
        if (i === 1) {
          bonus *= BONUS_FIRST_CHAR_MULTIPLIER;
        }

        // Consecutive bonus
        if ((M[j - 1] ?? 0) > 0) {
          bonus = Math.max(bonus, BONUS_CONSECUTIVE);
        }

        score += bonus;
        M[j] = score;

        const hPrev = H[j - 1] ?? 0;
        const gapStartScore = hPrev + SCORE_GAP_START;
        const gapExtScore = hPrev + SCORE_GAP_EXTENSION;
        H[j] = Math.max(score, gapStartScore, gapExtScore);
      } else {
        M[j] = -100000;
        const hPrev = H[j - 1] ?? 0;
        const gapStartScore = hPrev + SCORE_GAP_START;
        const gapExtScore = hPrev + SCORE_GAP_EXTENSION;
        H[j] = Math.max(gapStartScore, gapExtScore);
      }

      prevH = tempH;
      const curH = H[j] ?? -100000;
      if (curH > maxInRow) maxInRow = curH;
    }
  }

  // Find max score in the final row
  let maxScore = -100000;
  for (let j = pLen; j <= tLen; j++) {
    const curH = H[j] ?? -100000;
    if (curH > maxScore) maxScore = curH;
  }

  return maxScore;
}

/**
 * Traceback Pass 2: Runs 2D Smith-Waterman traceback for matching ranges.
 * Only executed for the top K surviving candidates.
 */
export function tracebackFzf(pattern: string, target: string): [number, number][] {
  const pLen = pattern.length;
  const tLen = target.length;
  if (pLen === 0 || tLen === 0) return [];

  const pLower = pattern.toLowerCase();
  const tLower = target.toLowerCase();

  const stride = tLen + 1;
  const H = new Int32Array((pLen + 1) * stride);
  H.fill(-100000);
  for (let j = 0; j <= tLen; j++) {
    H[j] = 0;
  }

  for (let i = 1; i <= pLen; i++) {
    const pChar = pLower.charCodeAt(i - 1);
    const rowOffset = i * stride;
    const prevRowOffset = (i - 1) * stride;
    for (let j = i; j <= tLen; j++) {
      const tChar = tLower.charCodeAt(j - 1);
      let matchScore = -100000;
      if (pChar === tChar) {
        matchScore = (H[prevRowOffset + j - 1] ?? -100000) + SCORE_MATCH;
      }
      const gapLeft = (H[rowOffset + j - 1] ?? -100000) + SCORE_GAP_EXTENSION;
      H[rowOffset + j] = Math.max(matchScore, gapLeft);
    }
  }

  // Backtrack from end
  let i = pLen;
  let bestJ = tLen;
  let bestScore = -100000;
  const lastRowOffset = pLen * stride;
  for (let col = pLen; col <= tLen; col++) {
    const s = H[lastRowOffset + col] ?? -100000;
    if (s > bestScore) {
      bestScore = s;
      bestJ = col;
    }
  }
  let j = bestJ;

  const matchedIndices: number[] = [];
  while (i > 0 && j > 0) {
    const curScore = H[i * stride + j] ?? -100000;
    const prevDiagScore = H[(i - 1) * stride + j - 1] ?? -100000;
    if (pLower.charCodeAt(i - 1) === tLower.charCodeAt(j - 1) &&
        curScore === prevDiagScore + SCORE_MATCH) {
      matchedIndices.push(j - 1);
      i--;
      j--;
    } else {
      j--;
    }
  }

  matchedIndices.reverse();
  if (matchedIndices.length === 0) return [];

  // Group contiguous indices into [start, end] ranges
  const ranges: [number, number][] = [];
  let rStart = matchedIndices[0]!;
  let rEnd = rStart;

  for (let k = 1; k < matchedIndices.length; k++) {
    const idx = matchedIndices[k]!;
    if (idx === rEnd + 1) {
      rEnd = idx;
    } else {
      ranges.push([rStart, rEnd + 1]);
      rStart = idx;
      rEnd = idx;
    }
  }
  ranges.push([rStart, rEnd + 1]);
  return ranges;
}

/**
 * Computes repository path proximity bonus between caller and candidate.
 */
function pathProximityBonus(callerPath: string | undefined, candPath: string): number {
  if (!callerPath) return 0;
  const callerNorm = callerPath.replace(/\\/g, "/");
  const candNorm = candPath.replace(/\\/g, "/");

  const callerDir = path.dirname(callerNorm);
  const candDir = path.dirname(candNorm);

  if (callerDir === candDir) return 20; // Same directory
  const callerParent = path.dirname(callerDir);
  const candParent = path.dirname(candDir);
  if (callerParent === candParent) return 10; // Same crate / parent module
  return 0;
}

/**
 * Normalizes raw fzf score into 0-100 confidence scale.
 */
export function normalizeScore(rawScore: number, pLen: number): number {
  if (rawScore < 0 || pLen <= 0) return 0;
  const maxPossible =
    (SCORE_MATCH + BONUS_BOUNDARY * BONUS_FIRST_CHAR_MULTIPLIER) +
    Math.max(0, pLen - 1) * (SCORE_MATCH + BONUS_CONSECUTIVE);
  if (maxPossible <= 0) return 0;
  return Math.min(100, Math.round((rawScore / maxPossible) * 100));
}

/**
 * Evaluates and ranks candidates using two-pass lazy traceback.
 */
export function rankFzf(
  pattern: string,
  candidates: readonly FuzzyCandidate[],
  options?: FuzzyMatcherOptions
): FuzzyScoreResult[] {
  const threshold = options?.threshold ?? 60;
  const maxResults = options?.maxResults ?? 5;
  const pLen = pattern.length;
  if (pLen === 0) return [];

  // Pass 1: Bulk score-only filtering
  const scored: { candidate: FuzzyCandidate; rawScore: number; confidence: number }[] = [];

  for (const cand of candidates) {
    const raw = scoreFzf(pattern, cand.name);
    if (raw < 0) continue;

    const prox = pathProximityBonus(options?.callerPath, cand.path);
    const confidence = normalizeScore(raw + prox, pLen);

    if (confidence >= threshold) {
      scored.push({ candidate: cand, rawScore: raw + prox, confidence });
    }
  }

  // Deterministic sort: score desc, length asc, path asc
  scored.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.candidate.name.length !== b.candidate.name.length) {
      return a.candidate.name.length - b.candidate.name.length;
    }
    const pathCmp = a.candidate.path.localeCompare(b.candidate.path);
    if (pathCmp !== 0) return pathCmp;
    return a.candidate.line - b.candidate.line;
  });

  // Take top K survivors
  const topK = scored.slice(0, maxResults);

  // Pass 2: Lazy traceback matrix for winning candidates only
  return topK.map((item) => ({
    candidate: item.candidate,
    score: item.confidence,
    matchRanges: tracebackFzf(pattern, item.candidate.name),
  }));
}
