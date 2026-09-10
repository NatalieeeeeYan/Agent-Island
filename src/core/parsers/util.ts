/** Tolerant accessors for transcript rows whose shape we do not control. */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return isRecord(v) ? v : null;
}

const TITLE_MAX_CHARS = 60;

/**
 * Last-resort title: the opening line of the first user message.
 *
 * Only used when the tool has produced no title of its own — a truncated prompt
 * reads worse than a real title, but far better than "(untitled)".
 */
export function titleFromMessage(text: string | null): string | null {
  const firstLine = str(text?.trim().split('\n', 1)[0]?.trim() ?? null);
  if (firstLine === null) return null;
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1)}…`
    : firstLine;
}

/** Parse an ISO-8601 string or epoch-ms number into epoch-ms. */
export function timestamp(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}
