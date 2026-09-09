/**
 * Headless development entry point.
 *
 * Runs the whole backend with no Electron involved and prints the live session
 * stream to the terminal. This is the M1 acceptance harness: start a real
 * Claude Code and Codex session in other terminals and watch the transitions
 * land here.
 */
import { ClaudeCodeAdapter } from '../core/adapters/claude-code.js';
import { CodexAdapter } from '../core/adapters/codex.js';
import { createIsland } from '../core/island.js';
import { DEFAULT_HOOK_PORT } from '../core/hook-server.js';
import type { Session, SessionEvent } from '../core/types.js';

const SCAN_WINDOW_DAYS = 7;

const STATUS_MARK: Record<Session['status'], string> = {
  running: '●',
  waiting: '⏸',
  idle: '○',
  complete: '✓',
  error: '✗',
};

/** Startup backfill is summarised below rather than streamed line by line. */
let streaming = false;

const island = createIsland({
  adapters: [new ClaudeCodeAdapter(), new CodexAdapter()],
  scan: { since: Date.now() - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000, limit: 50 },
});

island.subscribe(print);

await island.start();

const tools = island.activeAdapters.map((a) => a.displayName).join(', ') || 'none';
console.log(`\nAgent Island — headless`);
console.log(`  adapters : ${tools}`);
console.log(`  hooks    : http://127.0.0.1:${DEFAULT_HOOK_PORT}/hook`);
console.log(`  scanned  : ${island.store.list().length} sessions (last ${SCAN_WINDOW_DAYS}d)\n`);

for (const session of island.store.list().slice(0, 10)) {
  console.log(`  ${line(session)}`);
}
console.log('\nwatching… (ctrl-c to stop)\n');
streaming = true;

process.on('SIGINT', () => {
  void island.stop().then(() => process.exit(0));
});

function print(event: SessionEvent): void {
  if (!streaming) return;
  switch (event.kind) {
    case 'session_started':
      console.log(`${clock()} + ${line(event.session)}`);
      break;
    case 'session_updated':
      console.log(`${clock()}   ${line(event.session)}`);
      break;
    case 'session_removed':
      console.log(`${clock()} - ${event.sessionId}`);
      break;
    case 'adapter_error':
      console.error(`${clock()} ! ${event.tool}: ${event.message}`);
      break;
  }
}

function line(session: Session): string {
  const mark = STATUS_MARK[session.status];
  const tool = session.tool.padEnd(11);
  const title = (session.title ?? '(untitled)').slice(0, 42).padEnd(42);
  return `${mark} ${tool} ${title} ${shortCwd(session.cwd)}${usage(session)}`;
}

function usage(session: Session): string {
  const u = session.usage;
  if (!u) return '';
  const cost = u.costUSD !== undefined ? ` $${u.costUSD.toFixed(2)}` : '';
  return `  ${compact(u.outputTokens)} out${cost}`;
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function shortCwd(cwd: string): string {
  if (cwd === '') return '';
  const home = process.env['HOME'];
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function clock(): string {
  return new Date().toTimeString().slice(0, 8);
}
