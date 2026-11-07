import type { LLMClient, StreamOptions, UsageInfo } from "./client.js";
import type { ToolDefinition } from "./tools.js";
import { TaskControlError, type TaskRuntime } from "./runtime.js";

export interface ContextMessage {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** Spend only the root's reserved report request; local evidence remains the fallback. */
export async function finalTaskReport(runtime: TaskRuntime, createClient: () => LLMClient,
  onUsage?: (usage: UsageInfo) => void): Promise<string> {
  const recorded = runtime.partialReport();
  try {
    const client = createClient();
    const report = await client.complete(
      "The task stopped at a shared budget limit. Produce a brief partial report in the user's language using only the recorded operations. State what was actually completed and what remains unverified. Do not claim the entire task succeeded. No tools or further work are available.",
      JSON.stringify({ request: runtime.originalRequest, evidence: recorded }),
      { signal: runtime.signal, final: true, maxOutputTokens: 1024 },
    );
    if (client.usage) onUsage?.(client.usage);
    if (client.outcome?.status === "completed" && report.trim()) return `${report}\n\n[Task result is partial: shared budget exhausted.]`;
  } catch { /* A request/token limit may leave no reporting capacity. */ }
  return recorded;
}

/** Context scheduling estimate for mixed ASCII/CJK; provider usage is also checked. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  let ascii = 0;
  let other = 0;
  for (const char of text) { if (char.codePointAt(0)! < 128) ascii++; else other++; }
  return Math.ceil(ascii / 3) + other;
}
export const DEFAULT_OUTPUT_TOKENS = 16_384;
export function outputAllowance(capacity: number): number { return Math.max(64, Math.min(DEFAULT_OUTPUT_TOKENS, Math.floor(capacity * 0.1))); }
/** Reserve a byte-based upper estimate, including framing, when usage is unknown. */
export function inputTokenBound(value: unknown): number { return Buffer.byteLength(JSON.stringify(value), "utf8") + 512; }

function truncate(text: string, tokens: number): string {
  if (tokens <= 0) return "";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= tokens) low = mid; else high = mid - 1;
  }
  return text.slice(0, low);
}

/** Compact complete assistant/tool groups before any request, including wrap-up. */
export async function prepareContext<T extends ContextMessage>(options: {
  messages: T[];
  tools: ToolDefinition[];
  capacity: number;
  lastPromptTokens?: number;
  preserveBrief?: boolean;
  createClient(): LLMClient;
  stream?: StreamOptions;
  onUsage?(usage: UsageInfo): void;
  onProgress?(): void;
}): Promise<void> {
  const { messages, tools, capacity } = options;
  const schema = estimateTokens(tools) + 32;
  const allowance = outputAllowance(capacity);
  const limit = Math.floor(capacity * 0.8) - schema - allowance;
  if (Math.max(estimateTokens(messages), (options.lastPromptTokens ?? 0) - schema) <= limit) return;
  // Keep the system policy and current user input intact. Earlier history is evidence.
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "user") lastUser = i;
  // A wrap-up instruction is appended after preparation, so this is the actual brief.
  const head = options.preserveBrief ? messages.slice(0, 2) : [messages[0], ...(lastUser > 0 ? [messages[lastUser]] : [])];
  const available = limit - estimateTokens(head) - 64;
  if (available < 64) throw new TaskControlError("context_capacity", "The task brief and tool definitions exceed this model's context capacity");
  const body = options.preserveBrief ? messages.slice(2) : messages.filter((_, index) => index > 0 && index !== lastUser);
  if (!body.length) return;
  options.onProgress?.();
  const starts = body.flatMap((message, index) => message.role === "assistant" ? [index] : []);
  let keep = starts.at(-1) ?? body.length;
  if (estimateTokens(body.slice(keep)) > available * 0.45) keep = body.length;
  const transcript = JSON.stringify(body.slice(0, keep));
  const inputBudget = Math.max(64, Math.floor(capacity * 0.45));
  const input = estimateTokens(transcript) > inputBudget
    ? `${truncate(transcript, Math.floor(inputBudget / 2))}\n[Truncated; full tool records remain in the task ledger]\n${[...truncate([...transcript].reverse().join(""), Math.floor(inputBudget / 2))].reverse().join("")}`
    : transcript;
  let summary = "";
  try {
    const client = options.createClient();
    summary = await client.summarize(input, { ...options.stream, maxOutputTokens: Math.min(allowance, Math.floor(available / 2)) });
    if (client.usage) options.onUsage?.(client.usage);
  } catch { /* Fall back to a bounded local record, never erase the durable ledger. */ }
  if (options.stream?.cancelled?.() || options.stream?.signal?.aborted) throw new TaskControlError("cancelled", "Task cancelled during context compression");
  const retained = body.slice(keep);
  const fallback = "Earlier activity is recorded in the task ledger. Unverified work remains incomplete.\n" +
    body.filter(message => message.role === "tool").slice(-12).map(message => `${message.tool_call_id}: ${message.content?.slice(0, 160) ?? ""}`).join("\n");
  const summaryBudget = Math.max(32, available - estimateTokens(retained) - 32);
  const compacted = { role: "assistant", content: truncate(summary || fallback, summaryBudget) } as T;
  messages.splice(0, messages.length, ...head, compacted, ...retained);
  if (estimateTokens(messages) > limit) {
    messages.splice(head.length, messages.length - head.length, { role: "assistant", content: truncate(summary || fallback, available - 32) } as T);
  }
}
