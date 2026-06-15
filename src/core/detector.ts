import type { Capability, Conversation } from "./model.js";
import type { BloatPattern } from "./adapter.js";

/**
 * A detector is provider-agnostic: it reads the normalised Session and the
 * declared capabilities only. It runs solely where its required signals exist;
 * where they don't, the runner records a skip (with reason) instead of guessing.
 */
export interface Detector {
  /** The shared pattern this detector reports; ties a finding to an adapter's fix. */
  readonly pattern: BloatPattern;
  /** Signals this detector needs. Missing any -> skipped, not run. */
  readonly requires: ReadonlyArray<Capability>;
  /** Run over one conversation. Return zero or more findings (no fix wording here). */
  detect(conversation: Conversation): Finding[];
}

/**
 * A raw finding from a detector — the *what* and the measured cost, never the
 * fix wording (that comes from the session's adapter at report time). Savings
 * are directional estimates; a session's measured total is the hard ceiling.
 */
export interface Finding {
  pattern: BloatPattern;
  /** Human-readable location, e.g. "turns 12-40" or "read of src/big.ts". */
  where: string;
  /** Estimated wasted tokens, priced by class upstream. Never exceed the total. */
  wastedTokens: number;
  /** Optional supporting detail surfaced only under --verbose. */
  detail?: string;
}

/** Why a detector didn't run — shown plainly in the report. */
export interface Skip {
  pattern: BloatPattern;
  missing: Capability[];
  reason: string; // e.g. "no token data: this session predates token logging"
}
