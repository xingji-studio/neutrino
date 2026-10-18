import { INTENSITY_PARAMS, type ModelInfo } from "../config.js";
import type { ToolDefinition } from "./tools.js";

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

/** How many extra times a request is retried when the connection drops. */
const NETWORK_RETRIES = 2;
/** Give up if the server has not started to respond within this window. */
const CONNECT_TIMEOUT_MS = 120_000;

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
 * Terse transport messages that all mean "the connection dropped mid-flight".
 * The \b keeps "terminated" from matching unrelated text such as
 * "Unterminated string constant".
 */
const DROP_HINT_RE = /\bterminated\b|other side closed|socket hang up|premature close/i;

/**
 * Flatten an error and its `cause` chain into one readable line.
 *
 * `fetch` reports almost every transport problem as a bare
 * `TypeError: fetch failed`; the actual reason (`ECONNRESET`, `EMFILE`,
 * `ENOTFOUND`, `UND_ERR_…`) is tucked away in `error.cause`. Without walking
 * that chain a failure is impossible to diagnose, so this always reports it.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts: string[] = [];
  const push = (msg: string, code?: string): void => {
    const text = code && !msg.includes(code) ? `${msg} (${code})` : msg;
    if (text && !parts.includes(text)) parts.push(text);
  };

  let cur: unknown = e;
  const seen = new Set<unknown>();
  while (cur != null && !seen.has(cur)) {
    if (typeof cur === "string") {
      // fetch/undici sometimes stash the real reason in a plain string
      // (`cause: "other side closed"`), which an object-only walk would miss.
      push(cur);
      break;
    }
    if (typeof cur !== "object") break;
    seen.add(cur);
    const err = cur as { message?: unknown; name?: unknown; code?: unknown; cause?: unknown };
    const message = typeof err.message === "string" && err.message ? err.message : String(err.name ?? "Error");
    const code = typeof err.code === "string" ? err.code : undefined;
    push(message, code);
    cur = err.cause;
  }
  const text = parts.join(": ") || e.message;
  // A dropped mid-stream connection surfaces as a bare `TypeError: terminated`,
  // which on its own tells the user nothing worth reading.
  return DROP_HINT_RE.test(text) ? `${text} — the connection was closed before the response finished` : text;
}

/**
 * Whether a failed request is worth retrying: a transient connection problem
 * (reset / refused / DNS / timeout) rather than a real response from the API.
 */
function isRetriableNetworkError(e: unknown): boolean {
  const transient = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "ENETUNREACH",
    "ENETDOWN",
    "EAI_AGAIN",
    "ERR_STREAM_PREMATURE_CLOSE",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  let cur: unknown = e;
  const seen = new Set<unknown>();
  while (cur != null && !seen.has(cur)) {
    if (typeof cur === "string") {
      if (DROP_HINT_RE.test(cur)) return true;
      break;
    }
    if (typeof cur !== "object") break;
    seen.add(cur);
    const err = cur as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof err.code === "string" && transient.has(err.code)) return true;
    // Our own connect timeout aborts with a plain AbortError; undici wraps a
    // dropped socket in a SocketError.
    if (err.name === "AbortError" || err.name === "SocketError") return true;
    // A stream that dies mid-flight: "terminated", "socket hang up", …
    if (typeof err.message === "string" && DROP_HINT_RE.test(err.message)) return true;
    cur = err.cause;
  }
  // Undici's generic wrapper: assume the socket dropped and try again.
  return e instanceof Error && /fetch failed/i.test(e.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Issue a streaming request, retrying a few times on transient network errors
 * and giving up with a clear error if the server never starts responding.
 *
 * Retries are safe here because they only ever happen *before* a response is
 * returned; once bytes start flowing the caller is responsible for the stream.
 */
async function requestStream(url: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`request timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
      CONNECT_TIMEOUT_MS,
    );
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return resp;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === NETWORK_RETRIES || !isRetriableNetworkError(e)) throw e;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
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
  async summarize(transcript: string): Promise<string> {
    const messages: ApiMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ];
    let out = "";
    for await (const chunk of this.streamTurn(messages)) out += chunk;
    const text = out.trim();
    if (!text || text.startsWith("[Error")) return "";
    return text;
  }

  /**
   * One-shot completion with its own system prompt. The approval reviewers use
   * this so they never share context with the conversation they are judging.
   */
  async complete(system: string, user: string): Promise<string> {
    let out = "";
    for await (const chunk of this.streamTurn([
      { role: "system", content: system },
      { role: "user", content: user },
    ])) {
      out += chunk;
    }
    return out.trim();
  }

  async *streamTurn(messages: ApiMessage[], tools?: ToolDefinition[]): AsyncGenerator<string> {
    this.toolCalls = [];
    this.usage = null;
    try {
      if (this.provider === "Anthropic") {
        yield* this.streamAnthropic(messages);
        return;
      }
      yield* this.streamOpenAI(messages, tools);
    } catch (e) {
      yield `\n[Error: ${describeError(e)}]`;
    }
  }

  /**
   * Drive one request, retrying if the stream dies before it produced anything.
   *
   * A response can be cut off on the very first read — "terminated" when a
   * proxy or the server closes the connection mid-flight. Nothing has reached
   * the user yet, so re-issuing the request is invisible (and cannot duplicate
   * text). Once a token has been emitted a retry is unsafe, so the error is
   * surfaced instead.
   */
  private async *streamOpenAI(messages: ApiMessage[], tools?: ToolDefinition[]): AsyncGenerator<string> {
    for (let attempt = 0; ; attempt++) {
      this.toolCalls = [];
      let produced = false;
      try {
        for await (const token of this.openAIAttempt(messages, tools)) {
          produced = true;
          yield token;
        }
        return;
      } catch (e) {
        if (produced || attempt >= NETWORK_RETRIES || !isRetriableNetworkError(e)) throw e;
        await sleep(400 * (attempt + 1));
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

    const resp = await requestStream(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      yield `\n[Error: HTTP ${resp.status}${text ? " - " + text.slice(0, 500) : ""}]`;
      return;
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
  private async *streamAnthropic(messages: ApiMessage[]): AsyncGenerator<string> {
    for (let attempt = 0; ; attempt++) {
      this.toolCalls = [];
      let produced = false;
      try {
        for await (const token of this.anthropicAttempt(messages)) {
          produced = true;
          yield token;
        }
        return;
      } catch (e) {
        if (produced || attempt >= NETWORK_RETRIES || !isRetriableNetworkError(e)) throw e;
        await sleep(400 * (attempt + 1));
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

    const resp = await requestStream(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      yield `\n[Error: HTTP ${resp.status}${text ? " - " + text.slice(0, 500) : ""}]`;
      return;
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
