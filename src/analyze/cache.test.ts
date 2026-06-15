import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCacheReport, cacheHealthFromReport } from "./cache.js";
import type { PricingPort } from "./cache.js";
import { pricingForModel, costForUsage, formatUSD } from "../adapters/claude/pricing.js";
import type { Message, Usage } from "../core/model.js";

// Tests use Claude models, so the Claude adapter's pricing satisfies the port.
const pricing: PricingPort = { pricingForModel, costForUsage, formatUSD };

const MODEL = "claude-sonnet-4-6"; // input 3 / output 15 / cacheRead 0.3 per 1M

let seq = 0;
function turn(usage: Partial<Usage>): Message {
  seq += 1;
  return {
    uuid: `a${seq}`,
    parentUuid: null,
    role: "assistant",
    timestamp: "",
    model: MODEL,
    blocks: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      ...usage,
    },
  };
}

// Pure cache_read turns: turn cost = cacheRead * 0.3 / 1e6, so ramp/baseline are
// driven entirely by cache_read growth.
const read = (cacheReadTokens: number) => turn({ cacheReadTokens });

test("sharp ramp (>=6x) -> poor, recoverableBloatCost > 0", () => {
  const messages = [1000, 1000, 1000, 6000, 7000, 8000].map(read);
  const report = computeCacheReport(messages, pricing);
  // mean(last3)=7000, median(first3)=1000 -> ramp 7x
  assert.ok(report.finalRampRatio >= 6, `ramp ${report.finalRampRatio}`);
  assert.ok(report.aboveBaselineContextCost > 0);
  assert.ok(report.recoverableBloatCost > 0);
  assert.equal(report.recoverableBloatCost, report.aboveBaselineContextCost);
  assert.equal(cacheHealthFromReport(report), "poor");
});

test("moderate ramp (3x-6x) -> climbing, recoverableBloatCost > 0", () => {
  const messages = [1000, 1000, 1000, 3000, 4000, 5000].map(read);
  const report = computeCacheReport(messages, pricing);
  // mean(last3)=4000, median(first3)=1000 -> ramp 4x
  assert.ok(report.finalRampRatio >= 3 && report.finalRampRatio < 6, `ramp ${report.finalRampRatio}`);
  assert.ok(report.recoverableBloatCost > 0);
  assert.equal(cacheHealthFromReport(report), "climbing");
});

test("long session + low hit ratio, flat cost -> poor, recoverableBloatCost === 0", () => {
  // 21 turns, each input=cacheRead=1000 -> hit ratio 0.5 (<0.7); flat cost so no ramp.
  const messages = Array.from({ length: 21 }, () =>
    turn({ inputTokens: 1000, cacheReadTokens: 1000 }),
  );
  const report = computeCacheReport(messages, pricing);
  assert.ok(report.assistantTurnCount > 20);
  assert.ok(report.cacheHitRatio < 0.7);
  assert.ok(report.finalRampRatio < 3); // flat -> no ramp rec
  // Flat cache_read means nothing is above baseline.
  assert.equal(report.aboveBaselineContextCost, 0);
  assert.equal(report.recoverableBloatCost, 0);
  assert.equal(cacheHealthFromReport(report), "poor");
});

test("cache churning -> good, info rec only", () => {
  // write5m (2000) > read (1000), flat cost, short session.
  const messages = Array.from({ length: 5 }, () =>
    turn({ cacheReadTokens: 1000, cacheWrite5mTokens: 2000 }),
  );
  const report = computeCacheReport(messages, pricing);
  assert.equal(report.recommendations.length, 1);
  assert.equal(report.recommendations[0]?.severity, "info");
  assert.equal(report.recoverableBloatCost, 0);
  assert.equal(cacheHealthFromReport(report), "good");
});

test("healthy session -> good, no recs", () => {
  const messages = Array.from({ length: 6 }, () =>
    turn({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000 }),
  );
  const report = computeCacheReport(messages, pricing);
  assert.equal(report.recommendations.length, 0);
  assert.equal(report.recoverableBloatCost, 0);
  assert.equal(cacheHealthFromReport(report), "good");
});

test("above-baseline growth but ramp <3x -> recoverableBloatCost === 0 (gating)", () => {
  const messages = [1000, 1000, 1000, 1500, 1700, 1900].map(read);
  const report = computeCacheReport(messages, pricing);
  // mean(last3)=1700, median(first3)=1000 -> ramp 1.7x (<3, no rec fires)
  assert.ok(report.finalRampRatio < 3, `ramp ${report.finalRampRatio}`);
  assert.ok(report.aboveBaselineContextCost > 0, "raw above-baseline is positive");
  assert.equal(report.recommendations.length, 0);
  assert.equal(report.recoverableBloatCost, 0); // gated off
  assert.equal(cacheHealthFromReport(report), "good");
});

test("<5 turns -> null health", () => {
  const messages = [1000, 1000, 1000, 1000].map(read);
  const report = computeCacheReport(messages, pricing);
  assert.equal(report.assistantTurnCount, 4);
  assert.equal(cacheHealthFromReport(report), null);
});

test("user messages and assistant turns without usage are ignored", () => {
  const messages: Message[] = [
    { uuid: "u1", parentUuid: null, role: "user", timestamp: "", blocks: [] },
    read(1000),
    { uuid: "a-nousage", parentUuid: null, role: "assistant", timestamp: "", model: MODEL, blocks: [] },
    read(1000),
  ];
  const report = computeCacheReport(messages, pricing);
  assert.equal(report.assistantTurnCount, 2);
});
