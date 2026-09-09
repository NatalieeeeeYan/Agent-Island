import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isRecord } from './parsers/util.js';
import type { ToolId } from './types.js';

/**
 * Marker written onto every hook group we own.
 *
 * Both hook files on a typical machine already contain entries from other
 * tools (litmus, armorCodex). Installation therefore merges into the existing
 * arrays and never rewrites them, and uninstall removes only groups carrying
 * this marker. Overwriting either file wholesale would break the user's other
 * tooling — see the hook-conflict risk in the spec.
 */
export const ISLAND_MARKER = '_island';

/** Claude Code fires all of these; each maps to a status in `island.ts`. */
export const CLAUDE_CODE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const;

/**
 * Only events observed in a real `~/.codex/hooks.json`. Codex's `notify` slot
 * is deliberately untouched: it holds a single command, already taken by Codex
 * Computer Use, and appending is not possible.
 */
export const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
] as const;

export type HookTarget = {
  tool: ToolId;
  /** Settings file to merge into. */
  path: string;
  events: readonly string[];
};

export function defaultTargets(home = homedir()): HookTarget[] {
  return [
    {
      tool: 'claude-code',
      path: join(home, '.claude', 'settings.json'),
      events: CLAUDE_CODE_EVENTS,
    },
    { tool: 'codex', path: join(home, '.codex', 'hooks.json'), events: CODEX_EVENTS },
  ];
}

export type InstallResult = {
  path: string;
  added: string[];
  updated: string[];
  unchanged: string[];
};

/**
 * Merge Island's hook entries into a settings file, in place.
 *
 * Idempotent: re-running with the same script path is a no-op. Changing the
 * script path rewrites our own groups and leaves everything else alone.
 */
export function mergeHooks(
  settings: unknown,
  options: { tool: ToolId; events: readonly string[]; command: string },
): { settings: Record<string, unknown>; added: string[]; updated: string[]; unchanged: string[] } {
  const root: Record<string, unknown> = isRecord(settings) ? { ...settings } : {};
  const hooks: Record<string, unknown> = isRecord(root['hooks']) ? { ...root['hooks'] } : {};

  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const event of options.events) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const index = groups.findIndex((g) => isRecord(g) && g[ISLAND_MARKER] === 1);
    const group = islandGroup(options.tool, event, options.command);

    if (index === -1) {
      groups.push(group);
      added.push(event);
    } else if (JSON.stringify(groups[index]) === JSON.stringify(group)) {
      unchanged.push(event);
      continue;
    } else {
      groups[index] = group;
      updated.push(event);
    }
    hooks[event] = groups;
  }

  root['hooks'] = hooks;
  return { settings: root, added, updated, unchanged };
}

/** Strip every group carrying our marker, leaving other tools' entries intact. */
export function removeHooks(settings: unknown): {
  settings: Record<string, unknown>;
  removed: string[];
} {
  const root: Record<string, unknown> = isRecord(settings) ? { ...settings } : {};
  if (!isRecord(root['hooks'])) return { settings: root, removed: [] };

  const hooks: Record<string, unknown> = { ...root['hooks'] };
  const removed: string[] = [];

  for (const [event, value] of Object.entries(hooks)) {
    if (!Array.isArray(value)) continue;
    const kept = value.filter((g) => !(isRecord(g) && g[ISLAND_MARKER] === 1));
    if (kept.length === value.length) continue;
    removed.push(event);
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  root['hooks'] = hooks;
  return { settings: root, removed };
}

function islandGroup(tool: ToolId, event: string, command: string): Record<string, unknown> {
  return {
    matcher: '',
    [ISLAND_MARKER]: 1,
    hooks: [
      {
        type: 'command',
        command: `${command} ${tool} ${event}`,
        // Generous relative to the script's own 2s budget; it should never
        // reach this, and the agent must not be held up if it does.
        timeout: 5,
      },
    ],
  };
}

export async function installHooks(
  target: HookTarget,
  scriptCommand: string,
): Promise<InstallResult> {
  const existing = await readJsonFile(target.path);
  const result = mergeHooks(existing, {
    tool: target.tool,
    events: target.events,
    command: scriptCommand,
  });

  if (result.added.length > 0 || result.updated.length > 0) {
    await backup(target.path);
    await writeJsonFile(target.path, result.settings);
  }

  return {
    path: target.path,
    added: result.added,
    updated: result.updated,
    unchanged: result.unchanged,
  };
}

export async function uninstallHooks(target: HookTarget): Promise<{ path: string; removed: string[] }> {
  const existing = await readJsonFile(target.path);
  if (existing === null) return { path: target.path, removed: [] };

  const result = removeHooks(existing);
  if (result.removed.length > 0) {
    await backup(target.path);
    await writeJsonFile(target.path, result.settings);
  }
  return { path: target.path, removed: result.removed };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    // Missing file is fine; a corrupt one is not ours to repair, and starting
    // from `null` here would silently discard it — so callers back up first.
    return null;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function backup(path: string): Promise<void> {
  try {
    await copyFile(path, `${path}.island-backup`);
  } catch {
    // No existing file to back up.
  }
}
