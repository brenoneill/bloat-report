# Bloat Report

Your coding agent gets dumber the longer a session runs. Bloat Report is a local, read-only CLI that scans your agent's session transcripts, finds where each one crossed the line, and pairs every finding with the small change that fixes it.

```bash
npx bloat-report conversations report bloat
```

## The dumb zone

Past roughly **100k tokens** of context, models get noticeably worse — reasoning slips, instructions get dropped, the agent forgets what you told it ten turns ago. That's the **dumb zone**, and once a session is in it, every new prompt is answered by a worse version of the model.

> **On the name and the idea.** The "dumb zone" was coined by **Dex Horthy**, who put the degradation point at ~40% of the context window. [**Matt Pocock** furthered it](https://finance.biggo.com/news/e7209c094224b09c), pinning the line at ~100k tokens — the figure Bloat Report uses directly.

Catching this is the tool's main job: it flags the sessions that overstayed — where **2+ genuine prompts** were sent into a context already past 100k tokens. One prompt over the line is noise; staying there means the session should have been cleared, compacted, or split before it got dumb. The fix is a `/clear` or `/compact` at the task boundary, or a fresh conversation.

## Context bloat — the same growth, seen from the cost side

The dumb zone is a **quality** problem. Context bloat is the **cost** problem hiding underneath it — the same growing context, measured in dollars instead of degraded reasoning. The two are related but distinct: a session can be expensive long before it's dumb, and watching the cost is how you catch the drift early.

Here's the mechanism. Every assistant turn re-reads the whole conversation so far, so when a session wanders across unrelated tasks you pay full freight, turn after turn, to carry context you no longer need. Bloat Report prices each token class at its own rate and surfaces the *recoverable* slice — the re-read cost a `/clear` or `/compact` would have saved — so you can see the financial impact of bloat and adopt a few simple habits that keep sessions lean. That's the **"small changes, big savings"** pitch: small, boring practices (clear at task boundaries, quiet flags on noisy commands, ranged reads, drop unused MCP servers) that compound into real savings.

> **Estimates, not a bill.** These numbers come from what your machine recorded locally. They are directional estimates, not official provider billing, and can diverge from it.

This bloat analysis builds on **[Tokenoptics](https://tokenoptics.dev)** — the same vocabulary and thresholds as the companion app, brought to the terminal where it can read the transcripts on your disk directly. For a richer look at the financial side — trends over time, breakdowns, and visualisations — head to **[tokenoptics.dev](https://tokenoptics.dev)**.

## Principles

These are non-negotiable (see [CLAUDE.md](CLAUDE.md) for the full set):

- **Local-only, read-only. Nothing leaves your machine.** No network, no telemetry, no uploads. Transcripts are opened read-only. Privacy is the product.
- **No AI in the detection path.** Everything is deterministic parsing, counting, and sizing. (You *may* choose to export a flagged conversation to an LLM to learn more — that's your call, outside the tool.)
- **Never overstate savings.** Each token class is priced at its own rate (cached reads are far cheaper than fresh input). No token is counted under two findings. A session's measured total is the ceiling.
- **Provider-agnostic by design.** Adapters normalise each provider's transcripts into one shared model; detectors never know which provider produced the data. **Claude Code is the first adapter; Codex is next.**

## Install

Requires **Node.js 18+**.

```bash
npm install -g bloat-report
```

Or run without installing:

```bash
npx bloat-report conversations list
```

## Example output

```
$ bloat-report conversations report bloat

Dumb Zone — context past 100k tokens, where the model gets noticeably worse.
3/14 conversations kept going past 100k tokens for 2+ prompts:
a1b2c3d4  5 prompts in zone   peak 187k   Refactor auth middleware to use JWT
e5f6a7b8  3 prompts in zone   peak 142k   Add dark mode support to dashboard
c9d0e1f2  2 prompts in zone   peak 108k   Debug intermittent test failures in CI
Fix: /clear or /compact at the task boundary, or start a fresh conversation, before context runs past the line.

Bloat (secondary) — recoverable cost from carrying stale context past an early-session baseline.
Scanned 14 conversations: 4/14 climbing or worse  ·  1 heavy drift  ·  $0.43 recoverable
a1b2c3d4  Heavy       cost $0.31    bloat $0.21   ramp 8.4×  hit 91%  dumb zone yes   Refactor auth middleware to use JWT
e5f6a7b8  Climbing    cost $0.18    bloat $0.12   ramp 4.1×  hit 87%  dumb zone yes   Add dark mode support to dashboard
c9d0e1f2  Climbing    cost $0.14    bloat $0.07   ramp 3.8×  hit 84%  dumb zone yes   Debug intermittent test failures in CI
f3a4b5c6  Climbing    cost $0.09    bloat $0.03   ramp 3.2×  hit 79%  dumb zone no    Update README and contributing guide

To dig deeper, export flagged conversations and upload to an LLM:
  conversations export                  (saves export-<date>.md)
  conversations export <id>             (one specific conversation)
```

## Where it reads from

The Claude Code adapter reads transcripts from `~/.claude/projects/<project>/<session>.jsonl`. Set `CLAUDE_CONFIG_DIR` to point at a different root (still read-only). If no transcripts are found, the adapter simply reports nothing to scan.

## Commands

All commands hang off the `conversations` group (the singular `conversation` also works).

Global flags (work on any command):

- `--json` — machine-readable JSON instead of the plain-English report
- `--verbose` — include per-finding detail

### `conversations list`

List discovered conversations, most recent first, with token totals and estimated cost.

```bash
bloat-report conversations list
bloat-report conversations list -n 50            # show more
bloat-report conversations list -p claude        # one provider
```

- `-n, --limit <count>` — max conversations to show (default 30)
- `-p, --provider <name>` — limit to one provider (e.g. `claude`)

### `conversations detail <id>`

Show one conversation in detail — model, cwd, time span, token breakdown, and the signals that conversation carries. Accepts an id prefix.

```bash
bloat-report conversations detail a1b2c3d4
bloat-report conversations detail a1b2c3d4 --verbose   # per-message timeline
```

### `conversations report bloat`

The main event. Scans recent conversations and leads with the **Dumb Zone** roundup — who kept working past the ~100k line — then, as secondary detail, a **bloat table** of recoverable cost, biggest opportunity first.

```bash
bloat-report conversations report bloat
bloat-report conversations report bloat -a          # show every scanned convo, not just flagged
bloat-report conversations report bloat --verbose   # per-finding detail
bloat-report conversations report bloat --json      # structured output
```

- `-n, --limit <count>` — max conversations to scan (default 30)
- `-p, --provider <name>` — limit to one provider
- `-a, --all` — list every scanned conversation, not just the Climbing/Heavy ones

Conversations with no token data are skipped rather than reported as a hollow zero — the report tells you when and why a detector couldn't run (graceful degradation).

### `conversations export [id...]`

Export conversations as markdown ready to paste into an LLM chatbot (Claude.ai, ChatGPT, …) so you can ask *why* the bloat happened and how to avoid it next time. The export bundles Bloat Report's findings at the top, then the conversation with tool calls and result sizes summarised (thinking blocks and raw tool output are stripped to keep it lean).

```bash
bloat-report conversations export                   # exports what the bloat report flags
bloat-report conversations export a1b2c3d4 e5f6     # specific conversations
bloat-report conversations export --all             # include healthy ones too
bloat-report conversations export --print           # to terminal instead of a file
bloat-report conversations export -o my-export.md   # custom filename
```

With no ids, it exports exactly the set the bloat report flags (Climbing/Heavy). By default it saves to `bloat-report-export-<date>.md`.

## What it measures

### The Dumb Zone (primary)

The main detector. It flags conversations that kept going past the ~100k line — specifically, sessions where **2+ genuine prompts** were sent into a context of 100k+ tokens — and tells you where a `/clear`, `/compact`, or fresh conversation at the task boundary would have kept the session sharp. (See [The dumb zone](#the-dumb-zone) above for the concept and its origins.)

### Context bloat (secondary)

Alongside the Dumb Zone, the report surfaces *recoverable cost*. Bloat is **not** "total cost is high." It's the *recoverable* slice — the cache-read cost **above an early-session baseline** — and it's only counted when a drift signal fires (evidence the session wandered across topics and a `/clear` or `/compact` would have saved money). The report classifies each conversation:

| Health        | Meaning                                                              |
| ------------- | ------------------------------------------------------------------- |
| **No bloat**  | Cost per turn is steady; context is being used, not wasted.         |
| **Climbing**  | Late turns cost ~3×+ the early baseline — drift is starting.        |
| **Heavy**     | Late turns cost ~6×+ the baseline, or a long session with a low cache hit ratio. |

Each finding comes with the small change that fixes it — e.g. `/compact` at a task boundary, splitting a session that's drifted into a new topic, quiet flags on noisy commands, ranged reads on big files, or disconnecting MCP servers a session never calls.

> **Where this comes from.** The bloat analysis — the early-session baseline, the ramp ratios, and the Climbing/Heavy thresholds — is shared with **[Tokenoptics](https://tokenoptics.dev)**, the companion app this CLI builds on. For trends over time and richer breakdowns of the same numbers, see [tokenoptics.dev](https://tokenoptics.dev).

## How pricing works

Each message is priced at **its own model's rate** (a session can mix models) and summed — never recomputed from aggregated token totals. Cached reads, fresh input, output, and the two cache-write TTLs (5-minute and 1-hour) are each priced separately. Unknown model ids fall back to a sane mid rate rather than crashing, and an unrecognised newer minor version is priced at its newest known sibling rather than collapsing onto a pricier legacy entry.

## Architecture

```
adapters/      provider-specific: read transcripts, normalise to the shared model,
               supply the exact fix wording (Claude today, Codex next)
core/          the shared model (sessions → messages → blocks, token usage),
               adapter interface, and the provider registry
analyze/       provider-agnostic detectors: cache/bloat analysis, dumb zone
commands/      the Commander.js CLI surface
```

The design rule: **adapters normalise, detectors stay provider-agnostic.** Each adapter declares which signals it supplies (token usage, cache split, tool-output sizes, …); a detector runs only where its required signals exist. Provider-specific fixes (slash commands, flags) come from the adapter, never hard-coded into shared code. New providers plug in behind the shared interface without touching detectors or commands.

## Development

```bash
git clone <this-repo>
cd bloat-report
npm install

npm run dev -- conversations list   # run from source (tsx)
npm run build                       # bundle to dist/cli.js
npm run typecheck                   # tsc --noEmit
npm test                            # run analysis tests
```

To publish a new version:

```bash
npm version patch   # or minor / major
npm publish
```

## License

MIT
