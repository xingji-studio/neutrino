/**
 * Headless conversation runner for the web UI.
 *
 * The TUI keeps its agent loop inside `ChatScreen`, glued to the renderer. The
 * browser needs the same behaviour without a terminal, so this module resumes a
 * saved transcript from disk and runs turns against the configured model:
 * stream, execute tools, auto-compress, persist.
 *
 * A `WebSession` looks exactly like a TUI session from the outside: it
 * registers itself in the live hub, so the regular `/api/live/*` endpoints
 * (snapshot, stream, pause, resume, message) work unchanged.
 */

import {
  findModel,
  loadConfig,
  loadModels,
  loadPrompt,
  saveSession,
  type ModelInfo,
  type SessionData,
  type SessionMessage,
  type TokenUsage,
} from "../config.js";
import {
  COMPACT_KEEP,
  COMPACT_MAX_CHARS_PER_MESSAGE,
  planCompaction,
  transcriptFor,
  type CompactMessage,
} from "../compact.js";
import { LLMClient, describeError } from "../llm/client.js";
import { executeTool, getToolDefinitions } from "../llm/tools.js";
import { assessToolCall, type RiskAssessment } from "../llm/risk.js";
import { ApprovalGate, type ApprovalDecision } from "../llm/approval.js";
import {
  hub,
  type LiveAgent,
  type LiveMeta,
  type LiveSnapshot,
  type LiveWireMessage,
} from "./hub.js";

/** Same in-memory shape the TUI uses. */
type Msg =
  | { role: "user" | "assistant" | "system"; content: string }
  | { role: "tool"; name: string; arguments: Record<string, unknown>; result: string }
  | { role: "summary"; content: string; count: number };

interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

/** Drop a resumed conversation nobody touched for this long. */
const IDLE_DISPOSE_MS = 30 * 60 * 1000;

/** Upper bound on tool round-trips inside a single turn. */
const MAX_TOOL_ROUNDS = 24;

/** Placeholder shown while a tool is still running. */
const TOOL_PENDING = "…";

/** Marker stored on the collapsed part of a compressed transcript. */
const SUMMARY_PREFIX = "Context was compressed. Summary of the earlier part:";

export type ResumeOutcome =
  | { ok: true; session: WebSession }
  | { ok: false; error: string };

function parseArguments(raw: string): Record<string, unknown> {
  const text = raw?.trim() ?? "";
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {
    // Hand the raw payload over instead of failing the whole turn.
    return { value: text };
  }
  return { value: text };
}

/**
 * Look up the model recorded in the transcript. Returns a readable error
 * instead of throwing, so the HTTP layer can answer with a clean 4xx.
 */
export function resolveModel(
  modelName: string,
  providerName: string,
): { ok: true; model: ModelInfo } | { ok: false; error: string } {
  const providers = loadModels().providers ?? [];
  const scoped = providers.find((p) => p.name === providerName);
  const model =
    scoped?.models?.find((m) => m.name === modelName) ??
    providers.flatMap((p) => p.models ?? []).find((m) => m.name === modelName);
  if (!model) {
    return { ok: false, error: `model "${modelName}" is not configured any more` };
  }
  if (!model.api_key || !model.api_key.trim()) {
    return { ok: false, error: `model "${modelName}" has no API key configured` };
  }
  return { ok: true, model };
}

/** Build a web session from a saved transcript, or explain why we cannot. */
export function resumeSession(source: SessionData): ResumeOutcome {
  const resolved = resolveModel(source.model, source.provider);
  if (!resolved.ok) return resolved;
  return { ok: true, session: new WebSession(source, resolved.model) };
}

export class WebSession implements LiveAgent {
  key: string | null = null;

  private readonly model: ModelInfo;
  private readonly provider: string;
  private readonly intensity: string;
  private readonly dir: string;
  private readonly tokens: TokenUsage;

  private messages: Msg[];
  private sessionId: string;
  private busy = false;
  private paused = false;
  private queued: string | null = null;
  private compressing = false;
  private streamingContent: string | null = null;
  private turnToken = 0;
  private lastPromptTokens = 0;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Non-null while a tool call waits for the browser to answer. */
  private pendingApproval: {
    tool: string;
    risk: RiskAssessment;
    resolve(approved: boolean): void;
  } | null = null;

  /** Reviewer count while an automated review runs, null otherwise. */
  private reviewing: number | null = null;

  constructor(source: SessionData, model: ModelInfo) {
    this.model = model;
    this.provider = source.provider;
    this.intensity = source.intensity;
    this.dir = source.cwd;
    this.sessionId = source.id;
    this.messages = (source.messages as Msg[]).slice();
    this.tokens = {
      prompt: source.tokens?.prompt ?? 0,
      completion: source.tokens?.completion ?? 0,
    };
  }

  /** Register with the live hub so the browser can watch this conversation. */
  start(): string {
    this.key = hub.register(this);
    this.touch();
    this.publishLive();
    return this.key;
  }

  /** Detach from the hub. The transcript stays on disk. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    this.save();
    hub.unregister(this.key);
    this.key = null;
  }

  // ---- LiveAgent -------------------------------------------------------

  liveCwd(): string {
    return this.dir;
  }

  liveMeta(): LiveMeta {
    return {
      sessionId: this.sessionId,
      title: this.title(),
      provider: this.provider,
      model: this.model.name,
      intensity: this.intensity,
      busy: this.busy,
      paused: this.paused,
      queued: this.queued,
      compressing: this.compressing,
      tokens: { prompt: this.tokens.prompt, completion: this.tokens.completion },
      approval: this.pendingApproval
        ? { tool: this.pendingApproval.tool, level: this.pendingApproval.risk.level }
        : null,
      reviewing: this.reviewing,
    };
  }

  liveSnapshot(key: string): LiveSnapshot {
    const messages: LiveWireMessage[] = [];
    for (const message of this.messages) {
      if (message.role === "tool") {
        messages.push({
          role: "tool",
          name: message.name,
          arguments: message.arguments,
          result: message.result,
        });
      } else if (message.role === "summary") {
        messages.push({ role: "summary", content: message.content, count: message.count });
      } else if (message.role === "user" || message.role === "assistant") {
        messages.push({ role: message.role, content: message.content });
      }
    }
    return {
      ...this.liveMeta(),
      key,
      cwd: this.dir,
      messages,
      streamingContent: this.streamingContent,
    };
  }

  livePause(): void {
    if (this.paused || (!this.busy && !this.queued)) return;
    this.paused = true;
    this.turnToken++;
    // A queued decision would otherwise keep the promise (and the gate) alive.
    if (this.pendingApproval) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.resolve(false);
    }
    this.busy = false;
    this.streamingContent = null;
    this.save();
    this.publishLive();
  }

  liveResume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.publishLive();
    this.maybeFlushQueue();
  }

  liveSend(text: string): void {
    this.send(text);
  }

  liveApprove(approved: boolean): boolean {
    const pending = this.pendingApproval;
    if (!pending) return false;
    this.pendingApproval = null;
    pending.resolve(approved);
    this.publishLive();
    return true;
  }

  // ---- turn driving ----------------------------------------------------

  private send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.disposed) return;
    this.touch();
    this.messages.push({ role: "user", content: trimmed });

    if (this.busy || this.paused) {
      this.queued = trimmed;
      this.publishLive();
      return;
    }
    this.publishLive();
    this.startTurn();
  }

  private maybeFlushQueue(): void {
    if (!this.queued || this.busy || this.paused) return;
    this.queued = null;
    this.publishLive();
    this.startTurn();
  }

  private startTurn(): void {
    this.busy = true;
    const token = ++this.turnToken;
    this.streamingContent = "";
    this.publishLive();
    void (async () => {
      await this.autoCompress(token);
      if (token !== this.turnToken || this.paused) return;
      await this.agentLoop(this.buildApiMessages(), token);
    })().catch((err) => this.failTurn(err));
  }

  /** Ends a turn whose floating promise rejected, instead of crashing the app. */
  private failTurn(err: unknown): void {
    this.messages.push({ role: "assistant", content: `[Error: ${describeError(err)}]` });
    this.streamingContent = null;
    try {
      this.onTurnFinished();
    } catch {
      this.busy = false;
      this.paused = false;
    }
  }

  private buildApiMessages(): ApiMessage[] {
    const api: ApiMessage[] = [{ role: "system", content: loadPrompt() }];
    for (const m of this.messages) {
      if (m.role === "user" || m.role === "assistant") {
        api.push({ role: m.role, content: m.content });
      } else if (m.role === "summary") {
        api.push({ role: "assistant", content: m.content });
      }
    }
    return api;
  }

  private async agentLoop(apiMessages: ApiMessage[], token: number): Promise<void> {
    const tools = getToolDefinitions();
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (token !== this.turnToken || this.paused) return;
        const client = new LLMClient(this.model, this.provider, this.intensity);
        let text = "";
        this.streamingContent = "";
        this.publishLive();
        for await (const chunk of client.streamTurn(apiMessages, tools)) {
          if (token !== this.turnToken || this.paused) return;
          text += chunk;
          this.streamingContent = text;
          this.publishLive();
        }
        if (token !== this.turnToken || this.paused) return;
        this.streamingContent = null;

        if (client.usage) {
          this.tokens.prompt += client.usage.prompt;
          this.tokens.completion += client.usage.completion;
          this.lastPromptTokens = client.usage.prompt;
        }
        if (text.trim()) {
          this.messages.push({ role: "assistant", content: text });
          apiMessages.push({ role: "assistant", content: text });
        }
        this.save();
        this.publishLive();

        const toolCalls = client.toolCalls;
        if (toolCalls.length === 0) break;
        for (const call of toolCalls) {
          if (token !== this.turnToken || this.paused) return;
          const args = parseArguments(call.arguments);
          const toolMsg: Msg & { role: "tool" } = {
            role: "tool",
            name: call.name,
            arguments: args,
            result: TOOL_PENDING,
          };
          this.messages.push(toolMsg);
          this.publishLive();

          const decision = await this.requestApproval(call.name, args);
          if (token !== this.turnToken || this.paused) return;
          if (!decision.approved) {
            const denied =
              `[Not executed: approval denied (${decision.source}): ${decision.reason}] ` +
              "Do not retry this call unchanged; ask the user how to proceed.";
            toolMsg.result = denied;
            apiMessages.push({ role: "tool", content: denied, tool_call_id: call.id });
            this.save();
            this.publishLive();
            continue;
          }

          let result: string;
          try {
            result = await executeTool(call.name, args, this.dir);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          if (token !== this.turnToken || this.paused) return;
          toolMsg.result = result;
          apiMessages.push({ role: "tool", content: result, tool_call_id: call.id });
          this.publishLive();
        }
        this.save();
      }
      this.onTurnFinished();
    } catch (err) {
      if (this.streamingContent) {
        this.messages.push({ role: "assistant", content: this.streamingContent });
      }
      this.streamingContent = null;
      this.messages.push({
        role: "assistant",
        content: `[Error: ${err instanceof Error ? err.message : String(err)}]`,
      });
      this.onTurnFinished();
    }
  }

  private onTurnFinished(): void {
    this.busy = false;
    this.paused = false;
    this.streamingContent = null;
    this.save();
    this.publishLive();
    if (this.queued && !this.paused) this.maybeFlushQueue();
    else this.touch();
  }

  // ---- approval gate ---------------------------------------------------

  /** Classify a tool call and, when it is risky, wait for a decision. */
  private async requestApproval(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ApprovalDecision> {
    const risk = assessToolCall(tool, args, this.dir);
    if (!risk) return { approved: true, source: "prompt", reason: "routine call" };
    const gate = new ApprovalGate({
      askHuman: () =>
        new Promise<boolean>((resolve) => {
          this.pendingApproval = { tool, risk, resolve };
          this.publishLive();
        }),
      reviewer: () => this.reviewerModel(),
      extremeAutoApprovalEnabled: () => loadConfig().auto_approve_extreme_risk === true,
      context: () => this.reviewerContext(),
      onReview: (info) => {
        this.reviewing = info ? info.total : null;
        this.publishLive();
      },
    });
    return gate.decide({ tool, args, cwd: this.dir, prompt: this.currentPrompt(), risk });
  }

  /** Reviewer model: `approval_model` when set, otherwise the chat model. */
  private reviewerModel(): { model: ModelInfo; provider: string; intensity: string } {
    const name = String(loadConfig().approval_model ?? "").trim();
    const found = name ? findModel(name) : null;
    if (found) {
      const usable = resolveModel(found.model.name, found.provider);
      if (usable.ok) {
        return { model: usable.model, provider: found.provider, intensity: this.intensity };
      }
    }
    return { model: this.model, provider: this.provider, intensity: this.intensity };
  }

  /** The user message that opened this turn. */
  private currentPrompt(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === "user") return m.content;
    }
    return "";
  }

  /** Short conversation tail, so the reviewer sees the intent behind the call. */
  private reviewerContext(): string {
    return this.messages
      .slice(-6)
      .map((m) => {
        if (m.role === "tool") return `tool ${m.name}: ${m.result.slice(0, 500)}`;
        if (m.role === "summary") return `summary: ${m.content.slice(0, 500)}`;
        return `${m.role}: ${m.content.slice(0, 1000)}`;
      })
      .join("\n");
  }

  // ---- compression -----------------------------------------------------

  private compressThreshold(): number {
    const raw = loadConfig().context_compress_threshold;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private async autoCompress(token: number): Promise<void> {
    const threshold = this.compressThreshold();
    if (threshold <= 0 || this.lastPromptTokens < threshold) return;

    const visible = this.messages.filter((m) => m.role !== "system");
    const flat: CompactMessage[] = visible.map((m) =>
      m.role === "tool"
        ? { role: "tool", name: m.name, content: m.result }
        : { role: m.role, content: m.content },
    );
    const plan = planCompaction(flat, COMPACT_KEEP);
    if (!plan) return;

    const kept = visible.slice(plan.head.length);
    const transcript = transcriptFor(plan.head);

    this.compressing = true;
    this.publishLive();
    let summary = "";
    try {
      summary = await new LLMClient(this.model, this.provider, this.intensity).summarize(
        transcript,
      );
    } catch {
      summary = "";
    }
    this.compressing = false;
    this.publishLive();
    if (token !== this.turnToken || this.paused) return;

    const dropped = plan.head.length;
    const content = summary.trim()
      ? `${SUMMARY_PREFIX}\n\n${summary.trim()}`
      : `(${dropped} earlier messages were dropped to free up context.)`;

    this.messages = [{ role: "summary", content, count: dropped }, ...kept];
    this.lastPromptTokens = 0;
    this.save();
    this.publishLive();
  }

  // ---- persistence -----------------------------------------------------

  private title(): string {
    for (const m of this.messages) {
      if (m.role === "user") {
        const line = m.content.trim().split(/\r?\n/)[0] ?? "";
        return line.length > 80 ? `${line.slice(0, 77)}…` : line;
      }
    }
    return "Resumed chat";
  }

  private save(): void {
    const chat: SessionMessage[] = [];
    for (const m of this.messages) {
      if (m.role === "user" || m.role === "assistant" || m.role === "tool") chat.push(m);
      else if (m.role === "summary") chat.push({ role: "assistant", content: m.content });
    }
    if (chat.length === 0) return;
    try {
      this.sessionId = saveSession(
        chat,
        this.model.name,
        this.provider,
        this.intensity,
        this.dir,
        this.sessionId,
        this.tokens,
      );
    } catch {
      // A failed write must never break a live turn.
    }
  }

  private publishLive(): void {
    if (this.key) hub.notify(this.key);
  }

  private touch(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.busy && !this.queued) this.dispose();
    }, IDLE_DISPOSE_MS);
    if (typeof this.idleTimer.unref === "function") this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
