import { JsonlCursor } from './jsonl.js';

/**
 * Per-file bookkeeping shared by every transcript-backed adapter: remember how
 * far into each JSONL file we have read, and the facts folded so far, so a
 * change event only has to parse the newly appended bytes.
 */
export class TranscriptTracker<F> {
  readonly #files = new Map<string, { cursor: JsonlCursor; facts: F; activeAt: number }>();

  constructor(
    private readonly empty: () => F,
    private readonly fold: (rows: readonly unknown[], prev: F) => F,
    /** Last activity according to the folded facts; decides what `prune` drops. */
    private readonly activeAt: (facts: F) => number | null = () => null,
  ) {}

  /** Read whatever is new in `path` and fold it into that file's facts. */
  async ingest(path: string): Promise<F> {
    let entry = this.#files.get(path);
    if (!entry) {
      entry = { cursor: new JsonlCursor(path), facts: this.empty(), activeAt: Date.now() };
      this.#files.set(path, entry);
    }
    const rows = await entry.cursor.readNew();
    if (rows.length > 0) entry.facts = this.fold(rows, entry.facts);
    entry.activeAt = this.activeAt(entry.facts) ?? Date.now();
    return entry.facts;
  }

  /**
   * Drop everything idle since `before`, returning the paths dropped.
   *
   * This is where the memory actually is — a session record is small, the
   * folded facts are not. A pruned file is re-read from the start if it changes
   * again, which is the intended trade: idle sessions cost nothing, and one that
   * wakes up pays a single re-parse.
   */
  prune(before: number): string[] {
    const dropped: string[] = [];
    for (const [path, entry] of this.#files) {
      if (entry.activeAt >= before) continue;
      this.#files.delete(path);
      dropped.push(path);
    }
    return dropped;
  }

  facts(path: string): F | undefined {
    return this.#files.get(path)?.facts;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  forget(path: string): void {
    this.#files.delete(path);
  }

  paths(): string[] {
    return [...this.#files.keys()];
  }
}
