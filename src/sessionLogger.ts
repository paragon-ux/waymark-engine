import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AskResult } from "./types.js";

export interface SessionTelemetryEvent {
  timestamp: string;
  caller: "mcp" | "cli" | "daemon" | "repl";
  repoRoot: string;
  query: string;
  category: "ask" | "memory" | "symbols" | "outline";
  tierRoute: string;
  matchedSymbol?: string;
  matchedPath?: string;
  matchedLine?: number;
  score?: number;
  payloadTokens: number;
  fullFileTokensEquivalent?: number;
  tokensSavedPct?: number;
  latencyMs: number;
  timingBreakdown?: Record<string, number>;
  status: "hit" | "miss" | "junction" | "error";
  backingFiles?: string[];
  details?: string;
}

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function resolveSessionLogPath(repoRoot: string, customPath?: string): string {
  if (customPath) {
    return path.resolve(repoRoot, customPath);
  }
  const defaultDir = path.join(repoRoot, ".waymark", "sessions");
  return path.join(defaultDir, "active.jsonl");
}

/**
 * Append a structured telemetry event to the persistent session log file.
 * Non-blocking, fail-safe: never throws or disrupts query execution.
 */
export function logSessionEvent(event: SessionTelemetryEvent, customPath?: string): void {
  if (process.env.WAYMARK_TELEMETRY === "0" || process.env.WAYMARK_NO_LOG === "1") {
    return;
  }

  try {
    const logPath = resolveSessionLogPath(event.repoRoot, customPath);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        // Directory creation might fail in read-only mounts
        return;
      }
    }

    const line = JSON.stringify(event) + "\n";
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    // Fail silent to preserve engine response invariants
  }
}

export function logAskTelemetry(
  root: string,
  query: string,
  result: AskResult,
  durationMs: number,
  caller: "mcp" | "cli" | "daemon" | "repl" = "cli"
): void {
  let tierRoute = "Miss";
  let matchedSymbol: string | undefined;
  let matchedPath: string | undefined;
  let matchedLine: number | undefined;
  let score: number | undefined;
  let backingFiles: string[] | undefined;

  if (result.status === "hit") {
    if (result.provider === "codedb") tierRoute = "Tier 1: AST Structural";
    else if (result.provider === "literal-path") tierRoute = "Tier 2: Literal Path PrefixTrie";
    else if (result.provider === "fuzzy-lexical") tierRoute = "Tier 3: Deterministic Fuzzy";
    else if (result.provider === "capn-cli") tierRoute = "Tier 4: Consensus Memory";

    if (result.provider === "fuzzy-lexical" && typeof result.result === "object" && result.result) {
      const r = result.result as any;
      matchedSymbol = r.name;
      matchedPath = r.path;
      matchedLine = r.line;
      score = r.score;
    } else if (result.provider === "literal-path" && typeof result.result === "string") {
      matchedPath = result.result.split("\t")[0];
    } else if (result.provider === "codedb" && typeof result.result === "string") {
      const lines = result.result.split("\n");
      const resLine = lines.find((l) => l.trim().startsWith("results:")) || lines[1] || "";
      const match = resLine.match(/([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+(\d+)/);
      if (match) {
        matchedSymbol = match[1];
        matchedPath = match[3];
        matchedLine = parseInt(match[4] || "0", 10);
      }
    }
  } else if (result.status === "junction") {
    tierRoute = "Discovery Junction";
    if (result.executedOption?.result && typeof result.executedOption.result === "object") {
      const r = result.executedOption.result as any;
      matchedSymbol = r.name;
      matchedPath = r.path;
      matchedLine = r.line;
      score = r.score;
    }
  }

  const payloadStr = JSON.stringify(result);
  const payloadTokens = estimateTokenCount(payloadStr);
  const fullFileEquivalent = 1420;
  const tokensSavedPct = Math.max(0, Math.round((1 - (payloadTokens / fullFileEquivalent)) * 1000) / 10);

  logSessionEvent({
    timestamp: new Date().toISOString(),
    caller,
    repoRoot: root,
    query,
    category: "ask",
    tierRoute,
    matchedSymbol,
    matchedPath,
    matchedLine,
    score,
    payloadTokens,
    fullFileTokensEquivalent: fullFileEquivalent,
    tokensSavedPct,
    latencyMs: Math.round(durationMs),
    timingBreakdown: result.timings,
    status: result.status,
    backingFiles,
  });
}
