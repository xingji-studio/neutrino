import { pluginPrompt } from "../plugins/session.js";
/**
 * Sub-agents.
 *
 * A sub-agent is an agent loop inside an agent loop: the parent hands one
 * self-contained task to a fresh conversation, the child works with the same
 * tools in the same directory, and only its final report travels back. Its
 * intermediate messages are dropped on purpose — that isolation is the point: a
 * survey that reads thirty files must not fill the parent's context with thirty
 * files.
 *
 * That dropped transcript is why the loop keeps its own evidence. The last
 * round is sent without tools, so a child that has spent its budget can only
 * write; and a child that still runs out hands back what it actually ran and
 * read, instead of the half-sentence it happened to say last.
 *
 * This module owns the child loop and nothing else. Everything that touches the
 * app — which model, how a call is approved, where progress is shown, how tokens
 * are counted — is passed in, so the terminal session and the browser session
 * run the exact same sub-agent.
 */
import type { LLMClient, UsageInfo } from "./client.js";
import { describeError } from "./retry.js";
import type { RetryNotice } from "./retry.js";
import type { ApprovalDecision } from "./approval.js";
import type { ToolDefinition } from "./tools.js";
import { prepareContext, outputAllowance } from "./context.js";
import { currentTask, TaskRuntime, TaskControlError, linkSignals, type AgentResult, type AgentStatus, type TaskScope } from "./runtime.js";

/** One message of the child's private transcript. */
export interface SubAgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  /** Thinking text echoed back on an assistant tool-call message. */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  anthropic_content?: unknown[];
}

export interface SubAgentOptions {
  runtime?: TaskRuntime;
  scope?: TaskScope;
  readOnly?: boolean;
  writePaths?: readonly string[];
  signal?: AbortSignal;
  /** A fresh client per round; the loop owns usage and retries. */
  createClient(): LLMClient;
  /** The sub-agent's system prompt (see `loadSubAgentPrompt`). */
  system: string;
  /** The delegated task, already flattened into a standalone brief. */
  task: string;
  tools: ToolDefinition[];
  /** The same approval gate the parent turn uses. */
  approve(name: string, args: Record<string, unknown>): Promise<ApprovalDecision>;
  /** Run one approved call. */
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  /** What the child is doing right now, for the parent's status line. */
  onProgress?(label: string): void;
  /** Tokens spent by the child, added to the parent's conversation counters. */
  onUsage?(usage: UsageInfo): void;
  /** A dropped request is being retried, so the parent can explain the silence. */
  onRetry?(notice: RetryNotice): void;
  /** True once the parent turn was paused, superseded or cleared. */
  cancelled?(): boolean;
  maxRounds?: number;
  /** Pro role capacity; ordinary sub-agents retain the historical behaviour. */
  contextWindow?: number;
}

export interface SubAgentRun extends AgentResult {
  /** The child's final message: the only thing the parent receives. */
  report: string;
  /** The parent turn ended before the child finished. */
  aborted: boolean;
  /** The child used up its rounds without finishing. */
  exhausted: boolean;
  rounds: number;
  calls: number;
}

/**
 * Rounds one sub-agent may take, the last of which has no tools. Enough for real
 * work, few enough that a runaway child cannot cost a fortune.
 */
export const SUBAGENT_MAX_ROUNDS = 16;
/** A wrap-up round is only worth anything with at least one round of work before it. */
export const SUBAGENT_MIN_ROUNDS = 2;
/** A report is evidence for the parent, not a transcript of the child. */
export const SUBAGENT_MAX_REPORT = 8000;

/** How much of the accumulated evidence an exhausted child still hands back. */
const EVIDENCE_LINES = 24;
const EVIDENCE_CHARS = 200;

/** The configured round budget, reconciled with what the loop can honour. */
export function subAgentRounds(configured: unknown): number {
  const raw = Number(configured);
  return Number.isFinite(raw) && raw >= SUBAGENT_MIN_ROUNDS ? Math.floor(raw) : SUBAGENT_MAX_ROUNDS;
}

function parseArgs(raw: string): Record<string, unknown> {
  const text = raw?.trim() ?? "";
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object") return value as Record<string, unknown>;
  } catch {
    // Hand the raw payload over instead of failing the whole call.
  }
  return { value: text };
}

/** The task brief handed to the child: where it works, what it has, what to do. */
export function buildSubAgentTask(input: { task: string; context?: string; cwd?: string; rounds?: number }): string {
  const parts: string[] = [];
  if (input.cwd) parts.push(`Working directory: ${input.cwd}`);
  const rounds = Number.isFinite(input.rounds) && (input.rounds ?? 0) > 0 ? Math.floor(input.rounds!) : 0;
  if (rounds) {
    // Without this the child explores as if the budget were unlimited: it reads
    // one file per round and discovers the limit only when the loop stops.
    parts.push(
      `Budget: ${rounds} rounds. One round is one reply and may carry several tool calls; ` +
      "the last round has no tools, so leave room to write the report.",
    );
  }
  parts.push(`Task:\n${input.task.trim()}`);
  const context = (input.context ?? "").trim();
  if (context) parts.push(`What the agent that delegated this task already knows:\n${context}`);
  return parts.join("\n\n");
}

/** One thing the child learned, kept so an exhausted child can still report. */
interface Evidence {
  name: string;
  /** The call's own material: a command, path or search query. */
  detail: string;
  /** The first line of what it returned. */
  result: string;
}

function clip(text: string, limit = EVIDENCE_CHARS): string {
  const line = text.trim();
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function firstLine(text: string): string {
  return clip(text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "");
}

function evidenceFor(name: string, args: Record<string, unknown>, result: string): Evidence {
  return {
    name,
    detail: clip(String(args.command ?? args.path ?? args.query ?? "")),
    result: firstLine(result),
  };
}

/**
 * The report of a child that was cut short. The parent never sees the child's
 * transcript, so without this it would receive whatever sentence came last —
 * usually "let me start by exploring".
 */
function composePartial(input: { text: string; evidence: Evidence[]; denied: number; calls: number }): string {
  const parts: string[] = [];
  if (input.text) parts.push(input.text);
  const shown = input.evidence.slice(-EVIDENCE_LINES);
  if (shown.length) {
    const denied = input.denied ? `, ${input.denied} denied` : "";
    const omitted = input.evidence.length - shown.length;
    parts.push(
      `Work recorded before the agent stopped (${input.calls} call${input.calls === 1 ? "" : "s"}${denied}):\n` +
      shown.map((entry) => `- ${entry.name}${entry.detail ? ` ${entry.detail}` : ""}${entry.result ? ` -> ${entry.result}` : ""}`).join("\n") +
      (omitted > 0 ? `\n- …${omitted} earlier call${omitted === 1 ? "" : "s"} omitted` : ""),
    );
  }
  if (!parts.length) return "";
  parts.push("Anything the task asked for that is not listed above is still unverified.");
  return parts.join("\n\n");
}

/**
 * Run one sub-agent to its report.
 *
 * The child sees only its own task, its own tool results and the parent's
 * approval decisions. Nothing it says reaches the parent except the last
 * message, which is why the sub-agent prompt insists that the report be
 * complete on its own.
 */
export const FINISH_TASK_TOOL = "finish_task";
export const FINISH_TASK_DEFINITION: ToolDefinition = {
  type: "function", function: {
    name: FINISH_TASK_TOOL,
    description: "Finish this delegated task with an explicit status and factual, self-contained report. Use partial or blocked for unfinished work. This ends your task.",
    parameters: { type: "object", properties: {
      status: { type: "string", enum: ["completed", "partial", "blocked", "failed"] },
      report: { type: "string" },
      blockers: { type: "array", items: { type: "string" } },
      reason: { type: "string" },
    }, required: ["status", "report", "reason"] },
  },
};

export async function runSubAgent(options: SubAgentOptions): Promise<SubAgentRun> {
  const inherited = currentTask();
  const runtime = options.runtime ?? inherited?.runtime ?? new TaskRuntime({ request: options.task, signal: options.signal });
  const owned = !options.runtime && !inherited;
  const controller = new AbortController();
  const linked = linkSignals(runtime.signal, options.signal, controller.signal);
  let scopeSignal: AbortSignal | undefined;
  const cancelled = () => linked.signal.aborted || scopeSignal?.aborted === true || options.cancelled?.() === true;
  const poll = options.cancelled ? setInterval(() => {
    if (options.cancelled?.()) controller.abort("The parent turn was paused or replaced");
  }, 50) : undefined;
  poll?.unref();
  const maxRounds = subAgentRounds(options.maxRounds);
  let rounds = 0;
  let calls = 0;
  let denied = 0;
  let report = "";
  let runId = options.scope?.runId ?? runtime.rootRunId;
  const evidence: Evidence[] = [];
  const finish = (status: AgentStatus, error?: { code: string; message: string }, exhausted = false, blockers: string[] = []): SubAgentRun => {
    const records = runtime.evidenceFor(runId);
    if (status === "completed" && records.some(entry => entry.status === "denied")) status = "blocked";
    if (status === "completed" && records.some(entry => entry.status !== "completed")) status = "partial";
    const result: SubAgentRun = {
      runId, status,
      report: status === "completed" ? report : composePartial({ text: report, evidence, denied, calls }),
      evidenceIds: records.map(entry => entry.id),
      artifacts: records.filter(entry => entry.name === "write_file" && entry.status === "completed")
        .map(entry => String(entry.arguments.path ?? "")),
      blockers, ...(error ? { error } : {}),
      aborted: status === "cancelled", exhausted, rounds, calls,
    };
    runtime.recordResult(result);
    return result;
  };
  const stopped = (): SubAgentRun => {
    const reason = scopeSignal?.reason;
    if (reason instanceof TaskControlError && reason.code.endsWith("_budget")) {
      return finish(evidence.length ? "partial" : "blocked", { code: reason.code, message: reason.message });
    }
    return finish("cancelled");
  };
  const loop = async (): Promise<SubAgentRun> => {
    runId = currentTask()?.runId ?? runId;
    scopeSignal = currentTask()?.signal;
    const messages: SubAgentMessage[] = [
      { role: "system", content: `${pluginPrompt(options.system,currentTask()?.role ?? "subagent")}\n\n${runtime.instructions()}` },
      { role: "user", content: options.task },
    ];
    const tools = runtime.availableTools([...new Map([...options.tools.filter(tool => tool.function.name !== FINISH_TASK_TOOL),
      ...(runtime.plugins?.definitions(currentTask()?.role) ?? []), FINISH_TASK_DEFINITION].map(tool => [tool.function.name,tool])).values()]);
    const names = new Set(tools.map(tool => tool.function.name));
    let lastPromptTokens = 0;
    let emptyReplies = 0;
    for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      if (cancelled()) return stopped();
      const wrapUp = round === maxRounds;
      const availableTools = wrapUp ? [] : tools;
      const capacity = Number.isSafeInteger(options.contextWindow) && options.contextWindow! > 0 ? options.contextWindow! : 1_000_000;
      await prepareContext({ messages, tools: availableTools, capacity, lastPromptTokens, preserveBrief: true,
        createClient: options.createClient,
        stream: { signal: linked.signal, cancelled, onRetry: options.onRetry },
        onUsage: options.onUsage, onProgress: () => options.onProgress?.("compressing context"),
      });
      lastPromptTokens = 0;
      if (cancelled()) return stopped();
      if (wrapUp) messages.push({ role: "user", content:
        "This is the final round and no tools are available. Write your report now from actual evidence and state what remains unverified. Do not claim unfinished work is complete.",
      });
      options.onProgress?.(wrapUp ? "writing report" : "thinking");
      const client = options.createClient();
      let content = "";
      for await (const chunk of client.streamTurn(messages, availableTools, {
        signal: linked.signal, onRetry: options.onRetry, cancelled,
        maxOutputTokens: outputAllowance(capacity), final: wrapUp,
      })) {
        if (cancelled()) return stopped();
        content += chunk;
      }
      if (client.usage) { options.onUsage?.(client.usage); lastPromptTokens = client.usage.prompt; }
      if (cancelled() || client.outcome?.status === "cancelled") return stopped();
      if (client.outcome?.status === "failed" || (!client.outcome && /^\s*\[Error:/.test(content))) {
        return finish(evidence.length ? "partial" : client.outcome?.error?.code.endsWith("_budget") ? "blocked" : "failed",
          client.outcome?.error ?? { code: "model_error", message: content.trim() });
      }
      const toolCalls = wrapUp ? [] : client.toolCalls;
      if (!content.trim() && !toolCalls.length) {
        if (!wrapUp && emptyReplies++ === 0) { messages.push({ role: "user", content: "The response was empty. Return a factual final report, or continue using the available tools." }); continue; }
        report = "";
        return finish(evidence.length ? "partial" : "failed", { code: "empty_completion", message: "Sub-agent returned an empty completion" }, wrapUp);
      }
      if (content.trim()) report = content.trim();
      messages.push({ role: "assistant", content,
        ...(client.reasoningContent ? { reasoning_content: client.reasoningContent } : {}),
        ...(client.anthropicContent?.length ? { anthropic_content: client.anthropicContent } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls.map(call => ({ id: call.id, type: "function" as const,
          function: { name: call.name, arguments: call.arguments } })) } : {}),
      });
      if (!toolCalls.length) return finish(wrapUp ? "partial" : denied ? "blocked" : "completed", undefined, wrapUp);
      for (const call of toolCalls) {
        if (cancelled()) return stopped();
        const args = parseArgs(call.arguments);
        calls++;
        options.onProgress?.(call.name);
        if (call.name === FINISH_TASK_TOOL && ["completed", "partial", "blocked", "failed"].includes(String(args.status)) &&
            typeof args.report === "string" && args.report.trim()) {
          report = args.report.trim();
          return finish(args.status as AgentStatus, undefined, false,
            Array.isArray(args.blockers) ? args.blockers.filter((v): v is string => typeof v === "string") : []);
        }
        let result: string;
        if (!names.has(call.name) || call.name === FINISH_TASK_TOOL) {
          result = "[Not executed: this tool is not available, or its final result is invalid]";
          runtime.recordTool(call.name, args, result, "denied");
        } else {
          runtime.assertTool(call.name, args);
          const decision = await options.approve(call.name, args);
          if (cancelled()) return stopped();
          if (decision.approved) result = await runtime.tool(call.name, args, () => options.execute(call.name, args));
          else {
            denied++;
            result = decision.source === "input" ? `[Not executed: ${decision.reason}]`
              : `[Not executed: approval denied (${decision.source}): ${decision.reason}] Do not retry this call unchanged; work around it or report it as blocked.`;
            runtime.recordTool(call.name, args, result, "denied");
          }
        }
        evidence.push(evidenceFor(call.name, args, result));
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
        if (cancelled()) return stopped();
      }
    }
    return finish("partial", undefined, true);
  };
  try {
    const execute = () => runtime.withSignal(linked.signal, loop);
    return options.scope ? await execute() : await runtime.child("subagent", options.task, execute,
      { readOnly: options.readOnly, writePaths: options.writePaths });
  } catch (error) {
    const code = error instanceof TaskControlError ? error.code : "agent_error";
    if (cancelled()) return stopped();
    return finish(code === "cancelled" ? "cancelled" : evidence.length ? "partial" : code.endsWith("_budget") ? "blocked" : "failed",
      { code, message: describeError(error) });
  } finally {
    if (poll) clearInterval(poll);
    linked.dispose();
    if (owned) { await runtime.drain(); runtime.finish(cancelled() ? "cancelled" : runtime.results.at(-1)?.status ?? "failed"); }
  }
}

/** The tool result the parent sees: the report, or why there is none. */
export function formatSubAgentResult(run: SubAgentRun): string {
  const clipReport = (text: string): string => text.length > SUBAGENT_MAX_REPORT
    ? `${text.slice(0, SUBAGENT_MAX_REPORT)}\n…[report truncated]`
    : text;
  const report = run.report.trim();
  if (run.aborted) {
    const stopped = "[Sub-agent stopped: the turn was paused or replaced before it reported back.]";
    return report ? `${stopped}\nWhat it had done so far:\n${clipReport(report)}` : stopped;
  }
  if (!report) {
    if (run.error) return `[Sub-agent ${run.status ?? "failed"}: ${run.error.code}: ${run.error.message}]`;
    return run.exhausted
      ? `[Sub-agent used all ${run.rounds} rounds without producing a report.]`
      : "[Sub-agent finished without a report.]";
  }
  const text = clipReport(report);
  if (run.error) return `${text}\n\n[Sub-agent ${run.status}: ${run.error.code}: ${run.error.message}]`;
  if (run.status === "blocked" || run.status === "failed") return `${text}\n\n[Sub-agent ${run.status}${run.blockers.length ? `: ${run.blockers.join("; ")}` : ""}]`;
  if (run.status === "partial" && !run.exhausted) return `${text}\n\n[Sub-agent result is partial; unfinished work remains unverified.]`;
  return run.exhausted
    ? `${text}\n\n[Sub-agent stopped after ${run.rounds} rounds without finishing; treat this report as partial.]`
    : text;
}
