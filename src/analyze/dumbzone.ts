// Per-conversation "dumb zone" scan. The dumb zone is the regime where the
// context window has grown large enough (here: 100k input tokens) that model
// quality tends to degrade noticeably — at that point the cheap, reliable move
// is to /clear, /compact, or start a fresh conversation rather than push on.
//
// What we measure: for each GENUINE user prompt (real human input — the adapter
// already flagged these via Message.isGenuinePrompt, so we never re-derive the
// provider's prompt gate here), how big was the context it was sent into? We
// approximate that by the input context of the assistant turn that answered it
// — i.e. fresh input + everything re-read from cache that turn. A prompt sent
// into >= 100k tokens "landed in the dumb zone". A conversation is flagged only
// when the user stayed there for 2+ prompts (one prompt can cross the line by
// accident; carrying on for several means the session should have been split).
//
// Provider-agnostic by design (CLAUDE.md): this reads only the shared model and
// returns plain numbers. The human wording and the exact fix (/clear etc.) live
// with the caller / adapter, not here.

import type { Message } from "../core/model.js";

/** Context size (input tokens) at which we consider the model degraded. */
export const DUMB_ZONE_TOKENS = 100_000;
/** A session must spend at least this many prompts in-zone to be flagged. */
export const DUMB_ZONE_MIN_PROMPTS = 2;

export interface DumbZoneReport {
  /** Genuine user prompts sent into a context >= DUMB_ZONE_TOKENS. */
  promptsInZone: number;
  /** Genuine user prompts we could place against a context size. */
  totalPrompts: number;
  /** True once promptsInZone >= DUMB_ZONE_MIN_PROMPTS. */
  inDumbZone: boolean;
  /** Context size at the first prompt that crossed the line (null if never). */
  enteredAtTokens: number | null;
  /** Largest context any prompt in the session was sent into. */
  peakContextTokens: number;
}

// The input context the assistant saw on a given turn: fresh input plus
// everything re-read from cache (cache_read) and any cache writes that turn.
// Output tokens are generated, not part of the prompt, so they're excluded.
function inputContextTokens(m: Message): number {
  const u = m.usage;
  if (!u) return 0;
  return (
    u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens
  );
}

export function computeDumbZoneReport(messages: Message[]): DumbZoneReport {
  let promptsInZone = 0;
  let totalPrompts = 0;
  let peakContextTokens = 0;
  let enteredAtTokens: number | null = null;

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "user" || !m.isGenuinePrompt) continue;

    // Context this prompt was sent into = the next assistant turn that carries
    // usage. Stop at the following genuine prompt so a prompt with no response
    // never borrows a later turn's (larger) context.
    let ctx: number | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      const next = messages[j];
      if (next?.role === "user" && next.isGenuinePrompt) break;
      if (next?.role === "assistant" && next.usage) {
        ctx = inputContextTokens(next);
        break;
      }
    }
    if (ctx === null) continue;

    totalPrompts += 1;
    if (ctx > peakContextTokens) peakContextTokens = ctx;
    if (ctx >= DUMB_ZONE_TOKENS) {
      promptsInZone += 1;
      if (enteredAtTokens === null) enteredAtTokens = ctx;
    }
  }

  return {
    promptsInZone,
    totalPrompts,
    inDumbZone: promptsInZone >= DUMB_ZONE_MIN_PROMPTS,
    enteredAtTokens,
    peakContextTokens,
  };
}
