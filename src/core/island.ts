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
export const HOOK_STATUS: Record<string, SessionStatus | undefined> = {
  // Claude Code
  SessionStart: 'running',
  UserPromptSubmit: 'running',
  PreToolUse: 'running',
  PostToolUse: 'running',
  // Fires when Claude Code needs the user's attention, permission prompts included.
  Notification: 'waiting',
  Stop: 'idle',
  // Codex — a dedicated approval event, more precise than anything above.
  PermissionRequest: 'waiting',
};

/**
 * A session ends when its tool says so — the only exact signal available.
 * Anything else would be a guess about a terminal we cannot see.
 */
export const ENDS_SESSION = new Set(['SessionEnd']);

/**
 * How long a session with no activity stays on the island.
 *
 * Island reads files, not processes: a terminal closed yesterday and one open
 * but untouched look identical on disk. So liveness is approximated by recent
 * writes, with `SessionEnd` making the common case (you quit) exact. A session
 * dropped here comes back complete the moment its transcript changes again, at
 * the cost of one re-parse.
 */
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export type IslandOptions = {
  adapters: AgentAdapter[];
  store?: SessionStore;
  hookPort?: number;
  /** Passed to every adapter's `scan()` at startup. */
  scan?: ScanOptions;
  /** Idle time after which a session is dropped. Defaults to 24h. */
  retentionMs?: number;
};

export type Island = {
  readonly store: SessionStore;
  /** Adapters that passed `detect()`. Populated by `start()`. */
  readonly activeAdapters: readonly AgentAdapter[];
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: EventSink): () => void;
  /** Drop idle sessions now rather than waiting for the timer. */
  sweep(now?: number): void;
};

export function createIsland(options: IslandOptions): Island {
  const store = options.store ?? new MemoryStore();
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const listeners = new Set<EventSink>();
  const watchers: Disposable[] = [];
  const active: AgentAdapter[] = [];
  let hookServer: ReturnType<typeof createHookServer> | null = null;
  let sweeper: ReturnType<typeof setInterval> | null = null;

  // Subscribers see what the store holds, not what the adapter proposed: the
  // two differ wherever `mergeSession` protects a hook-set state, and a UI fed
  // the pre-merge event would contradict the very store it renders from.
  const emit: EventSink = (event) => {
    const applied = applyToStore(store, event);
    store.recordEvent(applied);
    for (const listener of listeners) listener(applied);
  };

  function sweep(now: number = Date.now()): void {
    const cutoff = now - retentionMs;
    for (const session of store.list()) {
      if (session.updatedAt >= cutoff) continue;
      emit({ kind: 'session_removed', sessionId: session.id });
    }
    // The store holds small records; the adapters hold the folded transcripts.
    for (const adapter of active) adapter.forget(cutoff);
  }

  return {
    store,
    sweep,
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
          // The tool saying it is done beats any timeout we could pick.
          if (ENDS_SESSION.has(hookEvent.event)) {
            if (store.get(hookEvent.sessionId)) {
              emit({ kind: 'session_removed', sessionId: hookEvent.sessionId });
            }
            return;
          }
          const updated = applyHookEvent(store, hookEvent);
          if (updated) emit({ kind: 'session_updated', session: updated });
        },
      });
      await hookServer.listen();

      sweeper = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
      sweeper.unref?.();
    },

    async stop(): Promise<void> {
      for (const watcher of watchers) watcher.dispose();
      watchers.length = 0;
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      await hookServer?.close();
      hookServer = null;
    },

    subscribe(listener: EventSink): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Applies the event and returns it as stored — see `emit`. */
function applyToStore(store: SessionStore, event: SessionEvent): SessionEvent {
  switch (event.kind) {
    case 'session_started':
    case 'session_updated': {
      const existing = store.get(event.session.id);
      // A transcript re-read must not clobber a `waiting` set by a hook: the
      // file keeps changing while the agent sits at an approval prompt.
      const session = existing ? mergeSession(existing, event.session) : event.session;
      store.upsert(session);
      return { ...event, session };
    }
    case 'session_removed': {
      store.remove(event.sessionId);
      return event;
    }
    case 'adapter_error':
      return event;
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
