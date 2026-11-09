interface Waiter {
  priority: number;
  order: number;
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** FIFO within priority; resizing never cancels running work or exceeds the new limit. */
export class ResourcePool {
  private active = 0;
  private serial = 0;
  private queue: Waiter[] = [];
  constructor(private capacity: number) {
    this.resize(capacity);
  }
  get running(): number { return this.active; }
  get limit(): number { return this.capacity; }
  resize(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid resource capacity");
    this.capacity = capacity;
    this.pump();
  }
  acquire(signal?: AbortSignal, priority = 0): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error(String(signal.reason ?? "Cancelled")));
    return new Promise((resolve, reject) => {
      const entry: Waiter = { priority, order: this.serial++, resolve, reject, signal };
      entry.abort = () => {
        this.queue = this.queue.filter(value => value !== entry);
        reject(new Error(String(signal?.reason ?? "Cancelled")));
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
      this.pump();
    });
  }
  async run<T>(callback: () => Promise<T>, signal?: AbortSignal, priority = 0): Promise<T> {
    const release = await this.acquire(signal, priority);
    try { return await callback(); } finally { release(); }
  }
  private pump(): void {
    while (this.active < this.capacity && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      this.active++;
      let released = false;
      next.resolve(() => { if (!released) { released = true; this.active--; this.pump(); } });
    }
  }
}
