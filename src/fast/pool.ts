import { performance } from "node:perf_hooks";
import { currentTask } from "../llm/runtime.js";
import type { DiagnosticRecorder, DiagnosticScope } from "../llm/diagnostics.js";

interface Waiter {
  priority: number;
  order: number;
  resolve(release: () => void): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  abort?: () => void;
  diagnostic?: { wait_id: string; queued: number; scope?: DiagnosticScope; metadata?: Record<string, unknown> };
}

/** FIFO within priority; resizing never cancels running work or exceeds the new limit. */
export class ResourcePool {
  private active = 0;
  private serial = 0;
  private queue: Waiter[] = [];
  constructor(private capacity: number, private diagnostics?: DiagnosticRecorder, private resource = "resource") {
    this.resize(capacity);
  }
  get running(): number { return this.active; }
  get limit(): number { return this.capacity; }
  resize(capacity: number): void {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Invalid resource capacity");
    this.capacity = capacity;
    this.diagnostics?.emit("resource_resized", { resource: this.resource, capacity });
    this.pump();
  }
  acquire(signal?: AbortSignal, priority = 0, metadata?: Record<string, unknown>): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new Error(String(signal.reason ?? "Cancelled")));
    return new Promise((resolve, reject) => {
      const entry: Waiter = { priority, order: this.serial++, resolve, reject, signal };
      if (this.diagnostics) {
        const scope = currentTask();
        entry.diagnostic = { wait_id: this.diagnostics.id("wait"), queued: performance.now(),
          scope: scope ? { runId: scope.runId, parentRunId: scope.parentRunId, role: scope.role } : undefined, metadata };
        this.diagnostics.emit("resource_queued", { resource: this.resource, wait_id: entry.diagnostic.wait_id, capacity: this.capacity, active: this.active, ...metadata }, entry.diagnostic.scope);
      }
      entry.abort = () => {
        this.queue = this.queue.filter(value => value !== entry);
        if (entry.diagnostic) this.diagnostics?.emit("resource_cancelled", { resource: this.resource, wait_id: entry.diagnostic.wait_id, wait_ms: performance.now() - entry.diagnostic.queued, ...metadata }, entry.diagnostic.scope);
        reject(new Error(String(signal?.reason ?? "Cancelled")));
      };
      signal?.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
      this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
      this.pump();
    });
  }
  async run<T>(callback: () => Promise<T>, signal?: AbortSignal, priority = 0, metadata?: Record<string, unknown>): Promise<T> {
    const release = await this.acquire(signal, priority, metadata);
    try { return await callback(); } finally { release(); }
  }
  private pump(): void {
    while (this.active < this.capacity && this.queue.length) {
      const next = this.queue.shift()!;
      if (next.abort) next.signal?.removeEventListener("abort", next.abort);
      this.active++;
      if (next.diagnostic) this.diagnostics?.emit("resource_acquired", { resource: this.resource, wait_id: next.diagnostic.wait_id, wait_ms: performance.now() - next.diagnostic.queued, active: this.active, capacity: this.capacity, ...next.diagnostic.metadata }, next.diagnostic.scope);
      let released = false;
      next.resolve(() => { if (!released) { released = true; this.active--;
        if (next.diagnostic) this.diagnostics?.emit("resource_released", { resource: this.resource, wait_id: next.diagnostic.wait_id, active: this.active, ...next.diagnostic.metadata }, next.diagnostic.scope);
        this.pump(); } });
    }
  }
}
