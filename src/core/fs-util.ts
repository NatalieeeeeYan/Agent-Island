import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export type TranscriptFile = { path: string; mtimeMs: number };

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * List every `.jsonl` under `root`, newest first.
 *
 * Missing or unreadable entries are skipped rather than thrown: transcripts are
 * being written by other processes and can vanish between readdir and stat.
 */
export async function listJsonl(root: string): Promise<TranscriptFile[]> {
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return [];
  }

  const files: TranscriptFile[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const path = join(root, name);
        try {
          const info = await stat(path);
          if (info.isFile()) files.push({ path, mtimeMs: info.mtimeMs });
        } catch {
          // Vanished or unreadable — skip.
        }
      }),
  );

  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Bound how much of a scan we actually parse. Startup must not read every
 * transcript ever written — see the scan performance constraint in the spec.
 */
export function selectForScan(
  files: readonly TranscriptFile[],
  options: { since?: number; limit?: number } = {},
): TranscriptFile[] {
  let out = [...files];
  if (options.since !== undefined) {
    const since = options.since;
    out = out.filter((f) => f.mtimeMs >= since);
  }
  if (options.limit !== undefined) out = out.slice(0, options.limit);
  return out;
}
