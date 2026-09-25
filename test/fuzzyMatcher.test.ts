import test from "node:test";
import assert from "node:assert/strict";
import {
  SCORE_MATCH,
  SCORE_GAP_START,
  SCORE_GAP_EXTENSION,
  BONUS_BOUNDARY,
  BONUS_CAMEL_123,
  BONUS_CONSECUTIVE,
  BONUS_FIRST_CHAR_MULTIPLIER,
  classifyTokenShape,
  scoreFzf,
  tracebackFzf,
  normalizeScore,
  rankFzf,
} from "../src/fuzzyMatcher.js";
import { FuzzyCandidate } from "../src/types.js";

test("exact fzf algo.go empirical constants are preserved", () => {
  assert.equal(SCORE_MATCH, 16);
  assert.equal(SCORE_GAP_START, -3);
  assert.equal(SCORE_GAP_EXTENSION, -1);
  assert.equal(BONUS_BOUNDARY, 8);
  assert.equal(BONUS_CAMEL_123, 7);
  assert.equal(BONUS_CONSECUTIVE, 4);
  assert.equal(BONUS_FIRST_CHAR_MULTIPLIER, 2);
});

test("classifyTokenShape detects code orthography vs plain words", () => {
  // camelCase
  assert.equal(classifyTokenShape("refundOrder"), "identifier-like");
  assert.equal(classifyTokenShape("verifyHop"), "identifier-like");
  assert.equal(classifyTokenShape("helloWorld"), "identifier-like");
  assert.equal(classifyTokenShape("getHTTPResponse"), "identifier-like");

  // snake_case
  assert.equal(classifyTokenShape("refund_order"), "identifier-like");
  assert.equal(classifyTokenShape("audit_trail"), "identifier-like");
  assert.equal(classifyTokenShape("_internal"), "identifier-like");

  // Qualified / dotted
  assert.equal(classifyTokenShape("EventStore.verifyChain"), "identifier-like");
  assert.equal(classifyTokenShape("billing.refund"), "identifier-like");

  // Plain / lowercase typos (must be plain as per design spec §3)
  assert.equal(classifyTokenShape("refund"), "plain");
  assert.equal(classifyTokenShape("flattenconfig"), "plain");
  assert.equal(classifyTokenShape("payment"), "plain");
  assert.equal(classifyTokenShape("authentication"), "plain");
  assert.equal(classifyTokenShape("a"), "plain");
  assert.equal(classifyTokenShape(""), "plain");
});

test("scoreFzf enforces strict subsequence matching", () => {
  assert.equal(scoreFzf("abc", "def"), -1);
  assert.equal(scoreFzf("order", "ord"), -1);
  assert.equal(scoreFzf("xyz", "xy"), -1);
  assert.equal(scoreFzf("", "anything"), 0);

  // Valid subsequences
  assert.ok(scoreFzf("ro", "refundOrder") > 0);
  assert.ok(scoreFzf("vh", "verifyHop") > 0);
  assert.ok(scoreFzf("capn", "capnChartArgs") > 0);
});

test("scoreFzf rewards camelCase, word boundaries, and consecutive matches", () => {
  // CamelCase boundary match 'rO' in 'refundOrder' vs non-boundary 'ro' in 'from'
  const camelScore = scoreFzf("ro", "refundOrder");
  const nonCamelScore = scoreFzf("ro", "errorOutput");
  assert.ok(camelScore > nonCamelScore, `Expected camelScore (${camelScore}) > nonCamelScore (${nonCamelScore})`);

  // Word boundary with delimiter
  const boundaryScore = scoreFzf("ro", "refund_order");
  assert.ok(boundaryScore > 0);

  // Consecutive matches score higher than fragmented matches
  const consecutive = scoreFzf("abc", "abcdef");
  const fragmented = scoreFzf("abc", "axbycz");
  assert.ok(consecutive > fragmented, `Expected consecutive (${consecutive}) > fragmented (${fragmented})`);
});

test("tracebackFzf produces contiguous match ranges for top survivors", () => {
  // Exact match
  const r1 = tracebackFzf("foo", "foobar");
  assert.deepEqual(r1, [[0, 3]]);

  // Disjoint camelCase match
  const r2 = tracebackFzf("foob", "fooBar");
  assert.deepEqual(r2, [[0, 4]]);

  const r3 = tracebackFzf("fb", "fooBar");
  assert.deepEqual(r3, [[0, 1], [3, 4]]);

  // No match
  const r4 = tracebackFzf("xyz", "foobar");
  assert.deepEqual(r4, []);
});

test("normalizeScore maps raw scores to a 0-100 range", () => {
  assert.equal(normalizeScore(-1, 5), 0);
  assert.equal(normalizeScore(0, 5), 0);

  const perfect = normalizeScore(100, 3);
  assert.ok(perfect > 50 && perfect <= 100);
});

test("rankFzf applies proximity bonus and ranks deterministically over 1,000 shuffles", () => {
  const candidates: FuzzyCandidate[] = [
    { name: "refundOrder", path: "src/billing/refund.ts", line: 42, kind: "function" },
    { name: "refundOrderOld", path: "src/legacy/refund.ts", line: 10, kind: "function" },
    { name: "processRefund", path: "src/billing/refund.ts", line: 90, kind: "function" },
    { name: "orderRefunder", path: "src/utils/order.ts", line: 15, kind: "class" },
    { name: "refundOrderExact", path: "src/billing/refund.ts", line: 45, kind: "function" },
  ];

  // Proximity bonus: caller in "src/billing/index.ts" gives +20 to "src/billing/refund.ts"
  const rankedWithProximity = rankFzf("refundOrder", candidates, {
    callerPath: "src/billing/index.ts",
    threshold: 50,
  });

  assert.ok(rankedWithProximity.length > 0);
  assert.equal(rankedWithProximity[0]?.candidate.name, "refundOrder");
  assert.equal(rankedWithProximity[0]?.candidate.path, "src/billing/refund.ts");
  assert.ok(rankedWithProximity[0]?.matchRanges.length > 0);

  // Determinism test: 1,000 shuffles
  const baseline = rankFzf("refundOrder", candidates);
  const baselineNames = baseline.map((b) => `${b.candidate.path}:${b.candidate.line}:${b.candidate.name}`);

  for (let trial = 0; trial < 1000; trial++) {
    const shuffled = [...candidates].sort(() => Math.random() - 0.5);
    const result = rankFzf("refundOrder", shuffled);
    const resultNames = result.map((b) => `${b.candidate.path}:${b.candidate.line}:${b.candidate.name}`);
    assert.deepEqual(resultNames, baselineNames, `Ranking drifted on trial ${trial}`);
  }
});
