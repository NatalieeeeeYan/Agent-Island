import type { Usage } from '../types.js';
import { clip, num, obj, replyText, str, stripInjected, timestamp } from './util.js';

/**
 * Facts extractable from a Claude Code transcript
 * (`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`).
 *
 * The parser deliberately does not decide a `status`. A transcript cannot
 * distinguish "blocked on approval" from any other pause, so status is left to
 * the state machine, which combines these facts with live hook events.
 */
export type ClaudeCodeFacts = {
  sessionId: string | null;
  title: string | null;
  /**
   * Fallback title source. `ai-title` only lands after a few turns, and sessions
   * launched from Claude Desktop never get one — their title lives in the
   * desktop sidecar instead.
   *
   * The *latest* ask, not the first: what the agent is working on now is what
   * you need off a glance at the island, and an opening prompt goes stale as
   * soon as the session moves on.
   */
  lastUserMessage: string | null;
  /**
   * The dispatch prompt of a subagent turn. Only ever used to title a subagent
   * transcript, which has no user prompt of its own.
   */
  lastSidechainMessage: string | null;
  /** Opening of the agent's most recent prose reply; no thinking, no tool calls. */
  lastReply: string | null;
  cwd: string | null;
  gitBranch: string | null;
  model: string | null;
  usage: Usage | null;
  /** True when `usage` came from a `cost-state` row rather than being summed. */
  usageIsAuthoritative: boolean;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  lastStopReason: string | null;
};

export function emptyClaudeCodeFacts(): ClaudeCodeFacts {
  return {
    sessionId: null,
    title: null,
    lastUserMessage: null,
    lastSidechainMessage: null,
    lastReply: null,
    cwd: null,
    gitBranch: null,
    model: null,
    usage: null,
    usageIsAuthoritative: false,
    firstTimestamp: null,
    lastTimestamp: null,
    lastStopReason: null,
  };
}

/**
 * Fold transcript rows into accumulated facts. Safe to call repeatedly with
 * only the newly appended rows, which is what incremental watching does.
 */
export function foldClaudeCodeRows(
  rows: readonly unknown[],
  prev: ClaudeCodeFacts = emptyClaudeCodeFacts(),
): ClaudeCodeFacts {
  const facts: ClaudeCodeFacts = { ...prev };
  // Tokens summed from per-turn `assistant` rows, used only until (or unless) a
  // `cost-state` row supplies the tool's own authoritative totals.
  let summedIn = prev.usageIsAuthoritative ? 0 : (prev.usage?.inputTokens ?? 0);
  let summedOut = prev.usageIsAuthoritative ? 0 : (prev.usage?.outputTokens ?? 0);
  let sawAssistantUsage = false;

  for (const row of rows) {
    const r = obj(row);
    if (!r) continue;

    const ts = timestamp(r['timestamp']);
    if (ts !== null) {
      if (facts.firstTimestamp === null || ts < facts.firstTimestamp) facts.firstTimestamp = ts;
      if (facts.lastTimestamp === null || ts > facts.lastTimestamp) facts.lastTimestamp = ts;
    }

    facts.sessionId ??= str(r['sessionId']) ?? str(r['session_id']);
    // `cwd` and `gitBranch` ride along on most rows; last one wins.
    facts.cwd = str(r['cwd']) ?? facts.cwd;
    facts.gitBranch = str(r['gitBranch']) ?? facts.gitBranch;

    switch (str(r['type'])) {
      case 'ai-title': {
        facts.title = str(r['aiTitle']) ?? facts.title;
        break;
      }
      case 'cost-state': {
        const parsed = parseCostState(r);
        if (parsed) {
          facts.usage = parsed;
          facts.usageIsAuthoritative = true;
        }
        break;
      }
      case 'assistant': {
        const message = obj(r['message']);
        if (!message) break;
        facts.model = str(message['model']) ?? facts.model;
        facts.lastStopReason = str(message['stop_reason']) ?? facts.lastStopReason;
        // Turns that only call tools say nothing, and must not blank the reply.
        facts.lastReply = replyText(proseReply(message)) ?? facts.lastReply;
        const usage = obj(message['usage']);
        if (usage) {
          sawAssistantUsage = true;
          summedIn += num(usage['input_tokens']) ?? 0;
          summedOut += num(usage['output_tokens']) ?? 0;
        }
        break;
      }
      case 'user': {
        const text = humanText(obj(r['message']));
        // A sidechain turn is a subagent's dispatch prompt, written by the tool
        // — in a normal session it must not become the title, and in a subagent
        // transcript it is the only thing there is. Kept apart, not merged.
        if (r['isSidechain'] === true) facts.lastSidechainMessage = text ?? facts.lastSidechainMessage;
        // Tool-result turns yield null and must not blank out the last prompt.
        else facts.lastUserMessage = text ?? facts.lastUserMessage;
        break;
      }
      case 'system': {
        facts.lastStopReason = str(r['stopReason']) ?? facts.lastStopReason;
        break;
      }
      default:
        // Unknown row types are expected across tool versions — ignore.
        break;
    }
  }

  if (!facts.usageIsAuthoritative && sawAssistantUsage) {
    facts.usage = { inputTokens: summedIn, outputTokens: summedOut };
  }

  return facts;
}

/**
 * Text the human actually typed. `user` rows also carry tool results, whose
 * content is an array of `tool_result` blocks — those are not a prompt and must
 * not become a title.
 */
function humanText(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message['content'];
  if (typeof content === 'string') return typed(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = obj(block);
    if (b && str(b['type']) === 'text') return typed(b['text']);
  }
  return null;
}

function typed(value: unknown): string | null {
  const text = str(value);
  return text === null ? null : clip(stripInjected(text));
}

/**
 * What the agent actually said, as opposed to what it did. An assistant message
 * mixes `thinking`, `tool_use` and `text` blocks; only the last is prose the
 * user would read.
 */
function proseReply(message: Record<string, unknown>): string | null {
  const content = message['content'];
  if (typeof content === 'string') return str(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const b = obj(block);
    if (b && str(b['type']) === 'text') return str(b['text']);
  }
  return null;
}

/**
 * `cost-state` carries the tool's own totals:
 * `{ totalCostUSD, modelUsage: { <model>: { inputTokens, outputTokens, ... } } }`
 */
function parseCostState(row: Record<string, unknown>): Usage | null {
  const modelUsage = obj(row['modelUsage']);
  const cost = num(row['totalCostUSD']);
  if (!modelUsage && cost === null) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const entry of Object.values(modelUsage ?? {})) {
    const m = obj(entry);
    if (!m) continue;
    inputTokens += num(m['inputTokens']) ?? 0;
    outputTokens += num(m['outputTokens']) ?? 0;
    cacheReadTokens += num(m['cacheReadInputTokens']) ?? 0;
    cacheCreationTokens += num(m['cacheCreationInputTokens']) ?? 0;
  }

  const usage: Usage = { inputTokens, outputTokens };
  if (cacheReadTokens > 0) usage.cacheReadTokens = cacheReadTokens;
  if (cacheCreationTokens > 0) usage.cacheCreationTokens = cacheCreationTokens;
  if (cost !== null) usage.costUSD = cost;
  return usage;
}
