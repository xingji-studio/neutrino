/** Serialize human prompts without overwriting an unresolved decision. */
export class ApprovalQueue {
  private active = false;
  private waiting: Array<{ run(): void; cancel(): void }> = [];

  run(start: () => Promise<boolean | null>, signal?: AbortSignal): Promise<boolean | null> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { resolve(false); return; }
      const item = {
        cancel: () => {
          const index = this.waiting.indexOf(item);
          if (index >= 0) {
            this.waiting.splice(index, 1);
            signal?.removeEventListener("abort", item.cancel);
            resolve(false);
          }
        },
        run: () => {
          signal?.removeEventListener("abort", item.cancel);
          if (signal?.aborted) { this.next(); resolve(false); return; }
          this.active = true;
          let result: Promise<boolean | null>;
          try { result = start(); } catch (error) { this.next(); reject(error); return; }
          result.then(value => { this.next(); resolve(value); }, error => { this.next(); reject(error); });
        },
      };
      if (this.active) { this.waiting.push(item); signal?.addEventListener("abort", item.cancel, { once: true }); }
      else item.run();
    });
  }

  cancelWaiting(): void {
    for (const item of [...this.waiting]) item.cancel();
  }

  private next(): void {
    const next = this.waiting.shift();
    if (next) next.run();
    else this.active = false;
  }
}
