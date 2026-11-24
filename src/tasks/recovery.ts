import fs from "node:fs";
import path from "node:path";
import { listSessions, loadSession, saveSession, sessionDir, type Mode, type SessionData, type ToolMessage } from "../config.js";
import { TaskStore, ownerAlive } from "./controller.js";

export interface RecoveryCandidate { source: SessionData; mode: Mode; autoResume: boolean; reason: string }

/** Reconcile durable operation results before constructing any new executor.
 * An unknown write/command is a visible blocker, never an automatic replay.
 */
export function recoverStoredTasks(): RecoveryCandidate[] {
  const candidates: RecoveryCandidate[] = [];
  for (const mode of ["standard", "pro"] as Mode[]) for (const meta of listSessions(mode)) {
    const source = loadSession(meta.id, mode);
    const task = source?.task_run;
    if (!source) continue;
    if (!task && source.client_id && source.pending_input) {
      candidates.push({ source, mode, autoResume: true, reason: "accepted_input_before_attempt" }); continue;
    }
    if (!task || (!source.pending_input && !["running", "cancelling"].includes(task.state))) continue;
    const directory = path.join(sessionDir(mode), "tasks", source.id, "controller");
    // Legacy/foreign executors have no controller identity. Never change them
    // merely because a new private service was started alongside an older UI.
    if (!task.spec || !fs.existsSync(path.join(directory, "events.jsonl"))) continue;
    let autoResume = false;
    let reason = "legacy_task_requires_review";
    try {
      if (fs.existsSync(path.join(directory, "events.jsonl"))) {
        const store = new TaskStore(directory);
        if (store.record && ownerAlive(store.record.owner) && fs.existsSync(path.join(directory, "owner.lock"))) continue;
        if (store.record?.spec) task.spec = store.record.spec;
        if (store.unknownTools().length) {
          task.state = "blocked"; reason = "tool_outcome_unknown";
        } else if (store.record && ["completed", "failed", "cancelled", "partial", "blocked"].includes(store.record.state)) {
          task.state = store.record.state as typeof task.state;
          reason = store.record.reason ?? `durable_${store.record.state}_recovered`;
        } else if (task.state === "cancelling") {
          task.state = "cancelled"; reason = "pause_completed_after_restart";
        } else {
          task.state = "interrupted"; reason = "owner_lost_recoverable";
          // A queued/new user input must not silently replace an interrupted
          // objective or be treated as permission to repeat the previous turn.
          const input = source.messages.filter(message => message.role === "user").at(-1);
          autoResume = !!task.spec && input?.role === "user" && input.content === task.spec.latestInput;
          if (!autoResume) reason = "task_input_requires_review";
        }
        if (source.pending_input && task.state !== "blocked") {
          task.state = "interrupted"; reason = "queued_input_requires_review"; autoResume = false;
        }
        for (const message of source.messages) {
          if (message.role !== "tool") continue;
          const tool = message as ToolMessage & { evidenceId?: string; executionStatus?: string };
          if (tool.executionStatus || (tool.result && tool.result !== "…")) continue;
          const evidence = tool.evidenceId ? store.tools.get(tool.evidenceId) : undefined;
          if (evidence?.status) {
            tool.result = evidence.result ?? ""; tool.evidenceId = evidence.id; tool.executionStatus = evidence.status;
          } else if (evidence) {
            tool.result = "[Execution outcome unknown: execution started but no durable result was committed. See task recovery state.]";
            tool.executionStatus = "unknown";
          } else if (!evidence) {
            tool.result = "[Interrupted before execution: this proposed tool was not executed]";
            tool.executionStatus = "cancelled";
          }
        }
      } else task.state = "interrupted";
    } catch (error) {
      task.state = "blocked"; reason = `recovery_error: ${error instanceof Error ? error.message : String(error)}`;
    }
    task.stopReason = reason;
    if (task.standard && task.state !== "completed") {
      task.standard.status = "partial";
      task.standard.unresolved = [reason];
    }
    saveSession(source.messages, source.model, source.provider, source.intensity, source.cwd, source.id,
      source.tokens, source.context, source.approval_mode, source.plan, mode, source.pro_preset,
      source.agent_mode, task, source.fast_run, source.title, source.goal,
      { client_id: source.client_id, input_receipts: source.input_receipts, input_receipt_hashes: source.input_receipt_hashes, pending_input: source.pending_input });
    candidates.push({ source, mode, autoResume, reason });
  }
  return candidates;
}
