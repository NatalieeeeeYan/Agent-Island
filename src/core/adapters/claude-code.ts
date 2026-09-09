import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import chokidar from 'chokidar';

import { debounceByKey } from '../debounce.js';
import { listJsonl, pathExists, selectForScan } from '../fs-util.js';
import {
  emptyClaudeCodeFacts,
  foldClaudeCodeRows,
  type ClaudeCodeFacts,
} from '../parsers/claude-code.js';
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

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly capabilities: AdapterCapabilities = {
    transcript: true,
    liveEvents: true,
    usage: true,
    approval: true,
  };

  readonly #root: string;
  readonly #tracker = new TranscriptTracker<ClaudeCodeFacts>(
    emptyClaudeCodeFacts,
    foldClaudeCodeRows,
  );

  constructor(options: { root?: string } = {}) {
    this.#root = options.root ?? join(homedir(), '.claude', 'projects');
  }

  async detect(): Promise<boolean> {
    return pathExists(this.#root);
  }

  async scan(options: ScanOptions = {}): Promise<Session[]> {
    const files = selectForScan(await listJsonl(this.#root), options);
    const sessions: Session[] = [];
    for (const file of files) {
      const facts = await this.#tracker.ingest(file.path);
      const session = this.#build(facts, file.path, file.mtimeMs);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  watch(emit: EventSink): Disposable {
    const seen = new Set(this.#tracker.paths());

    const refresh = debounceByKey((path: string) => {
      void this.#refresh(path, seen, emit);
    }, WATCH_DEBOUNCE_MS);

    const watcher = chokidar.watch(this.#root, {
      ignoreInitial: true,
      // <project-dir>/<session>.jsonl
      depth: 2,
      awaitWriteFinish: false,
    });

    watcher.on('add', (path) => {
      if (path.endsWith('.jsonl')) refresh.call(path);
    });
    watcher.on('change', (path) => {
      if (path.endsWith('.jsonl')) refresh.call(path);
    });
    watcher.on('unlink', (path) => {
      if (!path.endsWith('.jsonl')) return;
      const facts = this.#tracker.facts(path);
      const id = facts?.sessionId ?? basename(path, '.jsonl');
      this.#tracker.forget(path);
      seen.delete(path);
      emit({ kind: 'session_removed', sessionId: id });
    });
    watcher.on('error', (error) => {
      emit({ kind: 'adapter_error', tool: this.id, message: String(error) });
    });

    return {
      dispose: () => {
        refresh.cancelAll();
        void watcher.close();
      },
    };
  }

  async #refresh(path: string, seen: Set<string>, emit: EventSink): Promise<void> {
    try {
      const isNew = !seen.has(path);
      const facts = await this.#tracker.ingest(path);
      const session = this.#build(facts, path, Date.now());
      if (!session) return;
      seen.add(path);
      emit({ kind: isNew ? 'session_started' : 'session_updated', session });
    } catch (error) {
      emit({ kind: 'adapter_error', tool: this.id, message: String(error) });
    }
  }

  #build(facts: ClaudeCodeFacts, path: string, mtimeMs: number): Session | null {
    const id = facts.sessionId ?? basename(path, '.jsonl');
    const lastActivity = facts.lastTimestamp ?? mtimeMs;

    const session: Session = {
      id,
      tool: this.id,
      title: facts.title,
      cwd: facts.cwd ?? '',
      status: statusFromActivity(lastActivity),
      startedAt: facts.firstTimestamp ?? mtimeMs,
      updatedAt: lastActivity,
      sourcePath: path,
    };
    if (facts.model !== null) session.model = facts.model;
    if (facts.gitBranch !== null) session.gitBranch = facts.gitBranch;
    if (facts.usage !== null) session.usage = facts.usage;
    return session;
  }
}
