import { registerAdapter } from "../core/registry.js";
import { ClaudeAdapter } from "./claude/index.js";

// Register every provider adapter once at startup. Codex slots in here next.
export function registerAdapters(): void {
  registerAdapter(new ClaudeAdapter());
}
