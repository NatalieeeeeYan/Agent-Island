/**
 * Coalesce rapid repeats per key. An active agent appends to its transcript
 * many times a second; without this every write would trigger a re-read.
 */
export function debounceByKey(
  fn: (key: string) => void,
  waitMs: number,
): { call(key: string): void; cancelAll(): void } {
  const timers = new Map<string, NodeJS.Timeout>();

  return {
    call(key: string): void {
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          fn(key);
        }, waitMs),
      );
    },
    cancelAll(): void {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
