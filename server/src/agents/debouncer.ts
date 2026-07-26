interface Pending<Payload> {
  timer: NodeJS.Timeout;
  payload: Payload;
  waiters: Array<() => void>;
}

/** Keyed trailing-edge debounce that merges payloads and resolves every caller after flush. */
export class Debouncer<Key, Payload> {
  private pending = new Map<Key, Pending<Payload>>();

  constructor(
    private readonly delayMs: number,
    private readonly merge: (previous: Payload, next: Payload) => Payload,
    private readonly flush: (payload: Payload, key: Key) => Promise<void>
  ) {}

  push(key: Key, payload: Payload): Promise<void> {
    return new Promise((resolve) => {
      const previous = this.pending.get(key);
      if (previous) clearTimeout(previous.timer);
      const waiters = previous?.waiters ?? [];
      waiters.push(resolve);
      const merged = previous ? this.merge(previous.payload, payload) : payload;
      const timer = setTimeout(() => void this.run(key), this.delayMs);
      this.pending.set(key, { timer, payload: merged, waiters });
    });
  }

  private async run(key: Key): Promise<void> {
    const batch = this.pending.get(key);
    if (!batch) return;
    this.pending.delete(key);
    try {
      await this.flush(batch.payload, key);
    } finally {
      for (const resolve of batch.waiters) resolve();
    }
  }
}
