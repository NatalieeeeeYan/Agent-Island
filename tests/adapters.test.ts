import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeCodeAdapter } from '../src/core/adapters/claude-code.js';

const SESSION_ID = 'a41f164c-1fb8-43eb-959e-47145c55e4a5';

let home: string;
let projects: string;
let sidecarRoot: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'island-'));
  projects = join(home, 'projects', '-Users-me-proj');
  sidecarRoot = join(home, 'claude-code-sessions', 'org', 'user');
  await mkdir(projects, { recursive: true });
  await mkdir(sidecarRoot, { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeTranscript(...rows: unknown[]): Promise<void> {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  await writeFile(join(projects, `${SESSION_ID}.jsonl`), `${body}\n`);
}

function userRow(content: unknown) {
  return {
    type: 'user',
    sessionId: SESSION_ID,
    cwd: '/Users/me/proj',
    timestamp: '2026-09-09T12:00:00Z',
    message: { role: 'user', content },
  };
}

async function writeSidecar(fields: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(sidecarRoot, 'local_d4a9f9cb.json'),
    JSON.stringify({ cliSessionId: SESSION_ID, ...fields }),
  );
}

async function scanTitle(): Promise<string | null | undefined> {
  const adapter = new ClaudeCodeAdapter({ root: join(home, 'projects'), sidecarRoot });
  const [session] = await adapter.scan();
  return session?.title;
}

describe('claude code adapter titles', () => {
  it('prefers the desktop sidecar over every other source', async () => {
    await writeTranscript(userRow('some long typed prompt'), {
      type: 'ai-title',
      aiTitle: 'Transcript title',
    });
    await writeSidecar({ title: 'Sidecar title', titleSource: 'auto' });

    expect(await scanTitle()).toBe('Sidecar title');
  });

  it('falls back to ai-title when no sidecar describes the session', async () => {
    await writeTranscript(userRow('some long typed prompt'), {
      type: 'ai-title',
      aiTitle: 'Transcript title',
    });

    expect(await scanTitle()).toBe('Transcript title');
  });

  it('falls back to the first typed prompt when the tool produced no title', async () => {
    await writeTranscript(userRow('rename the parser module'));

    expect(await scanTitle()).toBe('rename the parser module');
  });

  it('never titles a session from a tool result', async () => {
    await writeTranscript(
      userRow([{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'ok' }]),
    );

    expect(await scanTitle()).toBeNull();
  });

  it('stays untitled while the sidecar has not generated a title yet', async () => {
    await writeTranscript({
      type: 'assistant',
      sessionId: SESSION_ID,
      timestamp: '2026-09-09T12:00:00Z',
      message: {},
    });
    await writeSidecar({});

    expect(await scanTitle()).toBeNull();
  });
});
