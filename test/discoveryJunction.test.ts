import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractCandidateTokens, routeDiscovery } from "../src/discoveryRouter.js";
import { ask, publish, assertLexicalStore, initCapn } from "../src/capnAdapter.js";
import { AskJunctionResult, AskHitResult, FuzzyCandidate, WaymarkError } from "../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const waymarkRoot = path.resolve(__dirname, "..");

function createTestRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "waymark-junction-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  fs.mkdirSync(path.join(repo, ".capn"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".capn", "config.json"), '{"embedding": false}');
  fs.mkdirSync(path.join(repo, "src", "billing"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "src", "billing", "refund.ts"),
    "export function refundOrder(orderId: string): boolean { return true; }\nexport function flattenConfig(cfg: any): any { return cfg; }\n",
    "utf8"
  );
  return repo;
}

test("extractCandidateTokens accurately partitions code tokens from narrative words", () => {
  // Long conversational query with one camelCase token
  const t1 = extractCandidateTokens("where in the payment module is refundOrdr declared");
  assert.equal(t1.shape, "identifier-like");
  assert.deepEqual(t1.candidateTokens, ["refundOrdr"]);
  assert.ok(t1.plainTokens.includes("payment"));

  // Pure narrative query
  const t2 = extractCandidateTokens("how does authentication token refreshing work");
  assert.equal(t2.shape, "narrative");
  assert.equal(t2.candidateTokens.length, 0);
  assert.ok(t2.plainTokens.includes("authentication"));

  // Lowercase typo'd identifier has no camelCase/underscore
  const t3 = extractCandidateTokens("flattenconfig");
  assert.equal(t3.shape, "narrative");
  assert.equal(t3.candidateTokens.length, 0);
  assert.deepEqual(t3.plainTokens, ["flattenconfig"]);
});

test("Discovery Junction: identifier-shaped query with structural miss recommends fuzzy-lexical eagerly", async () => {
  const repo = createTestRepo();
  const mockCandidates: FuzzyCandidate[] = [
    { name: "refundOrder", path: "src/billing/refund.ts", line: 42, kind: "function" },
  ];

  let capnQueried = false;
  const res = await routeDiscovery({
    root: repo,
    question: "where in the payment module is refundOrdr declared",
    overrideCandidates: mockCandidates,
    queryCapnMemory: async () => {
      capnQueried = true;
      return { hit: false, result: null };
    },
  });

  assert.equal(res.status, "junction");
  const junction = res as AskJunctionResult;
  assert.equal(junction.signal.shape, "identifier-like");
  assert.deepEqual(junction.signal.candidateTokens, ["refundOrdr"]);

  // fuzzy-lexical must be recommended and executed
  assert.equal(junction.executedOption.tier, "fuzzy-lexical");
  assert.equal(junction.executedOption.recommended, true);
  assert.equal(junction.executedOption.executed, true);
  const hit = junction.executedOption.result as Record<string, unknown>;
  assert.equal(hit.name, "refundOrder");
  assert.equal(hit.path, "src/billing/refund.ts");

  // capn-cli must be present but NOT executed (cost discipline)
  assert.equal(junction.alternativeOption.tier, "capn-cli");
  assert.equal(junction.alternativeOption.recommended, false);
  assert.equal(junction.alternativeOption.executed, false);
  assert.equal(junction.alternativeOption.result, null);
  assert.equal(capnQueried, false, "Capn should not be queried when fuzzy hits eagerly");

  // chartHint must be present
  assert.ok(junction.chartHint.includes("waymark-chart"));
  assert.ok(junction.options.length === 2);
});

test("Discovery Junction: narrative query recommends capn-cli eagerly without fuzzy pass", async () => {
  const repo = createTestRepo();

  let capnQueried = false;
  const res = await routeDiscovery({
    root: repo,
    question: "how does authentication token refreshing work",
    queryCapnMemory: async () => {
      capnQueried = true;
      return { hit: true, result: "Tokens are refreshed via rotateSession()" };
    },
  });

  assert.equal(res.status, "junction");
  const junction = res as AskJunctionResult;
  assert.equal(junction.signal.shape, "narrative");
  assert.equal(junction.signal.candidateTokens.length, 0);

  // capn-cli must be recommended and executed
  assert.equal(junction.executedOption.tier, "capn-cli");
  assert.equal(junction.executedOption.recommended, true);
  assert.equal(junction.executedOption.executed, true);
  assert.equal(junction.executedOption.result, "Tokens are refreshed via rotateSession()");
  assert.equal(capnQueried, true);

  // fuzzy-lexical must be present but NOT executed
  assert.equal(junction.alternativeOption.tier, "fuzzy-lexical");
  assert.equal(junction.alternativeOption.recommended, false);
  assert.equal(junction.alternativeOption.executed, false);
  assert.equal(junction.alternativeOption.result, null);
});

test("Discovery Junction: lowercase-typo identifier resolves on Stage 3 exhaustive fuzzy pass", async () => {
  const repo = createTestRepo();
  const mockCandidates: FuzzyCandidate[] = [
    { name: "flattenConfig", path: "src/billing/refund.ts", line: 2, kind: "function" },
  ];

  let capnQueried = false;
  const res = await routeDiscovery({
    root: repo,
    question: "flattenconfig",
    overrideCandidates: mockCandidates,
    queryCapnMemory: async () => {
      capnQueried = true;
      return { hit: false, result: null };
    },
  });

  assert.equal(res.status, "junction");
  const junction = res as AskJunctionResult;

  // Capn was tried in Stage 2 and missed
  assert.equal(capnQueried, true);

  // Stage 3 exhaustive fuzzy resolved it
  assert.equal(junction.executedOption.tier, "fuzzy-lexical");
  assert.equal(junction.executedOption.recommended, true);
  assert.equal(junction.executedOption.executed, true);
  assert.ok(junction.executedOption.note.includes("exhaustive fuzzy pass"));

  const hit = junction.executedOption.result as Record<string, unknown>;
  assert.equal(hit.name, "flattenConfig");
});

test("Discovery Junction: forceTier overrides default recommendation deterministically", async () => {
  const repo = createTestRepo();

  // Force capn on an identifier-shaped query
  let capnQueried = false;
  const resCapn = await routeDiscovery({
    root: repo,
    question: "refundOrdr",
    options: { forceTier: "capn-cli" },
    queryCapnMemory: async () => {
      capnQueried = true;
      return { hit: true, result: "Charted explanation of refund" };
    },
  });

  assert.equal(resCapn.status, "junction");
  const jCapn = resCapn as AskJunctionResult;
  assert.equal(jCapn.executedOption.tier, "capn-cli");
  assert.equal(jCapn.executedOption.executed, true);
  assert.equal(capnQueried, true);

  // Force fuzzy on a narrative query
  const resFuzzy = await routeDiscovery({
    root: repo,
    question: "where is the refund method",
    options: { forceTier: "fuzzy-lexical" },
    overrideCandidates: [{ name: "refundOrder", path: "src/billing/refund.ts", line: 42 }],
    queryCapnMemory: async () => {
      throw new Error("Should not be called");
    },
  });

  assert.equal(resFuzzy.status, "junction");
  const jFuzzy = resFuzzy as AskJunctionResult;
  assert.equal(jFuzzy.executedOption.tier, "fuzzy-lexical");
  assert.equal(jFuzzy.executedOption.executed, true);
});

test("Discovery Junction: autoResolve: true collapses junction to flat hit result", async () => {
  const repo = createTestRepo();
  const mockCandidates: FuzzyCandidate[] = [
    { name: "refundOrder", path: "src/billing/refund.ts", line: 42, kind: "function" },
  ];

  const res = await routeDiscovery({
    root: repo,
    question: "refundOrdr",
    options: { autoResolve: true },
    overrideCandidates: mockCandidates,
    queryCapnMemory: async () => ({ hit: false, result: null }),
  });

  assert.equal(res.status, "hit");
  const hit = res as AskHitResult;
  assert.equal(hit.provider, "fuzzy-lexical");
  assert.equal(hit.confidence, "approximate");
  const payload = hit.result as Record<string, unknown>;
  assert.equal(payload.name, "refundOrder");
});

test("Discovery Junction: timing option records high-resolution tier execution metrics", async () => {
  const repo = createTestRepo();
  const mockCandidates: FuzzyCandidate[] = [
    { name: "refundOrder", path: "src/billing/refund.ts", line: 42, kind: "function" },
  ];

  const res = await routeDiscovery({
    root: repo,
    question: "refundOrdr",
    options: { timing: true },
    overrideCandidates: mockCandidates,
    queryCapnMemory: async () => ({ hit: false, result: null }),
  });

  assert.ok(res.timings);
  assert.ok(typeof res.timings.total_ms === "number");
  assert.ok(typeof res.timings.fuzzy_ms === "number");
});

test("Discovery Junction: throws INVALID_TIER_OVERRIDE on unknown tier", async () => {
  const repo = createTestRepo();
  await assert.rejects(
    () =>
      routeDiscovery({
        root: repo,
        question: "test",
        options: { tier: "invalid_tier" as any },
        queryCapnMemory: async () => ({ hit: false, result: null }),
      }),
    (err: WaymarkError) => err.code === "INVALID_TIER_OVERRIDE"
  );
});

test("Decoupling invariant (§8): waymark-chart accepts code-shaped questions without rejection", async () => {
  const repo = createTestRepo();
  await initCapn(repo);

  // Bare code-shaped question must succeed in waymark-chart with profile none
  const resultNone = await publish(
    repo,
    "none",
    "capn",
    "refundOrder",
    "Handles customer order refunds",
    ["src/billing/refund.ts"]
  );
  assert.equal(resultNone.published, false);
  assert.equal(resultNone.output, "publication disabled");

  // Bare code-shaped question must succeed in waymark-chart with lexical store
  const resultPub = await publish(
    repo,
    "capn-cli",
    "",
    "refundOrder",
    "Handles customer order refunds",
    ["src/billing/refund.ts"]
  );
  assert.equal(resultPub.published, true, `Chart failed: ${resultPub.error}`);
  assert.ok(resultPub.output.length > 0);
});
