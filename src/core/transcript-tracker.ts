import { JsonlCursor } from './jsonl.js';

/**
 * Per-file bookkeeping shared by every transcript-backed adapter: remember how
 * far into each JSONL file we have read, and the facts folded so far, so a
 * change event only has to parse the newly appended bytes.
 */
export class TranscriptTracker<F> {
  readonly #files = new Map<string, { cursor: JsonlCursor; facts: F }>();

  constructor(
    private readonly empty: () => F,
    private readonly fold: (rows: readonly unknown[], prev: F) => F,
  ) {}

  /** Read whatever is new in `path` and fold it into that file's facts. */
  async ingest(path: string): Promise<F> {
    let entry = this.#files.get(path);
    if (!entry) {
      entry = { cursor: new JsonlCursor(path), facts: this.empty() };
      this.#files.set(path, entry);
    }
    const rows = await entry.cursor.readNew();
    if (rows.length > 0) entry.facts = this.fold(rows, entry.facts);
    return entry.facts;
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
