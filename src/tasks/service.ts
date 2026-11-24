import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { NEUTRINO_DIR, type ApprovalMode, type AgentMode, type Mode, type ModelSelection } from "../config.js";
import type { LiveSnapshot } from "../web/hub.js";
import { TaskStore } from "./controller.js";

export interface TaskServiceStatus {
  protocol: 1; build: string; pid: number; supervisorPid: number; url: string; token: string; startedAt: string;
}
function buildFingerprint(): string {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".js")) hash.update(path.relative(root, file).replaceAll("\\", "/") + "\0").update(fs.readFileSync(file));
    }
  };
  visit(root);
  return hash.digest("hex");
}
export const TASK_SERVICE_BUILD = buildFingerprint();
export interface TaskConnection {
  cwd: string; sessionId?: string | null; clientId?: string; mode?: Mode;
  selection?: ModelSelection; approvalMode?: ApprovalMode; agentMode?: AgentMode; proPreset?: string;
}
export const TASK_SERVICE_STATUS = path.join(NEUTRINO_DIR, "task-service.json");
export const TASK_SERVICE_LOG = path.join(NEUTRINO_DIR, "task-service.log");
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
let starting: Promise<TaskServiceStatus> | undefined;

export function readTaskService(): TaskServiceStatus | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(TASK_SERVICE_STATUS, "utf8")) as TaskServiceStatus;
    const url = new URL(value.url);
    if (value.protocol !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.token.length < 32
      || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return;
    return value;
  } catch { return; }
}

async function healthy(status: TaskServiceStatus): Promise<boolean> {
  try {
    const response = await fetch(`${status.url}/health`, { headers: { Authorization: `Bearer ${status.token}` }, signal: AbortSignal.timeout(1500) });
    return response.ok && (await response.json() as { ok?: boolean }).ok === true;
  } catch { return false; }
}

/** Detached supervised execution, also used with --no-web. No browser listener
 * or global API discovery file is opened/replaced by this private task service.
 */
export async function ensureTaskService(): Promise<TaskServiceStatus> {
  const current = readTaskService();
  if (current && await healthy(current)) {
    if (current.build !== TASK_SERVICE_BUILD) throw new Error("Task service is running a different build. Finish its active tasks before restarting it; automatic replacement is disabled.");
    return current;
  }
  if (starting) return starting;
  starting = (async () => {
    const supervisor = new TaskStore(path.join(NEUTRINO_DIR, "tasks", "supervisor"));
    if (supervisor.record?.state === "blocked" && supervisor.record.reason === "worker_restart_budget_exhausted") {
      throw new Error(`Task service stopped after repeated worker crashes; automatic relaunch is blocked. Inspect ${TASK_SERVICE_LOG}`);
    }
    const child = spawn(process.execPath, [fileURLToPath(new URL("./worker.js", import.meta.url)), "--supervise"], {
      detached: true, stdio: "ignore", windowsHide: true, env: process.env,
    });
    let spawnError: Error | undefined;
    child.once("error", error => { spawnError = error; });
    child.unref();
    const stop = Date.now() + 15_000;
    while (Date.now() < stop) {
      if (spawnError) throw spawnError;
      const status = readTaskService();
      if (status && await healthy(status)) {
        if (status.build !== TASK_SERVICE_BUILD) throw new Error("Task service build mismatch; active executors were preserved");
        return status;
      }
      await delay(100);
    }
    throw new Error(`Task service did not become ready; see ${TASK_SERVICE_LOG}`);
  })();
  try { return await starting; } finally { starting = undefined; }
}

export class TaskServiceError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "TaskServiceError"; }
}

/** A view owns this subscription, never the task's execution. */
export class TaskClient {
  snapshot: LiveSnapshot | null = null;
  readonly clientId: string;
  private service?: TaskServiceStatus;
  private key?: string;
  private sessionId?: string | null;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private detached = false;
  private mutations: Promise<unknown> = Promise.resolve();
  private disconnected = false;

  constructor(private readonly options: TaskConnection, private readonly observe: (snapshot: LiveSnapshot) => void,
    private readonly unavailable: (reason: string) => void = () => {}) {
    this.clientId = options.clientId ?? randomUUID();
    this.sessionId = options.sessionId;
  }
  async connect(): Promise<void> {
    this.detached = false;
    await this.attach();
    if (this.detached) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.poll(); }, 250);
    this.timer.unref();
  }
  private prefix(): string { return this.options.mode === "pro" ? "/pro" : ""; }
  private async request(route: string, body?: unknown): Promise<Record<string, unknown>> {
    const service = this.service!;
    const response = await fetch(service.url + this.prefix() + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${service.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new TaskServiceError(response.status, String(data.error ?? `Task service HTTP ${response.status}`));
    return data;
  }
  private update(snapshot: LiveSnapshot): void {
    if (snapshot.epoch && snapshot.epoch === this.snapshot?.epoch && snapshot.key === this.snapshot.key
      && snapshot.revision !== undefined && this.snapshot.revision !== undefined && snapshot.revision < this.snapshot.revision) return;
    this.key = snapshot.key;
    this.sessionId = snapshot.sessionId;
    this.snapshot = { ...snapshot, connection: "connected" };
    this.disconnected = false;
    if (!this.detached) this.observe(this.snapshot);
  }
  private async attach(): Promise<void> {
    this.service = await ensureTaskService();
    const data = this.sessionId
      ? await this.request(`/session/${encodeURIComponent(this.sessionId)}/continue`, {})
      : await this.request("/conversations", {
        cwd: this.options.cwd, client_id: this.clientId, selection: this.options.selection,
        approval_mode: this.options.approvalMode, agent_mode: this.options.agentMode, pro_preset: this.options.proPreset,
      });
    this.key = String(data.key);
    this.update((data.snapshot ?? await this.request(`/live/${encodeURIComponent(this.key)}`)) as LiveSnapshot);
  }
  private async poll(): Promise<void> {
    if (this.detached || this.polling) return;
    this.polling = true;
    try {
      if (this.disconnected || !this.key) await this.attach();
      else {
        const service = this.service;
        const snapshot = await this.request(`/live/${encodeURIComponent(this.key)}`) as unknown as LiveSnapshot;
        if (service === this.service) this.update(snapshot);
      }
    } catch (error) { this.lost(error); }
    finally { this.polling = false; }
  }
  private lost(error: unknown): void {
    this.disconnected = true;
    const reason = error instanceof Error ? error.message : String(error);
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, connection: "disconnected", disconnectReason: reason };
      if (!this.detached) this.observe(this.snapshot);
    }
    if (!this.detached) this.unavailable(reason);
  }
  action(action: string, body: Record<string, unknown> = {}): Promise<LiveSnapshot | null> {
    const execute = async (): Promise<LiveSnapshot | null> => {
      if (this.detached) throw new Error("Task view has detached");
      if (this.disconnected || !this.key) await this.attach();
      const payload = action === "message" ? { ...body, request_id: body.request_id ?? randomUUID() } : body;
      const send = async () => {
        const service = this.service;
        const route = action === "approve" ? `/live/${this.key}/approvals/${encodeURIComponent(String(payload.approval_id))}` : `/live/${this.key}/${action}`;
        const data = await this.request(route, payload);
        if (action === "close") return null;
        const snapshot = data.snapshot ?? await this.request(`/live/${this.key}`);
        if (service !== this.service) { await this.attach(); return this.snapshot; }
        this.update(snapshot as LiveSnapshot);
        return this.snapshot;
      };
      try { return await send(); }
      catch (error) {
        if (error instanceof TaskServiceError && error.status < 500) throw error;
        this.lost(error);
        // A message receipt is saved atomically with its user message before
        // any execution. Only this idempotent mutation may be retried here.
        if (action !== "message") throw error;
        await this.attach();
        if (this.snapshot?.inputReceipts?.includes(String(payload.request_id))) return this.snapshot;
        return send();
      }
    };
    const operation = this.mutations.then(execute);
    this.mutations = operation.catch(() => {});
    return operation;
  }
  detach(): void { this.detached = true; if (this.timer) clearInterval(this.timer); }
}
