import fs from "node:fs";
import path from "node:path";
import {
  WAYMARK_ASK,
  WAYMARK_CHART,
  WAYMARK_BUST,
  WAYMARK_LIST,
  WAYMARK_UNCHART,
  WAYMARK_PRUNE,
  GRAFANA_ROOT,
  OUT_DIR,
  runWaymark,
  estimateTokens,
} from "./benchmark_runner.mjs";

const results = {
  phase2: [],
  phase3: [],
  phase4: [],
  phase5: {},
};

async function logTest(tier, query, expected, res, extra = {}) {
  const plainText = res.stdout.trim();
  const entry = {
    tier,
    query,
    expected,
    actual: plainText,
    durationMs: res.durationMs,
    exitCode: res.exitCode,
    stdoutBytes: Buffer.byteLength(res.stdout),
    stderr: res.stderr,
    ...extra,
  };
  return entry;
}

async function runPhases2to5() {
  console.log("=== PHASE 2: TIER 2 LITERAL PATH ROUTER ===");

  // 7.1 Exact Relative Path
  const exactPaths = [
    "embed.go",
    "pkg/api/dtos/datasource.go",
    "package.json",
    ".gitignore",
    "Dockerfile",
  ];
  for (const p of exactPaths) {
    const res = await runWaymark(WAYMARK_ASK, [p, "--plain"]);
    const pass = res.stdout.includes("[hit: literal-path]") && res.stdout.includes(p);
    results.phase2.push(await logTest("Tier 2", p, `Exact path ${p}`, res, {
      subtest: "7.1 Exact Relative Path",
      path: p,
      correct: pass,
    }));
    console.log(`7.1 Exact [${p}]: ${pass ? "PASS" : "FAIL"} (${res.durationMs.toFixed(1)}ms)`);
  }

  // 7.2 Unique Basename
  const uniqueBasenames = [
    { base: "embed.go", expected: "embed.go" },
    { base: "relyance.yaml", expected: "relyance.yaml" },
    { base: "knip.config.ts", expected: "knip.config.ts" },
    { base: "crowdin.yml", expected: "crowdin.yml" },
    { base: "playwright.storybook.config.ts", expected: "playwright.storybook.config.ts" },
  ];
  for (const b of uniqueBasenames) {
    const res = await runWaymark(WAYMARK_ASK, [b.base, "-t", "path", "--plain"]);
    const pass = res.stdout.includes("[hit: literal-path]") && res.stdout.includes(b.expected);
    results.phase2.push(await logTest("Tier 2", `${b.base} -t path`, `Resolves to ${b.expected}`, res, {
      subtest: "7.2 Unique Basename",
      base: b.base,
      correct: pass,
    }));
    console.log(`7.2 Basename [${b.base}]: ${pass ? "PASS" : "FAIL"} (${res.durationMs.toFixed(1)}ms)`);
  }

  // 7.3 Ambiguous Basename
  const ambiguousBasenames = [
    { base: "index.ts", minCount: 50 },
    { base: "types.ts", minCount: 30 },
    { base: "utils.ts", minCount: 10 },
    { base: "service.go", minCount: 60 },
    { base: "constants.ts", minCount: 50 },
    { base: "README.md", minCount: 10, hasRootFile: true },
  ];
  for (const amb of ambiguousBasenames) {
    const res = await runWaymark(WAYMARK_ASK, [amb.base, "-t", "path", "--plain"]);
    const isMiss = res.stdout.includes("[miss]") || res.stdout.includes("No matching path");
    results.phase2.push(await logTest("Tier 2", `${amb.base} -t path`, "Fail closed [miss] due to ambiguity", res, {
      subtest: "7.3 Ambiguous Basename",
      base: amb.base,
      correct: isMiss,
    }));
    console.log(`7.3 Ambiguous [${amb.base}]: ${isMiss ? "PASS (Fails closed)" : "FAIL (Guessed arbitrary)"} (${res.durationMs.toFixed(1)}ms)`);
  }

  // 7.4 Path Normalization
  const forwardPath = "pkg/api/dtos/datasource.go";
  const backslashPath = "pkg\\api\\dtos\\datasource.go";
  const fwdRes = await runWaymark(WAYMARK_ASK, [forwardPath, "--plain"]);
  const bckRes = await runWaymark(WAYMARK_ASK, [backslashPath, "--plain"]);
  const normPass = fwdRes.stdout.includes(forwardPath) && bckRes.stdout.includes(forwardPath);
  results.phase2.push(await logTest("Tier 2", backslashPath, "Resolves identically to forward slash", bckRes, {
    subtest: "7.4 Path Normalization",
    correct: normPass,
  }));
  console.log(`7.4 Path Normalization: ${normPass ? "PASS" : "FAIL"}\n`);

  fs.writeFileSync(path.join(OUT_DIR, "phase2_results.json"), JSON.stringify(results.phase2, null, 2));

  console.log("=== PHASE 3: TIER 3 DETERMINISTIC FUZZY MATCHING ===");
  const fuzzyTests = [
    { cls: "Class A (Typo)", q: "DataSourc", expectedSymbol: "dataSource", minScore: 60 },
    { cls: "Class A (Typo)", q: "queryrunnr", expectedSymbol: "QueryRunner", minScore: 60 },
    { cls: "Class B (Lowercase typo)", q: "queryrunnr", expectedSymbol: "QueryRunner", minScore: 60 },
    { cls: "Class C (Abbreviation)", q: "dashbrd", expectedSymbol: "dashboard", minScore: 60 },
    { cls: "Class D (Boundary typo)", q: "backEndSrv", expectedSymbol: "backendSrv", minScore: 60 },
    { cls: "Class D (Boundary typo)", q: "timeRangePickr", expectedSymbol: "TimeRangePicker", minScore: 60 },
    { cls: "Class D (Boundary typo)", q: "plugnSettngs", expectedSymbol: "pluginSettings", minScore: 50 },
    { cls: "Class E (Negative control)", q: "xyzzyqwerty123", expectedSymbol: null, expectMiss: true },
  ];

  for (const ft of fuzzyTests) {
    const res = await runWaymark(WAYMARK_ASK, [ft.q, "-t", "fuzzy", "-b", "--plain"]);
    let pass = false;
    if (ft.expectMiss) {
      pass = res.stdout.includes("[miss]") || res.stdout.includes("No fuzzy lexical match");
    } else {
      pass = (res.stdout.includes("[junction]") || res.stdout.includes("[hit: fuzzy-lexical]")) &&
             res.stdout.toLowerCase().includes(ft.expectedSymbol.toLowerCase());
    }
    // Extract score if present
    const scoreMatch = res.stdout.match(/score:\s*(\d+)/i);
    const score = scoreMatch ? parseInt(scoreMatch[1], 10) : (ft.expectMiss ? 0 : null);

    results.phase3.push(await logTest("Tier 3", `${ft.q} -t fuzzy -b`, ft.expectMiss ? "Clean [miss]" : ft.expectedSymbol, res, {
      subtest: "Tier 3 Fuzzy",
      class: ft.cls,
      target: ft.expectedSymbol,
      score,
      correct: pass,
    }));
    console.log(`3. ${ft.cls} [${ft.q}]: ${pass ? "PASS" : "FAIL"} (score: ${score}) (${res.durationMs.toFixed(1)}ms)`);
  }
  fs.writeFileSync(path.join(OUT_DIR, "phase3_results.json"), JSON.stringify(results.phase3, null, 2));

  console.log("\n=== PHASE 4: DISCOVERY JUNCTION ===");
  // 9.1 Structural miss with identifier shape
  const j91Res = await runWaymark(WAYMARK_ASK, ["Where is DataSourc declared?", "--json"]);
  const j91Plain = await runWaymark(WAYMARK_ASK, ["Where is DataSourc declared?", "--plain"]);
  console.log("9.1 Raw envelope status:", JSON.parse(j91Res.stdout || "{}").status);

  // 9.2 Prose narrative query
  const j92Res = await runWaymark(WAYMARK_ASK, ["How does datasource request handling work?", "--json"]);
  const j92Plain = await runWaymark(WAYMARK_ASK, ["How does datasource request handling work?", "--plain"]);
  console.log("9.2 Raw envelope status:", JSON.parse(j92Res.stdout || "{}").status);

  // 9.3 Lowercase typo
  const j93Res = await runWaymark(WAYMARK_ASK, ["datasourc", "--json"]);
  const j93Plain = await runWaymark(WAYMARK_ASK, ["datasourc", "--plain"]);
  console.log("9.3 Raw envelope status:", JSON.parse(j93Res.stdout || "{}").status);

  // 9.4 Auto-resolve on these queries
  const j91Auto = await runWaymark(WAYMARK_ASK, ["Where is DataSourc declared?", "--auto-resolve", "--plain"]);
  const j92Auto = await runWaymark(WAYMARK_ASK, ["How does datasource request handling work?", "--auto-resolve", "--plain"]);
  const j93Auto = await runWaymark(WAYMARK_ASK, ["datasourc", "--auto-resolve", "--plain"]);

  results.phase4 = [
    { query: "Where is DataSourc declared?", jsonEnvelope: JSON.parse(j91Res.stdout || "{}"), plain: j91Plain.stdout.trim(), autoResolve: j91Auto.stdout.trim() },
    { query: "How does datasource request handling work?", jsonEnvelope: JSON.parse(j92Res.stdout || "{}"), plain: j92Plain.stdout.trim(), autoResolve: j92Auto.stdout.trim() },
    { query: "datasourc", jsonEnvelope: JSON.parse(j93Res.stdout || "{}"), plain: j93Plain.stdout.trim(), autoResolve: j93Auto.stdout.trim() },
  ];
  fs.writeFileSync(path.join(OUT_DIR, "phase4_results.json"), JSON.stringify(results.phase4, null, 2));

  console.log("\n=== PHASE 5: TIER 4 CHARTED CONSENSUS MEMORY ===");
  const testQuestion = "How does a datasource request move from frontend to backend in Grafana?";
  const testAnswer = "Frontend QueryRunner constructs the request and dispatches via DataSourceApi; backend Go proxy in pkg/api/pluginproxy routes it to the tsdb implementation.";
  const testFiles = "pkg/api/dtos/datasource.go,embed.go";

  // 10.1 Chart
  const chartRes = await runWaymark(WAYMARK_CHART, [
    "--question", testQuestion,
    "--answer", testAnswer,
    "--files", testFiles,
  ]);
  console.log("10.1 Chart output:", chartRes.stdout.trim());
  const chartIdMatch = chartRes.stdout.match(/charted\s+([a-f0-9]+)/i) || chartRes.stdout.match(/"id":\s*"([^"]+)"/);
  const chartId = chartIdMatch ? chartIdMatch[1] : null;
  console.log("10.1 Chart ID:", chartId);

  // 10.2 Recall
  const recallRes = await runWaymark(WAYMARK_ASK, [testQuestion, "--auto-resolve", "--plain"]);
  console.log("10.2 Recall output:", recallRes.stdout.trim());
  const recallPass = recallRes.stdout.includes("[hit: capn-cli]") && recallRes.stdout.includes(testAnswer.slice(0, 30));

  // 10.3 Provenance
  const f1Exists = fs.existsSync(path.join(GRAFANA_ROOT, "pkg/api/dtos/datasource.go"));
  const f2Exists = fs.existsSync(path.join(GRAFANA_ROOT, "embed.go"));
  const provenanceOk = f1Exists && f2Exists;
  console.log("10.3 Backing files exist on disk:", provenanceOk);

  // 10.4 Invalidation (bust embed.go)
  const bustRes = await runWaymark(WAYMARK_BUST, ["embed.go"]);
  console.log("10.4 Bust output:", bustRes.stdout.trim());
  const postBustRes = await runWaymark(WAYMARK_ASK, [testQuestion, "--auto-resolve", "--plain"]);
  console.log("10.4 Post-bust query output:", postBustRes.stdout.trim());
  const postBustEvicted = !postBustRes.stdout.includes(testAnswer.slice(0, 30));
  console.log("10.4 Invalidation verified (stale entry not returned):", postBustEvicted);

  // 10.5 List / Unchart / Prune
  const listRes = await runWaymark(WAYMARK_LIST, []);
  console.log("10.5 List output:", listRes.stdout.trim());
  let unchartRes = { stdout: "" };
  if (chartId) {
    unchartRes = await runWaymark(WAYMARK_UNCHART, [chartId, "--if-exists"]);
    console.log("10.5 Unchart output:", unchartRes.stdout.trim());
  }
  const pruneRes = await runWaymark(WAYMARK_PRUNE, []);
  console.log("10.5 Prune output:", pruneRes.stdout.trim());

  results.phase5 = {
    chart: { output: chartRes.stdout.trim(), chartId, durationMs: chartRes.durationMs },
    recall: { output: recallRes.stdout.trim(), pass: recallPass, durationMs: recallRes.durationMs },
    provenance: { f1: "pkg/api/dtos/datasource.go", f2: "embed.go", exists: provenanceOk },
    invalidation: { bustOutput: bustRes.stdout.trim(), postBustOutput: postBustRes.stdout.trim(), evicted: postBustEvicted },
    cleanup: { list: listRes.stdout.trim(), unchart: unchartRes.stdout.trim(), prune: pruneRes.stdout.trim() },
  };
  fs.writeFileSync(path.join(OUT_DIR, "phase5_results.json"), JSON.stringify(results.phase5, null, 2));

  console.log("Phases 2-5 complete.\n");
}

runPhases2to5().catch(console.error);
