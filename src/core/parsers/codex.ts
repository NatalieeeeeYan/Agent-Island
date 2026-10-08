import type { Usage } from '../types.js';
import { clip, num, obj, replyText, str, stripInjected, timestamp } from './util.js';

/**
 * Facts extractable from a Codex rollout
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`).
 *
 * Every row is `{ type, payload, timestamp, ordinal }`; `event_msg` rows carry
 * their own discriminator at `payload.type`.
 *
 * Note the title is *not* in the rollout — it lives in
 * `~/.codex/session_index.jsonl` as `thread_name`, which the adapter joins in.
 * Codex Desktop does not write that index, so `lastUserMessage` is kept as a
 * fallback for sessions the index never learns about — the latest ask, since
 * what the agent is working on now is what a glance at the island needs.
 */
export type CodexFacts = {
  sessionId: string | null;
  lastUserMessage: string | null;
  /** Opening of the agent's most recent prose reply. */
  lastReply: string | null;
  cwd: string | null;
  model: string | null;
  cliVersion: string | null;
  usage: Usage | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  /** Number of turns started minus turns completed. > 0 means a turn is open. */
  openTurns: number;
  lastTaskCompletedAt: number | null;
  /**
   * Message from the most recent failed turn, e.g. hitting a usage limit.
   * Unlike a pause, an explicit error record is hard evidence, so the adapter
   * is entitled to surface `status: 'error'` from it.
   */
  lastError: string | null;
};

export function emptyCodexFacts(): CodexFacts {
  return {
    sessionId: null,
    lastUserMessage: null,
    lastReply: null,
    cwd: null,
    model: null,
    cliVersion: null,
    usage: null,
    firstTimestamp: null,
    lastTimestamp: null,
    openTurns: 0,
    lastTaskCompletedAt: null,
    lastError: null,
  };
}

export function foldCodexRows(
  rows: readonly unknown[],
  prev: CodexFacts = emptyCodexFacts(),
): CodexFacts {
  const facts: CodexFacts = { ...prev };

  for (const row of rows) {
    const r = obj(row);
    if (!r) continue;

    const ts = timestamp(r['timestamp']);
    if (ts !== null) {
      if (facts.firstTimestamp === null || ts < facts.firstTimestamp) facts.firstTimestamp = ts;
      if (facts.lastTimestamp === null || ts > facts.lastTimestamp) facts.lastTimestamp = ts;
    }

    const payload = obj(r['payload']);
    if (!payload) continue;

    switch (str(r['type'])) {
      case 'session_meta': {
        facts.sessionId ??= str(payload['session_id']) ?? str(payload['id']);
        facts.cwd = str(payload['cwd']) ?? facts.cwd;
        facts.cliVersion = str(payload['cli_version']) ?? facts.cliVersion;
        break;
      }
      case 'turn_context': {
        facts.cwd = str(payload['cwd']) ?? facts.cwd;
        facts.model = str(payload['model']) ?? facts.model;
        break;
      }
      case 'event_msg': {
        applyEventMsg(facts, payload, ts);
        break;
      }
      default:
        break;
    }
  }

  return facts;
}

function applyEventMsg(
  facts: CodexFacts,
  payload: Record<string, unknown>,
  rowTs: number | null,
): void {
  switch (str(payload['type'])) {
    case 'user_message': {
      const message = str(payload['message']);
      const asked = message === null ? null : clip(stripInjected(message));
      facts.lastUserMessage = asked ?? facts.lastUserMessage;
      break;
    }
    case 'agent_message': {
      facts.lastReply = replyText(str(payload['message'])) ?? facts.lastReply;
      break;
    }
    case 'task_started': {
      facts.openTurns += 1;
      break;
    }
    case 'task_complete': {
      facts.openTurns = Math.max(0, facts.openTurns - 1);
      facts.lastTaskCompletedAt =
        timestamp(payload['completed_at']) ?? rowTs ?? facts.lastTaskCompletedAt;
      // A turn that ends in an error clears on the next successful turn.
      facts.lastError = str(obj(payload['error'])?.['message']);
      break;
    }
    case 'token_count': {
      // `info` is null on rows that only carry rate-limit state.
      const usage = parseTokenCount(payload);
      // Codex reports cumulative totals, so the latest row simply wins.
      if (usage) facts.usage = usage;
      break;
    }
    default:
      break;
  }
}

/**
 * `token_count.info.total_token_usage` is cumulative for the session.
 * Codex reports no dollar cost, so `costUSD` stays absent — the UI must render
 * that as "no cost data", never as zero.
 *
 * Codex Desktop fills in `total_tokens` but leaves every per-direction field at
 * zero, so `totalTokens` is carried through as the only honest number available
 * for those sessions.
 */
function parseTokenCount(payload: Record<string, unknown>): Usage | null {
  const total = obj(obj(payload['info'])?.['total_token_usage']);
  if (!total) return null;

  const usage: Usage = {
    inputTokens: num(total['input_tokens']) ?? 0,
    outputTokens: num(total['output_tokens']) ?? 0,
  };
  const cached = num(total['cached_input_tokens']);
  const written = num(total['cache_write_input_tokens']);
  const grandTotal = num(total['total_tokens']);
  if (cached !== null && cached > 0) usage.cacheReadTokens = cached;
  if (written !== null && written > 0) usage.cacheCreationTokens = written;
  if (grandTotal !== null && grandTotal > 0) usage.totalTokens = grandTotal;
  return usage;
}

/** One row of `~/.codex/session_index.jsonl`. */
export type CodexIndexEntry = {
  id: string;
  threadName: string | null;
  updatedAt: number | null;
};

export function parseCodexIndex(rows: readonly unknown[]): Map<string, CodexIndexEntry> {
  const out = new Map<string, CodexIndexEntry>();
  for (const row of rows) {
    const r = obj(row);
    if (!r) continue;
    const id = str(r['id']);
    if (!id) continue;
    // Later rows for the same id supersede earlier ones.
    out.set(id, {
      id,
      threadName: str(r['thread_name']),
      updatedAt: timestamp(r['updated_at']),
    });
  }
  return out;
}
