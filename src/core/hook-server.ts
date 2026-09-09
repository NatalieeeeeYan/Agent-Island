import { createServer, type Server } from 'node:http';

import type { HookEvent, ToolId } from './types.js';
import { num, obj, str } from './parsers/util.js';

export const DEFAULT_HOOK_PORT = 7821;

/** Refuse absurd bodies outright; hook payloads are small. */
const MAX_BODY_BYTES = 256 * 1024;

export type HookServerOptions = {
  port?: number;
  host?: string;
  onEvent: (event: HookEvent) => void;
};

/**
 * Local receiver for hook events, bound to loopback only.
 *
 * The contract with the hook scripts is that this endpoint is optional: a hook
 * whose request fails or times out must exit successfully and let the agent
 * proceed. Nothing here may ever become load-bearing for a running agent.
 */
export function createHookServer(options: HookServerOptions): {
  listen(): Promise<number>;
  close(): Promise<void>;
} {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_HOOK_PORT;

  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/hook')) {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const event = normalizeHookEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (event) options.onEvent(event);
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });

    req.on('error', () => res.writeHead(400).end());
  });

  return {
    listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          resolve(port);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Hook scripts post a thin envelope; the tool-native payload rides along
 * untouched so adapters can read fields this layer does not know about.
 */
export function normalizeHookEvent(body: unknown): HookEvent | null {
  const b = obj(body);
  if (!b) return null;

  const tool = str(b['tool']);
  const event = str(b['event']);
  const sessionId = str(b['sessionId']) ?? str(b['session_id']);
  if (!tool || !event || !sessionId) return null;

  const normalized: HookEvent = {
    tool: tool as ToolId,
    event,
    sessionId,
    receivedAt: num(b['receivedAt']) ?? Date.now(),
  };

  const cwd = str(b['cwd']);
  const toolName = str(b['toolName']) ?? str(b['tool_name']);
  const toolUseId = str(b['toolUseId']) ?? str(b['tool_use_id']);
  if (cwd) normalized.cwd = cwd;
  if (toolName) normalized.toolName = toolName;
  if (toolUseId) normalized.toolUseId = toolUseId;
  if (b['payload'] !== undefined) normalized.payload = b['payload'];

  return normalized;
}
