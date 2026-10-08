import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createIsland } from '../src/core/island.js';
import { MemoryStore } from '../src/core/store.js';
import type { AgentAdapter, Session } from '../src/core/types.js';
import { runCommand, type ReplContext } from '../src/cli/repl.js';

/**
 * A port per test. `fetch` pools keep-alive sockets by origin, so reusing one
 * port would hand a later test a connection to the previous test's closed
 * server.
 */
let nextPort = 7931;

function session(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    tool: 'claude-code',
    title: 'a title',
    cwd: '/Users/me/proj',
    status: 'running',
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Declares itself present but finds nothing — the store is seeded directly. */
function stubAdapter(id: string): AgentAdapter {
  return {
    id,
    displayName: id,
    capabilities: { transcript: true, liveEvents: true, usage: true, approval: true },
    detect: async () => true,
    scan: async () => [],
    watch: () => ({ dispose: () => {} }),
    forget: () => {},
  };
}

let ctx: ReplContext;
let stop: () => Promise<void>;

beforeEach(async () => {
  const hookPort = nextPort++;
  const island = createIsland({
    adapters: [stubAdapter('claude-code'), stubAdapter('codex')],
    store: new MemoryStore(),
    hookPort,
  });
  await island.start();
  ctx = { island, hookPort };
  stop = () => island.stop();
});

afterEach(async () => {
  await stop();
});

function seed(...sessions: Session[]): void {
  for (const s of sessions) ctx.island.store.upsert(s);
}

describe('repl dispatch', () => {
  it('reports unknown commands instead of failing', async () => {
    expect((await runCommand('frobnicate', ctx)).output).toContain('unknown command');
  });

  it('treats a blank line as a no-op', async () => {
    expect(await runCommand('   ', ctx)).toEqual({ output: '' });
  });

  it('asks to quit on quit and exit', async () => {
    expect((await runCommand('quit', ctx)).quit).toBe(true);
    expect((await runCommand('exit', ctx)).quit).toBe(true);
  });
});

describe('ls', () => {
  it('says so when nothing matches rather than printing an empty table', async () => {
    expect((await runCommand('ls', ctx)).output).toBe('(none)');
  });

  it('filters by status and by tool', async () => {
    seed(
      session({ id: 'aaaa1111', title: 'running one' }),
      session({ id: 'bbbb2222', title: 'idle one', status: 'idle' }),
      session({ id: 'cccc3333', title: 'codex one', tool: 'codex', status: 'idle' }),
    );

    expect((await runCommand('ls running', ctx)).output).toContain('running one');
    expect((await runCommand('ls running', ctx)).output).not.toContain('idle one');
    expect((await runCommand('ls codex', ctx)).output).toContain('codex one');
    expect((await runCommand('ls codex', ctx)).output).not.toContain('idle one');
  });

  it('widens the printed id until it can actually be typed as a prefix', async () => {
    // UUIDv7, as Codex emits: the leading hex is a shared timestamp.
    seed(
      session({ id: '01a07e23-8ab8-7531-bab6-b05101a61d95', title: 'first' }),
      session({ id: '01a07e23-8aa5-7e03-8e7b-cacc315525bc', title: 'second' }),
    );

    const printed = (await runCommand('ls', ctx)).output
      .split('\n')
      .map((row) => row.split('  ')[0]!.trim());

    expect(new Set(printed).size).toBe(2);
    for (const prefix of printed) {
      const output = (await runCommand(`show ${prefix}`, ctx)).output;
      expect(output).not.toContain('matches');
      expect(output).toContain('01a07e23');
    }
  });

  it('keeps unrelated ids short when one pair needs a longer prefix', async () => {
    seed(
      session({ id: '01a07e23-8ab8-7531-bab6-b05101a61d95' }),
      session({ id: '01a07e23-8aa5-7e03-8e7b-cacc315525bc' }),
      session({ id: '94d92866-a22c-432c-b957-6f07b4fb3b48' }),
    );

    const printed = (await runCommand('ls', ctx)).output
      .split('\n')
      .map((row) => row.split('  ')[0]!.trim());

    expect(printed).toContain('94d92866');
  });

  it('rejects a filter that is neither a status nor an active tool', async () => {
    const output = (await runCommand('ls nonsense', ctx)).output;

    expect(output).toContain('unknown filter');
    expect(output).toContain('claude-code');
  });
});

describe('show', () => {
  it('resolves a session by id prefix', async () => {
    seed(session({ id: 'aaaa1111-2222', model: 'claude-opus-5' }));

    const output = (await runCommand('show aaaa', ctx)).output;

    expect(output).toContain('aaaa1111-2222');
    expect(output).toContain('claude-opus-5');
  });

  it('omits fields the tool does not report', async () => {
    seed(session({ id: 'aaaa1111' }));

    const output = (await runCommand('show aaaa', ctx)).output;

    expect(output).not.toContain('usage');
    expect(output).not.toContain('branch');
  });

  it('lists the candidates when a prefix is ambiguous', async () => {
    seed(session({ id: 'aaaa1111', title: 'first' }), session({ id: 'aaaa2222', title: 'second' }));

    const output = (await runCommand('show aaaa', ctx)).output;

    expect(output).toContain('matches 2 sessions');
    expect(output).toContain('first');
    expect(output).toContain('second');
  });

  it('reports a prefix that matches nothing', async () => {
    expect((await runCommand('show zzzz', ctx)).output).toContain('no session id starts with');
  });

  it('explains its own usage when given no id', async () => {
    expect((await runCommand('show', ctx)).output).toBe('usage: show <id-prefix>');
  });
});

describe('fire', () => {
  it('drives a real state transition through the hook server', async () => {
    seed(session({ id: 'aaaa1111' }));

    const result = await runCommand('fire aaaa Notification Bash', ctx);

    expect(result.output).toContain('posted Notification');
    expect(ctx.island.store.get('aaaa1111')?.status).toBe('waiting');
    expect(ctx.island.store.get('aaaa1111')?.waitingOn?.toolName).toBe('Bash');
  });

  it('clears waiting when a later event carries a different status', async () => {
    seed(session({ id: 'aaaa1111' }));

    await runCommand('fire aaaa Notification Bash', ctx);
    await runCommand('fire aaaa Stop', ctx);

    expect(ctx.island.store.get('aaaa1111')?.status).toBe('idle');
    expect(ctx.island.store.get('aaaa1111')?.waitingOn).toBeUndefined();
  });

  it('removes the session outright on SessionEnd', async () => {
    seed(session({ id: 'aaaa1111' }));

    const result = await runCommand('fire aaaa SessionEnd', ctx);

    expect(result.output).toContain('the session is removed');
    expect(ctx.island.store.get('aaaa1111')).toBeUndefined();
  });

  it('warns when the event name carries no status meaning', async () => {
    seed(session({ id: 'aaaa1111' }));

    const result = await runCommand('fire aaaa MadeUpEvent', ctx);

    expect(result.output).toContain('no status meaning');
    expect(ctx.island.store.get('aaaa1111')?.status).toBe('running');
  });

  it('refuses an unknown id without posting anything', async () => {
    expect((await runCommand('fire zzzz Notification', ctx)).output).toContain(
      'no session id starts with',
    );
  });

  it('explains its own usage when the event is missing', async () => {
    expect((await runCommand('fire aaaa', ctx)).output).toBe(
      'usage: fire <id-prefix> <Event> [toolName]',
    );
  });
});

describe('help', () => {
  it('lists every command and the events fire accepts', async () => {
    const output = (await runCommand('help', ctx)).output;

    for (const command of ['ls', 'show', 'fire', 'quit']) expect(output).toContain(command);
    expect(output).toContain('Notification');
    expect(output).toContain('SessionEnd');
  });
});
