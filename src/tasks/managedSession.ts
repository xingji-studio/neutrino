import { TaskClient, TaskServiceError, type TaskConnection } from "./service.js";
import { hub, type LiveAgent, type LiveMeta, type LiveSnapshot, type ModelChangeResult } from "../web/hub.js";
import type { AgentMode, ApprovalMode, Mode, ResolvedModelSelection } from "../config.js";

/** A UI subscription. Disposing a console must never cancel its executor. */
export class ManagedSession implements LiveAgent {
  readonly mode: Mode;
  readonly clientId: string;
  private readonly client: TaskClient;
  private snapshot!: LiveSnapshot;
  private key: string | null = null;

  private constructor(options: TaskConnection) {
    this.mode = options.mode ?? "standard";
    this.client = new TaskClient(options, snapshot => {
      this.snapshot = snapshot;
      if (this.key) hub.notify(this.key);
    });
    this.clientId = this.client.clientId;
  }
  static async open(options: TaskConnection): Promise<ManagedSession> {
    const session = new ManagedSession(options);
    try { await session.client.connect(); return session; }
    catch (error) { session.client.detach(); throw error; }
  }
  start(): string { return this.key ??= hub.register(this); }
  liveCwd(): string { return this.snapshot.cwd; }
  liveMeta(): LiveMeta { return this.snapshot; }
  liveSnapshot(key: string): LiveSnapshot { return { ...this.snapshot, key }; }
  async remoteAction(action: string, body: unknown): Promise<{ status: number; data: unknown }> {
    try {
      const payload = { ...(body ?? {}) as Record<string, unknown> };
      if (action === "approve" && payload.approval_id === undefined) payload.approval_id = this.snapshot.approval?.id;
      if (action === "approve" && !payload.approval_id) return { status: 409, data: { error: "no approval is pending" } };
      const snapshot = await this.client.action(action, payload);
      if (action === "close") this.dispose();
      return { status: 200, data: { ok: true, ...(snapshot ? { snapshot: this.liveSnapshot(this.key!) } : { closed: true }) } };
    } catch (error) {
      return { status: error instanceof TaskServiceError ? error.status : 503,
        data: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
  private dispatch(action: string, body: unknown = {}): void { void this.remoteAction(action, body); }
  livePause(): void { this.dispatch("pause"); }
  liveResume(): void { this.dispatch("resume"); }
  liveSend(text: string, requestId?: string): void { this.dispatch("message", { text, request_id: requestId }); }
  liveApprove(approved: boolean, approvalId?: string): boolean {
    if (!this.snapshot.approval || (approvalId && this.snapshot.approval.id !== approvalId)) return false;
    this.dispatch("approve", { approved, approval_id: approvalId ?? this.snapshot.approval.id }); return true;
  }
  liveSetApprovalMode(mode: ApprovalMode): void { this.dispatch("approval-mode", { mode }); }
  liveSetAgentMode(mode: AgentMode): ModelChangeResult { this.dispatch("agent-mode", { mode }); return { ok: true }; }
  liveConfigure(selection: ResolvedModelSelection): ModelChangeResult {
    this.dispatch("model", { provider: selection.provider, model: selection.model.name, intensity: selection.intensity }); return { ok: true };
  }
  liveClear(): void { this.dispatch("clear"); }
  dispose(): void { this.client.detach(); hub.unregister(this.key); this.key = null; }
}
