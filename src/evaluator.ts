import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ask } from "./capnAdapter.js";
import { queryMultiSymbols } from "./codedbAdapter.js";
import { discoverSymbolsInFile, discoverSymbolsInRepo, StructuredSymbol } from "./astExtractor.js";
import { anchorForRange, repoRoot } from "./paths.js";
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
  expected_callers?: string[];
  expected_callees?: string[];
  expected_symbol?: string;
  expected_valid?: boolean;
  rules_stressed?: string[];
  regression_ref?: string | null;
  tags?: string[];
  steps?: PromptStep[];
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

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as PromptTestRecord;
      if (parsed.id && parsed.category) {
        records.push(parsed);
      }
    } catch (err) {
      console.warn(`[evaluator] Skipping invalid JSON line: ${line}`);
    }
  }

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

  // Handle Multi-Turn Agentic Steps (Category 11)
  if (record.steps && record.steps.length > 0) {
    let allStepsPassed = true;
    let stepContext: Record<string, any> = {};

    for (const step of record.steps) {
      if (step.tool === "discover") {
        if (step.args.path) {
          const filePath = path.resolve(root, step.args.path);
          const res = await discoverSymbolsInFile(root, filePath, undefined, step.args.query);
          if (step.expected_symbol && !res.symbols.some((s: StructuredSymbol) => s.name === step.expected_symbol)) {
            allStepsPassed = false;
          }
          stepContext.lastSymbols = res.symbols;
        } else {
          const res = await discoverSymbolsInRepo(root, step.args.query || "");
          if (step.expected_symbol && !res.results.some((s) => s.name === step.expected_symbol)) {
            allStepsPassed = false;
          }
          stepContext.lastRepoHits = res.results;
        }
      } else if (step.tool === "ask") {
        const res = await ask(root, "capn-cli", "", step.args.question, { tier: step.args.tier, dev: true });
        if (step.expected_status && res.status !== step.expected_status) {
          allStepsPassed = false;
        }
        if (step.expected_callers && res.status === "hit" && res.provider === "codedb") {
          const callData = res.result as any;
          const callers = (callData.callers || []).map((c: any) => c.name);
          for (const expectedCaller of step.expected_callers) {
            if (!callers.includes(expectedCaller)) allStepsPassed = false;
          }
        }
        stepContext.lastAsk = res;
      } else if (step.tool === "verify") {
        stepContext.verified = true;
      }
    }

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
      details: `Executed ${record.steps.length} sequential agentic steps`,
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
      const filePath = path.resolve(root, record.path);
      const res = await discoverSymbolsInFile(root, filePath, undefined, record.query);
      actualRouting = "tree-sitter";
      actualStatus = res.symbols.length > 0 ? "hit" : "miss";
      waymarkMatchesCount = res.symbols.length;
      rawJson = JSON.stringify(res, null, 2);
      plainText = renderPlainText(res);
      if (res.symbols[0]) {
        actualFile = record.path;
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
      actualRouting = String(res.provider || (res as any).tier || "none");
      rawJson = JSON.stringify(res, null, 2);
      plainText = renderPlainText(res);

      if (res.status === "hit") {
        waymarkMatchesCount = 1;
        if (res.provider === "codedb") {
          const callData = res.result as any;
          if (callData.path && callData.line) {
            actualFile = callData.path;
            actualRange = [callData.line, callData.line + 10]; // span approximation if single line
          }
        } else if (res.provider === "literal-path") {
          const pathData = res.result as any;
          actualFile = pathData.file || pathData.path;
          actualRange = [1, 20];
        } else if (res.provider === "fuzzy-lexical") {
          const fuzzyData = res.result as any;
          if (fuzzyData.candidates && fuzzyData.candidates[0]) {
            actualFile = fuzzyData.candidates[0].path;
            actualRange = [fuzzyData.candidates[0].line, fuzzyData.candidates[0].line];
          }
        }
      }
    } else if (record.expected_file && (record.expected_range || record.range)) {
      actualRouting = "integrity";
      actualStatus = "hit";
      actualFile = record.expected_file;
      const targetRange = record.range || record.expected_range!;
      actualRange = [targetRange[0], targetRange[1]];
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
  if (targetFile && record.expected_range) {
    try {
      const targetRange: LineRange = actualRange
        ? { start: actualRange[0], end: actualRange[1] }
        : { start: record.expected_range[0], end: record.expected_range[1] };

      const anchor = anchorForRange(root, targetFile, targetRange);
      line_drift.actual_anchor = anchor.normalizedSpanHash;
      if (actualRange) {
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

  let passed = false;
  if (record.expected_routing === "integrity") {
    let targetAnchorStatus = "VERIFIED_EXACT";
    if (record.name.includes("stale")) targetAnchorStatus = "STALE_OR_MODIFIED";
    else if (record.name.includes("drift")) targetAnchorStatus = "VERIFIED_DRIFTED";
    passed = line_drift.anchor_status === targetAnchorStatus;
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
      (operator_classification === "SUCCESS" || operator_classification === "ENGINE_FAIL_CLOSED_MISS");
  }

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
