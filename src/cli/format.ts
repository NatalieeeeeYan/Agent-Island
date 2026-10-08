/** Terminal rendering shared by the live stream and the REPL. */
import type { Session } from '../core/types.js';

export const STATUS_MARK: Record<Session['status'], string> = {
  running: '●',
  waiting: '⏸',
  idle: '○',
  complete: '✓',
  error: '✗',
};

const MIN_ID_WIDTH = 8;
const MAX_ID_COLUMN = 16;

/**
 * The shortest prefix of `id` that no other id shares — what a command can
 * actually be given.
 *
 * Codex uses UUIDv7, whose leading hex is a timestamp, so sessions started the
 * same day share far more than eight characters. Lengthening every id to suit
 * the worst pair would widen the whole column, so each is measured on its own.
 */
export function uniquePrefix(id: string, all: readonly string[]): string {
  const others = all.filter((other) => other !== id);
  for (let width = MIN_ID_WIDTH; width < id.length; width++) {
    const prefix = id.slice(0, width);
    if (!others.some((other) => other.startsWith(prefix))) return prefix;
  }
  return id;
}

/**
 * Prefixes for a whole listing, padded so the column lines up.
 *
 * Padding is capped: one hard-to-distinguish pair would otherwise put a
 * 20-character gutter in front of every row. Anything past the cap overflows
 * into its own row, which also flags that this id needs more characters.
 */
export function idColumn(all: readonly string[]): Map<string, string> {
  const prefixes = new Map(all.map((id) => [id, uniquePrefix(id, all)]));
  const longest = Math.max(MIN_ID_WIDTH, ...[...prefixes.values()].map((p) => p.length));
  const width = Math.min(longest, MAX_ID_COLUMN);
  return new Map([...prefixes].map(([id, prefix]) => [id, prefix.padEnd(width)]));
}

/** Enough of a uuid to name a session in a one-line message. */
export function shortId(id: string): string {
  return id.slice(0, MIN_ID_WIDTH);
}

export function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function shortCwd(cwd: string): string {
  if (cwd === '') return '';
  const home = process.env['HOME'];
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

export function clock(at: number = Date.now()): string {
  return new Date(at).toTimeString().slice(0, 8);
}

/**
 * Token summary. A tool that reports only an aggregate gets "N total" — showing
 * its zeroed output count as real would read as "produced nothing".
 */
export function usageText(session: Session): string {
  const u = session.usage;
  if (!u) return '';
  const cost = u.costUSD !== undefined ? ` $${u.costUSD.toFixed(2)}` : '';
  const tokens =
    u.outputTokens === 0 && u.totalTokens !== undefined
      ? `${compact(u.totalTokens)} total`
      : `${compact(u.outputTokens)} out`;
  return `${tokens}${cost}`;
}

/** One-line session summary, as used by the live stream and by `ls`. */
export function sessionLine(session: Session): string {
  // A subagent is not a peer of the sessions around it; the arrow says so
  // before the title, which is only ever its dispatch prompt.
  const name = `${session.parentId === undefined ? '' : '↳ '}${session.title ?? '(untitled)'}`;
  const title = name.slice(0, 42).padEnd(42);
  const usage = usageText(session);
  return `${STATUS_MARK[session.status]} ${session.tool.padEnd(11)} ${title} ${shortCwd(
    session.cwd,
  )}${usage === '' ? '' : `  ${usage}`}`;
}
