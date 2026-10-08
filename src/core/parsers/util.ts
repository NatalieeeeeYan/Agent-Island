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

/** A line that is nothing but `[...]`, e.g. `[external unsupported block: image]`. */
const BRACKET_LINE = /^\[[^\]]*\]$/;
const OPEN_TAG = /^<([a-zA-Z][\w-]*)>/;

/**
 * Drop the markers a tool injects ahead of what was actually said, and return
 * what is left — null if that is nothing.
 *
 * Attachment placeholders and slash-command echoes are *prefixes*, not whole
 * messages: `[external unsupported block: image]\n\n<the real question>` is one
 * observed shape, and dropping the whole message would throw away a good title.
 * A message that is only markers (`<local-command-stdout>Goodbye!</…>`) leaves
 * nothing, which is the signal to fall back to the previous one.
 *
 * Prose starting with an angle bracket loses its first line — a fair price for
 * not naming sessions "Goodbye!".
 */
export function stripInjected(text: string): string | null {
  let rest = text.trim();

  while (rest !== '') {
    const line = rest.split('\n', 1)[0]!.trim();

    // A tag block can span lines, so skip past its closing tag when there is one.
    const tag = OPEN_TAG.exec(line)?.[1];
    const close = tag === undefined ? -1 : rest.indexOf(`</${tag}>`);
    if (close !== -1) {
      rest = rest.slice(close + tag!.length + 3).trim();
      continue;
    }

    if (!BRACKET_LINE.test(line) && !line.startsWith('<')) break;

    const newline = rest.indexOf('\n');
    // Nothing follows the marker, so nothing was said.
    if (newline === -1) return null;
    rest = rest.slice(newline + 1).trim();
  }

  return str(rest);
}

/**
 * How much of any transcript text is kept in memory.
 *
 * A single row can hold a whole pasted file, and only the opening is ever
 * shown — retaining the rest is pure leak. Everything folded out of a
 * transcript passes through `clip` at parse time, so a session's footprint is
 * bounded no matter what was pasted into it.
 */
export const PREVIEW_MAX_CHARS = 200;

export function clip(text: string | null, max: number = PREVIEW_MAX_CHARS): string | null {
  const value = str(text);
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Squash newlines and runs of spaces, for text rendered as a single blob. */
export function oneLine(text: string | null): string | null {
  return str(text?.replace(/\s+/g, ' ').trim() ?? null);
}

/**
 * An agent reply as it will be displayed: one line, capped, and only if the
 * agent actually said it — import banners and placeholders are not prose.
 */
export function replyText(text: string | null): string | null {
  const said = text === null ? null : stripInjected(text);
  return clip(oneLine(said));
}

const TITLE_MAX_CHARS = 60;

/**
 * Last-resort title: the opening line of the latest user message.
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
