/**
 * Install or remove Agent Island's hooks.
 *
 *   npm run hooks:install     merge Island's entries into the tools' settings
 *   npm run hooks:uninstall   remove only Island's entries
 *   npm run hooks -- --dry    show what would change
 *
 * Both settings files usually already contain other tools' hooks, so this only
 * ever merges and never rewrites a file wholesale.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  defaultTargets,
  installHooks,
  mergeHooks,
  uninstallHooks,
  type HookTarget,
} from '../core/hook-install.js';

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, '..', '..', 'hooks', 'island-hook.mjs');
const command = `node ${JSON.stringify(scriptPath)}`;

const mode = process.argv[2] ?? 'install';
const targets = defaultTargets();

if (mode === 'uninstall') {
  for (const target of targets) {
    const { path, removed } = await uninstallHooks(target);
    report(target, path, removed.length > 0 ? `removed ${removed.join(', ')}` : 'nothing to remove');
  }
} else if (mode === 'dry') {
  for (const target of targets) {
    const existing = await readJson(target.path);
    const { added, updated, unchanged } = mergeHooks(existing, {
      tool: target.tool,
      events: target.events,
      command,
    });
    report(
      target,
      target.path,
      `would add ${added.length}, update ${updated.length}, leave ${unchanged.length} unchanged`,
    );
  }
} else {
  for (const target of targets) {
    const result = await installHooks(target, command);
    report(
      target,
      result.path,
      `added ${result.added.length}, updated ${result.updated.length}, unchanged ${result.unchanged.length}`,
    );
  }
  console.log(`\nhook script: ${scriptPath}`);
  console.log('Restart any running sessions for the hooks to take effect.');
}

function report(target: HookTarget, path: string, summary: string): void {
  console.log(`${target.tool.padEnd(12)} ${summary}`);
  console.log(`${''.padEnd(12)} ${path}`);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
