import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import chokidar from 'chokidar';

import {
  defaultSidecarRoot,
  loadSidecars,
  type SidecarEntry,
} from '../claude-desktop-sidecar.js';
import { debounceByKey } from '../debounce.js';
import { listJsonl, pathExists, selectForScan } from '../fs-util.js';
import {
  emptyClaudeCodeFacts,
  foldClaudeCodeRows,
  type ClaudeCodeFacts,
} from '../parsers/claude-code.js';
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
  readonly #sidecarRoot: string;
  readonly #tracker = new TranscriptTracker<ClaudeCodeFacts>(
    emptyClaudeCodeFacts,
    foldClaudeCodeRows,
  );
  #sidecars = new Map<string, SidecarEntry>();

  constructor(options: { root?: string; sidecarRoot?: string } = {}) {
    this.#root = options.root ?? join(homedir(), '.claude', 'projects');
    this.#sidecarRoot = options.sidecarRoot ?? defaultSidecarRoot();
  }

  async detect(): Promise<boolean> {
    return pathExists(this.#root);
  }

  async scan(options: ScanOptions = {}): Promise<Session[]> {
    this.#sidecars = await loadSidecars(this.#sidecarRoot);
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

    // Desktop titles arrive in the sidecar, not the transcript, so it needs its
    // own watcher — same shape as the Codex session index.
    const sidecars = chokidar.watch(this.#sidecarRoot, { ignoreInitial: true, depth: 3 });
    const reloadSidecars = debounceByKey(() => {
      void this.#reloadSidecars(emit);
    }, WATCH_DEBOUNCE_MS);
    sidecars.on('add', () => reloadSidecars.call('sidecars'));
    sidecars.on('change', () => reloadSidecars.call('sidecars'));
    // Titles are an enhancement, and this path is absent without Claude Desktop
    // — swallow rather than surface an adapter error, but never leave 'error'
    // unhandled, which would throw.
    sidecars.on('error', () => {});

    return {
      dispose: () => {
        refresh.cancelAll();
        reloadSidecars.cancelAll();
        void watcher.close();
        void sidecars.close();
      },
    };
  }

  /**
   * Desktop writes the sidecar's `title` a few turns in, long after the session
   * first appeared. Reloading the map is not enough — a session that is idle by
   * then would keep its fallback title until the next restart, so every session
   * whose title actually changed is re-emitted.
   */
  async #reloadSidecars(emit: EventSink): Promise<void> {
    const previous = this.#sidecars;
    this.#sidecars = await loadSidecars(this.#sidecarRoot);

    for (const path of this.#tracker.paths()) {
      const facts = this.#tracker.facts(path);
      // No timestamp means no basis for a status — leave it as first scanned.
      if (!facts || facts.lastTimestamp === null) continue;

      const id = facts.sessionId ?? basename(path, '.jsonl');
      if (previous.get(id)?.title === this.#sidecars.get(id)?.title) continue;

      const session = this.#build(facts, path, facts.lastTimestamp);
      if (session) emit({ kind: 'session_updated', session });
    }
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
      title:
        this.#sidecars.get(id)?.title ?? facts.title ?? titleFromMessage(facts.firstUserMessage),
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
