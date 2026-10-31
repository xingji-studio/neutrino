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
  contextCompressionThreshold,
  loadConfig,
  loadPlannerPrompt,
  loadStepPrompt,
  loadSubAgentPrompt,
  normalizeApprovalMode,
  planFirstEnabled,
  loadModels,
  loadPrompt,
  saveSession,
  type ModelInfo,
  type SessionData,
  type SessionMessage,
  type TokenUsage,
  type ResolvedModelSelection,
  type ModelSelection,
  type ApprovalMode,
} from "../config.js";
import {
  COMPACT_KEEP,
  COMPACT_MAX_CHARS_PER_MESSAGE,
  planCompaction,
  transcriptFor,
  type CompactMessage,
  modelHistory,
  normalizeContext,
  type ConversationContext,
} from "../compact.js";
import { LLMClient, describeError } from "../llm/client.js";
import type { RetryNotice } from "../llm/retry.js";
import {
  advancePlan,
  buildPlannerInput,
  lastRequestText,
  parsePlan,
  planMessage,
  planTranscript,
  renderStepDirective,
  resumePlan,
  stopPlan,
  type PlanState,
  type PlanStepStatus,
} from "../llm/plan.js";
import { DELEGATE_TOOL, executeTool, getSubAgentToolDefinitions, getToolDefinitions } from "../llm/tools.js";
import {
  buildSubAgentTask,
  formatSubAgentResult,
  runSubAgent as runSubAgentTask,
} from "../llm/subagent.js";
import { assessToolCall, type RiskAssessment } from "../llm/risk.js";
import { ApprovalGate, captureApprovalContext, describeApprovalIntent, type ApprovalDecision, type ApprovalContext } from "../llm/approval.js";
import { SessionCheckpoint } from "../persistence.js";
import { writeCrashLog } from "../terminal/restore.js";
import {
  hub,
  liveApprovalDetails,
  type LiveAgent,
  type LiveMeta,
  type LiveSnapshot,
  type LiveWireMessage,
  type ModelChangeResult,
  type LiveReviewProgress,
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

/** A sub-agent gets the same tools minus delegation: one level, never a tree. */
const SUB_AGENT_TOOLS = getSubAgentToolDefinitions();

/** Marker for the model-only summary, separate from the original transcript. */
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
  const model = scoped?.models?.find((m) => m.name === modelName);
  if (!model) {
    return { ok: false, error: `model "${modelName}" is not configured any more` };
  }
  if (!model.api_key || !model.api_key.trim()) {
    return { ok: false, error: `model "${modelName}" has no API key configured` };
  }
  return { ok: true, model };
}

/** Build a web session from a saved transcript, or explain why we cannot. */
export function resumeSession(source: SessionData, selection?: ModelSelection): ResumeOutcome {
  const updated = selection ? { ...source, ...selection } : source;
  const resolved = resolveModel(updated.model, updated.provider);
  if (!resolved.ok) return resolved;
  return { ok: true, session: new WebSession(updated, resolved.model) };
}

export class WebSession implements LiveAgent {
  key: string | null = null;

  private model: ModelInfo;
  private provider: string;
  private intensity: string;
  private readonly dir: string;
  private readonly tokens: TokenUsage;

  private messages: Msg[];
  private sessionId: string;
  private busy = false;
  private approvalMode: ApprovalMode;
  private paused = false;
  private queued: string | null = null;
  private compressing = false;
  private context: ConversationContext | null = null;
  private streamingContent: string | null = null;
  /** The plan of the current turn, if this turn was planned. */
  private plan: PlanState | null = null;
  /** True while the planner agent is writing the steps. */
  private planning = false;
  /** What the sub-agent is doing, or null when none is running. */
  private subagent: string | null = null;
  private saveError: string | null = null;
  /** A retried request, so the browser can explain why the stream is quiet. */
  private retrying: RetryNotice | null = null;
  private checkpoint = new SessionCheckpoint(() => {
    const saved = this.writeSession();
    this.publishLive();
    return saved;
  });
  private turnToken = 0;
  private lastPromptTokens = 0;
  private disposed = false;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Non-null while a tool call waits for the browser to answer. */
  private pendingApproval: {
    tool: string;
    args: Record<string, unknown>;
    risk: RiskAssessment;
    resolve(approved: boolean | null): void;
  } | null = null;

  /** Reviewer count while an automated review runs, null otherwise. */
  private reviewing: LiveReviewProgress | null = null;

  constructor(source: SessionData, model: ModelInfo) {
    this.model = model;
    this.approvalMode = normalizeApprovalMode(source.approval_mode ?? loadConfig().approval_mode);
    this.provider = source.provider;
    this.intensity = source.intensity;
    this.dir = source.cwd;
    this.sessionId = source.id;
    this.messages = (source.messages as Msg[]).slice();
    this.context = normalizeContext(source.context, this.messages.filter((m) => m.role !== "system").length);
    this.plan = resumePlan(source.plan ?? null);
    this.tokens = {
      prompt: source.tokens?.prompt ?? 0,
      completion: source.tokens?.completion ?? 0,
    };
  }

  /** Register with the live hub so the browser can watch this conversation. */
  start(): string {
    this.checkpoint.register();
    this.key = hub.register(this);
    this.save();
    this.touch();
    this.publishLive();
    return this.key;
  }

  /** Detach from the hub. The transcript stays on disk. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.turnToken++;
    this.busy = false;
    if (this.pendingApproval) {
      this.pendingApproval.resolve(false);
      this.pendingApproval = null;
    }
    this.clearIdleTimer();
    this.checkpoint.dispose();
    hub.unregister(this.key);
    this.key = null;
  }

  // ---- LiveAgent -------------------------------------------------------

  liveCwd(): string {
    return this.dir;
  }

  liveConfigure(selection: ResolvedModelSelection): ModelChangeResult {
    if (this.disposed) return { ok: false, error: "this session has ended" };
    if (this.busy || this.pendingApproval) {
      return { ok: false, error: "pause the current turn before changing models" };
    }
    this.model = { ...selection.model };
    this.provider = selection.provider;
    this.intensity = selection.intensity;
    this.save();
    this.publishLive();
    return { ok: true };
  }

  liveMeta(): LiveMeta {
    return {
      sessionId: this.sessionId,
      title: this.title(),
      provider: this.provider,
      model: this.model.name,
      intensity: this.intensity,
      approvalMode: this.approvalMode,
      busy: this.busy,
      paused: this.paused,
      queued: this.queued,
      compressing: this.compressing,
      saveError: this.saveError,
      retrying: this.retrying
        ? { attempt: this.retrying.attempt, attempts: this.retrying.attempts, delayMs: this.retrying.delayMs }
        : null,
      tokens: { prompt: this.tokens.prompt, completion: this.tokens.completion },
      subagent: this.subagent,
      approval: this.pendingApproval
        ? liveApprovalDetails(this.pendingApproval.tool, this.pendingApproval.args, this.pendingApproval.risk, this.dir)
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
      context: this.context,
      plan: this.plan,
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
    this.retainStreamingContent();
    this.subagent = null;
    stopPlan(this.plan);
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

  liveSetApprovalMode(mode: ApprovalMode): void {
    if (this.approvalMode === mode) return;
    this.approvalMode = mode;
    const pending = this.pendingApproval;
    if (pending) {
      this.pendingApproval = null;
      pending.resolve(null);
    }
    this.touch();
    this.save();
    this.publishLive();
  }

  // ---- turn driving ----------------------------------------------------

  private send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.disposed) return;
    this.touch();
    this.messages.push({ role: "user", content: trimmed });
    this.save();

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
    const turnMessages = this.messages.slice();
    const approvalContext = captureApprovalContext(turnMessages);
    this.busy = true;
    const token = ++this.turnToken;
    this.streamingContent = "";
    this.publishLive();
    void (async () => {
      await this.runTurn(token, turnMessages, approvalContext);
    })().catch((err) => {
      if (token === this.turnToken) this.failTurn(err);
    });
  }

  /**
   * One user turn, mirroring the terminal: plan first, then execute the steps in
   * order, one agent loop per step. Without a usable plan the turn runs in one
   * pass, exactly as it did before planning existed.
   */
  private async runTurn(token: number, turnMessages: Msg[], approvalContext: ApprovalContext): Promise<void> {
    await this.autoCompress(token);
    if (token !== this.turnToken || this.paused) return;

    const plan = await this.makePlan(token);
    if (token !== this.turnToken || this.paused) return;

    if (plan) {
      this.plan = plan;
      this.messages.push({ role: "assistant", content: planMessage(plan) });
      this.save();
      this.publishLive();
      const template = loadStepPrompt();
      for (let i = 0; i < plan.steps.length; i++) {
        if (token !== this.turnToken || this.paused) return;
        this.setStep(i, "active");
        const finished = await this.agentLoop(
          this.buildApiMessages(this.turnView(turnMessages), renderStepDirective(template, plan, i)),
          token,
          approvalContext,
        );
        if (token !== this.turnToken || this.paused) return;
        this.setStep(i, finished ? "done" : "failed");
        if (!finished) break;
      }
    } else {
      await this.agentLoop(this.buildApiMessages(this.turnView(turnMessages)), token, approvalContext);
      if (token !== this.turnToken || this.paused) return;
    }
    this.onTurnFinished();
  }

  /**
   * The transcript this turn may see: the messages it started with plus what it
   * added since. A user message queued while the turn runs belongs to the next
   * turn, so the model never sees it early.
   */
  private turnView(snapshot: Msg[]): Msg[] {
    const view = snapshot.slice();
    for (let i = snapshot.length; i < this.messages.length; i++) {
      if (this.messages[i].role !== "user") view.push(this.messages[i]);
    }
    return view;
  }

  /** Move the plan to one step and publish it. */
  private setStep(index: number, status: PlanStepStatus): void {
    if (!advancePlan(this.plan, index, status)) return;
    this.save();
    this.publishLive();
  }

  /**
   * Run the planner agent over the current request. Null on every failure path:
   * a plan must improve a turn, never be a new way for one to fail.
   */
  private async makePlan(token: number): Promise<PlanState | null> {
    if (!planFirstEnabled()) return null;
    const request = lastRequestText(this.messages);
    if (!request.trim()) return null;
    this.planning = true;
    this.publishLive();
    try {
      const client = new LLMClient(this.model, this.provider, this.intensity);
      const answer = await client.complete(
        loadPlannerPrompt(),
        buildPlannerInput({ request, cwd: this.dir, transcript: planTranscript(this.messages) }),
        {
          onRetry: (notice) => {
            this.retrying = notice;
            this.publishLive();
          },
          cancelled: () => token !== this.turnToken || this.paused,
        },
      );
      if (client.usage) {
        this.tokens.prompt += client.usage.prompt;
        this.tokens.completion += client.usage.completion;
        this.lastPromptTokens = client.usage.prompt;
      }
      if (token !== this.turnToken) return null;
      return parsePlan(answer);
    } catch {
      return null;
    } finally {
      this.planning = false;
      this.retrying = null;
      if (token === this.turnToken) this.publishLive();
    }
  }

  /** Ends a turn whose floating promise rejected, instead of crashing the app. */
  private failTurn(err: unknown): void {
    this.retainStreamingContent();
    this.messages.push({ role: "assistant", content: `[Error: ${describeError(err)}]` });
    this.streamingContent = null;
    // The turn died outside the loop, so the step it was on never reported back.
    const active = this.plan?.steps.findIndex((step) => step.status === "active") ?? -1;
    if (active >= 0) advancePlan(this.plan, active, "failed");
    try {
      this.onTurnFinished();
    } catch {
      this.busy = false;
      this.paused = false;
    }
  }

  private buildApiMessages(messages = this.messages, directive = ""): ApiMessage[] {
    // A step directive extends the system prompt: the plan is an instruction, not
    // something the user just said.
    const api: ApiMessage[] = [
      { role: "system", content: directive ? `${loadPrompt()}\n\n${directive}` : loadPrompt() },
    ];
    for (const m of modelHistory(messages, this.context)) {
      if (m.role === "user" || m.role === "assistant") {
        api.push({ role: m.role, content: m.content });
      } else if (m.role === "summary") {
        api.push({ role: "assistant", content: m.content });
      }
    }
    return api;
  }

  /**
   * One agent conversation for a single request (or a single plan step). Returns
   * true when the model finished on its own, false when the turn was cut short;
   * the caller owns the turn's end because a planned turn runs this per step.
   */
  private async agentLoop(apiMessages: ApiMessage[], token: number, approvalContext: ApprovalContext): Promise<boolean> {
    const tools = getToolDefinitions();
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        if (token !== this.turnToken || this.paused) return false;
        const client = new LLMClient(this.model, this.provider, this.intensity);
        let text = "";
        this.streamingContent = "";
        this.publishLive();
        for await (const chunk of client.streamTurn(apiMessages, tools, {
          onRetry: (notice) => {
            this.retrying = notice;
            this.publishLive();
          },
          cancelled: () => token !== this.turnToken || this.paused,
        })) {
          this.retrying = null;
          if (token !== this.turnToken || this.paused) return false;
          text += chunk;
          this.streamingContent = text;
          this.checkpoint.schedule();
          this.publishLive();
        }
        if (token !== this.turnToken || this.paused) return false;
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
          if (token !== this.turnToken || this.paused) return false;
          const args = parseArguments(call.arguments);
          const toolMsg: Msg & { role: "tool" } = {
            role: "tool",
            name: call.name,
            arguments: args,
            result: TOOL_PENDING,
          };
          this.messages.push(toolMsg);
          this.save();
          this.publishLive();

          const decision = await this.requestApproval(call.name, args, {
            ...approvalContext,
            context: captureApprovalContext(apiMessages).context,
          });
          if (token !== this.turnToken || this.paused) return false;
          if (!decision.approved) {
            // A malformed request was never shown to anyone, so there is no
            // verdict to respect and the right move is a corrected retry.
            const denied =
              decision.source === "input"
                ? `[Not executed: ${decision.reason}]`
                : `[Not executed: approval denied (${decision.source}): ${decision.reason}] ` +
                  describeApprovalIntent(approvalContext) +
                  "Do not retry this call unchanged; ask the user how to proceed.";
            toolMsg.result = denied;
            apiMessages.push({ role: "tool", content: denied, tool_call_id: call.id });
            this.save();
            this.publishLive();
            continue;
          }

          let result: string;
          try {
            result = await this.runTool(call.name, args, toolMsg, token, apiMessages, approvalContext);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          if (this.disposed) return false;
          toolMsg.result = result;
          this.save();
          if (token !== this.turnToken || this.paused) return false;
          apiMessages.push({ role: "tool", content: result, tool_call_id: call.id });
          this.publishLive();
        }
        this.save();
      }
      return true;
    } catch (err) {
      if (token !== this.turnToken) return false;
      if (this.streamingContent) {
        this.messages.push({ role: "assistant", content: this.streamingContent });
      }
      this.streamingContent = null;
      this.messages.push({
        role: "assistant",
        content: `[Error: ${err instanceof Error ? err.message : String(err)}]`,
      });
      return false;
    }
  }

  private onTurnFinished(): void {
    this.retrying = null;
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
    context = captureApprovalContext(this.messages),
  ): Promise<ApprovalDecision> {
    const risk = assessToolCall(tool, args, this.dir);
    if (!risk) return { approved: true, source: "prompt", reason: "routine call" };
    const gate = new ApprovalGate({
      askHuman: () =>
        new Promise<boolean | null>((resolve) => {
          this.pendingApproval = { tool, args, risk, resolve };
          this.publishLive();
        }),
      reviewer: () => this.reviewerModel(),
      autoApprovalEnabled: () => this.approvalMode === "auto",
      extremeAutoApprovalEnabled: () => loadConfig().auto_approve_extreme_risk === true,
      onReview: (info) => {
        this.reviewing = info
          ? {
            total: info.total, round: info.round ?? 1, rounds: info.rounds ?? 1,
            request: liveApprovalDetails(tool, args, risk, this.dir),
          }
          : null;
        this.publishLive();
      },
    });
    return gate.decide({ tool, args, cwd: this.dir, ...context, risk });
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

  // ---- sub-agents ------------------------------------------------------

  /**
   * Run one approved tool call. `delegate` runs a child agent instead of
   * touching the filesystem, so it is handled here, where the session's model,
   * approval gate and abort signal live.
   */
  private async runTool(
    name: string,
    args: Record<string, unknown>,
    toolMsg: Msg & { role: "tool" },
    token: number,
    apiMessages: ApiMessage[],
    approvalContext: ApprovalContext,
  ): Promise<string> {
    if (name !== DELEGATE_TOOL) return executeTool(name, args, this.dir);
    return this.delegate(args, toolMsg, token, apiMessages, approvalContext);
  }

  /**
   * Run a sub-agent for one `delegate` call and return its report. The child
   * works in its own transcript; only the report reaches this conversation, and
   * its risky calls go through the same approval gate as the parent turn.
   */
  private async delegate(
    args: Record<string, unknown>,
    toolMsg: Msg & { role: "tool" },
    token: number,
    apiMessages: ApiMessage[],
    approvalContext: ApprovalContext,
  ): Promise<string> {
    const task = String(args.task ?? "").trim();
    if (!task) return "[Error: delegate needs a task: what should the sub-agent do?]";
    const context = typeof args.context === "string" ? args.context.trim() : "";
    const approval = { ...approvalContext, context: captureApprovalContext(apiMessages).context };
    const run = await runSubAgentTask({
      createClient: () => new LLMClient(this.model, this.provider, this.intensity),
      system: loadSubAgentPrompt(),
      task: buildSubAgentTask({ task, context, cwd: this.dir }),
      tools: SUB_AGENT_TOOLS,
      approve: (name, callArgs) => this.requestApproval(name, callArgs, approval),
      execute: (name, callArgs) =>
        name === DELEGATE_TOOL
          ? Promise.resolve("[Error: sub-agents cannot delegate further]")
          : executeTool(name, callArgs, this.dir),
      onProgress: (label) => {
        this.subagent = label;
        toolMsg.result = `… ${label}`;
        this.publishLive();
      },
      onUsage: (usage) => {
        this.tokens.prompt += usage.prompt;
        this.tokens.completion += usage.completion;
      },
      onRetry: (notice) => {
        this.retrying = notice;
        this.publishLive();
      },
      cancelled: () => token !== this.turnToken || this.paused || this.disposed,
    });
    this.subagent = null;
    this.retrying = null;
    toolMsg.result = TOOL_PENDING;
    this.publishLive();
    return formatSubAgentResult(run);
  }

  // ---- compression -----------------------------------------------------

  private compressThreshold(): number {
    return contextCompressionThreshold(this.provider, this.model);
  }

  private async autoCompress(token: number): Promise<void> {
    const threshold = this.compressThreshold();
    if (threshold <= 0 || this.lastPromptTokens < threshold) return;

    const visible = this.messages.filter((m) => m.role !== "system");
    const flat: CompactMessage[] = modelHistory(this.messages, this.context).map((m) =>
      m.role === "tool"
        ? { role: "tool", name: m.name, content: m.result }
        : { role: m.role, content: m.content },
    );
    const plan = planCompaction(flat, COMPACT_KEEP);
    if (!plan) return;

    const end = visible.length - plan.tail.length;
    if (end <= (this.context?.end ?? 0)) return;
    const snapshotLen = this.messages.length;
    const transcript = transcriptFor(plan.head);

    this.compressing = true;
    this.publishLive();
    let summary = "";
    try {
      summary = await new LLMClient(this.model, this.provider, this.intensity).summarize(transcript, {
        cancelled: () => token !== this.turnToken || this.paused,
      });
    } catch {
      summary = "";
    }
    this.compressing = false;
    this.publishLive();
    if (token !== this.turnToken || this.paused) return;
    if (this.messages.length !== snapshotLen) return;

    const content = summary.trim()
      ? `${SUMMARY_PREFIX}\n\n${summary.trim()}`
      : "Earlier messages are preserved in history, but could not be summarized for this request.";

    this.context = { end, summary: content };
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

  private retainStreamingContent(): void {
    if (this.streamingContent) {
      this.messages.push({ role: "assistant", content: this.streamingContent });
    }
    this.streamingContent = null;
  }

  private save(): void {
    this.checkpoint.flush();
  }

  private writeSession(): boolean {
    const chat: SessionMessage[] = [];
    for (const m of this.messages) {
      if (m.role === "user" || m.role === "assistant" || m.role === "tool") chat.push(m);
      else if (m.role === "summary") chat.push({ role: "assistant", content: m.content });
    }
    if (this.streamingContent) chat.push({ role: "assistant", content: this.streamingContent });
    if (chat.length === 0) return true;
    try {
      this.sessionId = saveSession(
        chat,
        this.model.name,
        this.provider,
        this.intensity,
        this.dir,
        this.sessionId,
        this.tokens,
        this.context,
        this.approvalMode,
        this.plan,
      );
      this.saveError = null;
      return true;
    } catch (err) {
      const detail = describeError(err);
      if (this.saveError === null) writeCrashLog("save session", err);
      this.saveError = detail;
      return false;
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
