import type { LLMClient } from "../llm/client.js";
import { outputAllowance, prepareContext } from "../llm/context.js";
import { currentTask, TaskControlError, type TaskRuntime, type ToolEvidence } from "../llm/runtime.js";
import type { ToolDefinition } from "../llm/tools.js";
import type { ApprovalDecision } from "../llm/approval.js";
import { FastTaskError } from "./scheduler.js";
import type { FastOutput } from "./types.js";

// Fast-only guidance; batching never changes tool availability, ordering or approval.
export const FAST_INSPECTION_POLICY = "Read known required paths directly without a separate directory-listing round. If a listing is needed, request it together with independent reads whose paths are already known. Discover unknown paths before reading them. ";
export const FAST_COMMAND_POLICY = "When commands are available and necessary, combine related reads, computation, writes and read-back assertions for THIS task in one command when the full sequence is known. Preserve prerequisite order and stop on failed assertions. Split calls when later actions require diagnosis or a separate safety decision. The full command body still requires normal approval. Keep independent verification in its separate agent scope. ";

const FINISH = "finish_task";
const list = (value: unknown): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
function finishTool(verification: boolean): ToolDefinition {
  return { type: "function", function: {
    name: FINISH,
    description: verification
      ? "Finish independent local verification with an explicit boolean verdict. Completed/true means all original acceptance criteria and actual necessary checks passed. Cite actual evidence and use false/partial for unresolved work."
      : "Finish this work task with a factual self-contained report. Keep original evidence and state unresolved work. A separate verifier checks every acceptance criterion.",
    parameters: { type: "object", properties: {
      status: { type: "string", enum: ["completed", "partial", "blocked", "failed"], description: "Status of THIS task_goal/output_contract only. Other DAG tasks and later global integration do not make this task partial." },
      report: { type: "string" }, conclusions: { type: "array", items: { type: "string" } },
      evidence: { type: "array", items: { type: "string" } }, assumptions: { type: "array", items: { type: "string" } },
      unresolved: { type: "array", items: { type: "string" }, description: "Only unmet acceptance criteria of THIS task. Use [] when none. Do not list 'none', harmless presentation differences, out-of-scope tasks or future integration." },
      ...(verification ? { verification_passed: { type: "boolean" } } : {}),
    }, required: ["status", "report", "unresolved", ...(verification ? ["verification_passed"] : [])] },
  } };
}

/** Strict control results with correction inside the same private conversation. Standard's child loop is untouched. */
export async function runFastWorker(options: {
  runtime: TaskRuntime;
  signal: AbortSignal;
  task: string;
  system: string;
  verification: boolean;
  readOnly: boolean;
  writePaths?: readonly string[];
  tools: ToolDefinition[];
  maxRounds: number;
  contextWindow: number;
  createClient(): LLMClient;
  approve(name: string, args: Record<string, unknown>): Promise<ApprovalDecision>;
  execute(name: string, args: Record<string, unknown>): Promise<string>;
}): Promise<FastOutput> {
  const runtime = options.runtime;
  return runtime.child("subagent", options.task, async scope => runtime.withSignal(options.signal, async () => {
    const signal = currentTask()!.signal;
    const records = () => runtime.evidenceFor(scope.runId);
    const controlRejected = (reason_code: string) => runtime.diagnostics?.emit("control_rejected", { reason_code }, currentTask());
    const sideEffects = () => records().some(e => !["read_file", "list_files", "web_search", "delegate", "read_task_evidence"].includes(e.name) && e.status !== "denied");
    const messages: Parameters<LLMClient["streamTurn"]>[0] = [{ role: "system", content:
      `${options.system}\n\n${runtime.instructions()}\n\nUse finish_task to conclude. ` +
      "Your scope is this DAG task, not the entire global request. Preserve every global constraint. Status and unresolved refer only to THIS task's acceptance criteria, not to remaining DAG tasks. Use unresolved: [] when this task has no blockers; out-of-scope future work belongs in assumptions, not unresolved. " +
      (options.verification
        ? "Perform the independent acceptance checks for this task against original sources and requested outputs. A scratch helper or verifier script is not a deliverable unless the user requested it. Do not test the tests, inject faults into scratch copies, replay an already evidenced pipeline in a new directory, or add cleanliness/byte-forensics checks unless the original request explicitly requires that coverage or an actual contradictory result requires diagnosis. Required negative/edge tests for the delivered product remain mandatory. Reuse actual execution evidence to audit recorded actions. All necessary source and correctness checks remain mandatory. "
        : "Produce the task output and necessary self-checks. The separate verifier owns independent acceptance checks; do not repeat a full independent/global audit in this worker. Prefer read_file/list_files for inspection, and run_command for necessary computation or tests. ") +
      FAST_INSPECTION_POLICY + (scope.policy.readOnly ? "" : FAST_COMMAND_POLICY) +
      "Keep the report factual and concise; include requested findings and cite actual evidence IDs. Do not reproduce raw records, command bodies or long checklists already preserved in the ledger unless the output contract requires them. conclusions/evidence/assumptions are optional when they add no new facts; all actual tool evidence is attached automatically. This does not reduce reasoning or verification requirements. " +
      (options.verification ? "Your result MUST include top-level verification_passed (boolean), unresolved (string[]), and a factual report. Merely writing PASS or verification_passed=true inside prose is insufficient. " : "") +
      "Correct tool/input mistakes in this conversation, preserving actual failed and successful evidence. Do not repeat a denied call unchanged. Never claim that missing checks passed." },
      { role: "user", content: options.task }];
    const control = finishTool(options.verification);
    const tools = runtime.availableTools([...options.tools.filter(t => t.function.name !== FINISH), control]);
    const names = new Set(tools.map(t => t.function.name));
    let lastPromptTokens = 0, denied = false, lastReport = "";
    const accept = (value: Record<string, unknown>): FastOutput | undefined => {
      const result = typeof value.report === "string" ? value.report : typeof value.result === "string" ? value.result : "";
      const status = typeof value.status === "string" ? value.status : "completed";
      if (!result.trim() || !["completed", "partial", "blocked", "failed"].includes(status)) return undefined;
      if (options.verification && (typeof value.verification_passed !== "boolean" || !Array.isArray(value.unresolved) || value.unresolved.some(v => typeof v !== "string"))) return undefined;
      if (options.verification && value.verification_passed === true && (status !== "completed" || list(value.unresolved).length)) return undefined;
      if (denied || status === "blocked" || status === "failed") throw new FastTaskError(`${status}: ${result}`, sideEffects());
      const pending = list(value.unresolved);
      if (status === "partial" && !pending.length) pending.push("Worker explicitly reported partial work; independent verification must resolve it.");
      const output: FastOutput = { result, conclusions: list(value.conclusions),
        evidence: [...new Set([...records().map(e => e.id), ...list(value.evidence)])],
        assumptions: list(value.assumptions), unresolved: pending, side_effects: sideEffects(),
        ...(options.verification ? { verification_passed: status === "completed" && value.verification_passed === true } : {}),
      };
      runtime.recordResult({ runId: scope.runId, status: status === "partial" ? "partial" : "completed", report: JSON.stringify(output),
        evidenceIds: records().map(e => e.id), artifacts: records().filter(e => e.name === "write_file" && e.status === "completed").map(e => String(e.arguments.path)), blockers: pending });
      return output;
    };
    try {
      for (let round = 1; round <= options.maxRounds; round++) {
        if (signal.aborted) throw new FastTaskError(String(signal.reason), sideEffects());
        // Like ordinary children, the last round is for reporting, with no filesystem/network tools.
        const available = round === options.maxRounds ? [control] : tools;
        if (round === options.maxRounds) messages.push({ role: "user", content: "Final report round. Only finish_task is available. Return the actual verified result or report partial/blocked; do not invent completion." });
        await prepareContext({ messages, tools: available, capacity: options.contextWindow, lastPromptTokens,
          createClient: options.createClient, stream: { signal }, preserveBrief: true });
        const client = options.createClient(); let text = "";
        for await (const chunk of client.streamTurn(messages, available, { signal, maxOutputTokens: outputAllowance(options.contextWindow), final: round === options.maxRounds })) text += chunk;
        lastPromptTokens = client.usage?.prompt ?? 0;
        if (signal.aborted || client.outcome?.status === "cancelled") throw new FastTaskError(String(signal.reason ?? "Cancelled"), sideEffects());
        if (client.outcome?.status === "failed") throw new FastTaskError(client.outcome.error?.message ?? "Worker request failed", sideEffects());
        lastReport = text || lastReport;
        const calls = client.toolCalls;
        messages.push({ role: "assistant", content: text,
          ...(client.reasoningContent ? { reasoning_content: client.reasoningContent } : {}),
          ...(client.anthropicContent.length ? { anthropic_content: client.anthropicContent } : {}),
          ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) } : {}),
        });
        if (!calls.length) {
          // A provider returning the requested JSON directly is equivalent to a control call.
          let value: unknown;
          try { value = JSON.parse(text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "")); } catch { value = null; }
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const output = accept(value as Record<string, unknown>); if (output) return output;
          }
          controlRejected("missing_control_fields");
          messages.push({ role: "user", content: "The final result is missing required machine-readable fields. Conclude with finish_task using status, report, conclusions, evidence, assumptions, unresolved" +
            (options.verification ? ", and top-level verification_passed: true/false. Keep all original evidence; do not rerun completed writes to fix output formatting." : ". Do not rerun completed writes to fix output formatting.") });
          continue;
        }
        for (const call of calls) {
          if (signal.aborted) throw new FastTaskError(String(signal.reason), sideEffects());
          let args: Record<string, unknown>;
          try {
            const parsed = JSON.parse(call.arguments);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Arguments must be an object");
            args = parsed;
          } catch { controlRejected("invalid_tool_arguments"); messages.push({ role: "tool", tool_call_id: call.id, content: "Invalid JSON object; correct the arguments." }); continue; }
          if (call.name === FINISH) {
            if (calls.length !== 1) {
              controlRejected("mixed_control_and_tools");
              messages.push({ role: "tool", tool_call_id: call.id, content: "finish_task must be sent alone after all requested operations settle. Complete the other calls, then return the final result." });
              continue;
            }
            const output = accept(args); if (output) return output;
            controlRejected("contradictory_control_result");
            messages.push({ role: "tool", tool_call_id: call.id, content: "Invalid or contradictory final result. Include a nonempty report, unresolved array and, for verification, a top-level boolean verification_passed. Status and unresolved concern only THIS task's acceptance criteria. If those passed, use completed/true and unresolved: []; put out-of-scope work in assumptions. If a criterion remains unmet, state it and use false. Clarify using existing evidence without replaying writes or omitting necessary checks." });
            continue;
          }
          let result: string;
          if (!names.has(call.name) || round === options.maxRounds) {
            result = "Tool unavailable in this scope/round; use finish_task or correct the call.";
            runtime.recordTool(call.name, args, result, "denied"); denied = true;
          } else {
            let decision: ApprovalDecision;
            try { runtime.assertTool(call.name, args); decision = await options.approve(call.name, args); }
            catch (error) {
              if (!(error instanceof TaskControlError) || error.code !== "workspace_scope") throw error;
              decision = { approved: false, source: "input", reason: error.message };
            }
            if (signal.aborted) throw new FastTaskError(String(signal.reason), sideEffects());
            if (decision.approved) result = await runtime.tool(call.name, args, () => options.execute(call.name, args));
            else {
              result = `Not executed: ${decision.reason}. Do not retry a denied call unchanged.`;
              runtime.recordTool(call.name, args, result, "denied");
              // An input scope error ran nothing and can be corrected locally. A safety/human refusal remains a blocker.
              if (decision.source !== "input") denied = true;
            }
          }
          const evidence: ToolEvidence | undefined = records().at(-1);
          messages.push({ role: "tool", tool_call_id: call.id, content: result + (evidence ? `\n[Evidence ${evidence.id}; status=${evidence.status}]` : "") });
        }
      }
      throw new FastTaskError(`Worker exhausted its configured ${options.maxRounds} rounds. Partial report: ${lastReport}`, sideEffects());
    } catch (error) {
      runtime.recordResult({ runId: scope.runId, status: signal.aborted ? "cancelled" : "failed", report: lastReport,
        evidenceIds: records().map(e => e.id), artifacts: [], blockers: [error instanceof Error ? error.message : String(error)] });
      if (error instanceof FastTaskError) throw error;
      throw new FastTaskError(error instanceof Error ? error.message : String(error), sideEffects());
    }
  }), { readOnly: options.readOnly, writePaths: options.writePaths });
}
