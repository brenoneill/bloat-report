import type { Conversation, ConversationSummary } from "./model.js";

/**
 * One provider adapter. It reads that provider's local transcripts read-only,
 * normalises them into the shared model, and supplies the provider-specific
 * *wording* of each fix (the shared layer never hard-codes a provider's command).
 */
export interface ProviderAdapter {
  /** Stable id used on the CLI (`--provider claude`) and in summaries. */
  readonly id: string;
  readonly displayName: string;

  /**
   * True if this machine looks like it has transcripts for this provider
   * (e.g. ~/.claude/projects exists). Cheap check — no parsing — so callers can
   * skip providers that aren't installed without erroring.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Enumerate conversations without fully parsing every message — enough for
   * `conversations list` (id, dates, title, totals, capabilities).
   */
  listConversations(): Promise<ConversationSummary[]>;

  /** Fully parse one conversation into the normalised model. */
  loadConversation(sessionId: string): Promise<Conversation | null>;

  /**
   * The provider-specific fix for a detected pattern. The *pattern* is shared
   * (enum below); the exact one-step change/command is the adapter's to word.
   */
  recommend(pattern: BloatPattern): Recommendation;
}

/** Shared catalogue of bloat patterns detectors can report. */
export type BloatPattern =
  | "uncompactedSession" // long session never compacted at a task boundary
  | "noisyToolOutput" // a tool repeatedly dumps large output into context
  | "rereadUnchangedFile" // same unchanged file read more than once
  | "fullFileRead" // whole large file read where a range would do
  | "idleMcpServer"; // MCP server connected but never called

/** Provider-specific wording the report prints next to a finding. */
export interface Recommendation {
  /** One-line plain-English fix, e.g. "Run /compact at task boundaries". */
  fix: string;
  /** Optional concrete command/flag to show, provider-specific. */
  command?: string;
}
