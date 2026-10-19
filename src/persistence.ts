/** Synchronous session checkpoints, shared by terminal and browser sessions. */
const checkpoints = new Set<SessionCheckpoint>();

/** Bound how much streamed output a hard kill can lose, without writing per token. */
export const CHECKPOINT_MS = 1000;

export class SessionCheckpoint {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly write: () => boolean) {}

  register(): void {
    checkpoints.add(this);
  }

  /** A trailing checkpoint still runs if the provider stalls after one chunk. */
  schedule(): void {
    this.register();
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), CHECKPOINT_MS);
    this.timer.unref();
  }

  flush(): boolean {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.write();
  }

  dispose(): boolean {
    try {
      return this.flush();
    } finally {
      checkpoints.delete(this);
    }
  }
}

/** No promises: exit handlers cannot wait for asynchronous disk writes. */
export function flushSessionCheckpoints(): boolean {
  let saved = true;
  for (const checkpoint of checkpoints) {
    try {
      if (!checkpoint.flush()) saved = false;
    } catch {
      // One broken session must not prevent the others from being saved.
      saved = false;
    }
  }
  return saved;
}
