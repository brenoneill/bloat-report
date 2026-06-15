// Per-conversation context-bloat analysis. Ported 1:1 from the TokenOptics
// companion app (lib/analyze/cache.ts) — thresholds, formulas and the gating
// rule are deliberately identical; do not "simplify" them.
//
// What "bloat" means here: NOT "total cost is high". Every assistant turn
// re-reads the whole context so far via cache_read; in a long, focused session
// that is legitimate. Bloat is the *recoverable* slice — the cache_read cost
// above an early-session baseline — and we only COUNT it when a drift signal
// fires (evidence the session wandered across topics and /clear or /compact
// would have saved money). Hence recoverableBloatCost is GATED on a warn/critical
// recommendation; the raw aboveBaselineContextCost is informational only.
//
// Shared code stays provider-agnostic (CLAUDE.md): rates are an adapter concern,
// so pricing is injected as a PricingPort rather than imported. The Claude
// adapter's pricing functions satisfy this port structurally.

import type { Message, Usage } from "../core/model.js";

/** Rates for one model, USD per 1M tokens per class. Adapter-supplied. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

/**
 * The pricing surface this analysis needs. Each adapter brings its own rates
 * (Anthropic-specific table for Claude, a different one for Codex) so the
 * algorithm never hard-codes a provider. Claude's pricing module satisfies this.
 */
export interface PricingPort {
  pricingForModel(model: string | undefined): ModelPricing;
  costForUsage(model: string | undefined, usage: Usage): number;
  formatUSD(amount: number): string;
}

export type TokenBucket =
  | "input"
  | "output"
  | "cache_read"
  | "cache_write_5m"
  | "cache_write_1h";

export type RecommendationSeverity = "info" | "warn" | "critical";

/** Three-state health for the bloat report. null = too short to classify. */
export type CacheHealth = "good" | "climbing" | "poor";

export interface CacheTurnPoint {
  turnIndex: number;
  model: string | null;
  cost: number;
  cumulativeCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  dominantBucket: TokenBucket;
}

export interface CacheRecommendation {
  severity: RecommendationSeverity;
  title: string;
  message: string;
}

export interface CacheSessionReport {
  assistantTurnCount: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheHitRatio: number;
  cacheReadCost: number;
  cacheReadCostShare: number;
  baselineCacheReadCost: number;
  aboveBaselineContextCost: number;
  aboveBaselineContextShare: number;
  /** The bloat number: aboveBaselineContextCost IF drift fired, else 0. */
  recoverableBloatCost: number;
  trajectory: CacheTurnPoint[];
  baselineTurnCost: number;
  finalRampRatio: number;
  recommendations: CacheRecommendation[];
}

const HEALTH_MIN_TURNS = 5;
const LONG_SESSION_TURNS = 20;
const HEALTHY_CACHE_HIT_RATIO = 0.7;
const RAMP_WARN_RATIO = 3;
const RAMP_CRITICAL_RATIO = 6;

function dominantBucket(
  inputCost: number,
  outputCost: number,
  cacheReadCost: number,
  cacheWrite5mCost: number,
  cacheWrite1hCost: number,
): TokenBucket {
  let best: TokenBucket = "output";
  let bestVal = outputCost;
  const candidates: [TokenBucket, number][] = [
    ["input", inputCost],
    ["cache_read", cacheReadCost],
    ["cache_write_5m", cacheWrite5mCost],
    ["cache_write_1h", cacheWrite1hCost],
  ];
  for (const [bucket, val] of candidates) {
    if (val > bestVal) {
      best = bucket;
      bestVal = val;
    }
  }
  return best;
}

function buildTrajectory(messages: Message[], pricing: PricingPort): CacheTurnPoint[] {
  const out: CacheTurnPoint[] = [];
  let cumulative = 0;
  let turnIndex = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    turnIndex += 1;
    const p = pricing.pricingForModel(m.model);
    const inputCost = (m.usage.inputTokens * p.input) / 1_000_000;
    const outputCost = (m.usage.outputTokens * p.output) / 1_000_000;
    const cacheReadCost = (m.usage.cacheReadTokens * p.cacheRead) / 1_000_000;
    const cacheWrite5mCost = (m.usage.cacheWrite5mTokens * p.cacheWrite) / 1_000_000;
    const cacheWrite1hCost = (m.usage.cacheWrite1hTokens * p.cacheWrite1h) / 1_000_000;
    const cost =
      inputCost + outputCost + cacheReadCost + cacheWrite5mCost + cacheWrite1hCost;
    cumulative += cost;
    out.push({
      turnIndex,
      model: m.model ?? null,
      cost,
      cumulativeCost: cumulative,
      inputTokens: m.usage.inputTokens,
      outputTokens: m.usage.outputTokens,
      cacheReadTokens: m.usage.cacheReadTokens,
      cacheWrite5mTokens: m.usage.cacheWrite5mTokens,
      cacheWrite1hTokens: m.usage.cacheWrite1hTokens,
      dominantBucket: dominantBucket(
        inputCost,
        outputCost,
        cacheReadCost,
        cacheWrite5mCost,
        cacheWrite1hCost,
      ),
    });
  }
  return out;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function buildRecommendations(
  report: Omit<CacheSessionReport, "recommendations">,
  pricing: PricingPort,
): CacheRecommendation[] {
  const recs: CacheRecommendation[] = [];
  const bloatSuffix =
    report.aboveBaselineContextCost > 0
      ? ` Likely recoverable: ${pricing.formatUSD(report.aboveBaselineContextCost)} (${(report.aboveBaselineContextShare * 100).toFixed(0)}% of session cost) — drop it with /clear or /compact at the topic boundary.`
      : "";

  if (
    report.assistantTurnCount > LONG_SESSION_TURNS &&
    report.cacheHitRatio < HEALTHY_CACHE_HIT_RATIO
  ) {
    recs.push({
      severity: "critical",
      title: "Long session with low cache hit ratio",
      message: `Cache hit ratio is ${(report.cacheHitRatio * 100).toFixed(0)}% across ${report.assistantTurnCount} assistant turns. That means turns are paying full input price for context that should've been cached. Use /clear or /compact between unrelated tasks instead of letting one session drift across topics.${bloatSuffix}`,
    });
  }

  // Ramp recs are mutually exclusive (else if) — never both warn and critical.
  if (report.finalRampRatio >= RAMP_CRITICAL_RATIO) {
    recs.push({
      severity: "critical",
      title: "Cost per turn climbed sharply",
      message: `Late turns in this session cost about ${report.finalRampRatio.toFixed(1)}× as much as early turns. Most of the extra is cumulative cache_read on a growing context window. Split the session at the topic boundary or run /clear to drop history that isn't needed anymore.${bloatSuffix}`,
    });
  } else if (report.finalRampRatio >= RAMP_WARN_RATIO) {
    recs.push({
      severity: "warn",
      title: "Cost per turn climbing",
      message: `Late turns cost about ${report.finalRampRatio.toFixed(1)}× the early-session baseline. Cache_read on a growing context is doing the work. Consider splitting at task boundaries when one session drifts into a new topic.${bloatSuffix}`,
    });
  }

  if (
    report.cacheReadTokens > 0 &&
    report.cacheWrite5mTokens > report.cacheReadTokens
  ) {
    recs.push({
      severity: "info",
      title: "Cache is churning (5-minute TTL expiring)",
      message: `5-minute cache writes (${report.cacheWrite5mTokens.toLocaleString()} tokens) exceed cache reads (${report.cacheReadTokens.toLocaleString()}). The session is rebuilding cache more often than reusing it — usually caused by long pauses between turns or by prompt prefixes that change shape between calls.`,
    });
  }

  return recs;
}

export function computeCacheReport(
  messages: Message[],
  pricing: PricingPort,
): CacheSessionReport {
  const trajectory = buildTrajectory(messages, pricing);

  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWrite5mTokens = 0;
  let cacheWrite1hTokens = 0;
  let cacheReadCost = 0;
  for (const point of trajectory) {
    totalCost += point.cost;
    inputTokens += point.inputTokens;
    outputTokens += point.outputTokens;
    cacheReadTokens += point.cacheReadTokens;
    cacheWrite5mTokens += point.cacheWrite5mTokens;
    cacheWrite1hTokens += point.cacheWrite1hTokens;
  }
  for (const m of messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    const p = pricing.pricingForModel(m.model);
    cacheReadCost += (m.usage.cacheReadTokens * p.cacheRead) / 1_000_000;
  }

  const cacheHitDenom = inputTokens + cacheReadTokens;
  const cacheHitRatio = cacheHitDenom > 0 ? cacheReadTokens / cacheHitDenom : 0;
  const cacheReadCostShare = totalCost > 0 ? cacheReadCost / totalCost : 0;

  const baselineSample = trajectory.slice(0, 3).map((p) => p.cost);
  const baselineTurnCost = median(baselineSample);
  const tailSample = trajectory.slice(-3).map((p) => p.cost);
  const tailMeanCost = mean(tailSample);
  const finalRampRatio = baselineTurnCost > 0 ? tailMeanCost / baselineTurnCost : 0;

  const perTurnCacheReadCost = trajectory.map((p) => {
    const pricingForTurn = pricing.pricingForModel(p.model ?? undefined);
    return (p.cacheReadTokens * pricingForTurn.cacheRead) / 1_000_000;
  });
  const baselineCacheReadCost = median(perTurnCacheReadCost.slice(0, 3));
  let aboveBaselineContextCost = 0;
  for (const cost of perTurnCacheReadCost) {
    aboveBaselineContextCost += Math.max(0, cost - baselineCacheReadCost);
  }
  const aboveBaselineContextShare =
    totalCost > 0 ? aboveBaselineContextCost / totalCost : 0;

  // Source-of-truth total: recomputed via costForUsage per message (each priced
  // by its own model), not a naive sum of trajectory costs.
  let totalCostCheck = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    totalCostCheck += pricing.costForUsage(m.model, m.usage);
  }

  const baseReport = {
    assistantTurnCount: trajectory.length,
    totalCost: totalCostCheck,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    cacheHitRatio,
    cacheReadCost,
    cacheReadCostShare,
    baselineCacheReadCost,
    aboveBaselineContextCost,
    aboveBaselineContextShare,
    recoverableBloatCost: 0,
    trajectory,
    baselineTurnCost,
    finalRampRatio,
  };

  const recommendations = buildRecommendations(baseReport, pricing);
  // Gating: only warn/critical drift makes the above-baseline cost "recoverable".
  // info recs (cache churning) do NOT count.
  const driftDetected = recommendations.some(
    (r) => r.severity === "critical" || r.severity === "warn",
  );

  return {
    ...baseReport,
    recoverableBloatCost: driftDetected ? aboveBaselineContextCost : 0,
    recommendations,
  };
}

export function cacheHealthFromReport(report: CacheSessionReport): CacheHealth | null {
  if (report.assistantTurnCount < HEALTH_MIN_TURNS) return null;
  for (const rec of report.recommendations) {
    if (rec.severity === "critical") return "poor";
  }
  for (const rec of report.recommendations) {
    if (rec.severity === "warn") return "climbing";
  }
  return "good";
}

export function computeCacheHealth(
  messages: Message[],
  pricing: PricingPort,
): CacheHealth | null {
  return cacheHealthFromReport(computeCacheReport(messages, pricing));
}
