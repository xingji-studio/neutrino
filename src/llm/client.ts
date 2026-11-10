import { INTENSITY_PARAMS, intensityForModel, modelUsesReasoning, type ModelInfo } from "../config.js";
import type { ToolDefinition } from "./tools.js";
import { DiagnosticRequest, diagnosticHash, type DiagnosticRequestContext } from "./diagnostics.js";
import { currentTask, TaskControlError, type AgentError } from "./runtime.js";
import { inputTokenBound, DEFAULT_OUTPUT_TOKENS } from "./context.js";
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

/** OpenAI reasoning models require max_completion_tokens; other compatible APIs use max_tokens. */
export function completionLimit(model: ModelInfo, provider: string, tokens: number): Record<string, number> {
  let official = false;
  try { official = new URL(model.url).hostname === "api.openai.com"; } catch { /* Test/local endpoints may omit a URL. */ }
  return official || /^openai$/i.test(provider) || /^(?:o\d|gpt-[5-9])(?:\b|[.-])/i.test(model.name)
    ? { max_completion_tokens: tokens } : { max_tokens: tokens };
}

interface ApiMessage {
  role: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  /** Original Anthropic blocks, including signed thinking between tool calls. */
  anthropic_content?: unknown[];
}

/** Give up if the server has not started to respond within this window. */
const CONNECT_TIMEOUT_MS = 120_000;

export interface StreamOptions {
  /** Internal opt-in timing metadata; never included in a provider payload. */
  diagnostic?: DiagnosticRequestContext;
  diagnosticObserver?: DiagnosticRequest;
  maxOutputTokens?: number;
  /** Reserved final request after normal request capacity has been spent. */
  final?: boolean;
  /** Cancels both the connection and an in-progress response body. */
  signal?: AbortSignal;
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
async function postStream(url: string, init: RequestInit, diagnostic?: DiagnosticRequest): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
    CONNECT_TIMEOUT_MS,
  );
  try {
    if (diagnostic && typeof init.body === "string") diagnostic.dispatch(init.body);
    const response = await fetch(url, { ...init, signal: controller.signal });
    diagnostic?.headers(response.status);
    return response;
  } finally {
    clearTimeout(timer);
    // The caller's stream controller is aborted in streamTurn's finally, so
    // this listener also covers cancellation after the response headers.
    if (controller.signal.aborted) init.signal?.removeEventListener("abort", abort);
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
  options.diagnosticObserver?.retry(delayMs);
  options.onRetry?.({ attempt: attempt + 1, attempts: policy.attempts, delayMs, reason: describeError(error) });
  return waitBeforeRetry(attempt - 1, policy, options.cancelled);
}

export class LLMClient {
  readonly professional: boolean;
  model: ModelInfo;
  provider: string;
  intensity: string;
  temperature: number;
  top_p: number;
  toolCalls: ToolCall[] = [];
  usage: UsageInfo | null = null;
  outcome: { status: "completed" | "failed" | "cancelled"; error?: AgentError } | null = null;
  finishReason: string | null = null;
  /**
   * The thinking text streamed alongside the reply. DeepSeek's thinking mode
   * requires it to be echoed back on the assistant message that carries a tool
   * call, so the agent loops attach it to that message.
   */
  reasoningContent = "";
  anthropicContent: unknown[] = [];

  constructor(model: ModelInfo, provider: string, intensity: string, options: { professional?: boolean } = {}) {
    this.model = model;
    this.provider = provider;
    this.professional = options.professional === true;
    // Final safety net: even a stale UI, a saved session or a hand-edited
    // selection can never send a level this model does not declare.
    this.intensity = this.professional ? intensity.trim().toLowerCase() || "high" : intensityForModel(model, intensity);
    const sampling = this.professional
      ? this.intensity.charAt(0).toUpperCase() + this.intensity.slice(1)
      : this.intensity;
    const params = INTENSITY_PARAMS[sampling] ?? INTENSITY_PARAMS["High"];
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
    const streamOptions = currentTask()?.runtime.diagnostics ? { ...options, diagnostic: { ...options.diagnostic, role: "compression" as const } } : options;
    for await (const chunk of this.streamTurn(messages, undefined, streamOptions)) out += chunk;
    const text = out.trim();
    if (this.outcome?.status === "failed" || !text || text.startsWith("[Error")) return "";
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
    return this.outcome?.status === "failed" ? `[Error: ${this.outcome.error?.message ?? "model request failed"}]` : out.trim();
  }

  async *streamTurn(
    messages: ApiMessage[],
    tools?: ToolDefinition[],
    options: StreamOptions = {},
  ): AsyncGenerator<string> {
    this.toolCalls = [];
    this.usage = null;
    this.outcome = null;
    this.finishReason = null;
    this.reasoningContent = "";
    this.anthropicContent = [];
    const controller = new AbortController();
    const runtime = currentTask()?.runtime;
    const diagnostic = runtime?.diagnostics ? new DiagnosticRequest(runtime.diagnostics, { role: currentTask()?.depth ? "worker" : "main", ...options.diagnostic }, currentTask()) : undefined;
    if (diagnostic) runtime!.diagnostics!.emit("model_configuration", { request_id: diagnostic.requestId,
      model_config_hash: diagnosticHash({ model: this.model.name, provider: this.provider, intensity: this.intensity, professional: this.professional, temperature: this.temperature, top_p: this.top_p }),
      output_budget: options.maxOutputTokens ?? (runtime ? DEFAULT_OUTPUT_TOKENS : null) }, currentTask());
    const taskSignal = currentTask()?.signal;
    const release = runtime?.activity();
    const rootAbort = () => controller.abort(taskSignal?.reason);
    taskSignal?.addEventListener("abort", rootAbort, { once: true });
    if (taskSignal?.aborted) rootAbort();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const cancelled = () => controller.signal.aborted || options.cancelled?.() === true;
    const timer = options.cancelled ? setInterval(() => {
      if (options.cancelled?.()) controller.abort();
    }, 100) : null;
    const requestOptions = { ...options, ...(diagnostic ? { diagnosticObserver: diagnostic } : {}), maxOutputTokens: options.maxOutputTokens ?? (runtime ? DEFAULT_OUTPUT_TOKENS : undefined), signal: controller.signal, cancelled };
    try {
      if (controller.signal.aborted) return;
      if (tools && runtime?.plugins) {
        tools = runtime.availableTools(tools);
        const suffix = await runtime.plugins.requestSuffix({ provider:this.provider,model:this.model.name,role:currentTask()?.role ?? "main",toolCount:tools.length });
        if (suffix) {
          messages = messages.map((message,index) => index === 0 && message.role === "system" ? { ...message,content:(message.content ?? "") + suffix } : message);
          runtime.note("plugin_request_suffix",{ suffix });
        }
      }
      if (this.provider === "Anthropic") {
        yield* this.streamAnthropic(messages, tools, requestOptions);
        return;
      }
      yield* this.streamOpenAI(messages, tools, requestOptions);
    } catch (e) {
      this.outcome = { status: cancelled() ? "cancelled" : "failed", error: {
        code: e instanceof TaskControlError ? e.code : "model_error", message: describeError(e),
      } };
      if (!cancelled()) yield `\n[Error: ${describeError(e)}]`;
    } finally {
      if (!this.outcome && ["length", "max_tokens"].includes(this.finishReason ?? "")) {
        this.outcome = { status: "failed", error: { code: "output_limit", message: "Model output reached its limit before completion; no tool calls from this response were executed" } };
      }
      this.outcome ??= { status: cancelled() ? "cancelled" : "completed" };
      diagnostic?.end(this.outcome.status);
      taskSignal?.removeEventListener("abort", rootAbort);
      release?.();
      if (timer) clearInterval(timer);
      options.signal?.removeEventListener("abort", abort);
      controller.abort();
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
      this.usage = null;
      this.finishReason = null;
      this.reasoningContent = "";
      let produced = false;
      const inputTokens = inputTokenBound({ messages, tools });
      let reservation: ReturnType<NonNullable<ReturnType<typeof currentTask>>["runtime"]["request"]> | undefined;
      try {
        reservation = currentTask()?.runtime.request(inputTokens, options.maxOutputTokens ?? 4096, options.final);
        for await (const token of this.openAIAttempt(messages, tools, options)) {
          produced = true;
          yield token;
        }
        return;
      } catch (e) {
        if (produced || attempt >= policy.attempts || !isRetriableFailure(e)) throw e;
        if (!(await pauseForRetry(attempt, policy, e, options))) return;
      } finally {
        reservation?.settle((this.usage as UsageInfo | null)?.total ?? inputTokens + (options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS));
      }
    }
  }

  /**
   * DeepSeek's thinking mode rejects a tools-bearing request when any assistant
   * message in its history carries no `reasoning_content` ("The
   * `reasoning_content` in the thinking mode must be passed back to the API").
   * An empty string is accepted, which is the honest value for a message that
   * predates this turn's thinking: a compressed summary, the planner's plan, an
   * error note or a session saved before this rule existed. Endpoints outside
   * thinking mode must not receive the field at all.
   */
  private wireMessages(messages: ApiMessage[]): ApiMessage[] {
    if (!modelUsesReasoning(this.provider, this.model)) {
      return messages.map((message) => {
        if (message.role !== "assistant" || message.reasoning_content === undefined) return message;
        const { reasoning_content: _ignored, ...rest } = message;
        return rest;
      });
    }
    return messages.map((message) =>
      message.role === "assistant" && typeof message.reasoning_content !== "string"
        ? { ...message, reasoning_content: "" }
        : message,
    );
  }

  /** A single streaming attempt; see `streamOpenAI` for the retry policy. */
  private async *openAIAttempt(messages: ApiMessage[], tools: ToolDefinition[] | undefined, options: StreamOptions): AsyncGenerator<string> {
    const url = this.model.url.replace(/\/+$/, "") + "/chat/completions";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.model.api_key}`,
    };
    const payload: Record<string, unknown> = {
      model: this.model.name,
      messages: this.wireMessages(messages),
      ...(options.maxOutputTokens ? completionLimit(this.model, this.provider, options.maxOutputTokens) : {}),
      ...(this.professional ? { reasoning_effort: this.intensity } : {
        temperature: this.temperature,
        top_p: this.top_p,
      }),
      stream: this.model.supports_streaming !== false,
      ...(this.model.supports_streaming !== false ? { stream_options: { include_usage: true } } : {}),
    };
    if (tools && tools.length) payload.tools = tools;

    const resp = await postStream(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    }, options.diagnosticObserver);

    if (!resp.ok) {
      // Thrown rather than printed: a 502/503/504/429 is as transient as a
      // reset and deserves the same retries, while a 400/401 must surface at
      // once. `streamTurn` renders the final failure into the transcript.
      const body = await resp.text().catch(() => "");
      throw new HttpStatusError(resp.status, body.slice(0, 500));
    }
    if (this.model.supports_streaming === false || resp.headers.get("content-type")?.includes("application/json")) {
      const body = await resp.json() as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string; reasoning?: string;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const message = body.choices?.[0]?.message;
      this.finishReason = body.choices?.[0]?.finish_reason ?? null;
      if (!message) throw new Error("endpoint did not return a valid model completion");
      this.reasoningContent = message.reasoning_content ?? message.reasoning ?? "";
      if (this.reasoningContent) options.diagnosticObserver?.content("reasoning");
      if (message.content) options.diagnosticObserver?.content("text");
      if (message.tool_calls?.length) options.diagnosticObserver?.content("tool");
      options.diagnosticObserver?.usageUpdate(body.usage);
      this.toolCalls = (message.tool_calls ?? []).map((call) => ({
        id: call.id, name: call.function.name, arguments: call.function.arguments,
      }));
      if (body.usage) {
        const prompt = body.usage.prompt_tokens ?? 0;
        const completion = body.usage.completion_tokens ?? 0;
        this.usage = { prompt, completion, total: body.usage.total_tokens ?? prompt + completion };
      }
      if (message.content) yield message.content;
      return;
    }
    if (!resp.body) {
      throw new Error("empty response body");
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
          options.diagnosticObserver?.usageUpdate(usage);
          if (usage) {
            this.usage = {
              prompt: usage.prompt_tokens ?? 0,
              completion: usage.completion_tokens ?? 0,
              total: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
            };
          }
          const choice = (chunk as { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string }> }).choices?.[0];
          if (choice?.finish_reason) this.finishReason = choice.finish_reason;
          const delta = choice?.delta ?? {};
          // DeepSeek calls it reasoning_content; other compatible endpoints use
          // the shorter `reasoning`. Neither is part of the visible reply.
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === "string" && reasoning) { options.diagnosticObserver?.content("reasoning"); this.reasoningContent += reasoning; }
          const content = delta.content;
          if (typeof content === "string" && content) { options.diagnosticObserver?.content("text"); yield content; }
          const toolCalls = delta.tool_calls as Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }> | undefined;
          if (toolCalls?.length) options.diagnosticObserver?.content("tool");
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
  private async *streamAnthropic(messages: ApiMessage[], tools: ToolDefinition[] | undefined, options: StreamOptions): AsyncGenerator<string> {
    const policy = resolvePolicy(options);
    for (let attempt = 1; ; attempt++) {
      this.toolCalls = [];
      this.usage = null;
      this.finishReason = null;
      this.anthropicContent = [];
      let produced = false;
      const inputTokens = inputTokenBound({ messages, tools });
      let reservation: ReturnType<NonNullable<ReturnType<typeof currentTask>>["runtime"]["request"]> | undefined;
      try {
        reservation = currentTask()?.runtime.request(inputTokens, options.maxOutputTokens ?? 4096, options.final);
        for await (const token of this.anthropicAttempt(messages, tools, options)) {
          produced = true;
          yield token;
        }
        return;
      } catch (e) {
        if (produced || attempt >= policy.attempts || !isRetriableFailure(e)) throw e;
        if (!(await pauseForRetry(attempt, policy, e, options))) return;
      } finally {
        reservation?.settle((this.usage as UsageInfo | null)?.total ?? inputTokens + (options.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS));
      }
    }
  }

  /** A single streaming attempt; see `streamAnthropic` for the retry policy. */
  private async *anthropicAttempt(messages: ApiMessage[], tools: ToolDefinition[] | undefined, options: StreamOptions): AsyncGenerator<string> {
    const url = this.model.url.replace(/\/+$/, "") + "/messages";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.model.api_key,
      "anthropic-version": "2023-06-01",
    };

    const systemMessages: string[] = [];
    const chatMessages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
    for (const m of messages) {
      if (m.role === "system") {
        if (m.content) systemMessages.push(m.content);
        continue;
      }
      let blocks: unknown[];
      const role = m.role === "assistant" ? "assistant" : "user";
      if (m.role === "tool") {
        blocks = [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content ?? "" }];
      } else if (m.role === "assistant" && m.anthropic_content?.length) {
        blocks = m.anthropic_content;
      } else {
        blocks = m.content ? [{ type: "text", text: m.content }] : [];
        for (const raw of m.tool_calls ?? []) {
          const call = raw as { id: string; function: { name: string; arguments: string } };
          let input: unknown;
          try { input = JSON.parse(call.function.arguments); } catch { input = { value: call.function.arguments }; }
          blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
        }
      }
      if (!blocks.length) continue;
      const previous = chatMessages.at(-1);
      if (previous?.role === role) previous.content.push(...blocks);
      else chatMessages.push({ role, content: [...blocks] });
    }

    const payload: Record<string, unknown> = {
      model: this.model.name,
      messages: chatMessages,
      max_tokens: options.maxOutputTokens ?? 4096,
      ...(this.professional ? { output_config: { effort: this.intensity } } : { temperature: this.temperature }),
      stream: this.model.supports_streaming !== false,
    };
    if (systemMessages.length) payload.system = systemMessages.join("\n\n");
    if (tools?.length) payload.tools = tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));

    const resp = await postStream(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    }, options.diagnosticObserver);
    if (!resp.ok) {
      // Thrown rather than printed: a 502/503/504/429 is as transient as a
      // reset and deserves the same retries, while a 400/401 must surface at
      // once. `streamTurn` renders the final failure into the transcript.
      const body = await resp.text().catch(() => "");
      throw new HttpStatusError(resp.status, body.slice(0, 500));
    }
    if (this.model.supports_streaming === false || resp.headers.get("content-type")?.includes("application/json")) {
      const body = await resp.json() as {
        content?: Array<Record<string, unknown>>;
        stop_reason?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (!Array.isArray(body.content)) throw new Error("endpoint did not return a valid model completion");
      this.captureAnthropicContent(body.content);
      options.diagnosticObserver?.usageUpdate(body.usage);
      if (this.reasoningContent) options.diagnosticObserver?.content("reasoning");
      if (this.toolCalls.length) options.diagnosticObserver?.content("tool");
      if (body.content.some(block => block.type === "text")) options.diagnosticObserver?.content("text");
      this.finishReason = body.stop_reason ?? null;
      if (body.usage) {
        const prompt = body.usage.input_tokens ?? 0;
        const completion = body.usage.output_tokens ?? 0;
        this.usage = { prompt, completion, total: prompt + completion };
      }
      for (const block of body.content) if (block.type === "text" && typeof block.text === "string") yield block.text;
      return;
    }
    if (!resp.body) {
      throw new Error("empty response body");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let stopped = false;
    const blocks: Record<number, Record<string, unknown>> = {};
    const toolArguments: Record<number, string> = {};

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
          const event = chunk as {
            type?: string; index?: number; content_block?: Record<string, unknown>;
            delta?: { text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
            usage?: { output_tokens?: number };
            error?: { message?: string };
          };
          const type = event.type;
          options.diagnosticObserver?.usageUpdate(event.message?.usage ?? event.usage);
          if (event.content_block?.type === "tool_use" || event.delta?.partial_json) options.diagnosticObserver?.content("tool");
          if (event.delta?.thinking || event.content_block?.type === "thinking") options.diagnosticObserver?.content("reasoning");
          if (event.delta?.text || event.content_block?.text) options.diagnosticObserver?.content("text");
          if (event.delta?.stop_reason) this.finishReason = event.delta.stop_reason;
          if (type === "error") throw new Error(event.error?.message ?? "Anthropic stream failed");
          if (type === "message_start") {
            const input = event.message?.usage?.input_tokens ?? 0;
            const output = event.message?.usage?.output_tokens ?? 0;
            this.usage = { prompt: input, completion: output, total: input + output };
          } else if (type === "message_delta" && event.usage) {
            const prompt = this.usage?.prompt ?? 0;
            const completion = event.usage.output_tokens ?? this.usage?.completion ?? 0;
            this.usage = { prompt, completion, total: prompt + completion };
          } else if (type === "content_block_start") {
            blocks[event.index ?? 0] = { ...event.content_block };
            if (event.content_block?.type === "tool_use") toolArguments[event.index ?? 0] = "";
            if (typeof event.content_block?.text === "string" && event.content_block.text) yield event.content_block.text;
          }
          if (type === "content_block_delta") {
            const index = event.index ?? 0;
            const block = blocks[index] ??= { type: "text", text: "" };
            if (event.delta?.text) {
              block.text = String(block.text ?? "") + event.delta.text;
              yield event.delta.text;
            }
            if (event.delta?.partial_json) toolArguments[index] = (toolArguments[index] ?? "") + event.delta.partial_json;
            if (event.delta?.thinking) {
              block.thinking = String(block.thinking ?? "") + event.delta.thinking;
              this.reasoningContent += event.delta.thinking;
            }
            if (event.delta?.signature) block.signature = String(block.signature ?? "") + event.delta.signature;
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
    const content = Object.keys(blocks).map(Number).sort((a, b) => a - b).map((index) => {
      const block = blocks[index];
      if (block.type === "tool_use") {
        const raw = toolArguments[index];
        if (raw) {
          try { block.input = JSON.parse(raw); } catch { block.input = { value: raw }; }
        }
      }
      return block;
    });
    this.captureAnthropicContent(content);
  }

  private captureAnthropicContent(blocks: Array<Record<string, unknown>>): void {
    this.anthropicContent = blocks;
    this.reasoningContent = blocks.filter((block) => block.type === "thinking").map((block) => String(block.thinking ?? "")).join("");
    this.toolCalls = blocks.filter((block) => block.type === "tool_use").map((block) => ({
      id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: JSON.stringify(block.input ?? {}),
    }));
  }
}
