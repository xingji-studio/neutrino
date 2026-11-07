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

export interface SubAgentRun {
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
      `Work recorded before the budget ran out (${input.calls} call${input.calls === 1 ? "" : "s"}${denied}):\n` +
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
export async function runSubAgent(options: SubAgentOptions): Promise<SubAgentRun> {
  const maxRounds = Math.max(SUBAGENT_MIN_ROUNDS, Math.floor(options.maxRounds ?? SUBAGENT_MAX_ROUNDS));
  const messages: SubAgentMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.task },
  ];
  let report = "";
  let calls = 0;
  let denied = 0;
  let lastPromptTokens = 0;
  const evidence: Evidence[] = [];
  // A child that is stopped mid-work still owes the parent what it found.
  const aborted = (rounds: number): SubAgentRun => ({
    report: composePartial({ text: report, evidence, denied, calls }),
    aborted: true,
    exhausted: false,
    rounds,
    calls,
  });

  for (let round = 1; round <= maxRounds; round++) {
    if (options.cancelled?.()) return aborted(round - 1);
    // The last round is a wrap-up: no tools, so the only way out is a report.
    const wrapUp = round === maxRounds;
    const capacity = options.contextWindow;
    if (!wrapUp && capacity && messages.length > 2 &&
        Math.max(lastPromptTokens, Math.ceil(JSON.stringify(messages).length / 3)) >= capacity * 0.8) {
      // Only split at an assistant boundary: every retained tool result must
      // still have the assistant/tool_calls message that produced it.
      const starts = messages.flatMap((message, index) => index >= 2 && message.role === "assistant" ? [index] : []);
      let keep = starts.length > 1 ? starts.at(-1)! : messages.length;
      if (JSON.stringify(messages.slice(keep)).length > capacity) keep = messages.length;
      const head = messages.slice(2, keep);
      if (head.length) {
        options.onProgress?.("compressing context");
        const compressor = options.createClient();
        const transcript = JSON.stringify(head);
        // A single tool can produce more text than the role can hold. Bound
        // the compression request itself, retaining its beginning and end.
        const budget = Math.max(256, Math.floor(capacity * 0.6));
        const input = transcript.length > budget
          ? `${transcript.slice(0, Math.floor(budget / 2))}\n[Earlier activity truncated for compression]\n${transcript.slice(-Math.floor(budget / 2))}`
          : transcript;
        const summary = await compressor.summarize(input, { cancelled: options.cancelled, onRetry: options.onRetry });
        if (compressor.usage) options.onUsage?.(compressor.usage);
        if (options.cancelled?.()) return aborted(round - 1);
        messages.splice(2, keep - 2, {
          role: "assistant",
          content: summary || "Earlier specialist activity was compressed. Inspect the working directory for any evidence needed to continue.",
        });
        lastPromptTokens = 0;
      }
    }
    if (wrapUp) {
      messages.push({
        role: "user",
        content:
          "Your round budget is used up: this is the final round and no tools are available. " +
          "Write your report now from what you have already found, and say what is still unverified.",
      });
    }
    options.onProgress?.(wrapUp ? "writing report" : "thinking");

    const client = options.createClient();
    let content = "";
    for await (const chunk of client.streamTurn(messages, wrapUp ? [] : options.tools, {
      onRetry: options.onRetry,
      cancelled: options.cancelled,
    })) {
      if (options.cancelled?.()) return aborted(round - 1);
      content += chunk;
    }
    if (client.usage) {
      options.onUsage?.(client.usage);
      lastPromptTokens = client.usage.prompt;
    }

    // A call offered in the wrap-up round is not executed: there is no tool
    // result to feed back, and the round exists to produce the report.
    const toolCalls = wrapUp ? [] : client.toolCalls;
    if (content.trim()) report = content.trim();
    if (content.trim() || toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content,
        // A tool-call turn must carry the thinking that produced it back to a
        // thinking-mode endpoint, or its next request is rejected.
        ...(client.reasoningContent ? { reasoning_content: client.reasoningContent } : {}),
        ...(client.anthropicContent?.length ? { anthropic_content: client.anthropicContent } : {}),
        ...(toolCalls.length > 0
          ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.arguments },
            })),
          }
          : {}),
      });
    }
    if (toolCalls.length === 0) {
      // A report in the wrap-up round still means the budget is what ended the
      // work, so the parent is told the survey is partial.
      if (!wrapUp) return { report, aborted: false, exhausted: false, rounds: round, calls };
      break;
    }

    for (const call of toolCalls) {
      if (options.cancelled?.()) return aborted(round);
      const args = parseArgs(call.arguments);
      calls++;
      options.onProgress?.(call.name);
      const decision = await options.approve(call.name, args);
      if (options.cancelled?.()) return aborted(round);
      let result: string;
      if (decision.approved) {
        try {
          result = await options.execute(call.name, args);
        } catch (error) {
          result = `[Error: ${describeError(error)}]`;
        }
      } else {
        denied++;
        // The note goes to the child, not to the user: it must not retry the same
        // call unchanged, and it must say what was blocked in its report.
        result =
          decision.source === "input"
            ? `[Not executed: ${decision.reason}]`
            : `[Not executed: approval denied (${decision.source}): ${decision.reason}] ` +
              "Do not retry this call unchanged; work around it or report it as blocked.";
      }
      evidence.push(evidenceFor(call.name, args, result));
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  return {
    report: composePartial({ text: report, evidence, denied, calls }),
    aborted: false,
    exhausted: true,
    rounds: maxRounds,
    calls,
  };
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
    return run.exhausted
      ? `[Sub-agent used all ${run.rounds} rounds without producing a report.]`
      : "[Sub-agent finished without a report.]";
  }
  const text = clipReport(report);
  return run.exhausted
    ? `${text}\n\n[Sub-agent stopped after ${run.rounds} rounds without finishing; treat this report as partial.]`
    : text;
}
