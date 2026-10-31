import { INTENSITY_PARAMS, type ModelInfo } from "../config.js";
import type { ToolDefinition } from "./tools.js";
import {
  HttpStatusError,
  describeError,
  isRetriableFailure,
  retryDelayMs,
  retryPolicy,
  waitBeforeRetry,
  type RetryNotice,
  type RetryPolicy,
} from "./retry.js";

// Callers import `describeError` from this module; it lives next to the
// classification helpers that share the same "is this a dropped connection?"
// knowledge, so it is re-exported rather than duplicated.
export { describeError } from "./retry.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface UsageInfo {
  prompt: number;
  completion: number;
  total: number;
}

interface ApiMessage {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

/** Give up if the server has not started to respond within this window. */
const CONNECT_TIMEOUT_MS = 120_000;

export interface StreamOptions {
  /**
   * Reported before each wait so the UI can explain why the stream went quiet
   * for up to 160s instead of looking hung.
   */
  onRetry?: (notice: RetryNotice) => void;
  /**
   * Polled during the waits: a paused turn, a newer message or a quit has no
   * interest in the reply any more, and must not be held up by a long backoff.
   */
  cancelled?: () => boolean;
  /** Override the policy (tests, or a caller with its own budget). */
  retry?: Partial<RetryPolicy>;
}

/**
 * System prompt used when compressing a long conversation. The instruction
 * spells out exactly what must survive compression (goals, decisions, files,
 * commands) so the summary stays useful for continuing the work.
 */
const SUMMARY_SYSTEM_PROMPT =
  "You compress the conversation history of an AI coding assistant so it fits in a smaller context window. " +
  "Write a dense, factual summary in the same language as the conversation. Preserve: the user's goals and " +
  "constraints, decisions that were made, files created or modified (with their paths), commands that were run " +
  "and their meaningful results, and any unresolved problems or next steps. Drop pleasantries, restated " +
  "instructions and redundant tool output. Output only the summary, with no preface.";

/**
 * One POST, bounded by a connect timeout.
 *
 * Retrying deliberately does *not* happen here: only the caller knows whether a
 * token already reached the user, and nesting two retry loops would multiply
 * both the request count and the total wait by the attempt budget.
 */
async function postStream(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
    CONNECT_TIMEOUT_MS,
  );
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The policy a stream will actually use, with any per-call override applied. */
function resolvePolicy(options: StreamOptions): RetryPolicy {
  return { ...retryPolicy(), ...options.retry };
}

/**
 * Wait before the next attempt, telling the caller why the stream went quiet.
 * Returns false when the caller stopped caring during the wait.
 */
async function pauseForRetry(
  attempt: number,
  policy: RetryPolicy,
  error: unknown,
  options: StreamOptions,
): Promise<boolean> {
  const delayMs = retryDelayMs(attempt - 1, policy);
  options.onRetry?.({ attempt: attempt + 1, attempts: policy.attempts, delayMs, reason: describeError(error) });
  return waitBeforeRetry(attempt - 1, policy, options.cancelled);
}

export class LLMClient {
  model: ModelInfo;
  provider: string;
  intensity: string;
  temperature: number;
  top_p: number;
  toolCalls: ToolCall[] = [];
  usage: UsageInfo | null = null;

  constructor(model: ModelInfo, provider: string, intensity: string) {
    this.model = model;
    this.provider = provider;
    this.intensity = intensity;
    const params = INTENSITY_PARAMS[intensity] ?? INTENSITY_PARAMS["High"];
    this.temperature = params.temperature;
    this.top_p = params.top_p;
  }

  /**
   * Ask the model to compress a transcript into a short summary. Returns an
   * empty string on any failure so the caller can fall back to simply dropping
   * the old messages. Uses a throw-away request (no tools) via the normal
   * streaming path, so provider differences are handled for free.
   */
  async summarize(transcript: string, options: StreamOptions = {}): Promise<string> {
    const messages: ApiMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ];
    let out = "";
    for await (const chunk of this.streamTurn(messages, undefined, options)) out += chunk;
    const text = out.trim();
    if (!text || text.startsWith("[Error")) return "";
    return text;
  }

  /**
   * One-shot completion with its own system prompt. The approval reviewers use
   * this so they never share context with the conversation they are judging.
   */
  async complete(system: string, user: string, options: StreamOptions = {}): Promise<string> {
    let out = "";
    for await (const chunk of this.streamTurn(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      undefined,
      options,
    )) {
      out += chunk;
    }
    return out.trim();
  }

  async *streamTurn(
    messages: ApiMessage[],
    tools?: ToolDefinition[],
    options: StreamOptions = {},
  ): AsyncGenerator<string> {
    this.toolCalls = [];
    this.usage = null;
    try {
      if (this.provider === "Anthropic") {
        yield* this.streamAnthropic(messages, options);
        return;
      }
      yield* this.streamOpenAI(messages, tools, options);
    } catch (e) {
      yield `\n[Error: ${describeError(e)}]`;
    }
  }

  /**
   * Drive one request, retrying while the failure is transient.
   *
   * A response can be cut off on the very first read — "terminated" when a
   * proxy or the server closes the connection mid-flight — or the request can
   * never leave at all. Nothing has reached the user yet, so re-issuing is
   * invisible and cannot duplicate text; the attempts and the 5s/10s/20s/…
   * backoff live in `retry.ts`.
   *
   * Once a token has been emitted a retry would replay the reply from its
   * beginning, so the error is surfaced instead and the partial text is kept.
   */
  private async *streamOpenAI(
    messages: ApiMessage[],
    tools: ToolDefinition[] | undefined,
    options: StreamOptions,
  ): AsyncGenerator<string> {
    const policy = resolvePolicy(options);
    for (let attempt = 1; ; attempt++) {
      this.toolCalls = [];
      let produced = false;
      try {
        for await (const token of this.openAIAttempt(messages, tools)) {
          produced = true;
          yield token;
        }
        return;
      } catch (e) {
        if (produced || attempt >= policy.attempts || !isRetriableFailure(e)) throw e;
        if (!(await pauseForRetry(attempt, policy, e, options))) return;
      }
    }
  }

  /** A single streaming attempt; see `streamOpenAI` for the retry policy. */
  private async *openAIAttempt(messages: ApiMessage[], tools?: ToolDefinition[]): AsyncGenerator<string> {
    const url = this.model.url.replace(/\/+$/, "") + "/chat/completions";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.model.api_key}`,
    };
    const payload: Record<string, unknown> = {
      model: this.model.name,
      messages,
      temperature: this.temperature,
      top_p: this.top_p,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools && tools.length) payload.tools = tools;

    const resp = await postStream(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      // Thrown rather than printed: a 502/503/504/429 is as transient as a
      // reset and deserves the same retries, while a 400/401 must surface at
      // once. `streamTurn` renders the final failure into the transcript.
      const body = await resp.text().catch(() => "");
      throw new HttpStatusError(resp.status, body.slice(0, 500));
    }
    if (!resp.body) {
      yield "\n[Error: empty response body]";
      return;
    }

    const toolCallsByIndex: Record<number, ToolCall> = {};
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let stopped = false;

    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          const line = raw.trim();
          if (!line) continue;
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            stopped = true;
            break;
          }
          let chunk: unknown;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const usage = (chunk as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }).usage;
          if (usage) {
            this.usage = {
              prompt: usage.prompt_tokens ?? 0,
              completion: usage.completion_tokens ?? 0,
              total: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
            };
          }
          const choice = (chunk as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0];
          const delta = choice?.delta ?? {};
          const content = delta.content;
          if (typeof content === "string" && content) yield content;
          const toolCalls = delta.tool_calls as Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }> | undefined;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const i = tc.index ?? 0;
              const entry = (toolCallsByIndex[i] ??= { id: "", name: "", arguments: "" });
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;
              if (tc.function?.arguments) entry.arguments += tc.function.arguments;
            }
          }
        }
      }
    } finally {
      // The consumer may walk away mid-stream (pause, a newer turn taking over,
      // or `[DONE]` arriving before the body ends). Always release the reader so
      // the socket is torn down instead of lingering — leaked streaming bodies
      // are what eventually make every request fail with "fetch failed".
      try {
        await reader.cancel();
      } catch {
        // Already closed / errored; nothing left to release.
      }
    }

    this.toolCalls = Object.keys(toolCallsByIndex)
      .map((k) => Number(k))
      .sort((a, b) => a - b)
      .map((k) => toolCallsByIndex[k]);
  }

  /** Anthropic counterpart of `streamOpenAI`, with the same retry policy. */
  private async *streamAnthropic(messages: ApiMessage[], options: StreamOptions): AsyncGenerator<string> {
    const policy = resolvePolicy(options);
    for (let attempt = 1; ; attempt++) {
      this.toolCalls = [];
      let produced = false;
      try {
        for await (const token of this.anthropicAttempt(messages)) {
          produced = true;
          yield token;
        }
        return;
      } catch (e) {
        if (produced || attempt >= policy.attempts || !isRetriableFailure(e)) throw e;
        if (!(await pauseForRetry(attempt, policy, e, options))) return;
      }
    }
  }

  /** A single streaming attempt; see `streamAnthropic` for the retry policy. */
  private async *anthropicAttempt(messages: ApiMessage[]): AsyncGenerator<string> {
    const url = this.model.url.replace(/\/+$/, "") + "/messages";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.model.api_key,
      "anthropic-version": "2023-06-01",
    };

    let systemMsg: string | undefined;
    const chatMessages: ApiMessage[] = [];
    for (const m of messages) {
      if (m.role === "system") systemMsg = m.content ?? "";
      else chatMessages.push({ role: m.role, content: m.content ?? "" });
    }

    const payload: Record<string, unknown> = {
      model: this.model.name,
      messages: chatMessages,
      max_tokens: 4096,
      temperature: this.temperature,
      stream: true,
    };
    if (systemMsg) payload.system = systemMsg;

    const resp = await postStream(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      // Thrown rather than printed: a 502/503/504/429 is as transient as a
      // reset and deserves the same retries, while a 400/401 must surface at
      // once. `streamTurn` renders the final failure into the transcript.
      const body = await resp.text().catch(() => "");
      throw new HttpStatusError(resp.status, body.slice(0, 500));
    }
    if (!resp.body) {
      yield "\n[Error: empty response body]";
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let stopped = false;

    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, idx).replace(/\r$/, "");
          buf = buf.slice(idx + 1);
          const line = raw.trim();
          if (!line || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            stopped = true;
            break;
          }
          let chunk: unknown;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          const type = (chunk as { type?: string }).type;
          if (type === "content_block_delta") {
            const text = (chunk as { delta?: { text?: string } }).delta?.text;
            if (text) yield text;
          } else if (type === "message_stop") {
            stopped = true;
            break;
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Already closed / errored; nothing left to release.
      }
    }
  }
}
