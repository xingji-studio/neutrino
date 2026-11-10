import path from "node:path";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { linkSignals } from "../llm/runtime.js";
import { ArtifactStore } from "./artifacts.js";
import type { FastTask, FastOutput, FastSettings } from "./types.js";
import type { DiagnosticRecorder } from "../llm/diagnostics.js";

export type TaskDefinition = Omit<FastTask, "status" | "kind" | "attempts" | "generation" | "verifies" | "error" | "needs_repair" | "repair_from"> & { kind?: FastTask["kind"] };
export class FastTaskError extends Error {
  constructor(message: string, readonly sideEffects = false) { super(message); }
}
const verifyId = (id: string) => `${id}.verify`;
const overlaps = (a: string, b: string): boolean => {
  const rel = path.relative(a, b);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
};
function canonical(input: string): string {
  const tail: string[] = []; let cursor = path.resolve(input);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    tail.unshift(path.basename(cursor)); cursor = parent;
  }
  return path.join(fs.realpathSync(cursor), ...tail).toLowerCase();
}
export function withinLease(file: string, roots: string[], cwd: string): boolean {
  const target = canonical(path.resolve(cwd, file));
  return roots.some(root => overlaps(canonical(path.resolve(cwd, root)), target));
}

/** Event driven DAG: a verified dependency unlocks its successors immediately. */
export class DynamicScheduler {
  readonly tasks = new Map<string, FastTask>();
  private running = new Map<string, { promise: Promise<void>; abort: AbortController; generation: number }>();
  private wake?: () => void;
  private change = 0;
  private closed = false;
  private producerError?: Error;
  private cancelled = false;
  private pinned = new Map<string, Record<string, number | string>>();
  private diagnosticWaits = new Map<string, string>();
  schedulingMs = 0;
  retries = 0;
  constructor(readonly store: ArtifactStore, readonly settings: FastSettings, private options: {
    signal?: AbortSignal;
    cwd: string;
    diagnostics?: DiagnosticRecorder;
    execute(task: FastTask, signal: AbortSignal): Promise<FastOutput>;
    onChange?(): void;
    onVerified?(task: FastTask): void;
  }) {}

  add(definition: TaskDefinition): void {
    if (this.plannedTaskCount >= this.settings.maxTasks) throw new Error("Fast task count limit exceeded");
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(definition.task_id) || this.tasks.has(definition.task_id)) throw new Error("Invalid or duplicate task_id");
    this.validate(definition);
    if (["verifies", "needs_repair", "repair_from"].some(key => key in definition)) throw new Error("Planner cannot set runtime verification or repair fields");
    const task: FastTask = { ...structuredClone(definition), kind: definition.kind ?? "work", status: "PENDING", attempts: 0, generation: 0 };
    this.tasks.set(task.task_id, task);
    try { this.checkCycles(); } catch (error) { this.tasks.delete(task.task_id); throw error; }
    this.pinned.set(task.task_id, { ...task.input_versions });
    if (task.kind === "work") this.tasks.set(verifyId(task.task_id), { ...structuredClone(task), task_id: verifyId(task.task_id),
      task_goal: `Verify: ${task.task_goal}`, dependencies: [task.task_id], kind: "verification", verifies: task.task_id,
      // A verifier may run necessary tests, so it holds an exclusive lease if its source can write.
      priority: task.priority + 1, read_only: task.read_only, exclusive: !task.read_only,
    });
    this.options.diagnostics?.emit("task_defined", { task_id: task.task_id, role: task.kind === "verification" ? "verification" : "worker", dependencies: task.dependencies,
      read_only: task.read_only, exclusive: task.exclusive, write_scope_count: task.write_paths.length });
    if (task.kind === "work") this.options.diagnostics?.emit("task_defined", { task_id: verifyId(task.task_id), role: "verification", verifies: task.task_id,
      dependencies: [task.task_id], read_only: task.read_only, exclusive: !task.read_only, write_scope_count: task.write_paths.length });
    this.notify();
  }

  update(id: string, dependencies: string[], reason: string): void {
    const task = this.planned(id);
    this.validate({ ...task, dependencies });
    const previous = task.dependencies;
    task.dependencies = [...dependencies];
    try { this.checkCycles(); } catch (error) { task.dependencies = previous; throw error; }
    this.pinned.set(id, {});
    this.invalidate(id, reason);
  }

  invalidate(id: string, reason: string): void {
    this.planned(id);
    const affected = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasks.values()) {
        if (!task.verifies && !affected.has(task.task_id) && task.dependencies.some(dep => affected.has(dep))) {
          affected.add(task.task_id); changed = true;
        }
      }
    }
    for (const key of affected) {
      for (const target of [key, verifyId(key)]) {
        const task = this.tasks.get(target);
        if (!task) continue;
        if (!task.read_only && !task.verifies && (task.attempts > 0 || this.store.latest(target)?.side_effects)) {
          task.needs_repair = true;
        }
        task.generation++;
        task.status = "INVALIDATED";
        task.error = reason;
        task.attempts = 0;
        this.running.get(target)?.abort.abort(`Invalidated: ${reason}`);
        this.store.invalidate(target);
      }
    }
    this.notify();
  }

  /** A repair is a new explicit task accounting for prior side effects, followed by original acceptance checks. */
  repair(id: string, replacement: string, reason: string): void {
    const task = this.planned(id);
    if (id === replacement || !/^[a-zA-Z0-9_-]{1,80}$/.test(replacement)) throw new Error("Invalid repair task");
    // An additional check must retain the original inputs as well as the repair evidence.
    const dependencies = task.kind === "verification" ? [...new Set([...task.dependencies, replacement])] : [replacement];
    this.update(id, dependencies, reason);
    task.repair_from = replacement;
    task.needs_repair = false;
    this.notify();
  }

  get plannedTaskCount(): number { return [...this.tasks.values()].filter(task => !task.verifies).length; }

  snapshot(): FastTask[] { return structuredClone([...this.tasks.values()]); }
  get successful(): boolean { return this.tasks.size > 0 && [...this.tasks.values()].every(t => t.status === "COMPLETED"); }
  get failed(): FastTask[] { return this.snapshot().filter(t => ["FAILED", "BLOCKED"].includes(t.status)); }

  async run(produce: (scheduler: DynamicScheduler) => Promise<void>): Promise<void> {
    this.closed = false;
    this.producerError = undefined;
    this.cancelled = false;
    const abort = () => {
      this.cancelled = true;
      for (const entry of this.running.values()) entry.abort.abort(this.options.signal?.reason);
      this.notify();
    };
    this.options.signal?.addEventListener("abort", abort, { once: true });
    if (this.options.signal?.aborted) abort();
    const producer = Promise.resolve().then(() => produce(this)).catch(error => {
      this.producerError = error instanceof Error ? error : new Error(String(error));
      this.cancelled = true;
      for (const entry of this.running.values()) entry.abort.abort(this.producerError);
    }).finally(() => { this.closed = true; this.notify(); });
    try {
      while (true) {
        const revision = this.change;
        if (!this.cancelled) this.schedule();
        if (this.cancelled && !this.running.size) break;
        if (this.closed && !this.running.size) {
          for (const task of this.tasks.values()) {
            if (!["COMPLETED", "FAILED"].includes(task.status)) {
              task.status = "BLOCKED";
              task.error ||= "Dependency missing, failed, or invalidated; replan required";
            }
          }
          this.notify();
          break;
        }
        if (revision === this.change) await new Promise<void>(resolve => { this.wake = resolve; });
      }
      await producer;
      if (this.producerError) throw this.producerError;
    } finally {
      for (const entry of this.running.values()) entry.abort.abort("Scheduler stopped");
      await Promise.allSettled([...this.running.values()].map(entry => entry.promise));
      if (this.cancelled) for (const task of this.tasks.values()) {
        if (!["COMPLETED", "FAILED"].includes(task.status)) {
          if (!task.read_only && !task.verifies && task.attempts > 0) task.needs_repair = true;
          task.status = "BLOCKED"; task.error ||= "Execution cancelled";
        }
      }
      this.options.signal?.removeEventListener("abort", abort);
      this.notify();
    }
  }

  private schedule(): void {
    const start = performance.now();
    for (const task of this.tasks.values()) {
      if (task.needs_repair || this.running.has(task.task_id) || !["PENDING", "INVALIDATED", "BLOCKED", "READY"].includes(task.status)) continue;
      const ready = task.verifies
        ? this.tasks.get(task.verifies)?.status === "VERIFYING" && this.store.latest(task.verifies)?.verification === "pending"
        : task.dependencies.every(dep => this.tasks.get(dep)?.status === "COMPLETED" && this.store.latest(dep)?.verification === "verified");
      if (ready && !task.verifies) {
        const actual = this.versions(task);
        if (Object.entries(this.pinned.get(task.task_id) ?? {}).some(([key, version]) => actual[key] !== version)) {
          task.status = "BLOCKED"; task.error = "Pinned input version mismatch; update dependencies or replan before execution"; continue;
        }
      }
      if (ready && task.status !== "READY") this.options.diagnostics?.emit("task_ready", { task_id: task.task_id, generation: task.generation });
      task.status = ready ? "READY" : task.status === "READY" ? "PENDING" : task.status;
    }
    const ready = [...this.tasks.values()].filter(t => t.status === "READY" && !this.running.has(t.task_id))
      .sort((a, b) => b.priority - a.priority || b.estimated_duration - a.estimated_duration);
    for (const task of ready) {
      if (this.running.size >= this.settings.workerSlots) {
        this.options.diagnostics?.emit("worker_capacity_wait", { task_id: task.task_id, active: this.running.size, capacity: this.settings.workerSlots });
        break;
      }
      const blocker = [...this.running.keys()].find(id => this.conflicts(task, this.tasks.get(id)!));
      if (blocker) {
        if (this.options.diagnostics && this.diagnosticWaits.get(task.task_id) !== blocker) {
          this.diagnosticWaits.set(task.task_id, blocker);
          this.options.diagnostics.emit("workspace_wait", { task_id: task.task_id, blocker_ids: [blocker],
            exclusive: task.exclusive, blocker_exclusive: this.tasks.get(blocker)!.exclusive });
        }
        continue;
      }
      this.launch(task);
    }
    this.schedulingMs += performance.now() - start;
  }

  private launch(task: FastTask): void {
    task.status = task.kind === "verification" ? "VERIFYING" : "RUNNING";
    task.attempts++;
    this.diagnosticWaits.delete(task.task_id);
    this.options.diagnostics?.emit("workspace_acquired", { task_id: task.task_id, role: task.kind === "verification" ? "verification" : "worker",
      generation: task.generation, attempt: task.attempts, read_only: task.read_only, exclusive: task.exclusive });
    const generation = task.generation;
    task.input_versions = this.versions(task);
    const abort = new AbortController();
    const linked = linkSignals(abort.signal, this.options.signal);
    // Timeout aborts the underlying request/command; the lease is held until it drains.
    const timer = setTimeout(() => abort.abort("Fast task timed out"), this.settings.taskTimeoutMs);
    const promise = Promise.resolve().then(async () => {
      try {
        const repaired = task.kind === "work" && task.repair_from ? this.store.latest(task.repair_from) : undefined;
        const output = repaired?.verification === "verified" ? repaired : await this.options.execute(structuredClone(task), linked.signal);
        if (generation !== task.generation || this.cancelled) return;
        if (linked.signal.aborted) throw new FastTaskError(String(linked.signal.reason), output.side_effects);
        if (JSON.stringify(task.input_versions) !== JSON.stringify(this.versions(task))) {
          this.invalidate(task.verifies ?? task.task_id, "Input version changed during execution"); return;
        }
        this.store.put(task.task_id, output, task.input_versions);
        if (task.kind === "work") task.status = "VERIFYING";
        else {
          if (output.verification_passed !== true || output.unresolved.length) throw new FastTaskError("Local verification failed", output.side_effects);
          this.store.verify(task.task_id);
          if (task.verifies) this.store.verify(task.verifies);
          const source = task.verifies ? this.planned(task.verifies) : task;
          source.status = "VERIFIED";
          this.notify();
          source.status = "COMPLETED";
          task.status = "COMPLETED";
          this.options.diagnostics?.emit("artifact_verified", { task_id: source.task_id, generation: source.generation });
          this.options.onVerified?.(structuredClone(source));
        }
        task.error = undefined;
      } catch (error) {
        if (generation !== task.generation || this.cancelled) return;
        task.error = error instanceof Error ? error.message : String(error);
        const safe = task.read_only && !(error instanceof FastTaskError && error.sideEffects);
        if (safe && task.attempts <= this.settings.retries && !this.options.signal?.aborted) {
          task.status = "PENDING"; this.retries++;
        } else {
          task.status = "FAILED";
          if (task.verifies) { const source = this.planned(task.verifies); source.status = "FAILED"; source.error = task.error; }
        }
      } finally {
        clearTimeout(timer);
        linked.dispose();
        this.running.delete(task.task_id);
        this.options.diagnostics?.emit("workspace_released", { task_id: task.task_id, generation, status: task.status });
        this.notify();
      }
    });
    this.running.set(task.task_id, { promise, abort, generation });
    this.notify();
  }

  private versions(task: FastTask): Record<string, number | string> {
    const versions: Record<string, number | string> = Object.create(null);
    for (const key of ["request", "history", ...task.required_context]) {
      const context = this.store.readContext(key);
      if (context) versions[key] = context.version;
    }
    for (const id of task.dependencies) {
      const artifact = this.store.latest(id);
      if (artifact) versions[id] = artifact.version;
    }
    return versions;
  }
  private conflicts(a: FastTask, b: FastTask): boolean {
    // Readers must also be isolated from writers: file content is not a versioned artifact.
    if (a.read_only && b.read_only) return false;
    if (a.exclusive || b.exclusive || a.read_only || b.read_only) return true;
    const paths = (task: FastTask) => task.write_paths.map(p => canonical(path.resolve(this.options.cwd, p)));
    return paths(a).some(left => paths(b).some(right => overlaps(left, right) || overlaps(right, left)));
  }
  private validate(task: TaskDefinition): void {
    if (!task || typeof task.task_goal !== "string" || !task.task_goal.trim() ||
        typeof task.output_contract !== "string" || !task.output_contract.trim() || !Array.isArray(task.acceptance_criteria) || !task.acceptance_criteria.length ||
        (task.kind !== undefined && task.kind !== "work" && task.kind !== "verification") ||
        !Array.isArray(task.dependencies) || !Array.isArray(task.required_context) || !Array.isArray(task.write_paths) ||
        task.dependencies.some(dep => typeof dep !== "string" || dep === task.task_id || !/^[a-zA-Z0-9_-]{1,80}$/.test(dep)) ||
        task.acceptance_criteria.some(c => typeof c !== "string" || !c.trim()) ||
        task.required_context.some(c => typeof c !== "string") || task.write_paths.some(p => typeof p !== "string" || !p.trim()) ||
        !task.input_versions || typeof task.input_versions !== "object" || Array.isArray(task.input_versions) ||
        Object.values(task.input_versions).some(v => typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v))) ||
        task.required_context.some(c => !["request", "history", ...task.dependencies].includes(c) && !this.store.readContext(c)) ||
        !Number.isFinite(task.priority) || !Number.isFinite(task.estimated_duration) || task.estimated_duration < 0 ||
        typeof task.read_only !== "boolean" || typeof task.exclusive !== "boolean" ||
        (!task.read_only && !task.exclusive && !task.write_paths.length) ||
        (task.kind === "verification" && (!task.dependencies.length || (!task.read_only && !task.exclusive)))) throw new Error("Incomplete Fast task definition");
  }
  private planned(id: string): FastTask {
    const task = this.tasks.get(id);
    if (!task || task.verifies) throw new Error(`Unknown planned task: ${id}`);
    return task;
  }
  private checkCycles(): void {
    const visiting = new Set<string>(), done = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new Error("Cyclic Fast task dependencies");
      if (done.has(id) || !this.tasks.has(id)) return;
      visiting.add(id);
      for (const dep of this.tasks.get(id)!.dependencies) visit(dep);
      visiting.delete(id); done.add(id);
    };
    for (const task of this.tasks.values()) if (!task.verifies) visit(task.task_id);
  }
  private notify(): void { this.change++; this.wake?.(); this.wake = undefined; this.options.onChange?.(); }
}
