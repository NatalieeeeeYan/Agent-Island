#!/usr/bin/env node
/**
 * Agent Island hook relay.
 *
 * Usage: island-hook.mjs <tool-id> [event-name]
 *
 * Reads a hook payload on stdin, forwards a thin envelope to the local Island
 * endpoint, prints nothing, and exits 0 — always.
 *
 * This script runs on every tool call of every session on the machine. It is
 * therefore written to be incapable of affecting the agent: any failure, any
 * slow endpoint, any malformed input results in a silent successful exit. Do
 * not add behaviour here that an agent could come to depend on.
 */

const ENDPOINT = process.env.AGENT_ISLAND_URL ?? 'http://127.0.0.1:7821/hook';
const TIMEOUT_MS = Number(process.env.AGENT_ISLAND_TIMEOUT_MS ?? 2000);

const tool = process.argv[2] ?? 'unknown';
const eventFromArgv = process.argv[3];

// Nothing this script does is allowed to surface as a failure.
process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

try {
  await main();
} catch {
  // Fall through to the exit below.
}
process.exit(0);

async function main() {
  const input = parseJson(await readStdin());

  const envelope = {
    tool,
    event: eventFromArgv ?? pick(input, 'hook_event_name', 'hookEventName') ?? 'unknown',
    sessionId: pick(input, 'session_id', 'sessionId'),
    cwd: pick(input, 'cwd'),
    toolName: pick(input, 'tool_name', 'toolName'),
    toolUseId: pick(input, 'tool_use_id', 'toolUseId'),
    receivedAt: Date.now(),
  };

  // Without a session id there is nothing to correlate against; drop it.
  if (!envelope.sessionId) return;

  await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

function readStdin() {
  return new Promise((resolve) => {
    // If nothing is piped in, don't hang the agent waiting for EOF.
    const timer = setTimeout(() => resolve(''), TIMEOUT_MS);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function pick(source, ...keys) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}
