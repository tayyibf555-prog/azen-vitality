/**
 * Run `fn` over `items` with at most `limit` in flight at once — bounded-concurrency
 * fan-out for per-record secondary reads (e.g. a Dentally call per patient). Fast
 * without spiking upstream load past `limit`. Order-independent: `fn` should record
 * its result via a side effect (a Map/array), not rely on the return value.
 *
 * Runs on a single event loop, so the shared index increment is race-free; each
 * item is handed to exactly one worker.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}
