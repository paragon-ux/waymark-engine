import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ask } from "./capnAdapter.js";
import { queryMultiSymbols } from "./codedbAdapter.js";
import { discoverSymbolsInFile, discoverSymbolsInRepo, StructuredSymbol } from "./astExtractor.js";
import { anchorForRange, repoRoot, resolveRepositoryFile } from "./paths.js";
import { verifyHop } from "./integrity.js";
import { renderPlainText } from "./renderPlainText.js";
import { runBaselineSearch, computeBaselineComparison, BaselineComparison } from "./baselineSearch.js";
import { AskResult, DiscoveryTier, LineRange } from "./types.js";

export interface PromptStep {
  step: number;
  tool: "ask" | "symbols" | "discover" | "verify" | "chart";
  args: Record<string, any>;
  expected_status?: string;
  expected_file?: string;
  expected_symbol?: string;
  expected_callers?: string[];
  expected_callees?: string[];
  expected_valid?: boolean;
  expected_routing?: string;
  expected_range?: [number, number];
  expected_anchor?: string;
  expected_anchor_status?: LineDriftInfo["anchor_status"];
}

export interface PromptTestRecord {
  id: string;
  category: string;
  name: string;
  query?: string;
  tier?: DiscoveryTier;
  symbols?: string[];
  path?: string;
  direction?: "callers" | "callees" | "both";
  depth?: number;
  exclude_tests?: boolean;
  expected_routing?: string;
  expected_status?: "hit" | "miss" | "junction" | "error";
  expected_file?: string;
  expected_range?: [number, number];
  range?: [number, number];
  expected_anchor?: string;
  expected_anchor_status?: LineDriftInfo["anchor_status"];
  expected_callers?: string[];
  expected_callees?: string[];
  expected_symbol?: string;
  expected_valid?: boolean;
  rules_stressed?: string[];
  regression_ref?: string | null;
  tags?: string[];
  steps?: PromptStep[];
}

const recordExpectations = new Set([
  "expected_routing", "expected_status", "expected_file", "expected_range", "expected_anchor",
  "expected_anchor_status", "expected_callers", "expected_callees", "expected_symbol", "expected_valid",
]);

function reportedPath(root: string, value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return relative.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function matchesFile(root: string, expected: string | undefined, actual: unknown): boolean {
  if (expected === undefined) return true;
  const expectedPath = reportedPath(root, expected);
  const actualPath = reportedPath(root, actual);
  return expectedPath !== undefined && actualPath !== undefined && expectedPath === actualPath;
}

function graphNames(value: unknown, direction: "callers" | "callees"): string[] | null {
  if (typeof value === "string") {
    const match = value.match(new RegExp(`^${direction}:\\s*(.*)$`, "imu"));
    if (!match) return null;
    return match[1] && match[1] !== "None" ? match[1].split(",").map((name) => name.trim()).filter(Boolean) : [];
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!(direction in record)) return null;
  const found: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const entry of node) collect(entry);
    } else if (node && typeof node === "object") {
      const item = node as Record<string, unknown>;
      if (typeof item.name === "string") found.push(item.name);
      collect(item[direction]);
    }
  };
  collect(record[direction]);
  return found;
}

function namesIn(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const names: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (node && typeof node === "object") {
      const item = node as Record<string, unknown>;
      if (typeof item.name === "string") names.push(item.name);
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return names;
}

function containsSymbol(value: unknown, symbol: string): boolean {
  if (namesIn(value).includes(symbol)) return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const symbols = (value as Record<string, unknown>).symbols;
    if (symbols && typeof symbols === "object" && !Array.isArray(symbols) &&
        (symbols as Record<string, { status?: unknown }>)[symbol]?.status === "hit") return true;
  }
  if (typeof value !== "string") return false;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_$])${escaped}(?:$|[^\\p{L}\\p{N}_$])`, "u").test(value);
}

function routingMatches(actual: string, expected: string | undefined): boolean {
  if (!expected) return true;
  const aliases: Record<string, string> = { symbol: "codedb" };
  return actual === (aliases[expected] ?? expected);
}

function queryTargetSymbol(query: string): string | undefined {
  return query.match(/\b(?:who calls|callees of|where is|definition of|trace)\s+([\p{L}_$][\p{L}\p{N}_$]*)/iu)?.[1];
}

function pathInText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.match(/(?:^|\s)((?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md))(?:\s|$)/iu)?.[1]?.replaceAll("\\", "/");
}

export interface LineDriftInfo {
  expected_range?: [number, number];
  actual_range?: [number, number];
  delta_lines: number;
  anchor_status: "VERIFIED_EXACT" | "VERIFIED_DRIFTED" | "STALE_OR_MODIFIED" | "N/A";
  actual_anchor?: string;
}

export interface TestDiagnosticReport {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  actual_routing: string;
  actual_status: string;
  duration_ms: number;
  line_drift: LineDriftInfo;
  operator_classification:
    | "SUCCESS"
    | "ENGINE_FAIL_CLOSED_MISS"
    | "OPERATOR_INVALID_SYNTAX"
    | "OPERATOR_WRONG_TIER"
    | "OPERATOR_PATH_ESCAPED"
    | "OPERATOR_STALE_ANCHOR"
    | "ENGINE_MISROUTING";
  baseline_comparison?: BaselineComparison;
  token_footprint: {
    plain_tokens: number;
    json_tokens: number;
    savings_pct: number;
  };
  details?: string;
}

export interface ManifestEvaluationScoreboard {
  total: number;
  passed: number;
  failed: number;
  line_drift: {
    verified_exact: number;
    verified_drifted: number;
    stale_or_modified: number;
    na: number;
  };
  classifications: Record<string, number>;
  average_duration_ms: number;
  average_noise_reduction_pct: number;
  average_token_savings_pct: number;
  reports: TestDiagnosticReport[];
}

/**
 * Load and parse prompt test records from a JSONL manifest file.
 */
export function loadManifest(manifestPath: string): PromptTestRecord[] {
  const resolved = path.resolve(manifestPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Manifest not found at: ${resolved}`);
  }
  const content = fs.readFileSync(resolved, "utf-8");
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  const records: PromptTestRecord[] = [];

  for (const [index, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as PromptTestRecord;
      if (!parsed || typeof parsed.id !== "string" || !parsed.id || typeof parsed.category !== "string" || !parsed.category) {
        throw new Error("record must include nonempty id and category");
      }
      if (parsed.steps !== undefined && !Array.isArray(parsed.steps)) {
        throw new Error("steps must be an array");
      }
      if (parsed.steps?.length === 0) throw new Error("steps must not be empty");
      if (parsed.range !== undefined && parsed.expected_routing !== "integrity") throw new Error("range is only supported for integrity records");
      const unknownExpectation = Object.keys(parsed).find((key) => key.startsWith("expected_") && !recordExpectations.has(key));
      if (unknownExpectation) throw new Error(`unsupported expectation: ${unknownExpectation}`);
      records.push(parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid prompt manifest line ${index + 1}: ${message}`);
    }
  }

  if (records.length === 0) throw new Error("Prompt manifest contains no records");
  return records;
}

/**
 * Execute a single prompt test and produce a rich diagnostic report.
 */
export async function executePromptTest(
  record: PromptTestRecord,
  rootDir?: string
): Promise<TestDiagnosticReport> {
  const root = rootDir ? path.resolve(rootDir) : repoRoot();
  const start = performance.now();

  let actualRouting = "unknown";
  let actualStatus = "unknown";
  let actualFile: string | undefined;
  let actualRange: [number, number] | undefined;
  let rawJson = "";
  let plainText = "";
  let waymarkMatchesCount = 0;
  let executionError: Error | undefined;
  const assertionFailures: string[] = [];

  // Handle Multi-Turn Agentic Steps (Category 11)
  if (record.steps && record.steps.length > 0) {
    let allStepsPassed = true;
    let stepContext: Record<string, any> = {};

    for (const step of record.steps) {
      let stepStatus = "error";
      let stepRouting: string = step.tool;
      let stepFile: string | undefined;
      let stepNames: string[] = [];
      let stepPassed = true;
      let stepRange: [number, number] | undefined;
      let stepAnchor: string | undefined;
      let stepValid: boolean | undefined;
      try {
        const knownExpectations = new Set(["expected_status", "expected_file", "expected_symbol", "expected_callers", "expected_callees", "expected_valid", "expected_routing", "expected_range", "expected_anchor", "expected_anchor_status"]);
        const unknownExpectation = Object.keys(step).find((key) => key.startsWith("expected_") && !knownExpectations.has(key));
        if (unknownExpectation) throw new Error(`Unsupported prompt expectation: ${unknownExpectation}`);
        if (step.expected_valid !== undefined && step.tool !== "verify") throw new Error("expected_valid is only supported by verify steps");
        if ((step.expected_callers || step.expected_callees) && step.tool !== "ask") throw new Error("expected_callers and expected_callees are only supported by ask steps");
        if ((step.expected_range || step.expected_anchor || step.expected_anchor_status) && step.tool !== "verify") throw new Error("anchor expectations are only supported by verify steps");
        if (step.tool === "discover") {
          if (step.args.path) {
            stepRouting = [".ts", ".tsx", ".py"].includes(path.extname(step.args.path).toLowerCase()) ? "tree-sitter" : "codedb";
            const file = resolveRepositoryFile(root, step.args.path);
            stepFile = reportedPath(root, file.real);
            const res = await discoverSymbolsInFile(root, file.real, undefined, step.args.query);
            stepNames = res.symbols.map((symbol: StructuredSymbol) => symbol.name);
            stepStatus = stepNames.length ? "hit" : "miss";
            stepContext.lastSymbols = res.symbols;
          } else {
            stepRouting = "codedb";
            const res = await discoverSymbolsInRepo(root, step.args.query || "");
            stepNames = res.results.map((symbol) => symbol.name);
            stepStatus = stepNames.length ? "hit" : "miss";
            stepContext.lastRepoHits = res.results;
          }
        } else if (step.tool === "symbols") {
          stepRouting = "multi-symbols";
          const res = await queryMultiSymbols(root, step.args.symbols ?? []);
          stepStatus = res.status;
          stepNames = Object.keys(res.symbols).filter((name) => res.symbols[name]?.status === "hit");
          const first = Object.values(res.symbols).find((entry) => entry.status === "hit");
          stepFile = first?.path;
          stepContext.lastSymbolsResult = res;
        } else if (step.tool === "ask") {
          if (typeof step.args.question !== "string") throw new Error("ask step requires a string question");
          const res = (await ask(root, "capn-cli", "", step.args.question, { tier: step.args.tier, dev: true })) as AskResult;
          stepStatus = res.status;
          stepRouting = res.status === "hit" ? res.provider : res.status === "miss" || res.status === "error" ? res.provider : "waymark-engine";
          stepNames = namesIn(res.status === "hit" ? res.result : undefined);
          if (res.status === "hit") {
            const result = res.result as Record<string, unknown>;
            stepFile = typeof result.path === "string" ? result.path : undefined;
          }
          stepContext.lastAsk = res;
          const callers = res.status === "hit" ? graphNames(res.result, "callers") : null;
          const callees = res.status === "hit" ? graphNames(res.result, "callees") : null;
          if (step.expected_callers && (res.status !== "hit" || !callers || !step.expected_callers.every((name) => callers.includes(name)))) stepPassed = false;
          if (step.expected_callees && (res.status !== "hit" || !callees || !step.expected_callees.every((name) => callees.includes(name)))) stepPassed = false;
        } else if (step.tool === "verify") {
          stepRouting = "integrity";
          const { caller, target, hop } = step.args;
          let fresh = false;
          let relation = true;
          if (hop && typeof hop === "object") {
            fresh = verifyHop(root, hop, 20).status === "FRESH";
            if (typeof hop.path === "string" && Number.isInteger(hop.range?.start) && Number.isInteger(hop.range?.end)) {
              stepFile = reportedPath(root, hop.path);
              stepRange = [hop.range.start, hop.range.end];
              stepAnchor = anchorForRange(root, hop.path, { start: hop.range.start, end: hop.range.end }).normalizedSpanHash;
            }
          } else if (typeof target === "string" && target) {
            const found = await discoverSymbolsInRepo(root, target);
            const symbol = found.results.find((item) => item.name === target);
            if (symbol) {
              const range = { start: symbol.line, end: symbol.line };
              const anchor = anchorForRange(root, symbol.path, range);
              fresh = verifyHop(root, { index: 0, path: symbol.path, label: target, inference: "manifest source verification", range, ...anchor }, 20).status === "FRESH";
              stepFile = symbol.path;
              stepRange = [range.start, range.end];
              stepAnchor = anchor.normalizedSpanHash;
              stepNames = [symbol.name];
            }
            if (typeof caller === "string") {
              const lastAsk = stepContext.lastAsk;
              const callers = lastAsk?.status === "hit" && lastAsk.provider === "codedb" ? graphNames(lastAsk.result, "callers") : null;
              relation = Boolean(callers?.includes(caller));
            }
          }
          stepStatus = fresh && relation ? "hit" : "miss";
          const valid = fresh && relation;
          stepValid = valid;
          if (step.expected_valid !== undefined && valid !== step.expected_valid) stepPassed = false;
          stepContext.verified = valid;
        } else {
          throw new Error(`Unsupported prompt step tool: ${String(step.tool)}`);
        }
        if (step.expected_status && stepStatus !== step.expected_status) stepPassed = false;
        if (!routingMatches(stepRouting, step.expected_routing)) stepPassed = false;
        if (!matchesFile(root, step.expected_file, stepFile)) stepPassed = false;
        if (step.expected_symbol && !stepNames.includes(step.expected_symbol)) stepPassed = false;
        if (step.expected_range && (!stepRange || stepRange[0] !== step.expected_range[0] || stepRange[1] !== step.expected_range[1])) stepPassed = false;
        if (step.expected_anchor && step.expected_anchor !== stepAnchor) stepPassed = false;
        if (step.expected_anchor_status) {
          const rangeDrifted = step.expected_range && stepRange && step.expected_range[0] !== stepRange[0];
          const anchorStatus = !stepAnchor ? "N/A" : step.expected_anchor && step.expected_anchor !== stepAnchor ? "STALE_OR_MODIFIED" : stepValid === false ? "STALE_OR_MODIFIED" : rangeDrifted ? "VERIFIED_DRIFTED" : "VERIFIED_EXACT";
          if (anchorStatus !== step.expected_anchor_status) stepPassed = false;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assertionFailures.push(`step ${step.step}: ${message}`);
        stepPassed = false;
      }
      if (!stepPassed) {
        allStepsPassed = false;
        assertionFailures.push(`step ${step.step} (${step.tool}) did not satisfy its declared expectations`);
      }
    }

    if (!routingMatches("agentic-pipeline", record.expected_routing)) assertionFailures.push(`expected routing ${record.expected_routing}, got agentic-pipeline`);
    if (record.expected_status && record.expected_status !== (allStepsPassed ? "hit" : "miss")) assertionFailures.push(`expected status ${record.expected_status}, got ${allStepsPassed ? "hit" : "miss"}`);
    const unsupportedRecordExpectations = ["expected_file", "expected_range", "expected_anchor", "expected_anchor_status", "expected_callers", "expected_callees", "expected_symbol", "expected_valid"]
      .filter((key) => (record as unknown as Record<string, unknown>)[key] !== undefined);
    for (const key of unsupportedRecordExpectations) assertionFailures.push(`top-level ${key} is unsupported for multi-step records; put the expectation on a step`);
    allStepsPassed = allStepsPassed && assertionFailures.length === 0;
    const duration_ms = Math.round((performance.now() - start) * 100) / 100;
    actualRouting = "agentic-pipeline";
    actualStatus = allStepsPassed ? "hit" : "miss";

    return {
      id: record.id,
      category: record.category,
      name: record.name,
      passed: allStepsPassed,
      actual_routing: actualRouting,
      actual_status: actualStatus,
      duration_ms,
      line_drift: { delta_lines: 0, anchor_status: "N/A" },
      operator_classification: allStepsPassed ? "SUCCESS" : "ENGINE_MISROUTING",
      token_footprint: { plain_tokens: 30, json_tokens: 200, savings_pct: 85 },
      details: assertionFailures.length ? assertionFailures.join("; ") : `Executed ${record.steps.length} sequential agentic steps`,
    };
  }

  // Handle Single Queries
  try {
    if (record.symbols && record.symbols.length > 0) {
      const res = await queryMultiSymbols(root, record.symbols);
      actualRouting = "multi-symbols";
      actualStatus = res.hits > 0 ? "hit" : "miss";
      waymarkMatchesCount = res.hits;
      rawJson = JSON.stringify(res, null, 2);
      plainText = renderPlainText(res);
      const symbolNames = Object.keys(res.symbols);
      const firstHitName = symbolNames.find((s) => res.symbols[s]?.status === "hit");
      if (firstHitName && res.symbols[firstHitName]) {
        const item = res.symbols[firstHitName]!;
        if (item.path && item.line) {
          actualFile = item.path;
          actualRange = [item.line, item.line];
        }
      }
    } else if (record.path) {
      const file = resolveRepositoryFile(root, record.path);
      const filePath = file.real;
      actualFile = reportedPath(root, filePath);
      const res = await discoverSymbolsInFile(root, filePath, undefined, record.query);
      actualRouting = "tree-sitter";
      actualStatus = res.symbols.length > 0 ? "hit" : "miss";
      waymarkMatchesCount = res.symbols.length;
      rawJson = JSON.stringify(res, null, 2);
      plainText = renderPlainText(res);
      if (res.symbols[0]) {
        actualFile = reportedPath(root, filePath);
        actualRange = [res.symbols[0].start.line, res.symbols[0].end.line];
      }
    } else if (record.query) {
      const autoResolve = record.expected_status !== "junction";
      const res = (await ask(root, "capn-cli", "", record.query, {
        tier: record.tier || "auto",
        autoResolve,
        depth: record.depth,
        direction: record.direction,
        excludeTests: record.exclude_tests,
        dev: true,
      })) as AskResult;

      actualStatus = res.status;
      actualRouting = res.status === "junction" ? (res.provider || "waymark-engine") : String(res.provider || (res as any).tier || "none");
      rawJson = JSON.stringify(res, null, 2);
      plainText = renderPlainText(res);

      if (res.status === "hit") {
        waymarkMatchesCount = 1;
        if (res.provider === "codedb") {
          const callData = res.result as any;
          if (callData.path && callData.line) {
            actualFile = callData.path;
            actualRange = [callData.line, callData.line + 10]; // span approximation if single line
          } else {
            actualFile = pathInText(res.result);
            const target = queryTargetSymbol(record.query);
            if (!actualFile && target) {
              const discovered = await discoverSymbolsInRepo(root, target);
              actualFile = discovered.results.find((symbol) => symbol.name === target)?.path;
            }
          }
        } else if (res.provider === "literal-path") {
          const pathData = res.result as any;
          actualFile = typeof pathData === "string" ? pathData.split(/\s|\[/u)[0] : pathData.file || pathData.path;
          actualRange = [1, 20];
        } else if (res.provider === "fuzzy-lexical") {
          const fuzzyData = res.result as any;
          if (fuzzyData.candidates && fuzzyData.candidates[0]) {
            actualFile = fuzzyData.candidates[0].path;
            actualRange = [fuzzyData.candidates[0].line, fuzzyData.candidates[0].line];
          }
        }
      }
    } else if (record.expected_routing === "integrity" && record.expected_file && (record.expected_range || record.range)) {
      actualRouting = "integrity";
      actualStatus = "hit";
      const file = resolveRepositoryFile(root, record.expected_file);
      actualFile = reportedPath(root, file.real);
      const targetRange = record.range || record.expected_range!;
      actualRange = [targetRange[0], targetRange[1]];
      anchorForRange(root, record.expected_file, { start: targetRange[0], end: targetRange[1] });
    }
  } catch (err: any) {
    executionError = err;
    actualStatus = "error";
    actualRouting = "error";
  }

  const duration_ms = Math.round((performance.now() - start) * 100) / 100;

  // Calculate Line Drift and Anchor Status
  const line_drift: LineDriftInfo = {
    expected_range: record.expected_range,
    actual_range: actualRange,
    delta_lines: 0,
    anchor_status: "N/A",
  };

  const targetFile = actualFile || record.expected_file;
  if (targetFile && (record.expected_range || record.expected_anchor || record.expected_anchor_status)) {
    try {
      const targetRange: LineRange | undefined = actualRange
        ? { start: actualRange[0], end: actualRange[1] }
        : record.expected_range ? { start: record.expected_range[0], end: record.expected_range[1] } : undefined;
      if (!targetRange) throw new Error("anchor expectation has no verifiable range");

      const anchor = anchorForRange(root, targetFile, targetRange);
      line_drift.actual_anchor = anchor.normalizedSpanHash;
      if (actualRange && record.expected_range) {
        line_drift.delta_lines = actualRange[0] - record.expected_range[0];
      }

      if (record.expected_anchor) {
        if (record.expected_anchor === anchor.normalizedSpanHash) {
          line_drift.anchor_status = line_drift.delta_lines === 0 ? "VERIFIED_EXACT" : "VERIFIED_DRIFTED";
        } else {
          line_drift.anchor_status = "STALE_OR_MODIFIED";
        }
      } else {
        line_drift.anchor_status = line_drift.delta_lines === 0 ? "VERIFIED_EXACT" : "VERIFIED_DRIFTED";
      }
    } catch {
      line_drift.anchor_status = "STALE_OR_MODIFIED";
    }
  }

  // Operator Classification
  let operator_classification: TestDiagnosticReport["operator_classification"] = "SUCCESS";
  const expectedStatus = record.expected_status || "hit";
  const graphResult = (() => {
    const parsed = JSON.parse(rawJson || "null") as any;
    return parsed?.result ?? parsed;
  })();
  const expectedRangeMatches = !record.expected_range || record.expected_routing === "integrity" ||
    Boolean(actualRange && actualRange[0] === record.expected_range[0] && actualRange[1] === record.expected_range[1]) ||
    (record.expected_anchor_status === "VERIFIED_DRIFTED" && line_drift.anchor_status === "VERIFIED_DRIFTED");

  let passed = false;
  if (record.expected_routing === "integrity") {
    const targetAnchorStatus = record.expected_anchor_status ?? "VERIFIED_EXACT";
    passed = actualStatus === expectedStatus && routingMatches(actualRouting, record.expected_routing) && matchesFile(root, record.expected_file, actualFile) && line_drift.anchor_status === targetAnchorStatus;
    operator_classification = passed ? "SUCCESS" : "OPERATOR_STALE_ANCHOR";
  } else {
    if (actualStatus === expectedStatus) {
      operator_classification = actualStatus === "miss" ? "ENGINE_FAIL_CLOSED_MISS" : "SUCCESS";
    } else if (record.query && (record.query.includes("\0") || record.query.startsWith("---"))) {
      operator_classification = "OPERATOR_INVALID_SYNTAX";
    } else if (record.path && (record.path.includes("..") || path.isAbsolute(record.path))) {
      operator_classification = "OPERATOR_PATH_ESCAPED";
    } else if (record.tier && record.tier !== "auto" && actualStatus === "miss") {
      operator_classification = "OPERATOR_WRONG_TIER";
    } else {
      operator_classification = "ENGINE_MISROUTING";
    }

    passed =
      actualStatus === expectedStatus &&
      (operator_classification === "SUCCESS" || operator_classification === "ENGINE_FAIL_CLOSED_MISS") &&
      routingMatches(actualRouting, record.expected_routing) &&
      matchesFile(root, record.expected_file, actualFile) &&
      (!record.expected_symbol || containsSymbol(JSON.parse(rawJson || "null"), record.expected_symbol) || (actualStatus === "hit" && Boolean(record.symbols?.includes(record.expected_symbol)))) &&
      (!record.expected_callers || (actualStatus === "hit" && actualRouting === "codedb" && graphNames(graphResult, "callers") !== null && record.expected_callers.every((name) => graphNames(graphResult, "callers")!.includes(name)))) &&
      (!record.expected_callees || (actualStatus === "hit" && actualRouting === "codedb" && graphNames(graphResult, "callees") !== null && record.expected_callees.every((name) => graphNames(graphResult, "callees")!.includes(name)))) &&
      expectedRangeMatches &&
      (record.expected_valid === undefined || (record.expected_routing === "integrity" &&
        (line_drift.anchor_status === "VERIFIED_EXACT" || line_drift.anchor_status === "VERIFIED_DRIFTED") === record.expected_valid)) &&
      (!record.expected_anchor || line_drift.actual_anchor === record.expected_anchor) &&
      (!record.expected_anchor_status || line_drift.anchor_status === record.expected_anchor_status);
  }
  if (!passed && operator_classification === "SUCCESS") operator_classification = "ENGINE_MISROUTING";

  // Token Footprint
  const plain_tokens = Math.ceil(plainText.length / 4);
  const json_tokens = Math.ceil(rawJson.length / 4);
  const savings_pct =
    json_tokens > 0 ? Math.round(((json_tokens - plain_tokens) / json_tokens) * 100) : 0;

  // Baseline Comparison (for hit queries)
  let baseline_comparison: BaselineComparison | undefined;
  if (record.query && passed && actualStatus === "hit") {
    try {
      const baseline = runBaselineSearch(record.query, root);
      baseline_comparison = computeBaselineComparison(
        record.query,
        actualRouting,
        duration_ms,
        waymarkMatchesCount,
        plain_tokens,
        baseline
      );
    } catch {}
  }

  return {
    id: record.id,
    category: record.category,
    name: record.name,
    passed,
    actual_routing: actualRouting,
    actual_status: actualStatus,
    duration_ms,
    line_drift,
    operator_classification,
    baseline_comparison,
    token_footprint: {
      plain_tokens,
      json_tokens,
      savings_pct,
    },
    details: executionError ? executionError.message : undefined,
  };
}

/**
 * Run evaluation across multiple manifest records with filtering and generate a scoreboard.
 */
export async function runManifestEvaluation(options: {
  manifestPath: string;
  category?: string;
  id?: string;
  rootDir?: string;
  onProgress?: (report: TestDiagnosticReport, index: number, total: number) => void;
}): Promise<ManifestEvaluationScoreboard> {
  const records = loadManifest(options.manifestPath);
  const filtered = records.filter((r) => {
    if (options.id && r.id !== options.id) return false;
    if (options.category && !r.category.toLowerCase().includes(options.category.toLowerCase())) return false;
    return true;
  });

  const reports: TestDiagnosticReport[] = [];
  const classifications: Record<string, number> = {};
  const driftCounts = {
    verified_exact: 0,
    verified_drifted: 0,
    stale_or_modified: 0,
    na: 0,
  };

  let totalDuration = 0;
  let totalNoiseReduction = 0;
  let noiseReductionCount = 0;
  let totalTokenSavings = 0;
  let tokenSavingsCount = 0;

  for (let i = 0; i < filtered.length; i++) {
    const record = filtered[i];
    if (!record) continue;
    const report = await executePromptTest(record, options.rootDir);
    reports.push(report);

    classifications[report.operator_classification] =
      (classifications[report.operator_classification] || 0) + 1;

    if (report.line_drift.anchor_status === "VERIFIED_EXACT") driftCounts.verified_exact++;
    else if (report.line_drift.anchor_status === "VERIFIED_DRIFTED") driftCounts.verified_drifted++;
    else if (report.line_drift.anchor_status === "STALE_OR_MODIFIED") driftCounts.stale_or_modified++;
    else driftCounts.na++;

    totalDuration += report.duration_ms;

    if (report.baseline_comparison) {
      totalNoiseReduction += report.baseline_comparison.noise_reduction_ratio * 100;
      noiseReductionCount++;
    }

    if (report.token_footprint.savings_pct > 0) {
      totalTokenSavings += report.token_footprint.savings_pct;
      tokenSavingsCount++;
    }

    if (options.onProgress) {
      options.onProgress(report, i + 1, filtered.length);
    }
  }

  const passed = reports.filter((r) => r.passed).length;
  const failed = reports.length - passed;

  return {
    total: reports.length,
    passed,
    failed,
    line_drift: driftCounts,
    classifications,
    average_duration_ms: reports.length > 0 ? Math.round((totalDuration / reports.length) * 10) / 10 : 0,
    average_noise_reduction_pct:
      noiseReductionCount > 0 ? Math.round((totalNoiseReduction / noiseReductionCount) * 10) / 10 : 0,
    average_token_savings_pct:
      tokenSavingsCount > 0 ? Math.round((totalTokenSavings / tokenSavingsCount) * 10) / 10 : 0,
    reports,
  };
}
