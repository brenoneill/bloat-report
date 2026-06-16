#!/usr/bin/env node
import { Command } from "commander";
import { registerConversations, addReportCommand } from "./commands/conversations.js";
import { registerAdapters } from "./adapters/index.js";

registerAdapters();

const program = new Command();

program
  .name("bloat-report")
  .description(
    "Scan local coding-agent transcripts for wasteful token patterns — " +
      "small changes, big savings. Local-only, read-only.",
  )
  .version("1.0.0");

// Global flags shared by every command. Output stays tight by default;
// detail lives behind --verbose / --json (see CLAUDE.md: "Not wasteful itself").
program
  .option("--json", "emit machine-readable JSON instead of the plain-English report")
  .option("--verbose", "include per-finding detail");

registerConversations(program);
addReportCommand(program);

program.parseAsync(process.argv);
