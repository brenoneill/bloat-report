import type { ProviderAdapter, BloatPattern, Recommendation } from "../../core/adapter.js";
import type { Conversation, ConversationSummary } from "../../core/model.js";
import { hasProjects, listTranscriptFiles } from "./paths.js";
import { summarizeTranscript, loadTranscript } from "./parse.js";

// Claude Code adapter. Recommendations are worded for Claude Code specifically
// (slash commands, its flags) — shared code never hard-codes these.
const RECOMMENDATIONS: Record<BloatPattern, Recommendation> = {
  uncompactedSession: {
    fix: "Run /compact at task boundaries to summarise and shrink the running context.",
    command: "/compact",
  },
  noisyToolOutput: {
    fix: "Pipe noisy commands through a quiet flag or `head` so only the useful slice enters context.",
  },
  rereadUnchangedFile: {
    fix: "Read a file once; don't re-read it while it's unchanged in context.",
  },
  fullFileRead: {
    fix: "Use a ranged read on large files instead of pulling the whole thing.",
  },
  idleMcpServer: {
    fix: "Disconnect MCP servers a session never calls so their tool definitions stop costing tokens.",
    command: "/mcp",
  },
};

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude";
  readonly displayName = "Claude Code";

  isAvailable(): Promise<boolean> {
    return hasProjects();
  }

  async listConversations(): Promise<ConversationSummary[]> {
    const files = await listTranscriptFiles();
    const summaries = await Promise.all(files.map(summarizeTranscript));
    return summaries
      .filter((s): s is ConversationSummary => s !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)); // most recent first
  }

  async loadConversation(sessionId: string): Promise<Conversation | null> {
    const files = await listTranscriptFiles();
    const file = files.find((f) => f.sessionId === sessionId);
    return file ? loadTranscript(file) : null;
  }

  recommend(pattern: BloatPattern): Recommendation {
    return RECOMMENDATIONS[pattern];
  }
}
