import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, access } from "node:fs/promises";

// Claude Code stores transcripts as JSONL under ~/.claude/projects/<encoded-cwd>/
// <sessionId>.jsonl. CLAUDE_CONFIG_DIR overrides the root (honour it read-only).
// The folder name is the project cwd with path separators flattened to dashes;
// it's lossy, so we read the real cwd from inside the transcript, not from here.

export function claudeRoot(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

export function projectsDir(): string {
  return join(claudeRoot(), "projects");
}

export async function hasProjects(): Promise<boolean> {
  try {
    await access(projectsDir());
    return true;
  } catch {
    return false;
  }
}

export interface TranscriptFile {
  projectId: string; // the encoded project folder name
  sessionId: string; // jsonl basename without extension
  path: string;
}

/** Every *.jsonl transcript across every project folder. Skips unreadable dirs. */
export async function listTranscriptFiles(): Promise<TranscriptFile[]> {
  const root = projectsDir();
  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return [];
  }

  const files: TranscriptFile[] = [];
  for (const projectId of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(root, projectId));
    } catch {
      continue; // not a dir / unreadable — tolerate and move on
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      files.push({
        projectId,
        sessionId: entry.slice(0, -".jsonl".length),
        path: join(root, projectId, entry),
      });
    }
  }
  return files;
}
