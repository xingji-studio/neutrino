import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface TaskSpec {
  taskId: string;
  revision: number;
  objective: string;
  latestInput: string;
}
export interface TaskOwner { pid: number; instance: string; startedAt: string; leaseId: string }
export interface TaskRecord {
  spec: TaskSpec;
  attemptId: string;
  owner: TaskOwner;
  state: string;
  phase: string;
  at: string;
  reason?: string;
}
interface Transaction {
  version: 1; seq: number; previous: string; record: TaskRecord;
  event: { type: string; data: unknown }; hash: string;
}
export interface RecoverableTool { id: string; runId?: string; name: string; arguments: Record<string, unknown>; result?: string; status?: string }
export class TaskOwnershipError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TaskOwnershipError"; }
}

const INSTANCE = randomUUID();
const STARTED = new Date().toISOString();
const active = new Set<TaskController>();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const continuation = (text: string) => /^(?:开始|继续|接着|接着做|继续做|继续执行|开始吧|继续吧|恢复|重试|go ahead|continue|resume|retry|start)[\s?!？！。.!]*$/i.test(text.trim());
const terminal = (state?: string) => ["completed", "failed", "cancelled", "partial", "blocked", "interrupted"].includes(state ?? "");
const safeToRepeat = new Set(["read_file", "list_files", "web_search", "read_task_evidence", "finish_step", "finish_task", "finish_standard_task"]);

/** EPERM means a process may still exist; uncertainty never permits a second writer. */
export function ownerAlive(owner: TaskOwner): boolean {
  if (owner.pid === process.pid) return owner.instance === INSTANCE;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Single fsynced transaction contains both the state transition and its event.
 * The checksum chain detects corruption; a torn last record is the only suffix
 * recovery may discard. A partial write is never interpreted as a completion.
 */
export class TaskStore {
  readonly file: string;
  record?: TaskRecord;
  readonly tools = new Map<string, RecoverableTool>();
  private seq = 0;
  private digest = "";
  private validBytes = 0;
  private torn = false;

  constructor(readonly directory: string) {
    this.file = path.join(directory, "events.jsonl");
    if (!fs.existsSync(this.file)) return;
    const bytes = fs.readFileSync(this.file);
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0) { this.torn = true; break; }
      const text = bytes.subarray(offset, end).toString("utf8");
      let tx: Transaction;
      try { tx = JSON.parse(text) as Transaction; }
      catch { throw new TaskOwnershipError("task_store_corrupt", `Task transaction is corrupt at byte ${offset}`); }
      const { hash: actual, ...payload } = tx;
      if (tx.version !== 1 || tx.seq !== this.seq + 1 || tx.previous !== this.digest || hash(JSON.stringify(payload)) !== actual) {
        throw new TaskOwnershipError("task_store_corrupt", `Task transaction checksum failed at byte ${offset}`);
      }
      this.apply(tx);
      offset = end + 1;
      this.validBytes = offset;
    }
  }
  private apply(tx: Transaction): void {
    this.seq = tx.seq; this.digest = tx.hash; this.record = tx.record;
    const data = tx.event.data as RecoverableTool;
    if (tx.event.type === "tool_started") this.tools.set(data.id, structuredClone(data));
    if (tx.event.type === "tool_finished") this.tools.set(data.id, structuredClone(data));
    if (tx.event.type === "reconciled") this.tools.set(data.id, structuredClone(data));
  }
  commit(record: TaskRecord, type: string, data: unknown): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (this.torn) { fs.truncateSync(this.file, this.validBytes); this.torn = false; }
    const payload = { version: 1 as const, seq: this.seq + 1, previous: this.digest, record, event: { type, data } };
    const tx = { ...payload, hash: hash(JSON.stringify(payload)) };
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(tx) + "\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    this.apply(tx);
  }
  pendingTools(): RecoverableTool[] { return [...this.tools.values()].filter(tool => !tool.status); }
  unknownTools(): RecoverableTool[] { return this.pendingTools().filter(tool => !safeToRepeat.has(tool.name)); }
}

/** A session lease is acquired before any model/tool execution. A complete
 * owner file is linked atomically; crashed owners are retired once via a
 * permanent lease-id claim, so competing recovery processes cannot unlink a
 * new owner's lock after observing the old owner.
 */
export class TaskController {
  readonly store: TaskStore;
  readonly owner: TaskOwner;
  readonly spec: TaskSpec;
  private record: TaskRecord;
  private released = false;
  private readonly lock: string;
  private heartbeat?: NodeJS.Timeout;

  constructor(directory: string, attemptId: string, input: string,
    previous?: { state: string; spec?: TaskSpec; standard?: { requirements: Array<{ text: string }> } }) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(directory, "owner.lock");
    this.owner = { pid: process.pid, instance: INSTANCE, startedAt: STARTED, leaseId: randomUUID() };
    this.acquire();
    try {
      this.store = new TaskStore(directory);
      const saved = this.store.record;
      const savedSpec = previous?.spec ?? saved?.spec;
      const legacyObjective = previous?.standard?.requirements.map(item => item.text).join("\n\n");
      const oldObjective = savedSpec?.objective ?? legacyObjective;
      const incomplete = (previous?.state ?? saved?.state) !== "completed";
      const reuse = incomplete && !!oldObjective && (continuation(input) || input === savedSpec?.latestInput || input === oldObjective);
      this.spec = reuse ? { ...(savedSpec ?? { taskId: randomUUID(), revision: 1, objective: oldObjective! }), latestInput: input }
        : { taskId: randomUUID(), revision: 1, objective: input, latestInput: input };
      this.record = { spec: this.spec, attemptId, owner: this.owner, state: "running", phase: "starting", at: new Date().toISOString() };
      if (saved && !terminal(saved.state)) {
        this.store.commit({ ...saved, state: "interrupted", phase: "recovery", reason: "owner_lost_unknown", at: this.record.at }, "interrupted", { previousOwner: saved.owner });
      }
      const unknown = this.store.unknownTools();
      if (unknown.length) {
        this.store.commit({ ...this.record, state: "blocked", phase: "reconciling", reason: "tool_outcome_unknown" }, "recovery_blocked",
          { tools: unknown.map(tool => ({ id: tool.id, name: tool.name })) });
        throw new TaskOwnershipError("tool_outcome_unknown", `Recovery requires checking previous tool outcomes before retrying: ${unknown.map(tool => `${tool.name} (${tool.id})`).join(", ")}`);
      }
      for (const tool of this.store.pendingTools()) this.store.commit(this.record, "reconciled", {
        ...tool, status: "cancelled", result: "Interrupted read-only operation; safe to retry in a new attempt",
      });
      this.store.commit(this.record, "attempt_started", { owner: this.owner });
      active.add(this);
      this.heartbeat = setInterval(() => { try { this.event("owner_heartbeat", {}); } catch { /* Runtime checks fail closed before another operation. */ } }, 10_000);
      this.heartbeat.unref();
    } catch (error) { this.release(); throw error; }
  }
  private acquire(): void {
    if (fs.existsSync(this.lock)) {
      let old: TaskOwner;
      try { old = JSON.parse(fs.readFileSync(this.lock, "utf8")) as TaskOwner; }
      catch { throw new TaskOwnershipError("owner_unknown", "Task owner record cannot be verified; automatic takeover is blocked"); }
      if (!old.leaseId || !Number.isSafeInteger(old.pid) || ownerAlive(old)) {
        throw new TaskOwnershipError("task_owned", "This conversation already has an executor; attach to it instead of starting another");
      }
      const claim = path.join(path.dirname(this.lock), `retired-${hash(old.leaseId)}`);
      let fd: number;
      try { fd = fs.openSync(claim, "wx", 0o600); }
      catch { throw new TaskOwnershipError("recovery_in_progress", "Another process is reconciling the previous executor"); }
      fs.closeSync(fd);
      const current = JSON.parse(fs.readFileSync(this.lock, "utf8")) as TaskOwner;
      if (current.leaseId !== old.leaseId) throw new TaskOwnershipError("owner_changed", "Task owner changed during recovery");
      fs.unlinkSync(this.lock);
    }
    const candidate = `${this.lock}.${this.owner.leaseId}`;
    const fd = fs.openSync(candidate, "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.owner)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.linkSync(candidate, this.lock); }
    catch { throw new TaskOwnershipError("task_owned", "This conversation already has an executor"); }
    finally { fs.unlinkSync(candidate); }
  }
  check(): void {
    if (this.released) throw new TaskOwnershipError("attempt_ended", "The task attempt no longer owns execution");
    const current = JSON.parse(fs.readFileSync(this.lock, "utf8")) as TaskOwner;
    if (current.leaseId !== this.owner.leaseId) throw new TaskOwnershipError("owner_changed", "The execution lease changed; old executor is fenced out");
  }
  event(type: string, data: unknown): void {
    this.check();
    const value = data as Record<string, unknown>;
    let phase = this.record.phase;
    if (type === "model_started") phase = "model";
    if (type === "model_progress") phase = "model";
    if (type === "approval_started") phase = "approval";
    if (type === "tool_started") phase = "tool";
    if (type === "tool_finished" || type === "model_finished" || type === "approval_finished" || type === "approval_failed") phase = "executing";
    const state = type === "finished" ? String(value.state) : type === "cancelling" ? "cancelling" : this.record.state;
    if (state === "completed" && this.store.pendingTools().length) throw new TaskOwnershipError("pending_tools", "Pending tool outcomes prevent task completion");
    this.record = { ...this.record, at: new Date().toISOString(), phase, state,
      ...(type === "cancelling" ? { reason: String(value.reason) } : {}) };
    this.store.commit(this.record, type, data);
  }
  finish(state: string, reason?: string): void {
    if (this.released) return;
    try {
      this.check();
      if (state === "completed" && this.store.pendingTools().length) throw new TaskOwnershipError("pending_tools", "Pending tool outcomes prevent task completion");
      this.record = { ...this.record, state, phase: terminal(state) ? "ended" : "recovery", reason, at: new Date().toISOString() };
      this.store.commit(this.record, "attempt_ended", { state, reason });
    } finally { this.release(); }
  }
  private release(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    active.delete(this);
    try {
      if ((JSON.parse(fs.readFileSync(this.lock, "utf8")) as TaskOwner).leaseId === this.owner.leaseId) fs.unlinkSync(this.lock);
    } catch { /* An absent/replaced lease never belongs to this attempt. */ }
    this.released = true;
  }
}

process.on("exit", code => {
  for (const controller of [...active]) {
    try { controller.finish("interrupted", `process_exit:${code}`); } catch { /* A hard failure remains recoverable as unknown. */ }
  }
});
