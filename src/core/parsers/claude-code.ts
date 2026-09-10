import type { Usage } from '../types.js';
import { num, obj, str, timestamp } from './util.js';

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
   */
  firstUserMessage: string | null;
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
    firstUserMessage: null,
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
        const usage = obj(message['usage']);
        if (usage) {
          sawAssistantUsage = true;
          summedIn += num(usage['input_tokens']) ?? 0;
          summedOut += num(usage['output_tokens']) ?? 0;
        }
        break;
      }
      case 'user': {
        facts.firstUserMessage ??= humanText(obj(r['message']));
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
