
# Bloat Report

A local CLI that scans coding-agent session transcripts and produces a plain-English report
on wasteful token patterns — each one paired with the small change that fixes it.

The pitch is **"small changes, big savings."** Provider-agnostic by design: **Claude Code is the
first adapter, Codex is next.** New providers plug in behind a shared interface.

## Architecture: providers behind one model

- **Adapters normalise; detectors don't know about providers.** Each provider has an adapter that
  reads its local transcripts and emits a shared internal model (sessions -> turns -> events,
  tool calls, token accounting). Detectors run only on that normalised model.
- **Capability detection, graceful degradation.** Providers — and even versions of one provider —
  record different things. An adapter declares which signals it supplies (token usage, cache split,
  tool-output sizes, compaction events, model-per-turn). A detector runs only where its required
  signals exist, and the report says plainly when one was skipped and why
  (e.g. "no token data: this Codex session predates token logging").
- **Recommendations come from the adapter.** The *pattern* is shared (uncompacted session, noisy
  output, re-reading unchanged files); the *exact fix/command* is provider-specific, so the adapter
  supplies the wording. Never hard-code one provider's commands into shared code.

## Non-negotiables

- **Local-only, read-only. Nothing leaves the machine.** No network, no telemetry, no uploads.
  Open transcripts read-only. Privacy is the product. If a dependency phones home, drop it.
- **No AI in the detection path.** Deterministic parsing, counting, sizing. (The *user* may export
  a flagged conversation to an LLM to learn more — their choice, outside the tool.)
- **Estimates, not a bill.** Local logs estimate what this machine recorded; they are not official
  provider billing and can diverge from it. Report savings as directional estimates only.
- **Never overstate savings.** Price each token class at its own rate (cached reads are far cheaper
  than fresh input). Don't count one token under two detectors. A session's measured total is the
  ceiling — exceed it and the model is wrong.
- **Tolerate schema drift.** Transcript formats change across versions (Codex alone has several in
  the wild). Parse defensively, skip unknown entries, never crash on a moved field.

## The report (what we optimise for)

- **Plain English.** Short sentences. Finding -> fix -> saving. Never a raw token count without a
  percentage or dollar figure the reader feels.
- **Every finding paired with the small change** the relevant adapter supplies — what it is, roughly
  what it cost, the concrete one-step fix (e.g. `/compact` at task boundaries; quiet flags or `head`
  on noisy commands; read once, don't re-read unchanged files; ranged reads on big files; disconnect
  MCP servers a session never calls; diffs over full-file rewrites).
- **A path to learn more, not a verdict.** For the biggest opportunities, suggest exporting that
  conversation to discuss with an LLM. Findings are candidates worth reviewing, not accusations.
- **Not wasteful itself.** A token-waste tool must not emit a bloated report. Tight summary by
  default; detail behind `--verbose` / `--json`.

## How to work on this codebase (dogfooding)

We're building an efficiency tool; the work should model efficiency.
- Don't re-read files already in context or unchanged since the last read.
- Read the slice you need (ranges), not whole large files.
- Targeted diffs, not full-file rewrites. On a failed edit, re-read the few relevant lines and retry
  a narrow edit — don't rewrite the file.
- Terse responses: no preamble/postamble, don't restate code, summarise what changed and why.
- Prefer quiet command flags; don't dump large output into context.
- Keep provider-specific logic — and the schema facts that explain it — as comments at the adapter
  functions; keep shared code provider-agnostic.

## Stack & commands

Scanner runs in the terminal with direct filesystem access (browser stacks can't reach
`~/.claude` / `~/.codex`).

- Runtime: **Node + TypeScript.** Bundle with esbuild / tsup.
- CLI framework: **Commander.js** for command/flag parsing (e.g. `--verbose`, `--json`).
