/**
 * Command dispatch for the headless view.
 *
 * Strings in, strings out — no stdin, no stdout, no readline. That keeps every
 * command unit-testable without a TTY and leaves `dev.ts` responsible only for
 * wiring the terminal to it.
 */
import { ENDS_SESSION, HOOK_STATUS, type Island } from '../core/island.js';
import type { Session, SessionStatus } from '../core/types.js';
import { clock, idColumn, sessionLine, shortCwd, shortId, usageText } from './format.js';

const STATUSES: readonly SessionStatus[] = ['running', 'waiting', 'idle', 'complete', 'error'];

/** Events the island acts on: those that set a status, plus those that end a session. */
const MEANINGFUL_EVENTS = [...Object.keys(HOOK_STATUS), ...ENDS_SESSION];

export type ReplContext = {
  island: Island;
  hookPort: number;
};

export type CommandResult = {
  output: string;
  /** Set when the command asks the process to shut down. */
  quit?: boolean;
};

const HELP = [
  'ls [status|tool]           list sessions, newest first',
  'show <id-prefix>           everything known about one session',
  'fire <id-prefix> <Event> [toolName]',
  '                           post a synthetic hook event to the running server',
  'help                       this list',
  'quit                       stop watching and exit',
  '',
  `statuses : ${STATUSES.join(', ')}`,
  `events   : ${MEANINGFUL_EVENTS.join(', ')}`,
  `           ${[...ENDS_SESSION].join(', ')} removes the session outright`,
].join('\n');

export async function runCommand(line: string, ctx: ReplContext): Promise<CommandResult> {
  const [name, ...args] = line.trim().split(/\s+/).filter((part) => part !== '');
  if (name === undefined) return { output: '' };

  switch (name) {
    case 'ls':
      return { output: list(ctx.island, args[0]) };
    case 'show':
      return { output: show(ctx.island, args[0]) };
    case 'fire':
      return { output: await fire(ctx, args) };
    case 'help':
      return { output: HELP };
    case 'quit':
    case 'exit':
      return { output: '', quit: true };
    default:
      return { output: `unknown command: ${name} — try "help"` };
  }
}

function list(island: Island, filter?: string): string {
  const tools = new Set(island.activeAdapters.map((adapter) => adapter.id));

  if (filter !== undefined && !isStatus(filter) && !tools.has(filter)) {
    return `unknown filter: ${filter}\n  statuses: ${STATUSES.join(', ')}\n  tools   : ${[...tools].join(', ')}`;
  }

  const sessions = island.store.list(isStatus(filter) ? { status: filter } : {});
  const rows = filter !== undefined && !isStatus(filter)
    ? sessions.filter((session) => session.tool === filter)
    : sessions;

  if (rows.length === 0) return '(none)';

  // Prefixes are measured against every session, not just the filtered rows, so
  // one copied out of a filtered list still resolves.
  const ids = idColumn(island.store.list().map((s) => s.id));
  return rows.map((session) => `${ids.get(session.id)}  ${sessionLine(session)}`).join('\n');
}

function show(island: Island, prefix?: string): string {
  const found = resolve(island, prefix, 'show');
  if ('error' in found) return found.error;
  const session = found.session;

  const fields: [string, string | undefined][] = [
    ['id', session.id],
    ['tool', session.tool],
    ['parent', session.parentId && `${shortId(session.parentId)} (this is a subagent)`],
    ['status', session.status],
    ['title', session.title ?? '(untitled)'],
    ['cwd', shortCwd(session.cwd) || '(unknown)'],
    ['model', session.model],
    ['branch', session.gitBranch],
    ['usage', usageText(session) || undefined],
    [
      'waiting',
      session.waitingOn && `${session.waitingOn.summary} since ${clock(session.waitingOn.since)}`,
    ],
    ['started', clock(session.startedAt)],
    ['updated', clock(session.updatedAt)],
    ['source', session.sourcePath],
    ['reply', session.lastReply],
  ];

  // Absent fields are omitted rather than shown blank — a tool that reports no
  // cost must not render as one that reported zero.
  return fields
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key.padEnd(8)} ${value}`)
    .join('\n');
}

/**
 * Post a hook event the way a real hook script would.
 *
 * Deliberately goes over HTTP rather than calling `applyHookEvent` directly, so
 * a test exercises the same path a real agent takes: envelope parsing, the
 * server, and the fold into the store. The endpoint always answers 204 by
 * contract, so the session is resolved locally first — that way an unknown id
 * is a clear error here instead of a silent no-op there.
 */
async function fire(ctx: ReplContext, args: string[]): Promise<string> {
  const [prefix, event, toolName] = args;
  if (prefix === undefined || event === undefined) {
    return 'usage: fire <id-prefix> <Event> [toolName]';
  }

  const found = resolve(ctx.island, prefix, 'fire');
  if ('error' in found) return found.error;

  const body = {
    tool: found.session.tool,
    event,
    sessionId: found.session.id,
    ...(toolName !== undefined ? { toolName } : {}),
  };

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${ctx.hookPort}/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return `hook endpoint unreachable on 127.0.0.1:${ctx.hookPort}: ${String(error)}`;
  }

  if (!response.ok) return `hook endpoint returned ${response.status}`;

  const posted = `posted ${event} for ${shortId(found.session.id)}`;
  if (ENDS_SESSION.has(event)) return `${posted} — the session is removed`;
  return HOOK_STATUS[event] === undefined
    ? `${posted} — carries no status meaning, so the session is unchanged`
    : posted;
}

type Resolution = { session: Session } | { error: string };

function resolve(island: Island, prefix: string | undefined, command: string): Resolution {
  if (prefix === undefined) return { error: `usage: ${command} <id-prefix>` };

  const matches = island.store.list().filter((session) => session.id.startsWith(prefix));
  if (matches.length === 0) return { error: `no session id starts with "${prefix}"` };
  if (matches.length > 1) {
    const ids = idColumn(matches.map((s) => s.id));
    const candidates = matches
      .map((session) => `  ${ids.get(session.id)}  ${session.title ?? '(untitled)'}`)
      .join('\n');
    return { error: `"${prefix}" matches ${matches.length} sessions:\n${candidates}` };
  }
  return { session: matches[0]! };
}

function isStatus(value: string | undefined): value is SessionStatus {
  return value !== undefined && (STATUSES as readonly string[]).includes(value);
}
