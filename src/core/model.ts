// The shared, provider-agnostic model. Adapters normalise transcripts into
// these types; detectors read only these types and never know which provider
// produced them. (CLAUDE.md: "Adapters normalise; detectors don't know about
// providers.") These mirror the tokenoptics companion app so the two share one
// vocabulary; the additions here are `Capability` (for graceful degradation)
// and the per-conversation capability set.

export type ContentBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; toolUseId: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      toolUseId: string;
      isError: boolean;
      charCount: number;
      toolName?: string; // resolved from the matching tool_use, when known
    };

/**
 * Token accounting for one message. Anthropic splits cache writes by TTL
 * (5-minute vs 1-hour ephemeral), which are priced differently — kept separate
 * so we never blur the two. Other providers fill what they record; absent
 * signals are reflected in the conversation's capability set, not faked as 0.
 */
export interface Usage {
  inputTokens: number; // fresh (uncached) input
  outputTokens: number;
  cacheReadTokens: number; // served from cache, far cheaper than fresh input
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export interface Message {
  uuid: string;
  parentUuid: string | null;
  role: "user" | "assistant";
  timestamp: string;
  model?: string;
  blocks: ContentBlock[];
  usage?: Usage; // present only where the tokenUsage capability holds
  cost?: number; // filled by pricing; absent until priced
  // True only on user messages that are real human input (not tool-result-only
  // lines or a provider's synthetic wrappers). Which lines qualify is a
  // provider-specific call, so the adapter sets this and detectors just read it
  // — they never re-implement the gate. Absent on assistant messages.
  isGenuinePrompt?: boolean;
}

/**
 * Three-state traffic light derived from a conversation's cache/context
 * analysis. null = not computed (e.g. too short to classify, or no token data).
 */
export type CacheHealth = "healthy" | "warning" | "critical";

/**
 * Signals an adapter can supply, declared per *conversation* (not per provider —
 * different versions of one provider record different things). A detector runs
 * only where the signals it needs are present; otherwise the report says it was
 * skipped and why.
 */
export type Capability =
  | "tokenUsage" // per-message token counts at all
  | "cacheSplit" // cache-read / cache-write broken out from fresh input
  | "toolOutputSize" // size of tool results (charCount)
  | "compactionEvents" // explicit compaction/summary markers
  | "modelPerTurn"; // which model served each message

export interface ConversationSummary {
  projectId: string;
  sessionId: string;
  title: string;
  cwd: string;
  gitBranch?: string;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  // Genuine human prompts only (real input), vs. messageCount which counts every
  // line incl. assistant turns and tool-result-only "user" messages. See the
  // userPromptText gate in the parser.
  userPromptCount: number;
  primaryModel: string;
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  cacheHealth: CacheHealth | null;
  /** Signals this specific conversation actually carries. */
  capabilities: ReadonlySet<Capability>;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
}
