import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createHookServer } from '../src/core/hook-server.js';
import { MemoryStore } from '../src/core/store.js';
import { applyHookEvent } from '../src/core/island.js';
import type { HookEvent, Session } from '../src/core/types.js';

const RELAY = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'island-hook.mjs');
const PORT = 7893;

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

/** Run the real relay script the way a tool would: payload on stdin. */
function runRelay(
  args: string[],
  stdin: unknown,
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; elapsedMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn('node', [RELAY, ...args], {
      env: { ...process.env, AGENT_ISLAND_URL: `http://127.0.0.1:${PORT}/hook`, ...env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
    child.on('exit', (code) => resolve({ code, stdout, elapsedMs: Date.now() - startedAt }));
  });
}

/**
 * Start a receiver and hand back the pending event.
 *
 * The promise is wrapped in an object on purpose: returning it bare would make
 * this `Promise<Promise<HookEvent>>`, which `await` flattens — so the caller
 * would block on the event before it had a chance to send one.
 */
async function collectOne(): Promise<{ received: Promise<HookEvent> }> {
  let resolveEvent: (event: HookEvent) => void;
  const received = new Promise<HookEvent>((r) => {
    resolveEvent = r;
  });
  const server = createHookServer({ port: PORT, onEvent: (event) => resolveEvent(event) });
  await server.listen();
  close = () => server.close();
  return { received };
}

describe('hook relay script', () => {
  it('forwards a Claude Code payload as a normalized envelope', async () => {
    const { received } = await collectOne();

    const result = await runRelay(['claude-code', 'PreToolUse'], {
      session_id: 'abc-123',
      cwd: '/tmp/project',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01',
    });

    expect(result.code).toBe(0);
    // Anything on stdout would be interpreted by the tool as a hook decision.
    expect(result.stdout).toBe('');

    await expect(received).resolves.toMatchObject({
      tool: 'claude-code',
      event: 'PreToolUse',
      sessionId: 'abc-123',
      cwd: '/tmp/project',
      toolName: 'Bash',
      toolUseId: 'toolu_01',
    });
  });

  it('falls back to the payload event name when argv omits it', async () => {
    const { received } = await collectOne();

    await runRelay(['codex'], { session_id: 'x', hook_event_name: 'PermissionRequest' });

    await expect(received).resolves.toMatchObject({
      tool: 'codex',
      event: 'PermissionRequest',
    });
  });

  it('exits 0 quickly when Island is not running', async () => {
    const result = await runRelay(['codex', 'PreToolUse'], { session_id: 'x' }, {
      // Nothing listens here, and the connection is refused immediately.
      AGENT_ISLAND_URL: 'http://127.0.0.1:1/hook',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.elapsedMs).toBeLessThan(5000);
  });

  it('exits 0 on malformed stdin', async () => {
    await collectOne();
    const result = await runRelay(['claude-code', 'Stop'], 'this is not json');

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('hook event reaches the store', () => {
  it('flips a scanned session to waiting and back', () => {
    const store = new MemoryStore();
    const session: Session = {
      id: 's1',
      tool: 'claude-code',
      title: 'Refactor auth',
      cwd: '/tmp/project',
      status: 'running',
      startedAt: 0,
      updatedAt: 0,
    };
    store.upsert(session);

    const waiting = applyHookEvent(store, {
      tool: 'claude-code',
      event: 'Notification',
      sessionId: 's1',
      toolName: 'Bash',
      receivedAt: 100,
    });
    expect(waiting?.status).toBe('waiting');

    const resumed = applyHookEvent(store, {
      tool: 'claude-code',
      event: 'PostToolUse',
      sessionId: 's1',
      receivedAt: 200,
    });
    expect(resumed?.status).toBe('running');
    expect(resumed?.waitingOn).toBeUndefined();
  });
});
