import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import chokidar from 'chokidar';

import { debounceByKey } from '../debounce.js';
import { listJsonl, pathExists, selectForScan } from '../fs-util.js';
import { readJsonl } from '../jsonl.js';
import {
  emptyCodexFacts,
  foldCodexRows,
  parseCodexIndex,
  type CodexFacts,
  type CodexIndexEntry,
} from '../parsers/codex.js';
import { titleFromMessage } from '../parsers/util.js';
import { statusFromActivity } from '../status.js';
import { TranscriptTracker } from '../transcript-tracker.js';
import type {
  AgentAdapter,
  AdapterCapabilities,
  Disposable,
  EventSink,
  ScanOptions,
  Session,
} from '../types.js';

const WATCH_DEBOUNCE_MS = 200;
const UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex';
  readonly capabilities: AdapterCapabilities = {
    transcript: true,
    liveEvents: true,
    // Token counts only — Codex reports no dollar cost.
    usage: true,
    approval: true,
  };

  readonly #home: string;
  readonly #sessionsRoot: string;
  readonly #indexPath: string;
  readonly #tracker = new TranscriptTracker<CodexFacts>(
    emptyCodexFacts,
    foldCodexRows,
    (facts) => facts.lastTimestamp,
  );
  #index = new Map<string, CodexIndexEntry>();
  /** Paths already reported, so a re-appearance is announced as a new session. */
  readonly #seen = new Set<string>();

  constructor(options: { home?: string } = {}) {
    this.#home = options.home ?? join(homedir(), '.codex');
    this.#sessionsRoot = join(this.#home, 'sessions');
    this.#indexPath = join(this.#home, 'session_index.jsonl');
  }

  async detect(): Promise<boolean> {
    return pathExists(this.#sessionsRoot);
  }

  async scan(options: ScanOptions = {}): Promise<Session[]> {
    await this.#loadIndex();
    const files = selectForScan(await listJsonl(this.#sessionsRoot), options);
    const sessions: Session[] = [];
    for (const file of files) {
      const facts = await this.#tracker.ingest(file.path);
      const session = this.#build(facts, file.path, file.mtimeMs);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  /** Idle transcripts cost memory in the tracker, not in the store. */
  forget(before: number): void {
    for (const path of this.#tracker.prune(before)) this.#seen.delete(path);
  }

  watch(emit: EventSink): Disposable {
    for (const path of this.#tracker.paths()) this.#seen.add(path);

    const refresh = debounceByKey((path: string) => {
      void this.#refresh(path, emit);
    }, WATCH_DEBOUNCE_MS);

    const rollouts = chokidar.watch(this.#sessionsRoot, {
      ignoreInitial: true,
      // sessions/YYYY/MM/DD/rollout-*.jsonl
      depth: 4,
      awaitWriteFinish: false,
    });

    rollouts.on('add', (path) => {
      if (path.endsWith('.jsonl')) refresh.call(path);
    });
    rollouts.on('change', (path) => {
      if (path.endsWith('.jsonl')) refresh.call(path);
    });
    rollouts.on('unlink', (path) => {
      if (!path.endsWith('.jsonl')) return;
      const id = this.#tracker.facts(path)?.sessionId ?? sessionIdFromFilename(path);
      this.#tracker.forget(path);
      this.#seen.delete(path);
      emit({ kind: 'session_removed', sessionId: id });
    });
    rollouts.on('error', (error) => {
      emit({ kind: 'adapter_error', tool: this.id, message: String(error) });
    });

    // Titles live in the index, not the rollout, so it needs its own watcher.
    const index = chokidar.watch(this.#indexPath, { ignoreInitial: true });
    const reloadIndex = debounceByKey(() => {
      void this.#loadIndex();
    }, WATCH_DEBOUNCE_MS);
    index.on('change', () => reloadIndex.call('index'));
    index.on('add', () => reloadIndex.call('index'));

    return {
      dispose: () => {
        refresh.cancelAll();
        reloadIndex.cancelAll();
        void rollouts.close();
        void index.close();
      },
    };
  }

  async #loadIndex(): Promise<void> {
    try {
      this.#index = parseCodexIndex(await readJsonl(this.#indexPath));
    } catch {
      // Index is an optimisation for titles; sessions still work without it.
    }
  }

  async #refresh(path: string, emit: EventSink): Promise<void> {
    try {
      const isNew = !this.#seen.has(path);
      const facts = await this.#tracker.ingest(path);
      const session = this.#build(facts, path, Date.now());
      if (!session) return;
      this.#seen.add(path);
      emit({ kind: isNew ? 'session_started' : 'session_updated', session });
    } catch (error) {
      emit({ kind: 'adapter_error', tool: this.id, message: String(error) });
    }
  }

  #build(facts: CodexFacts, path: string, mtimeMs: number): Session | null {
    const id = facts.sessionId ?? sessionIdFromFilename(path);
    const entry = this.#index.get(id);
    const lastActivity = facts.lastTimestamp ?? entry?.updatedAt ?? mtimeMs;

    const session: Session = {
      id,
      tool: this.id,
      // Codex Desktop never registers in the index, so fall back to the prompt.
      title: entry?.threadName ?? titleFromMessage(facts.lastUserMessage),
      cwd: facts.cwd ?? '',
      status: facts.lastError !== null ? 'error' : statusFromActivity(lastActivity),
      startedAt: facts.firstTimestamp ?? mtimeMs,
      updatedAt: lastActivity,
      sourcePath: path,
    };
    if (facts.model !== null) session.model = facts.model;
    if (facts.usage !== null) session.usage = facts.usage;
    if (facts.lastReply !== null) session.lastReply = facts.lastReply;
    return session;
  }
}

/** `rollout-2026-08-25T18-07-29-<uuid>.jsonl` → `<uuid>`. */
export function sessionIdFromFilename(path: string): string {
  const stem = basename(path, '.jsonl');
  return UUID_SUFFIX.exec(stem)?.[1] ?? stem;
}
