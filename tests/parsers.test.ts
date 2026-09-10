import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseSidecar } from '../src/core/claude-desktop-sidecar.js';
import { readJsonl } from '../src/core/jsonl.js';
import { foldClaudeCodeRows } from '../src/core/parsers/claude-code.js';
import { foldCodexRows, parseCodexIndex } from '../src/core/parsers/codex.js';
import { titleFromMessage } from '../src/core/parsers/util.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('claude code parser', () => {
  it('extracts identity, title and authoritative usage from a real transcript', async () => {
    const facts = foldClaudeCodeRows(await readJsonl(join(fixtures, 'claude-code.jsonl')));

    expect(facts.sessionId).toBe('36a30a75-b111-4288-b0d2-0b7595c9c219');
    expect(facts.title).toBe('GildedRose updateQuality refactor');
    expect(facts.cwd).toContain('GildedRoseKataStudent');
    expect(facts.model).toBe('claude-opus-5');

    // `cost-state` totals win over summed per-turn usage.
    expect(facts.usageIsAuthoritative).toBe(true);
    expect(facts.usage?.costUSD).toBeCloseTo(2.797936, 5);
    expect(facts.usage?.outputTokens).toBe(31752);
    expect(facts.usage?.cacheReadTokens).toBe(2178044);

    expect(facts.firstTimestamp).not.toBeNull();
    expect(facts.lastTimestamp).toBeGreaterThanOrEqual(facts.firstTimestamp!);
  });

  it('folds incrementally to the same result as a single pass', async () => {
    const rows = await readJsonl(join(fixtures, 'claude-code.jsonl'));
    const split = Math.floor(rows.length / 2);

    const oneShot = foldClaudeCodeRows(rows);
    const incremental = foldClaudeCodeRows(
      rows.slice(split),
      foldClaudeCodeRows(rows.slice(0, split)),
    );

    expect(incremental).toEqual(oneShot);
  });

  it('sums per-turn usage when no cost-state row is present', () => {
    const facts = foldClaudeCodeRows([
      { type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } },
      { type: 'assistant', message: { usage: { input_tokens: 3, output_tokens: 7 } } },
    ]);

    expect(facts.usageIsAuthoritative).toBe(false);
    expect(facts.usage).toEqual({ inputTokens: 13, outputTokens: 12 });
  });

  it('ignores unknown row types instead of failing', () => {
    const facts = foldClaudeCodeRows([
      { type: 'some-future-row-type', whatever: true },
      null,
      'not an object',
      { type: 'ai-title', aiTitle: 'Still parsed' },
    ]);

    expect(facts.title).toBe('Still parsed');
  });

  it('keeps the first human prompt and ignores tool results', () => {
    const facts = foldClaudeCodeRows([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] },
      },
      { type: 'user', message: { role: 'user', content: 'second prompt' } },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'not a prompt' }] },
      },
    ]);

    expect(facts.firstUserMessage).toBe('first prompt');
  });

  it('records no prompt when every user row is a tool result', () => {
    const facts = foldClaudeCodeRows([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ls output' }] },
      },
    ]);

    expect(facts.firstUserMessage).toBeNull();
  });
});

describe('codex parser', () => {
  it('extracts identity, model and cumulative token usage', async () => {
    const facts = foldCodexRows(await readJsonl(join(fixtures, 'codex.jsonl')));

    expect(facts.sessionId).toBe('01a04433-3e5b-77e2-8ac8-9c77fdce23af');
    expect(facts.cwd).toBe('/Users/songwenyan/ME');
    expect(facts.model).toBe('gpt-5.6-terra');
    expect(facts.cliVersion).not.toBeNull();

    expect(facts.usage?.inputTokens).toBe(25708);
    expect(facts.usage?.outputTokens).toBe(181);
    expect(facts.usage?.cacheReadTokens).toBe(11008);
    // Codex reports no dollar cost — this must stay absent, never 0.
    expect(facts.usage?.costUSD).toBeUndefined();
    expect(facts.lastError).toBeNull();
  });

  it('survives a rate-limited session: null token info and a failed turn', async () => {
    const facts = foldCodexRows(await readJsonl(join(fixtures, 'codex-ratelimited.jsonl')));

    // `token_count.info` is null on rate-limit-only rows — no usage, no crash.
    expect(facts.usage).toBeNull();
    expect(facts.lastError).toContain('usage limit');
  });

  it('tracks open turns across task_started / task_complete', () => {
    const started = foldCodexRows([
      { type: 'event_msg', payload: { type: 'task_started' }, timestamp: '2026-09-01T00:00:00Z' },
    ]);
    expect(started.openTurns).toBe(1);

    const finished = foldCodexRows(
      [
        {
          type: 'event_msg',
          payload: { type: 'task_complete', completed_at: '2026-09-01T00:01:00Z' },
          timestamp: '2026-09-01T00:01:00Z',
        },
      ],
      started,
    );
    expect(finished.openTurns).toBe(0);
    expect(finished.lastTaskCompletedAt).not.toBeNull();
    expect(finished.lastError).toBeNull();
  });

  it('clears a previous error when the next turn succeeds', () => {
    const failed = foldCodexRows([
      { type: 'event_msg', payload: { type: 'task_complete', error: { message: 'boom' } } },
    ]);
    expect(failed.lastError).toBe('boom');

    const recovered = foldCodexRows(
      [{ type: 'event_msg', payload: { type: 'task_complete' } }],
      failed,
    );
    expect(recovered.lastError).toBeNull();
  });

  it('reads titles from the session index, last row winning', async () => {
    const index = parseCodexIndex(await readJsonl(join(fixtures, 'codex-session-index.jsonl')));
    const entry = index.get('01a04433-3e5b-77e2-8ac8-9c77fdce23af');

    expect(entry?.threadName).toBe('解释 Floss 和 Root Canal 重构');
    expect(entry?.updatedAt).toBeGreaterThan(0);
  });

  it('carries total_tokens for Desktop sessions that report no in/out split', () => {
    const facts = foldCodexRows([
      {
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 0,
              output_tokens: 0,
              cached_input_tokens: 0,
              total_tokens: 14959,
            },
          },
        },
      },
    ]);

    expect(facts.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 14959 });
  });

  it('keeps the first user message as a title fallback', () => {
    const facts = foldCodexRows([
      { type: 'event_msg', payload: { type: 'user_message', message: 'first ask' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'second ask' } },
    ]);

    expect(facts.firstUserMessage).toBe('first ask');
  });
});

describe('title fallback', () => {
  it('takes the opening line and truncates long prompts', () => {
    expect(titleFromMessage('  fix the parser  ')).toBe('fix the parser');
    expect(titleFromMessage('line one\nline two')).toBe('line one');
    expect(titleFromMessage('x'.repeat(80))).toBe(`${'x'.repeat(59)}…`);
    expect(titleFromMessage('   \n  ')).toBeNull();
    expect(titleFromMessage(null)).toBeNull();
  });
});

describe('claude desktop sidecar', () => {
  it('maps a sidecar onto the transcript it describes', () => {
    const entry = parseSidecar({
      sessionId: 'local_d4a9f9cb',
      cliSessionId: 'a41f164c-1fb8-43eb-959e-47145c55e4a5',
      title: 'Agent Island 架构设计评审',
      titleSource: 'auto',
      lastActivityAt: 1788934782285,
    });

    expect(entry).toEqual({
      cliSessionId: 'a41f164c-1fb8-43eb-959e-47145c55e4a5',
      title: 'Agent Island 架构设计评审',
      lastActivityAt: 1788934782285,
    });
  });

  it('skips files in the same directory that describe no session', () => {
    expect(parseSidecar({ tasks: [] })).toBeNull();
    expect(parseSidecar('not an object')).toBeNull();
  });
});
