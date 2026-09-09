/**
 * Core domain types for Agent Island.
 *
 * Nothing in `src/core` may import electron — the backend has to stay runnable
 * under plain `node` so it can be developed and tested headlessly.
 */

/** Stable identifier for a supported tool. Adapters are keyed by this. */
export type ToolId = 'claude-code' | 'codex' | 'cowork' | 'cursor' | (string & {});

/**
 * Lifecycle of a session as Agent Island understands it.
 *
 * `waiting` is only ever set by a live hook event — a transcript alone cannot
 * distinguish "blocked on approval" from any other pause. Adapters without
 * `liveEvents` must never emit it.
 */
export type SessionStatus = 'running' | 'waiting' | 'idle' | 'complete' | 'error';

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUSD?: number;
};

/** What a session is blocked on. Populated from hook events only. */
export type WaitingOn = {
  toolName: string;
  /** Single-line human summary, e.g. `rm -rf ./dist`. */
  summary: string;
  toolUseId?: string;
  since: number;
};

/** The unified session record every adapter maps its native format into. */
export type Session = {
  id: string;
  tool: ToolId;
  /** Tool-generated title when available; null until the tool produces one. */
  title: string | null;
  cwd: string;
  status: SessionStatus;
  startedAt: number;
  updatedAt: number;
  model?: string;
  gitBranch?: string;
  usage?: Usage;
  waitingOn?: WaitingOn;
  /** Absolute path of the transcript this session was derived from. */
  sourcePath?: string;
};

export type SessionEvent =
  | { kind: 'session_started'; session: Session }
  | { kind: 'session_updated'; session: Session }
  | { kind: 'session_removed'; sessionId: string }
  | { kind: 'adapter_error'; tool: ToolId; message: string };

export type EventSink = (event: SessionEvent) => void;

/**
 * Capabilities are declared, not inferred. The UI branches on these so that a
 * tool which cannot report cost shows no cost field at all — rather than an
 * empty placeholder that reads as "cost zero".
 */
export type AdapterCapabilities = {
  /** Has a parseable transcript on disk. */
  transcript: boolean;
  /** Has a hook system, so state transitions arrive in real time. */
  liveEvents: boolean;
  /** Exposes token counts and/or cost. */
  usage: boolean;
  /** Can intercept approvals (M3). */
  approval: boolean;
};

export type Disposable = { dispose(): void };

export interface AgentAdapter {
  readonly id: ToolId;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;

  /** Is this tool present on the machine? Cheap filesystem check only. */
  detect(): Promise<boolean>;

  /**
   * Backfill history from disk. Called once at startup. Implementations must
   * bound their own work — see `ScanOptions.since`.
   */
  scan(options?: ScanOptions): Promise<Session[]>;

  /** Begin incremental watching. Returns a handle that stops all watchers. */
  watch(emit: EventSink): Disposable;
}

export type ScanOptions = {
  /**
   * Only fully parse transcripts modified at or after this epoch-ms timestamp.
   * Older sessions may be skipped or summarised from an index.
   */
  since?: number;
  /** Hard cap on how many transcripts to fully parse, newest first. */
  limit?: number;
};

/** Normalised shape of an inbound hook event, whatever tool produced it. */
export type HookEvent = {
  tool: ToolId;
  /** Tool-native event name, e.g. `PreToolUse`, `Stop`, `PermissionRequest`. */
  event: string;
  sessionId: string;
  cwd?: string;
  toolName?: string;
  toolUseId?: string;
  payload?: unknown;
  receivedAt: number;
};
