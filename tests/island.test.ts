import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JsonlCursor } from '../src/core/jsonl.js';
import { MemoryStore } from '../src/core/store.js';
import { statusFromActivity, ACTIVE_WINDOW_MS } from '../src/core/status.js';
import { applyHookEvent } from '../src/core/island.js';
import { normalizeHookEvent } from '../src/core/hook-server.js';
import { sessionIdFromFilename } from '../src/core/adapters/codex.js';
import type { Session } from '../src/core/types.js';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tool: 'claude-code',
    title: 'Refactor auth',
    cwd: '/tmp/project',
    status: 'idle',
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('JsonlCursor', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'island-'));
    file = join(dir, 'transcript.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads only newly appended lines', async () => {
    await writeFile(file, '{"a":1}\n{"a":2}\n');
    const cursor = new JsonlCursor(file);

    expect(await cursor.readNew()).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await cursor.readNew()).toEqual([]);

    await appendFile(file, '{"a":3}\n');
    expect(await cursor.readNew()).toEqual([{ a: 3 }]);
  });

  it('skips malformed lines rather than throwing', async () => {
    await writeFile(file, '{"a":1}\nnot json\n\n{"a":2}\n');
    expect(await new JsonlCursor(file).readNew()).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('re-reads from the start when the file is truncated', async () => {
    await writeFile(file, '{"a":1}\n{"a":2}\n');
    const cursor = new JsonlCursor(file);
    await cursor.readNew();

    await writeFile(file, '{"b":1}\n');
    expect(await cursor.readNew()).toEqual([{ b: 1 }]);
  });

  it('handles multi-byte content without desynchronising the offset', async () => {
    await writeFile(file, '{"t":"重构认证中间件"}\n');
    const cursor = new JsonlCursor(file);
    expect(await cursor.readNew()).toEqual([{ t: '重构认证中间件' }]);

    await appendFile(file, '{"t":"下一行"}\n');
    expect(await cursor.readNew()).toEqual([{ t: '下一行' }]);
  });

  it('returns nothing for a missing file', async () => {
    expect(await new JsonlCursor(join(dir, 'absent.jsonl')).readNew()).toEqual([]);
  });
});

describe('statusFromActivity', () => {
  const now = 1_000_000;

  it('reports running inside the activity window', () => {
    expect(statusFromActivity(now - 1000, { now })).toBe('running');
  });

  it('reports idle once the window has elapsed', () => {
    expect(statusFromActivity(now - ACTIVE_WINDOW_MS - 1, { now })).toBe('idle');
  });

  it('never infers waiting or complete from file activity alone', () => {
    for (const age of [0, 10_000, 10 ** 9]) {
      expect(['running', 'idle']).toContain(statusFromActivity(now - age, { now }));
    }
  });
});

describe('MemoryStore', () => {
  it('lists newest first and filters by tool and status', () => {
    const store = new MemoryStore();
    store.upsert(session({ id: 'a', updatedAt: 100, tool: 'claude-code', status: 'idle' }));
    store.upsert(session({ id: 'b', updatedAt: 300, tool: 'codex', status: 'running' }));
    store.upsert(session({ id: 'c', updatedAt: 200, tool: 'codex', status: 'idle' }));

    expect(store.list().map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(store.list({ tool: 'codex' }).map((s) => s.id)).toEqual(['b', 'c']);
    expect(store.list({ status: 'idle' }).map((s) => s.id)).toEqual(['c', 'a']);
    expect(store.list({ since: 200 }).map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('bounds the recorded event log', () => {
    const store = new MemoryStore({ maxEvents: 2 });
    for (const id of ['a', 'b', 'c']) {
      store.recordEvent({ kind: 'session_removed', sessionId: id });
    }

    expect(store.events()).toHaveLength(2);
    expect(store.events().at(-1)).toEqual({ kind: 'session_removed', sessionId: 'c' });
  });
});

describe('applyHookEvent', () => {
  it('marks a session waiting and records what it is blocked on', () => {
    const store = new MemoryStore();
    store.upsert(session());

    const updated = applyHookEvent(store, {
      tool: 'claude-code',
      event: 'Notification',
      sessionId: 's1',
      toolName: 'Bash',
      toolUseId: 'toolu_01abc',
      receivedAt: 5000,
    });

    expect(updated?.status).toBe('waiting');
    expect(updated?.waitingOn).toMatchObject({ toolName: 'Bash', toolUseId: 'toolu_01abc' });
    expect(store.get('s1')?.status).toBe('waiting');
  });

  it('clears waitingOn once the session moves on', () => {
    const store = new MemoryStore();
    store.upsert(session());
    applyHookEvent(store, {
      tool: 'codex',
      event: 'PermissionRequest',
      sessionId: 's1',
      receivedAt: 5000,
    });

    const resumed = applyHookEvent(store, {
      tool: 'codex',
      event: 'PostToolUse',
      sessionId: 's1',
      receivedAt: 6000,
    });

    expect(resumed?.status).toBe('running');
    expect(resumed?.waitingOn).toBeUndefined();
  });

  it('ignores events for sessions not yet seen on disk', () => {
    const store = new MemoryStore();
    const result = applyHookEvent(store, {
      tool: 'claude-code',
      event: 'Stop',
      sessionId: 'unknown',
      receivedAt: 1,
    });

    expect(result).toBeNull();
  });

  it('leaves status untouched for events that carry no status meaning', () => {
    const store = new MemoryStore();
    store.upsert(session({ status: 'running' }));

    const updated = applyHookEvent(store, {
      tool: 'claude-code',
      event: 'SomeFutureHook',
      sessionId: 's1',
      receivedAt: 9000,
    });

    expect(updated?.status).toBe('running');
    expect(updated?.updatedAt).toBe(9000);
  });
});

describe('normalizeHookEvent', () => {
  it('accepts snake_case and camelCase field names', () => {
    expect(
      normalizeHookEvent({
        tool: 'codex',
        event: 'PreToolUse',
        session_id: 'abc',
        tool_name: 'shell',
        receivedAt: 42,
      }),
    ).toEqual({
      tool: 'codex',
      event: 'PreToolUse',
      sessionId: 'abc',
      toolName: 'shell',
      receivedAt: 42,
    });
  });

  it('rejects envelopes missing required fields', () => {
    expect(normalizeHookEvent({ tool: 'codex', event: 'Stop' })).toBeNull();
    expect(normalizeHookEvent({ sessionId: 'abc' })).toBeNull();
    expect(normalizeHookEvent('nope')).toBeNull();
  });
});

describe('sessionIdFromFilename', () => {
  it('pulls the uuid out of a codex rollout filename', () => {
    expect(
      sessionIdFromFilename(
        '/x/rollout-2026-08-25T18-07-29-01a03b9b-9d62-7042-b1b4-350dad90fc20.jsonl',
      ),
    ).toBe('01a03b9b-9d62-7042-b1b4-350dad90fc20');
  });

  it('falls back to the stem when there is no uuid', () => {
    expect(sessionIdFromFilename('/x/weird-name.jsonl')).toBe('weird-name');
  });
});
