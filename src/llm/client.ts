import { INTENSITY_PARAMS, type ModelInfo } from "../config.js";
import type { ToolDefinition } from "./tools.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ApiMessage {
  role: string;
  content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export class LLMClient {
  model: ModelInfo;
  provider: string;
  intensity: string;
  temperature: number;
  top_p: number;
  toolCalls: ToolCall[] = [];

  constructor(model: ModelInfo, provider: string, intensity: string) {
    this.model = model;
    this.provider = provider;
    this.intensity = intensity;
    const params = INTENSITY_PARAMS[intensity] ?? INTENSITY_PARAMS["High"];
    this.temperature = params.temperature;
    this.top_p = params.top_p;
  }

  async *streamTurn(messages: ApiMessage[], tools?: ToolDefinition[]): AsyncGenerator<string> {
    this.toolCalls = [];
    try {
      if (this.provider === "Anthropic") {
        yield* this.streamAnthropic(messages);
        return;
      }
      yield* this.streamOpenAI(messages, tools);
    } catch (e) {
      yield `\n[Error: ${e instanceof Error ? e.message : String(e)}]`;
    }
  }

  private async *streamOpenAI(messages: ApiMessage[], tools?: ToolDefinition[]): AsyncGenerator<string> {
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
    };
    if (tools && tools.length) payload.tools = tools;

    const resp = await fetch(url, {
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

    this.toolCalls = Object.keys(toolCallsByIndex)
      .map((k) => Number(k))
      .sort((a, b) => a - b)
      .map((k) => toolCallsByIndex[k]);
  }

  private async *streamAnthropic(messages: ApiMessage[]): AsyncGenerator<string> {
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

    const resp = await fetch(url, {
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
  }
}
