import type { SessionStatus } from './types.js';

/**
 * How long after the last transcript write a session is still considered
 * running. An active agent writes constantly, so a gap this long means the turn
 * ended or the process is gone.
 */
export const ACTIVE_WINDOW_MS = 90_000;

/**
 * Status derivable from a transcript alone — only ever `running` or `idle`.
 *
 * `waiting` and `complete` require live hook events: a transcript cannot
 * distinguish "blocked on an approval prompt" from "the user walked away
 * mid-turn", and a terminal session that was quit leaves no final row. Guessing
 * either from file activity would put a state on screen that the data does not
 * support.
 *
 * `error` is different — a transcript that explicitly records a failed turn is
 * hard evidence, so an adapter may set it directly rather than calling this.
 */
export function statusFromActivity(
  lastActivityAt: number | null,
  options: { now?: number; activeWindowMs?: number } = {},
): SessionStatus {
  if (lastActivityAt === null) return 'idle';
  const now = options.now ?? Date.now();
  const window = options.activeWindowMs ?? ACTIVE_WINDOW_MS;
  return now - lastActivityAt <= window ? 'running' : 'idle';
}
