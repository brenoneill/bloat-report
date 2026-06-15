// Claude model pricing — USD per 1M tokens, per token class (cached reads are
// far cheaper than fresh input, and cache writes split by TTL). These rates are
// Anthropic-specific so they live with the Claude adapter, not in shared code.
// Keep in sync with the TokenOptics companion app's lib/pricing.ts.
//
// Cost is computed per message at parse time (each message priced by ITS OWN
// model) and summed — never recomputed from aggregated token totals, since a
// session can mix models. cache_creation_input_tokens is NOT billed here; only
// the per-TTL ephemeral_5m / ephemeral_1h buckets are (see mapUsage in parse).

import type { Usage } from "../../core/model.js";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

export const PRICING: Record<string, ModelPricing> = {
  // Fable 5 — flagship tier above Opus. cacheWrite (5m) is the standard 1.25x
  // input ($12.50, not in the public table); cacheWrite1h is 2x input ($20),
  // and cacheRead is the 90%-off-input read ($1.00).
  "claude-fable-5": { input: 10.0, output: 50.0, cacheRead: 1.0, cacheWrite: 12.5, cacheWrite1h: 20.0 },
  // Opus 4.8 — 1M context at standard pricing (no long-context premium); same
  // rates as 4.7/4.6/4.5. Without this row the dash-walk falls through to the
  // legacy "claude-opus-4" entry (15/75), overstating cost ~3x.
  "claude-opus-4-8": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-7": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-6": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-5": { input: 5.0, output: 25.0, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10.0 },
  "claude-opus-4-1": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30.0 },
  "claude-opus-4": { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0 },
  "claude-sonnet-4-5": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0 },
  "claude-sonnet-4": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0 },
  "claude-3-7-sonnet": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0 },
  "claude-3-5-sonnet": { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2.0 },
  "claude-3-5-haiku": { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0, cacheWrite1h: 1.6 },
};

// Unknown models fall back to Sonnet 4.6 — a sane mid rate, never a crash.
const FALLBACK_PRICING: ModelPricing = PRICING["claude-sonnet-4-6"]!;

// Newest known sibling in a versioned family: for a candidate like
// "claude-opus-4-9" (base "claude-opus-4", minor 9), find the highest-minor
// known id sharing that base ("claude-opus-4-8"). Same-family rates are stable
// across minors, so the latest known minor is the safe estimate for an
// unrecognised one. Only matches purely-numeric minors, so dated snapshots
// ("…-4-7-20260101") and word-suffixed legacy ids don't count as siblings.
function newestSiblingPricing(candidate: string): ModelPricing | undefined {
  const m = candidate.match(/^(.*)-\d+$/);
  if (!m) return undefined;
  const prefix = m[1] + "-";
  let bestMinor = -1;
  let best: ModelPricing | undefined;
  for (const key of Object.keys(PRICING)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    const minor = Number(rest);
    if (minor > bestMinor) ((bestMinor = minor), (best = PRICING[key]));
  }
  return best;
}

// Resolve a model id to its rates. Strips a trailing [..] tag (e.g. "[1m]"),
// then walks off date/version suffixes one dash-segment at a time until a known
// id matches (so "claude-opus-4-7-20260101" → "claude-opus-4-7"). For an
// UNKNOWN minor we price at the newest known sibling rather than continuing the
// walk down onto an older base entry — otherwise a future "claude-opus-4-9"
// would collapse onto the legacy "claude-opus-4" at 15/75 (3x too dear).
export function pricingForModel(model: string | undefined): ModelPricing {
  if (!model) return FALLBACK_PRICING;
  if (PRICING[model]) return PRICING[model];
  const stripped = model.replace(/\[.*\]$/, "");
  const parts = stripped.split("-");
  while (parts.length > 1) {
    const candidate = parts.join("-");
    if (PRICING[candidate]) return PRICING[candidate];
    const sibling = newestSiblingPricing(candidate);
    if (sibling) return sibling;
    parts.pop();
  }
  return FALLBACK_PRICING;
}

// Cost in USD for one message's usage, priced at its own model's rates.
export function costForUsage(model: string | undefined, usage: Usage): number {
  const p = pricingForModel(model);
  return (
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWrite5mTokens * p.cacheWrite +
    usage.cacheWrite1hTokens * p.cacheWrite1h
  ) / 1_000_000;
}

// List-column money formatting, matching TokenOptics: more decimals for tiny
// amounts so a sub-cent cost never collapses to "$0.00".
export function formatUSD(amount: number): string {
  if (amount === 0) return "$0.00";
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  if (amount < 1) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(2)}`;
}
