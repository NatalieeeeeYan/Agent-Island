import type { Session, SessionEvent, SessionStatus, ToolId } from './types.js';

export type SessionFilter = {
  tool?: ToolId;
  status?: SessionStatus;
  /** Only sessions updated at or after this epoch-ms timestamp. */
  since?: number;
};

/**
 * Storage boundary. M1 ships `MemoryStore` only; `SqliteStore` lands in M3
 * (ADR-005). Keeping every consumer behind this interface means swapping the
 * implementation touches exactly one line.
 */
export interface SessionStore {
  upsert(session: Session): void;
  get(id: string): Session | undefined;
  list(filter?: SessionFilter): Session[];
  remove(id: string): boolean;
  recordEvent(event: SessionEvent): void;
  /** Events in arrival order, newest last. Bounded; see `maxEvents`. */
  events(): readonly SessionEvent[];
}

export class MemoryStore implements SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #events: SessionEvent[] = [];
  readonly #maxEvents: number;

  constructor(options: { maxEvents?: number } = {}) {
    this.#maxEvents = options.maxEvents ?? 1000;
  }

  upsert(session: Session): void {
    this.#sessions.set(session.id, session);
  }

  get(id: string): Session | undefined {
    return this.#sessions.get(id);
  }

  list(filter: SessionFilter = {}): Session[] {
    let out = [...this.#sessions.values()];
    if (filter.tool !== undefined) out = out.filter((s) => s.tool === filter.tool);
    if (filter.status !== undefined) out = out.filter((s) => s.status === filter.status);
    if (filter.since !== undefined) {
      const since = filter.since;
      out = out.filter((s) => s.updatedAt >= since);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  remove(id: string): boolean {
    return this.#sessions.delete(id);
  }

  recordEvent(event: SessionEvent): void {
    this.#events.push(event);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  events(): readonly SessionEvent[] {
    return this.#events;
  }
}
