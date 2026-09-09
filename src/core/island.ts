import { createHookServer, DEFAULT_HOOK_PORT } from './hook-server.js';
import { MemoryStore, type SessionStore } from './store.js';
import type {
  AgentAdapter,
  Disposable,
  EventSink,
  HookEvent,
  ScanOptions,
  Session,
  SessionEvent,
  SessionStatus,
} from './types.js';

/**
 * Status implied by a hook event.
 *
 * This is the only source of `waiting` and `complete` — see `status.ts` for why
 * a transcript alone cannot supply them. Events not listed here carry no status
 * meaning and leave the session as-is.
 */
const HOOK_STATUS: Record<string, SessionStatus | undefined> = {
  // Claude Code
  SessionStart: 'running',
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  // Fires when Claude Code needs the user's attention, permission prompts included.
  Notification: 'waiting',
  Stop: 'idle',
  SessionEnd: 'complete',
  // Codex — a dedicated approval event, more precise than anything above.
  PermissionRequest: 'waiting',
};

export type IslandOptions = {
  adapters: AgentAdapter[];
  store?: SessionStore;
  hookPort?: number;
  /** Passed to every adapter's `scan()` at startup. */
  scan?: ScanOptions;
};

export type Island = {
  readonly store: SessionStore;
  /** Adapters that passed `detect()`. Populated by `start()`. */
  readonly activeAdapters: readonly AgentAdapter[];
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: EventSink): () => void;
};

export function createIsland(options: IslandOptions): Island {
  const store = options.store ?? new MemoryStore();
  const listeners = new Set<EventSink>();
  const watchers: Disposable[] = [];
  const active: AgentAdapter[] = [];
  let hookServer: ReturnType<typeof createHookServer> | null = null;

  const emit: EventSink = (event) => {
    applyToStore(store, event);
    store.recordEvent(event);
    for (const listener of listeners) listener(event);
  };

  return {
    store,
    get activeAdapters(): readonly AgentAdapter[] {
      return active;
    },

    async start(): Promise<void> {
      for (const adapter of options.adapters) {
        let present = false;
        try {
          present = await adapter.detect();
        } catch (error) {
          emit({ kind: 'adapter_error', tool: adapter.id, message: String(error) });
        }
        if (!present) continue;
        active.push(adapter);

        try {
          for (const session of await adapter.scan(options.scan)) {
            emit({ kind: 'session_started', session });
          }
        } catch (error) {
          emit({ kind: 'adapter_error', tool: adapter.id, message: String(error) });
        }

        watchers.push(adapter.watch(emit));
      }

      hookServer = createHookServer({
        port: options.hookPort ?? DEFAULT_HOOK_PORT,
        onEvent: (hookEvent) => {
          const updated = applyHookEvent(store, hookEvent);
          if (updated) emit({ kind: 'session_updated', session: updated });
        },
      });
      await hookServer.listen();
    },

    async stop(): Promise<void> {
      for (const watcher of watchers) watcher.dispose();
      watchers.length = 0;
      await hookServer?.close();
      hookServer = null;
    },

    subscribe(listener: EventSink): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function applyToStore(store: SessionStore, event: SessionEvent): void {
  switch (event.kind) {
    case 'session_started':
    case 'session_updated': {
      const existing = store.get(event.session.id);
      // A transcript re-read must not clobber a `waiting` set by a hook: the
      // file keeps changing while the agent sits at an approval prompt.
      store.upsert(existing ? mergeSession(existing, event.session) : event.session);
      break;
    }
    case 'session_removed': {
      store.remove(event.sessionId);
      break;
    }
    case 'adapter_error':
      break;
  }
}

function mergeSession(existing: Session, incoming: Session): Session {
  const merged: Session = { ...existing, ...incoming };
  if (existing.waitingOn && incoming.waitingOn === undefined) {
    merged.waitingOn = existing.waitingOn;
    merged.status = 'waiting';
  }
  // The tool's own title is authoritative once it exists; don't regress to null.
  merged.title = incoming.title ?? existing.title;
  return merged;
}

/**
 * Fold a hook event into the stored session. Returns the updated session, or
 * null when the event refers to a session we have not seen on disk yet.
 */
export function applyHookEvent(store: SessionStore, event: HookEvent): Session | null {
  const existing = store.get(event.sessionId);
  if (!existing) return null;

  const status = HOOK_STATUS[event.event];
  const updated: Session = { ...existing, updatedAt: event.receivedAt };
  if (status) updated.status = status;

  if (status === 'waiting') {
    updated.waitingOn = {
      toolName: event.toolName ?? event.event,
      summary: event.toolName ?? event.event,
      since: event.receivedAt,
      ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
    };
  } else if (existing.waitingOn) {
    delete updated.waitingOn;
  }

  store.upsert(updated);
  return updated;
}
