import { describe, expect, it } from 'vitest';

import { ISLAND_MARKER, mergeHooks, removeHooks } from '../src/core/hook-install.js';

const COMMAND = 'node "/x/island-hook.mjs"';

/** Shaped like the entries actually found in the user's settings files. */
function foreignSettings() {
  return {
    permissions: { allow: ['Bash(npx tsc *)'] },
    model: 'opus',
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [{ type: 'command', command: 'node /x/armorcodex/bootstrap.mjs router' }],
        },
        {
          matcher: '',
          _litmus: 1,
          hooks: [{ type: 'command', command: "node '/x/.litmus/hook-logger.cjs' claude", timeout: 30 }],
        },
      ],
      Stop: [
        {
          matcher: '',
          _litmus: 1,
          hooks: [{ type: 'command', command: "node '/x/.litmus/hook-logger.cjs' claude" }],
        },
      ],
    },
  };
}

function merge(settings: unknown, events: readonly string[] = ['UserPromptSubmit', 'Stop']) {
  return mergeHooks(settings, { tool: 'claude-code', events, command: COMMAND });
}

describe('mergeHooks', () => {
  it('appends to existing event arrays without disturbing other tools', () => {
    const before = foreignSettings();
    const { settings, added } = merge(before);

    const hooks = settings['hooks'] as Record<string, unknown[]>;
    expect(added).toEqual(['UserPromptSubmit', 'Stop']);
    expect(hooks['UserPromptSubmit']).toHaveLength(3);
    expect(hooks['Stop']).toHaveLength(2);

    // The pre-existing entries survive untouched, in their original order.
    expect(hooks['UserPromptSubmit']?.slice(0, 2)).toEqual(
      before.hooks.UserPromptSubmit,
    );
    expect(hooks['Stop']?.[0]).toEqual(before.hooks.Stop[0]);
  });

  it('preserves unrelated top-level settings', () => {
    const { settings } = merge(foreignSettings());

    expect(settings['model']).toBe('opus');
    expect(settings['permissions']).toEqual({ allow: ['Bash(npx tsc *)'] });
  });

  it('is idempotent — a second run changes nothing', () => {
    const first = merge(foreignSettings());
    const second = merge(first.settings);

    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged).toEqual(['UserPromptSubmit', 'Stop']);
    expect(second.settings).toEqual(first.settings);
  });

  it('replaces its own group when the command changes, without duplicating', () => {
    const first = merge(foreignSettings());
    const second = mergeHooks(first.settings, {
      tool: 'claude-code',
      events: ['Stop'],
      command: 'node "/new/path/island-hook.mjs"',
    });

    const stop = (second.settings['hooks'] as Record<string, unknown[]>)['Stop']!;
    expect(second.updated).toEqual(['Stop']);
    expect(stop).toHaveLength(2);
    expect(stop.filter((g) => (g as Record<string, unknown>)[ISLAND_MARKER] === 1)).toHaveLength(1);
  });

  it('passes the tool and event name to the hook script', () => {
    const { settings } = merge(foreignSettings(), ['PreToolUse']);
    const group = (settings['hooks'] as Record<string, unknown[]>)['PreToolUse']![0] as {
      hooks: { command: string }[];
    };

    expect(group.hooks[0]?.command).toBe(`${COMMAND} claude-code PreToolUse`);
  });

  it('builds a fresh structure when the settings file is absent or unusable', () => {
    for (const input of [null, undefined, 'garbage', 42]) {
      const { settings, added } = merge(input);
      expect(added).toEqual(['UserPromptSubmit', 'Stop']);
      expect(Object.keys(settings['hooks'] as object)).toEqual(['UserPromptSubmit', 'Stop']);
    }
  });
});

describe('removeHooks', () => {
  it('removes only marked groups and leaves other tools intact', () => {
    const before = foreignSettings();
    const installed = merge(before);
    const { settings, removed } = removeHooks(installed.settings);

    expect(removed.sort()).toEqual(['Stop', 'UserPromptSubmit']);
    expect(settings['hooks']).toEqual(before.hooks);
  });

  it('drops an event key that held nothing but our group', () => {
    const installed = merge({}, ['Notification']);
    const { settings } = removeHooks(installed.settings);

    expect(settings['hooks']).toEqual({});
  });

  it('is a no-op on settings that were never installed into', () => {
    const before = foreignSettings();
    const { settings, removed } = removeHooks(structuredClone(before));

    expect(removed).toEqual([]);
    expect(settings['hooks']).toEqual(before.hooks);
  });
});
