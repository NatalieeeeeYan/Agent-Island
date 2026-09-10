/**
 * Claude Desktop's per-session metadata sidecars.
 *
 * Sessions started from the desktop app run the same Claude Code engine and
 * write the same transcripts under `~/.claude/projects`, so the existing
 * adapter already sees them — but they never emit an `ai-title` row. The title
 * lives here instead, keyed by `cliSessionId`, which is the transcript's own
 * session id.
 *
 * ```
 * ~/Library/Application Support/Claude/claude-code-sessions/<org>/<user>/local_<uuid>.json
 * ```
 *
 * Cowork (`local-agent-mode-sessions`) is a separate adapter in M3 and is not
 * read here.
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { num, obj, str } from './parsers/util.js';

export type SidecarEntry = {
  /** Id of the `~/.claude/projects` transcript this describes. */
  cliSessionId: string;
  title: string | null;
  lastActivityAt: number | null;
};

export function defaultSidecarRoot(): string {
  return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

export function parseSidecar(raw: unknown): SidecarEntry | null {
  const d = obj(raw);
  if (!d) return null;
  const cliSessionId = str(d['cliSessionId']);
  if (!cliSessionId) return null;
  return {
    cliSessionId,
    title: str(d['title']),
    lastActivityAt: num(d['lastActivityAt']),
  };
}

/**
 * Read every sidecar under `root`, keyed by `cliSessionId`.
 *
 * The directory also holds unrelated files (`scheduled-tasks.json`, tombstones)
 * — anything without a `cliSessionId` is skipped rather than treated as an
 * error.
 */
export async function loadSidecars(root: string): Promise<Map<string, SidecarEntry>> {
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return new Map();
  }

  const out = new Map<string, SidecarEntry>();
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        try {
          const entry = parseSidecar(JSON.parse(await readFile(join(root, name), 'utf8')));
          if (entry) out.set(entry.cliSessionId, entry);
        } catch {
          // Written by the desktop app while we read — skip torn or missing files.
        }
      }),
  );
  return out;
}
