import fs from "node:fs";
import { Command } from "commander";
import { resolveAdapters } from "../core/registry.js";
import type { ConversationSummary, Conversation } from "../core/model.js";
import { formatUSD, pricingForModel, costForUsage } from "../adapters/claude/pricing.js";
import {
  computeCacheReport,
  cacheHealthFromReport,
  type CacheHealth,
  type PricingPort,
} from "../analyze/cache.js";
import {
  computeDumbZoneReport,
  DUMB_ZONE_TOKENS,
  DUMB_ZONE_MIN_PROMPTS,
  type DumbZoneReport,
} from "../analyze/dumbzone.js";

// The bloat analysis is provider-agnostic and takes pricing as a port. Today
// only Claude supplies rates; when a second adapter lands, resolve the port per
// conversation's provider instead of using Claude's unconditionally.
const claudePricing: PricingPort = { pricingForModel, costForUsage, formatUSD };

const DEFAULT_LIMIT = 100;

function bloatHealthLabel(health: CacheHealth | null): string {
  switch (health) {
    case null:
      return "n/a";
    case "good":
      return "No bloat";
    case "climbing":
      return "Climbing";
    case "poor":
      return "Heavy";
  }
}

// All conversation-facing commands hang off one `conversations` group so the
// noun stays consistent (`conversations list`, `conversations detail <id>`,
// `conversations report bloat`). Each handler is a placeholder for now — the
// real work (adapters -> normalised model -> detectors) lands behind these.

type GlobalOpts = { json?: boolean; verbose?: boolean };

// Global flags live on the root program; pull them off the top-most command so
// any subcommand can honour --json / --verbose.
function globalOpts(cmd: Command): GlobalOpts {
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return root.opts<GlobalOpts>();
}

// Render a conversation as LLM-ready markdown so the user can paste it into
// Claude.ai / ChatGPT and ask why the bloat happened and how to fix it.
function renderExport(convo: Conversation): string {
  const report = computeCacheReport(convo.messages, claudePricing);
  const health = cacheHealthFromReport(report);
  const dumbZone = computeDumbZoneReport(convo.messages);
  const lines: string[] = [];

  lines.push(`# Bloat Report Export — ${convo.title}`);
  lines.push("");
  lines.push(`**Session:** ${convo.sessionId}`);
  lines.push(`**Date:** ${convo.startedAt.slice(0, 10)}`);
  lines.push(`**Model:** ${convo.primaryModel}`);
  lines.push(`**Total cost:** ${formatUSD(convo.totalCost)}`);
  lines.push(`**Messages:** ${convo.messageCount} (${convo.userPromptCount} user prompts)`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## What Bloat Report found");
  lines.push("");
  if (dumbZone.inDumbZone) {
    const tokK = Math.round(DUMB_ZONE_TOKENS / 1000);
    lines.push(
      `**Dumb zone:** ${dumbZone.promptsInZone} prompt${dumbZone.promptsInZone === 1 ? "" : "s"} past ${tokK}k tokens (peak ${Math.round(dumbZone.peakContextTokens / 1000)}k)`,
    );
  } else {
    lines.push("**Dumb zone:** clear — context stayed under the line");
  }
  lines.push(
    `**Context bloat (secondary):** ${bloatHealthLabel(health)}` +
      (report.recoverableBloatCost > 0
        ? ` — ~${formatUSD(report.recoverableBloatCost)} recoverable`
        : ""),
  );
  lines.push(`**Cache hit ratio:** ${(report.cacheHitRatio * 100).toFixed(0)}%`);
  lines.push(`**Context ramp:** ${report.finalRampRatio.toFixed(1)}× baseline`);
  if (report.recommendations.length > 0) {
    lines.push("");
    lines.push("### Findings");
    for (const rec of report.recommendations) {
      lines.push(`- **[${rec.severity}] ${rec.title}:** ${rec.message}`);
    }
  }
  lines.push("");
  lines.push(
    "> Please review this conversation. Explain why each finding above occurred, " +
      "which specific exchanges caused it, and what the user could have done differently " +
      "to avoid the wasted cost.",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("## Conversation");
  lines.push("");

  for (const msg of convo.messages) {
    lines.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
    lines.push(`*${msg.timestamp.slice(0, 19).replace("T", " ")}*`);
    if (msg.usage) {
      lines.push(
        `*tokens: in ${msg.usage.inputTokens.toLocaleString()} · out ${msg.usage.outputTokens.toLocaleString()} · cache-read ${msg.usage.cacheReadTokens.toLocaleString()}*`,
      );
    }
    lines.push("");
    for (const block of msg.blocks) {
      if (block.kind === "text") {
        lines.push(block.text.trimEnd());
      } else if (block.kind === "thinking") {
        // Skip — internal monologue adds length without helping the reviewer.
      } else if (block.kind === "tool_use") {
        const inputSummary = JSON.stringify(block.input).slice(0, 120);
        lines.push(`*[Tool call: **${block.name}** — \`${inputSummary}\`]*`);
      } else if (block.kind === "tool_result") {
        const label = block.toolName ? `${block.toolName} result` : "Tool result";
        const size = block.charCount.toLocaleString();
        const errFlag = block.isError ? " (error)" : "";
        lines.push(`*[${label}${errFlag} — ${size} chars]*`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Every token class this machine recorded, for the at-a-glance list total.
function totalTokens(c: ConversationSummary): number {
  return (
    c.totalInputTokens +
    c.totalOutputTokens +
    c.totalCacheReadTokens +
    c.totalCacheWriteTokens
  );
}

export function addReportCommand(parent: Command): void {
  parent
    .command("report")
    .description("Find context-bloat patterns and the small change that fixes each")
    .option("-p, --provider <name>", "limit to one provider (e.g. claude, codex)")
    .option("-n, --limit <count>", "max conversations to scan", String(DEFAULT_LIMIT))
    .option("-a, --all", "show every scanned conversation, not just Climbing/Heavy ones")
    .action(async (opts, cmd) => {
      const g = globalOpts(cmd);
      const limit = Number.parseInt(opts.limit, 10) || 30;

      const adapters = resolveAdapters(opts.provider);
      if (opts.provider && adapters.length === 0) {
        console.error(`Unknown provider: ${opts.provider}`);
        process.exitCode = 1;
        return;
      }

      // List is cheap; sort recent-first and only fully parse the ones we report.
      const summaries: ConversationSummary[] = [];
      for (const adapter of adapters) {
        if (!(await adapter.isAvailable())) continue;
        summaries.push(...(await adapter.listConversations()));
      }
      summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

      const rows: {
        summary: ConversationSummary;
        report: ReturnType<typeof computeCacheReport>;
        health: CacheHealth | null;
        dumbZone: DumbZoneReport;
      }[] = [];
      for (const summary of summaries.slice(0, limit)) {
        // Only Claude has token-level usage today; skip a conversation with no
        // token signal rather than reporting a hollow zero (graceful degradation).
        if (!summary.capabilities.has("tokenUsage")) continue;
        // Single-provider for now; once summaries carry their source adapter,
        // load from that one instead of assuming the first available.
        const owner = adapters.find((a) => a.id === "claude") ?? adapters[0];
        if (!owner) continue;
        const convo = await owner.loadConversation(summary.sessionId);
        if (!convo) continue;
        const report = computeCacheReport(convo.messages, claudePricing);
        const dumbZone = computeDumbZoneReport(convo.messages);
        rows.push({ summary, report, health: cacheHealthFromReport(report), dumbZone });
      }

      if (g.json) {
        console.log(
          JSON.stringify(
            rows.map((r) => ({
              sessionId: r.summary.sessionId,
              title: r.summary.title,
              totalCost: r.report.totalCost,
              recoverableBloatCost: r.report.recoverableBloatCost,
              aboveBaselineContextCost: r.report.aboveBaselineContextCost,
              finalRampRatio: r.report.finalRampRatio,
              cacheHitRatio: r.report.cacheHitRatio,
              health: r.health,
              dumbZone: r.dumbZone,
              recommendations: r.report.recommendations,
            })),
            null,
            2,
          ),
        );
        return;
      }

      if (rows.length === 0) {
        console.log("No conversations with token data to analyse.");
        return;
      }

      const climbingOrWorse = rows.filter(
        (r) => r.health === "climbing" || r.health === "poor",
      ).length;
      const heavyBloat = rows.filter((r) => r.health === "poor").length;
      const totalRecoverable = rows.reduce((sum, r) => sum + r.report.recoverableBloatCost, 0);
      const scanned = rows.length;
      const climbingFraction = `${climbingOrWorse}/${scanned} climbing or worse`;
      const heavyFraction = heavyBloat > 0 ? `  ·  ${heavyBloat} heavy drift` : "";
      const recoverableStr =
        totalRecoverable > 0 ? `  ·  ${formatUSD(totalRecoverable)} recoverable` : "";

      // ── Dumb Zone ──────────────────────────────────────────────────────────
      // Past ~100k tokens of context, model quality tends to drop off. A single
      // prompt over the line is noise; staying there for 2+ prompts means the
      // session should have been cleared, compacted, or split. List who did.
      const tokK = `${Math.round(DUMB_ZONE_TOKENS / 1000)}k`;
      const inZone = rows
        .filter((r) => r.dumbZone.inDumbZone)
        .sort((a, b) => b.dumbZone.promptsInZone - a.dumbZone.promptsInZone);

      console.log(`\nDumb Zone — context past ${tokK} tokens, where the model gets noticeably worse.`);
      if (inZone.length === 0) {
        console.log(`No conversations lingered there. (Flagged at ${DUMB_ZONE_MIN_PROMPTS}+ prompts past ${tokK}.)`);
      } else {
        console.log(
          `${inZone.length}/${rows.length} conversation${inZone.length === 1 ? "" : "s"} kept going past ${tokK} tokens for ${DUMB_ZONE_MIN_PROMPTS}+ prompts:`,
        );
        for (const { summary, dumbZone } of inZone) {
          const date = summary.startedAt ? summary.startedAt.slice(0, 10) : "??????????";
          const id = summary.sessionId.slice(0, 8);
          const prompts = `${dumbZone.promptsInZone} prompt${dumbZone.promptsInZone === 1 ? "" : "s"} in zone`.padEnd(20);
          const peak = `peak ${Math.round(dumbZone.peakContextTokens / 1000)}k`.padEnd(11);
          console.log(`${id}  ${date}  ${prompts}${peak}${summary.title}`);
        }
        console.log("Fix: /clear or /compact at the task boundary, or start a fresh conversation, before context runs past the line.");
      }

      // ── Bloat table (secondary) ──────────────────────────────────────────────
      // Biggest recoverable bloat first — the opportunities worth reviewing.
      console.log("\nBloat (secondary) — recoverable cost from carrying stale context past an early-session baseline.");
      console.log(`Scanned ${scanned} conversations: ${climbingFraction}${heavyFraction}${recoverableStr}`);
      rows.sort((a, b) => b.report.recoverableBloatCost - a.report.recoverableBloatCost);
      // By default the table lists only the conversations worth acting on —
      // Climbing or Heavy. Pass --all to see every scanned conversation. The
      // summary line above still counts the full scan either way.
      const listed = opts.all
        ? rows
        : rows.filter((r) => r.health === "climbing" || r.health === "poor");
      let totalBloat = 0;
      for (const { summary, report, health, dumbZone } of listed) {
        totalBloat += report.recoverableBloatCost;
        const date = summary.startedAt ? summary.startedAt.slice(0, 10) : "??????????";
        const id = summary.sessionId.slice(0, 8);
        const cost = `cost ${formatUSD(report.totalCost)}`.padEnd(14);
        const bloat = `bloat ${formatUSD(report.recoverableBloatCost)}`.padEnd(15);
        const ramp = `ramp ${report.finalRampRatio.toFixed(1)}×`.padEnd(11);
        const hit = `hit ${(report.cacheHitRatio * 100).toFixed(0)}%`.padEnd(9);
        const dz = `dumb zone ${dumbZone.inDumbZone ? "yes" : "no"}`.padEnd(15);
        const healthLabel = bloatHealthLabel(health);
        console.log(
          `${id}  ${date}  ${healthLabel.padEnd(12)}${cost}${bloat}${ramp}${hit}${dz}${summary.title}`,
        );
        if (g.verbose) {
          for (const rec of report.recommendations) {
            console.log(`            [${rec.severity}] ${rec.title}`);
            console.log(`              ${rec.message}`);
          }
        }
      }
      if (listed.length === 0) {
        console.log("Nothing Climbing or Heavy — every scanned conversation looks healthy. (--all to list them.)");
      }
      console.log("\nTo dig deeper, export flagged conversations and upload to an LLM:");
      console.log("  conversations export                  (saves export-<date>.md)");
      console.log("  conversations export <id>             (one specific conversation)");
    });
}

export function registerConversations(program: Command): void {
  const conversations = program
    .command("conversations")
    // Accept the singular too, so `conversation detail <id>` also resolves.
    .alias("conversation")
    .description("Inspect locally-recorded agent conversations");

  conversations
    .command("list")
    .description("List discovered conversations (most recent first)")
    .option("-p, --provider <name>", "limit to one provider (e.g. claude, codex)")
    .option("-n, --limit <count>", "max conversations to show", String(DEFAULT_LIMIT))
    .action(async (opts, cmd) => {
      const g = globalOpts(cmd);
      const limit = Number.parseInt(opts.limit, 10) || 30;

      const adapters = resolveAdapters(opts.provider);
      if (opts.provider && adapters.length === 0) {
        console.error(`Unknown provider: ${opts.provider}`);
        process.exitCode = 1;
        return;
      }

      const rows: ConversationSummary[] = [];
      for (const adapter of adapters) {
        if (!(await adapter.isAvailable())) continue;
        rows.push(...(await adapter.listConversations()));
      }
      rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const shown = rows.slice(0, limit);

      if (g.json) {
        console.log(JSON.stringify(shown, (k, v) => (v instanceof Set ? [...v] : v), 2));
        return;
      }
      if (shown.length === 0) {
        console.log("No conversations found.");
        return;
      }
      for (const c of shown) {
        const date = c.startedAt ? c.startedAt.slice(0, 10) : "??????????";
        const tokens = totalTokens(c).toLocaleString();
        const cost = formatUSD(c.totalCost).padStart(9);
        console.log(
          `${date}  ${c.sessionId.slice(0, 8)}  ${tokens.padStart(9)} tok  ${cost}  ${c.title}`,
        );
      }
      // Grand total across the rows actually shown (directional estimate, not a bill).
      const grandTotal = shown.reduce((sum, c) => sum + c.totalCost, 0);
      console.log(
        `${" ".repeat(34)}${formatUSD(grandTotal).padStart(9)}  ${shown.length} conversation${shown.length === 1 ? "" : "s"} total`,
      );
      if (rows.length > shown.length) {
        console.log(`\n…and ${rows.length - shown.length} more (raise --limit to see them).`);
      }
    });

  conversations
    .command("detail")
    .description("Show one conversation in detail")
    .argument("[conversationId]", "id (or id prefix) of the conversation to inspect")
    .option("-p, --provider <name>", "provider to load from (e.g. claude, codex)")
    .action(async (conversationId: string | undefined, opts, cmd) => {
      const g = globalOpts(cmd);
      if (!conversationId) {
        console.error("Pass a conversation id — see `conversations list`.");
        process.exitCode = 1;
        return;
      }

      const adapters = resolveAdapters(opts.provider);
      let convo = null;
      for (const adapter of adapters) {
        if (!(await adapter.isAvailable())) continue;
        // Accept an id prefix for convenience; first exact-or-prefix match wins.
        const summaries = await adapter.listConversations();
        const match = summaries.find(
          (s) => s.sessionId === conversationId || s.sessionId.startsWith(conversationId),
        );
        if (match) {
          convo = await adapter.loadConversation(match.sessionId);
          break;
        }
      }

      if (!convo) {
        console.error(`No conversation matching "${conversationId}".`);
        process.exitCode = 1;
        return;
      }

      if (g.json) {
        console.log(JSON.stringify(convo, (k, v) => (v instanceof Set ? [...v] : v), 2));
        return;
      }

      console.log(convo.title);
      console.log(`  session   ${convo.sessionId}`);
      console.log(`  model     ${convo.primaryModel}`);
      console.log(`  cwd       ${convo.cwd}`);
      console.log(`  span      ${convo.startedAt.slice(0, 19)} → ${convo.endedAt.slice(0, 19)}`);
      console.log(`  messages  ${convo.messageCount} (${convo.userPromptCount} user prompts)`);
      console.log(
        `  tokens    in ${convo.totalInputTokens.toLocaleString()} · ` +
          `out ${convo.totalOutputTokens.toLocaleString()} · ` +
          `cache-read ${convo.totalCacheReadTokens.toLocaleString()} · ` +
          `cache-write ${convo.totalCacheWriteTokens.toLocaleString()}`,
      );
      console.log(`  signals   ${[...convo.capabilities].join(", ")}`);
      if (g.verbose) {
        console.log("");
        for (const m of convo.messages) {
          const kinds = m.blocks.map((b) => b.kind).join(",");
          console.log(`  ${m.timestamp.slice(11, 19)}  ${m.role.padEnd(9)}  ${kinds}`);
        }
      }
    });

  addReportCommand(conversations);

  conversations
    .command("export")
    .description(
      "Export conversations as markdown ready to paste into an LLM chatbot. " +
        "Pass id(s) for specific ones, or no ids to export everything the bloat report flags.",
    )
    .argument("[id...]", "session id(s) or prefixes (omit to export from the bloat report)")
    .option("-p, --provider <name>", "limit to one provider (e.g. claude, codex)")
    .option("-n, --limit <count>", "max conversations to scan (no-id mode)", String(DEFAULT_LIMIT))
    .option("-a, --all", "include healthy conversations too (no-id mode)")
    .option("-o, --output <file>", "custom filename (default: bloat-report-export-<date>.md)")
    .option("--print", "print to the terminal instead of saving a file")
    .action(async (ids: string[], opts) => {
      const adapters = resolveAdapters(opts.provider);
      if (opts.provider && adapters.length === 0) {
        console.error(`Unknown provider: ${opts.provider}`);
        process.exitCode = 1;
        return;
      }

      const owner = adapters.find((a) => a.id === "claude") ?? adapters[0];
      const exports: string[] = [];

      if (ids.length > 0) {
        // Specific ids — load each directly, same prefix matching as `detail`.
        const summaries: ConversationSummary[] = [];
        for (const adapter of adapters) {
          if (!(await adapter.isAvailable())) continue;
          summaries.push(...(await adapter.listConversations()));
        }
        for (const id of ids) {
          const match = summaries.find(
            (s) => s.sessionId === id || s.sessionId.startsWith(id),
          );
          if (!match) {
            console.error(`No conversation matching "${id}".`);
            process.exitCode = 1;
            continue;
          }
          const convo = await owner?.loadConversation(match.sessionId);
          if (!convo) {
            console.error(`Could not load conversation "${id}".`);
            process.exitCode = 1;
            continue;
          }
          exports.push(renderExport(convo));
        }
      } else {
        // No ids — run the bloat scan and export the same set the report shows.
        const limit = Number.parseInt(opts.limit, 10) || 30;
        const summaries: ConversationSummary[] = [];
        for (const adapter of adapters) {
          if (!(await adapter.isAvailable())) continue;
          summaries.push(...(await adapter.listConversations()));
        }
        summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

        const rows: { summary: ConversationSummary; health: CacheHealth | null }[] = [];
        for (const summary of summaries.slice(0, limit)) {
          if (!summary.capabilities.has("tokenUsage")) continue;
          const convo = await owner?.loadConversation(summary.sessionId);
          if (!convo) continue;
          const report = computeCacheReport(convo.messages, claudePricing);
          const health = cacheHealthFromReport(report);
          const inScope = opts.all || health === "climbing" || health === "poor";
          if (inScope) exports.push(renderExport(convo));
          rows.push({ summary, health });
        }

        const flagged = rows.filter((r) => r.health === "climbing" || r.health === "poor").length;
        const exported = exports.length;
        process.stderr.write(
          `Scanned ${rows.length} conversations, exporting ${exported}` +
            (opts.all ? "" : ` flagged (${flagged} climbing/heavy)`) +
            ".\n",
        );

        if (exported === 0) {
          process.stderr.write("Nothing to export — no climbing or heavy conversations found. (--all to export everything.)\n");
          return;
        }
      }

      if (exports.length === 0) return;

      const content = exports.join("\n\n---\n\n");
      if (opts.print) {
        process.stdout.write(content + "\n");
      } else {
        const date = new Date().toISOString().slice(0, 10);
        const filename = opts.output ?? `bloat-report-export-${date}.md`;
        fs.writeFileSync(filename, content, "utf8");
        process.stderr.write(`Saved to ${filename}\n`);
      }
    });
}
