import { readFile } from "node:fs/promises";
import type {
  Capability,
  ContentBlock,
  Conversation,
  ConversationSummary,
  Message,
  Usage,
} from "../../core/model.js";
import type { TranscriptFile } from "./paths.js";
import { costForUsage } from "./pricing.js";

// Schema facts (Claude Code JSONL), all handled defensively so a moved or
// missing field skips a line rather than crashing the run:
//  - Lines are tagged by `type`. We care about "user" and "assistant"; other
//    types (queue-operation, file-history-snapshot, attachment, last-prompt,
//    ai-title) are metadata. We read the title from "ai-title".
//  - A single assistant response is split across MULTIPLE lines that share one
//    `message.id`, and every one of those lines REPEATS the same `usage`. So we
//    dedupe usage by message.id — otherwise token totals multiply (~2-3x here).
//  - tool_result blocks don't carry the tool name; we resolve it from the
//    earlier tool_use with the matching id.
//  - Anthropic splits cache writes by TTL (ephemeral_5m / ephemeral_1h) under
//    message.usage.cache_creation; older schemas only have a single
//    cache_creation_input_tokens, which we treat as unknown-TTL (bucketed 5m).

interface RawLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  aiTitle?: string;
  message?: any;
}

function mapUsage(raw: any): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const cc = raw.cache_creation ?? {};
  const has5m = typeof cc.ephemeral_5m_input_tokens === "number";
  const has1h = typeof cc.ephemeral_1h_input_tokens === "number";
  // No per-TTL split available: attribute the lump sum to the 5m bucket.
  const lump = !has5m && !has1h ? (raw.cache_creation_input_tokens ?? 0) : 0;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheReadTokens: raw.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens: (cc.ephemeral_5m_input_tokens ?? 0) + lump,
    cacheWrite1hTokens: cc.ephemeral_1h_input_tokens ?? 0,
  };
}

// A "genuine user prompt" is real human input — not a tool-result-only "user"
// line, and not Claude Code's synthetic wrappers (slash-command markers, local
// command stdout/stderr, injected system reminders). Mirrors the companion
// app's userPromptText gate: collect the text, strip those wrappers, and treat
// it as a prompt only if something remains. (Slash commands themselves DO count
// once unwrapped — matching the promptCount convention, not the stricter
// routing-span notion that also drops slash commands.)
function userPromptText(content: unknown): string | null {
  const parts: string[] = [];
  if (typeof content === "string") {
    if (content) parts.push(content);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  if (parts.length === 0) return null;

  let text = parts.join("\n");
  text = text.replace(/<command-name>([^<]*)<\/command-name>/g, "$1");
  text = text.replace(/<command-args>([\s\S]*?)<\/command-args>/g, (_, args: string) =>
    args.trim() ? ` ${args.trim()}` : "",
  );
  text = text
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, "")
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();

  return text || null;
}

function charCountOf(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce(
      (n, b) => n + (typeof b?.text === "string" ? b.text.length : 0),
      0,
    );
  }
  return 0;
}

/** Map a raw message's content array, recording tool names for result lookup. */
function mapBlocks(content: unknown, toolNames: Map<string, string>): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const b of content) {
    switch (b?.type) {
      case "text":
        blocks.push({ kind: "text", text: b.text ?? "" });
        break;
      case "thinking":
        blocks.push({ kind: "thinking", text: b.thinking ?? "" });
        break;
      case "tool_use":
        if (b.id && b.name) toolNames.set(b.id, b.name);
        blocks.push({ kind: "tool_use", toolUseId: b.id ?? "", name: b.name ?? "", input: b.input });
        break;
      case "tool_result":
        blocks.push({
          kind: "tool_result",
          toolUseId: b.tool_use_id ?? "",
          isError: !!b.is_error,
          charCount: charCountOf(b.content),
          toolName: b.tool_use_id ? toolNames.get(b.tool_use_id) : undefined,
        });
        break;
      // Unknown block kinds are skipped — tolerate schema drift.
    }
  }
  return blocks;
}

function* readLines(text: string): Generator<RawLine> {
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      yield JSON.parse(s) as RawLine;
    } catch {
      // Truncated/garbled line — skip it, never crash the parse.
    }
  }
}

interface Accumulator {
  title?: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  endedAt?: string;
  modelCounts: Map<string, number>;
  totals: Usage;
  totalCost: number; // summed per-message, each priced by its own model
  messageCount: number;
  userPromptCount: number; // genuine human prompts only (see userPromptText)
  seenUsageIds: Set<string>; // message.ids whose usage we've already counted
  caps: Set<Capability>;
}

function newAccumulator(): Accumulator {
  return {
    modelCounts: new Map(),
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    },
    totalCost: 0,
    messageCount: 0,
    userPromptCount: 0,
    seenUsageIds: new Set(),
    caps: new Set(),
  };
}

/** Fold one line's metadata/usage into the accumulator (shared by list + load). */
function accumulate(acc: Accumulator, raw: RawLine): void {
  if (raw.type === "ai-title" && raw.aiTitle) {
    acc.title = raw.aiTitle; // latest title wins
    return;
  }
  if (raw.type !== "user" && raw.type !== "assistant") return;

  if (raw.timestamp) {
    if (!acc.startedAt) acc.startedAt = raw.timestamp;
    acc.endedAt = raw.timestamp;
  }
  if (raw.cwd && !acc.cwd) acc.cwd = raw.cwd;
  if (raw.gitBranch && !acc.gitBranch) acc.gitBranch = raw.gitBranch;

  const msg = raw.message;
  if (raw.type === "user" && userPromptText(msg?.content) !== null) {
    acc.userPromptCount += 1;
  }
  if (raw.type === "assistant" && msg?.model) {
    acc.modelCounts.set(msg.model, (acc.modelCounts.get(msg.model) ?? 0) + 1);
    acc.caps.add("modelPerTurn");
  }

  // Usage lives on assistant lines and repeats per message.id — count once.
  const usage = mapUsage(msg?.usage);
  if (usage && raw.type === "assistant") {
    const id = msg?.id ?? raw.uuid;
    if (id && !acc.seenUsageIds.has(id)) {
      acc.seenUsageIds.add(id);
      acc.totals.inputTokens += usage.inputTokens;
      acc.totals.outputTokens += usage.outputTokens;
      acc.totals.cacheReadTokens += usage.cacheReadTokens;
      acc.totals.cacheWrite5mTokens += usage.cacheWrite5mTokens;
      acc.totals.cacheWrite1hTokens += usage.cacheWrite1hTokens;
      // Price this message at ITS model's rates and add to the running total —
      // never recomputed from aggregated tokens, since a session can mix models.
      acc.totalCost += costForUsage(msg?.model, usage);
      acc.caps.add("tokenUsage");
      if (usage.cacheReadTokens || usage.cacheWrite5mTokens || usage.cacheWrite1hTokens) {
        acc.caps.add("cacheSplit");
      }
    }
  }
}

function primaryModel(counts: Map<string, number>): string {
  let best = "";
  let n = -1;
  for (const [model, c] of counts) if (c > n) ((best = model), (n = c));
  return best;
}

function toSummary(file: TranscriptFile, acc: Accumulator): ConversationSummary {
  acc.caps.add("toolOutputSize"); // tool_result charCount is always derivable
  return {
    projectId: file.projectId,
    sessionId: file.sessionId,
    title: acc.title || acc.cwd || file.sessionId,
    cwd: acc.cwd ?? "",
    gitBranch: acc.gitBranch,
    startedAt: acc.startedAt ?? "",
    endedAt: acc.endedAt ?? "",
    messageCount: acc.messageCount,
    userPromptCount: acc.userPromptCount,
    primaryModel: primaryModel(acc.modelCounts),
    totalCost: acc.totalCost,
    totalInputTokens: acc.totals.inputTokens,
    totalOutputTokens: acc.totals.outputTokens,
    totalCacheReadTokens: acc.totals.cacheReadTokens,
    totalCacheWriteTokens: acc.totals.cacheWrite5mTokens + acc.totals.cacheWrite1hTokens,
    cacheHealth: null, // analysis fills this
    capabilities: acc.caps,
  };
}

/** Cheap pass for `conversations list`: totals + metadata, no block arrays kept. */
export async function summarizeTranscript(
  file: TranscriptFile,
): Promise<ConversationSummary | null> {
  let text: string;
  try {
    text = await readFile(file.path, "utf8");
  } catch {
    return null;
  }
  const acc = newAccumulator();
  let messages = 0;
  for (const raw of readLines(text)) {
    accumulate(acc, raw);
    if (raw.type === "user" || raw.type === "assistant") messages++;
  }
  acc.messageCount = messages;
  return toSummary(file, acc);
}

/** Full parse: collapses split assistant lines (shared message.id) into one Message. */
export async function loadTranscript(file: TranscriptFile): Promise<Conversation | null> {
  let text: string;
  try {
    text = await readFile(file.path, "utf8");
  } catch {
    return null;
  }

  const acc = newAccumulator();
  const toolNames = new Map<string, string>();
  const messages: Message[] = [];
  const byAssistantId = new Map<string, Message>();

  for (const raw of readLines(text)) {
    accumulate(acc, raw);
    if (raw.type !== "user" && raw.type !== "assistant") continue;
    const msg = raw.message;
    const blocks = mapBlocks(msg?.content, toolNames);

    if (raw.type === "assistant") {
      const id = msg?.id ?? raw.uuid ?? "";
      const existing = byAssistantId.get(id);
      if (existing) {
        existing.blocks.push(...blocks); // same response, another streamed line
        continue;
      }
      const message: Message = {
        uuid: raw.uuid ?? id,
        parentUuid: raw.parentUuid ?? null,
        role: "assistant",
        timestamp: raw.timestamp ?? "",
        model: msg?.model,
        blocks,
        usage: mapUsage(msg?.usage),
      };
      byAssistantId.set(id, message);
      messages.push(message);
    } else {
      messages.push({
        uuid: raw.uuid ?? "",
        parentUuid: raw.parentUuid ?? null,
        role: "user",
        timestamp: raw.timestamp ?? "",
        blocks,
        // Same gate that drives userPromptCount — mark genuine prompts so
        // detectors (e.g. the dumb-zone scan) can count them without re-deriving
        // which "user" lines are real human input vs. tool results / wrappers.
        isGenuinePrompt: userPromptText(msg?.content) !== null,
      });
    }
  }

  acc.messageCount = messages.length;
  return { ...toSummary(file, acc), messages };
}
