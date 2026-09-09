import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * Incremental JSONL reader.
 *
 * Transcripts are append-only, so we remember how many bytes of each file we
 * have already consumed and parse only what is new. Malformed lines are
 * skipped rather than thrown — a transcript being written concurrently will
 * routinely present a torn final line, and a tool upgrade can introduce line
 * shapes we do not know yet (see the format-drift risk in the spec).
 */
export class JsonlCursor {
  #offset = 0;

  constructor(readonly path: string) {}

  get offset(): number {
    return this.#offset;
  }

  /** Skip everything currently on disk, so only future appends are read. */
  async seekToEnd(): Promise<void> {
    this.#offset = await fileSize(this.path);
  }

  /**
   * Read every complete line appended since the last call.
   *
   * A truncated or replaced file (size < offset) resets the cursor and re-reads
   * from the start, which is the only safe interpretation.
   */
  async readNew(): Promise<unknown[]> {
    const size = await fileSize(this.path);
    if (size === this.#offset) return [];
    if (size < this.#offset) this.#offset = 0;

    const start = this.#offset;
    const stream = createReadStream(this.path, { start, encoding: 'utf8' });
    const rows: unknown[] = [];
    let consumed = 0;

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        // +1 for the newline the reader stripped. A final line without a
        // trailing newline is still counted, then re-read next time if it was
        // in fact torn — parse failures make that harmless.
        consumed += Buffer.byteLength(line, 'utf8') + 1;
        const trimmed = line.trim();
        if (trimmed === '') continue;
        try {
          rows.push(JSON.parse(trimmed));
        } catch {
          // Torn or malformed line: skip it.
        }
      }
    } finally {
      rl.close();
      stream.destroy();
    }

    this.#offset = Math.min(start + consumed, size);
    return rows;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** Read a whole JSONL file, skipping malformed lines. */
export async function readJsonl(path: string): Promise<unknown[]> {
  const cursor = new JsonlCursor(path);
  return cursor.readNew();
}
