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
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
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

/** Enough for real work, few enough that a runaway child cannot cost a fortune. */
export const SUBAGENT_MAX_ROUNDS = 12;
/** A report is evidence for the parent, not a transcript of the child. */
export const SUBAGENT_MAX_REPORT = 8000;

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

/** The task brief handed to the child: where it works, what to do, what it must know. */
export function buildSubAgentTask(input: { task: string; context?: string; cwd?: string }): string {
  const parts: string[] = [];
  if (input.cwd) parts.push(`Working directory: ${input.cwd}`);
  parts.push(`Task:\n${input.task.trim()}`);
  const context = (input.context ?? "").trim();
  if (context) parts.push(`What the agent that delegated this task already knows:\n${context}`);
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
  const maxRounds = Math.max(1, options.maxRounds ?? SUBAGENT_MAX_ROUNDS);
  const messages: SubAgentMessage[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.task },
  ];
  let report = "";
  let calls = 0;
  const aborted = (rounds: number): SubAgentRun => ({ report, aborted: true, exhausted: false, rounds, calls });

  for (let round = 1; round <= maxRounds; round++) {
    if (options.cancelled?.()) return aborted(round - 1);
    options.onProgress?.("thinking");

    const client = options.createClient();
    let content = "";
    for await (const chunk of client.streamTurn(messages, options.tools, {
      onRetry: options.onRetry,
      cancelled: options.cancelled,
    })) {
      if (options.cancelled?.()) return aborted(round - 1);
      content += chunk;
    }
    if (client.usage) options.onUsage?.(client.usage);

    const toolCalls = client.toolCalls;
    if (content.trim()) report = content.trim();
    if (content.trim() || toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content,
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
      return { report, aborted: false, exhausted: false, rounds: round, calls };
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
        // The note goes to the child, not to the user: it must not retry the same
        // call unchanged, and it must say what was blocked in its report.
        result =
          decision.source === "input"
            ? `[Not executed: ${decision.reason}]`
            : `[Not executed: approval denied (${decision.source}): ${decision.reason}] ` +
              "Do not retry this call unchanged; work around it or report it as blocked.";
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  return { report, aborted: false, exhausted: true, rounds: maxRounds, calls };
}

/** The tool result the parent sees: the report, or why there is none. */
export function formatSubAgentResult(run: SubAgentRun): string {
  if (run.aborted) {
    return "[Sub-agent stopped: the turn was paused or replaced before it reported back.]";
  }
  const report = run.report.trim();
  if (!report) {
    return run.exhausted
      ? `[Sub-agent used all ${run.rounds} rounds without producing a report.]`
      : "[Sub-agent finished without a report.]";
  }
  const text = report.length > SUBAGENT_MAX_REPORT
    ? `${report.slice(0, SUBAGENT_MAX_REPORT)}\n…[report truncated]`
    : report;
  return run.exhausted
    ? `${text}\n\n[Sub-agent stopped after ${run.rounds} rounds without finishing; treat this report as partial.]`
    : text;
}
