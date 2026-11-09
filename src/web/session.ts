import { runPluginTurn, pluginCommand, pluginApprovalContext } from "../plugins/session.js";
import path from "node:path";
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

import { randomUUID } from "node:crypto";
import { FastAgentEngine } from "../fast/engine.js";
import { FAST_MODE, assertFastAvailable, fastSettings, type FastSnapshot } from "../fast/types.js";
import {
  findModel,
  contextCompressionThreshold,
  modelContextWindow,
  sessionDir,
  intensityForModel,
  loadConfig,
  loadPlannerPrompt,
  loadStepPrompt,
  loadSubAgentPrompt,
  normalizeApprovalMode,
  planFirstEnabled,
  loadModels,
  loadPrompt,
  loadAgentPrompt,
  normalizeAgentMode,
  type AgentMode,
  saveSession,
  type ModelInfo,
  type SessionData,
  type SessionMessage,
  type TokenUsage,
  type ResolvedModelSelection,
  type ModelSelection,
  type ApprovalMode,
  type Mode,
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
import { TaskRuntime, TaskControlError, currentTask, linkSignals, taskLimits, taskBudgetScope, resumeTaskSnapshot, type AgentStatus, type TaskSnapshot } from "../llm/runtime.js";
import { prepareContext, outputAllowance, finalTaskReport } from "../llm/context.js";
import { FINISH_STEP_TOOL, FINISH_STEP_DEFINITION, finishPlanStep, preparePlan, settlePlan } from "../llm/plan.js";
import { LLMClient, describeError } from "../llm/client.js";
import { defaultProPreset, loadProModels, loadProPrompt, proMaxRecursionDepth, requireProPreset, type ProRole } from "../pro/config.js";
import { resolveProTeam, ProPreflightError } from "../pro/preflight.js";
import { ProAgentTeam, getProToolDefinitions } from "../pro/agents.js";
import type { RetryNotice } from "../llm/retry.js";
import {
  advancePlan,
  buildPlannerInput,
  lastRequestText,
  needsPlan,
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
  subAgentRounds,
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
  | { role: "tool"; name: string; arguments: Record<string, unknown>; result: string; evidenceId?: string; executionStatus?: string }
  | { role: "summary"; content: string; count: number };

interface ApiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Thinking text echoed back on an assistant tool-call message. */
  reasoning_content?: string;
  anthropic_content?: unknown[];
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** Drop a resumed conversation nobody touched for this long. */
const IDLE_DISPOSE_MS = 30 * 60 * 1000;

/** Placeholder shown while a tool is still running. */
const TOOL_PENDING = "…";

/** A sub-agent gets the same tools minus delegation: one level, never a tree. */

/** Marker for the model-only summary, separate from the original transcript. */
const SUMMARY_PREFIX = "Context was compressed. Summary of the earlier part:";

export type ResumeOutcome =
  | { ok: true; session: WebSession }
  | { ok: false; error: string };

/**
 * A fresh session id in the same shape `saveSession` generates, so a new
 * browser conversation has a stable identity before its first message exists.
 */
export function newSessionId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

/**
 * Start an empty conversation in a caller-chosen working directory. Nothing is
 * written to disk until the first message, so an abandoned new-chat dialog
 * cannot litter the history with empty transcripts.
 */
export function createWebSession(
  cwd: string,
  selection: ResolvedModelSelection,
  approvalMode?: ApprovalMode,
  mode: Mode = "standard",
  proPreset?: string,
  agentMode: AgentMode = "standard",
): WebSession {
  if (agentMode === FAST_MODE) assertFastAvailable(loadConfig(mode));
  const now = new Date();
  const source: SessionData = {
    id: newSessionId(now),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    model: selection.model.name,
    provider: selection.provider,
    intensity: selection.intensity,
    cwd,
    title: "",
    messages: [],
    tokens: { prompt: 0, completion: 0 },
    approval_mode: normalizeApprovalMode(approvalMode ?? loadConfig(mode).approval_mode),
    agent_mode: mode === "pro" ? "standard" : agentMode,
    ...(mode === "pro" ? { pro_preset: requireProPreset(proPreset ?? defaultProPreset()) } : {}),
  };
  return new WebSession(source, selection.model, mode);
}

/** A preset may need fallback; defer model credentials/availability to preflight. */
export function proInitialSelection(preset = defaultProPreset()): ResolvedModelSelection {
  const tier = loadProModels().tier.find((entry) => entry.name === requireProPreset(preset))!;
  const setting = tier["model-setting"].find((entry) => entry.type === "main_model");
  const provider = setting?.provider ?? "";
  const name = setting?.model ?? "";
  const model = loadModels().providers.find((entry) => entry.name === provider)?.models.find((entry) => entry.name === name);
  return {
    provider,
    model: model ? { ...model } : { name, url: "", api_key: "", supports_streaming: true },
    intensity: setting?.intensity || "high",
  };
}

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
export function resumeSession(source: SessionData, selection?: ModelSelection, mode: Mode = "standard"): ResumeOutcome {
  if (mode === "pro") {
    try {
      const initial = proInitialSelection(source.pro_preset ?? defaultProPreset());
      return { ok: true, session: new WebSession({ ...source, provider: initial.provider,
        model: initial.model.name, intensity: initial.intensity }, initial.model, mode) };
    } catch (error) {
      return { ok: false, error: describeError(error) };
    }
  }
  const updated = selection ? { ...source, ...selection } : source;
  const resolved = resolveModel(updated.model, updated.provider);
  if (!resolved.ok) return resolved;
  return { ok: true, session: new WebSession(updated, resolved.model, mode) };
}

export class WebSession implements LiveAgent {
  key: string | null = null;
  /** Workspace this conversation belongs to; keeps Pro and standard separate. */
  readonly mode: Mode;

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
  private proPreset: string | null = null;
  private proTeam: ProAgentTeam | null = null;
  private proState: LiveMeta["pro"];
  private proAbort: AbortController | null = null;
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
  private taskRuntime: TaskRuntime | null = null;
  private lastTask: TaskSnapshot | undefined;
  private taskOutcome: AgentStatus = "completed";
  private turnToken = 0;
  private agentMode: AgentMode = "standard";
  private activeAgentMode: AgentMode = "standard";
  private fastState?: FastSnapshot;
  private queuedAgentMode: AgentMode | null = null;
  private turnAbort: AbortController | null = null;
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

  constructor(source: SessionData, model: ModelInfo, mode: Mode = "standard") {
    this.mode = mode;
    this.agentMode = mode === "pro" ? "standard" : normalizeAgentMode(source.agent_mode);
    if (mode === "pro") this.proPreset = requireProPreset(source.pro_preset ?? defaultProPreset());
    this.model = model;
    this.approvalMode = normalizeApprovalMode(source.approval_mode ?? loadConfig(this.mode).approval_mode);
    this.provider = source.provider;
    // A transcript saved before the model's limits existed (or before the model
    // itself was narrowed) must not replay an unsupported sampling level.
    this.intensity = mode === "pro" ? source.intensity : intensityForModel(model, source.intensity, loadConfig(this.mode).default_intensity);
    this.dir = source.cwd;
    this.sessionId = source.id;
    this.messages = (source.messages as Msg[]).slice();
    this.context = normalizeContext(source.context, this.messages.filter((m) => m.role !== "system").length);
    this.plan = resumePlan(source.plan ?? null);
    this.lastTask = resumeTaskSnapshot(source.task_run);
    this.fastState = source.fast_run ? structuredClone(source.fast_run) : undefined;
    if (this.fastState && !["completed", "failed", "cancelled"].includes(this.fastState.phase)) {
      this.fastState.phase = "failed";
      this.fastState.error = "Process restarted; artifacts preserved. Review partial state before resuming; tools are never replayed automatically.";
    }
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
    this.proAbort?.abort();
    this.turnAbort?.abort();
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
    if (this.mode === "pro") return { ok: false, error: "choose a Pro preset to change professional models" };
    if (this.disposed) return { ok: false, error: "this session has ended" };
    if (this.busy || this.pendingApproval) {
      return { ok: false, error: "pause the current turn before changing models" };
    }
    this.model = { ...selection.model };
    this.provider = selection.provider;
    this.intensity = intensityForModel(this.model, selection.intensity, loadConfig(this.mode).default_intensity);
    this.save();
    this.publishLive();
    return { ok: true };
  }

  liveSetProPreset(preset: string): ModelChangeResult {
    if (this.mode !== "pro" || this.disposed) return { ok: false, error: "this is not an active Pro session" };
    if (this.busy || this.pendingApproval) return { ok: false, error: "pause the current turn before changing presets" };
    try {
      this.proPreset = requireProPreset(preset);
      const initial = proInitialSelection(this.proPreset);
      this.model = initial.model;
      this.provider = initial.provider;
      this.intensity = initial.intensity;
      this.proTeam = null;
      this.proState = undefined;
      this.save();
      this.publishLive();
      return { ok: true };
    } catch (error) { return { ok: false, error: describeError(error) }; }
  }

  liveMeta(): LiveMeta {
    return {
      ...(this.mode === "pro" ? { pro: this.proState ?? {
        preset: this.proPreset!, checking: false, checkId: "", models: [], fallbacks: [],
      } } : {}),
      sessionId: this.sessionId,
      title: this.title(),
      empty: this.messages.length === 0 && !this.streamingContent,
      provider: this.provider,
      model: this.model.name,
      intensity: this.intensity,
      approvalMode: this.approvalMode,
      agentMode: this.agentMode,
      activeAgentMode: this.busy ? this.activeAgentMode : this.agentMode,
      ...(this.fastState ? { fast: this.fastState } : {}),
      task: this.taskRuntime?.snapshot() ?? this.lastTask,
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
    if (this.fastState && this.activeAgentMode === FAST_MODE && this.busy) this.fastState.phase = "cancelling";
    this.paused = true;
    this.proAbort?.abort();
    this.turnAbort?.abort();
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
    if (this.proState) this.proState.checking = false;
    this.reviewing = null;
    this.retrying = null;
    this.planning = false;
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

  liveSetAgentMode(mode: AgentMode): ModelChangeResult {
    if (this.mode === "pro" || this.disposed) return { ok: false, error: "this session cannot change agent mode" };
    if (mode === FAST_MODE) {
      try { assertFastAvailable(loadConfig(this.mode)); }
      catch (error) { return { ok: false, error: describeError(error) }; }
    }
    this.agentMode = mode;
    this.save();
    this.publishLive();
    return { ok: true };
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

  /**
   * Start a fresh chat in the same working directory, mirroring the terminal's
   * clear shortcut. The finished transcript is checkpointed first and stays on
   * disk; this session simply moves on under a new id.
   */
  liveClear(): void {
    if (this.disposed) return;
    if (!this.checkpoint.flush()) return;
    this.proAbort?.abort();
    this.proTeam = null;
    this.proState = undefined;
    this.turnAbort?.abort();
    this.turnToken++;
    this.taskRuntime = null;
    this.lastTask = undefined;
    this.fastState = undefined;
    this.queuedAgentMode = null;
    if (this.pendingApproval) {
      const pending = this.pendingApproval;
      this.pendingApproval = null;
      pending.resolve(false);
    }
    this.busy = false;
    this.paused = false;
    this.queued = null;
    this.compressing = false;
    this.retrying = null;
    this.subagent = null;
    this.reviewing = null;
    this.streamingContent = null;
    this.plan = null;
    this.planning = false;
    this.messages = [];
    this.context = null;
    this.lastPromptTokens = 0;
    this.saveError = null;
    this.sessionId = newSessionId();
    this.publishLive();
    this.touch();
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
      this.queuedAgentMode = this.agentMode;
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
    if (this.taskRuntime?.settling) {
      const previous = this.taskRuntime;
      this.queued = lastRequestText(this.messages);
      void previous.drain().then(() => {
        if (this.taskRuntime === previous && this.queued && !this.paused) {
          this.queued = null;
          this.startTurn();
        }
      });
      this.publishLive();
      return;
    }
    const turnMessages = this.messages.slice();
    const approvalContext = captureApprovalContext(turnMessages);
    this.busy = true;
    this.activeAgentMode = this.queuedAgentMode ?? this.agentMode;
    this.queuedAgentMode = null;
    this.turnAbort?.abort();
    this.turnAbort = new AbortController();
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
    const runtime = new TaskRuntime({
      executionMode: this.mode === "pro" ? "pro" : this.activeAgentMode,
      request: approvalContext.prompt, priorUserRequests: approvalContext.priorUserRequests,
      cwd: this.dir, signal: this.turnAbort?.signal, limits: taskLimits(loadConfig(this.mode)),
      budgetScope: taskBudgetScope(loadConfig(this.mode)),
      journalDir: path.join(sessionDir(this.mode), "tasks", path.basename(this.sessionId || "unsaved")),
    });
    this.taskRuntime = runtime;
    this.taskOutcome = "completed";
    let failed = false;
    try {
      await runPluginTurn(runtime, { profile:this.mode, cwd:this.dir, sessionId:this.sessionId ?? undefined, role:"main", request:approvalContext.prompt },
        (name,args,signal) => this.requestApproval(name,args,approvalContext,signal), async () => {
          const command = pluginCommand(approvalContext.prompt);
          if (command) {
            const result = await runtime.plugins!.runCommand(command.name,command.args);
            this.messages.push({ role:"assistant",content:typeof result === "string" ? result : JSON.stringify(result ?? null,null,2) });
            this.onTurnFinished();
            return;
          }
          await this.runTaskTurn(token,turnMessages,approvalContext);
        });
    } catch (error) { failed = true; throw error; }
    finally {
      await runtime.drain();
      if (runtime.signal.aborted) settlePlan(runtime.plan ?? null, true);
      runtime.finish(runtime.signal.aborted ? "cancelled" : failed ? "failed" :
        runtime.plan?.steps.some(step => step.status === "failed") ? "failed" :
        runtime.plan?.steps.some(step => !["done", "skipped"].includes(step.status)) ? "partial" : this.taskOutcome);
      if (this.taskRuntime === runtime && !this.disposed) {
        if (runtime.signal.aborted && token === this.turnToken && this.busy && !this.paused) {
          if ((this.taskOutcome as AgentStatus) !== "cancelled") this.messages.push({ role: "assistant", content: `[Task stopped: ${String(runtime.signal.reason)}]\n${runtime.partialReport()}` });
          this.streamingContent = null;
          this.onTurnFinished();
        }
        if (this.taskRuntime === runtime) {
          this.lastTask = runtime.snapshot();
          this.save(); this.publishLive();
        }
      }
    }
  }

  private async runTaskTurn(token: number, turnMessages: Msg[], approvalContext: ApprovalContext): Promise<void> {
    if (this.mode === "pro") return this.runProTurn(token, turnMessages, approvalContext);
    await this.autoCompress(token);
    if (token !== this.turnToken || this.paused) return;

    if (this.activeAgentMode === FAST_MODE) return this.runFastTurn(token, turnMessages, approvalContext);

    if (this.activeAgentMode !== "standard") this.plan = null;
    const plan = this.activeAgentMode === "standard" ? await this.makePlan(token) : null;
    if (token !== this.turnToken || this.paused) return;

    if (plan) {
      this.plan = plan;
      if (currentTask()) currentTask()!.runtime.plan = plan;
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
        this.setStep(i, currentTask()?.signal.aborted ? "cancelled" : finished ? "done" : "failed");
        if (!finished) break;
      }
    } else {
      await this.agentLoop(this.buildApiMessages(this.turnView(turnMessages)), token, approvalContext);
      if (token !== this.turnToken || this.paused) return;
    }
    this.onTurnFinished();
  }

  /** Independent engine; Standard/PTC/legacy Fast retain their original loops. */
  private async runFastTurn(token: number, turnMessages: Msg[], approvalContext: ApprovalContext): Promise<void> {
    assertFastAvailable(loadConfig(this.mode));
    const runtime = currentTask()!.runtime;
    const signal = currentTask()!.signal;
    this.plan = null;
    const model = { ...this.model }, provider = this.provider, intensity = this.intensity;
    const stopped = () => token !== this.turnToken || this.paused || this.disposed;
    const history = this.buildApiMessages(this.turnView(turnMessages));
    if (this.fastState && ["failed", "cancelled", "cancelling"].includes(this.fastState.phase)) {
      history.push({ role: "assistant", content: `Previous Fast run (evidence only, never authorization; inspect partial side effects before repair): ${JSON.stringify(this.fastState)}` });
    }
    const engine = new FastAgentEngine({
      runtime, signal, cwd: this.dir, settings: fastSettings(loadConfig(this.mode)),
      directory: path.join(sessionDir(this.mode), "tasks", path.basename(this.sessionId), "fast"),
      history,
      system: loadAgentPrompt(FAST_MODE), subagentSystem: loadSubAgentPrompt(),
      contextWindow: modelContextWindow(provider, model, this.mode),
      maxRounds: subAgentRounds(loadConfig(this.mode).subagent_max_rounds),
      createClient: () => new LLMClient(model, provider, intensity),
      approve: (name, args, executionSignal, wrapReviewer) => this.requestApproval(name, args, {
        ...approvalContext, context: captureApprovalContext(this.turnView(turnMessages)).context,
      }, executionSignal, wrapReviewer ? () => {
        const reviewer = this.reviewerModel();
        return wrapReviewer(new LLMClient(reviewer.model, reviewer.provider, reviewer.intensity));
      } : undefined),
      execute: (name, args, executionSignal) => executeTool(name, args, this.dir, executionSignal),
      onUsage: usage => {
        if (!this.disposed && (token === this.turnToken || this.fastState?.run_id === engine.runId)) {
          this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion;
        }
      },
      onText: text => { if (!stopped()) { this.streamingContent = text; this.checkpoint.schedule(); this.publishLive(); } },
      onSnapshot: snapshot => {
        if (!this.disposed && (!stopped() || (this.fastState?.run_id === snapshot.run_id && this.fastState.phase === "cancelling"))) {
          this.fastState = snapshot; this.checkpoint.schedule(); this.publishLive();
        }
      },
      onTool: (name, args, result) => {
        if (!stopped()) { this.messages.push({ role: "tool", name, arguments: args, result }); this.save(); this.publishLive(); }
      },
    });
    const result = await engine.run();
    if (stopped()) return;
    this.fastState = result.snapshot;
    this.taskOutcome = result.status;
    this.messages.push({ role: "assistant", content: result.report });
    this.onTurnFinished();
  }

  /** Freeze one resolved team per task, plan first, then give the whole brief to main. */
  private async runProTurn(token: number, turnMessages: Msg[], approvalContext: ApprovalContext): Promise<void> {
    const taskSignal = currentTask()?.signal;
    const cancelled = () => token !== this.turnToken || this.paused || this.disposed || taskSignal?.aborted === true;
    const controller = new AbortController();
    this.proAbort = controller;
    this.proTeam = null;
    this.plan = null;
    this.proState = { preset: this.proPreset!, checking: true, checkId: randomUUID(), models: [], fallbacks: [] };
    this.publishLive();
    try {
      const resolved = await resolveProTeam(this.proPreset!, {
        signal: controller.signal,
        onUsage: (usage) => {
          if (!cancelled()) { this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion; }
        },
      });
      if (cancelled()) return;
      this.proState.models = Object.values(resolved.models).map((entry) => ({
        role: entry!.role, provider: entry!.provider, model: entry!.model.name, intensity: entry!.intensity, tier: entry!.tier,
      }));
      this.proState.fallbacks = resolved.fallbacks;
      this.proState.checking = false;
      const team = new ProAgentTeam({
        runtime: currentTask()?.runtime, request: approvalContext.prompt,
        models: resolved.models, maxDepth: proMaxRecursionDepth(), cwd: this.dir, cancelled,
        approve: (name, args) => this.requestApproval(name, args, {
          ...approvalContext, context: captureApprovalContext(this.turnView(turnMessages)).context,
        }),
        execute: (name, args) => executeTool(name, args, this.dir),
        onProgress: (label) => { if (!cancelled()) { this.subagent = label; this.publishLive(); } },
        onUsage: (usage) => {
          if (!cancelled()) { this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion; }
        },
        onRetry: (notice) => { if (!cancelled()) { this.retrying = notice; this.publishLive(); } },
      });
      this.proTeam = team;
      const main = resolved.models.main_model!;
      this.model = main.model;
      this.provider = main.provider;
      this.intensity = main.intensity;
      this.publishLive();
      this.planning = true;
      this.publishLive();
      const planningResult = await team.callResult("plan_model", buildPlannerInput({
        request: approvalContext.prompt, cwd: this.dir, transcript: planTranscript(turnMessages),
      }), "Plan the task before execution. Do not modify files or execute commands.", 0, true);
      const planning = planningResult.report;
      if (cancelled()) return;
      this.planning = false;
      this.subagent = null;
      this.retrying = null;
      if (planningResult.status !== "completed" || !planning.trim()) {
        throw new Error(`Pro planning failed: ${planningResult.error?.message ?? planning}`);
      }
      this.plan = parsePlan(planning, 1);
      if (!this.plan) throw new Error("Pro planning failed: no usable plan steps were returned");
      await this.autoCompress(token);
      if (cancelled()) return;
      if (this.plan) {
        preparePlan(this.plan);
        if (currentTask()) currentTask()!.runtime.plan = this.plan;
      }
      this.messages.push({ role: "assistant", content: this.plan ? planMessage(this.plan) : planning });
      this.save();
      this.publishLive();
      const directive = `The planning agent produced this plan for the current user request:\n${JSON.stringify(this.plan ?? planning)}\n\n` +
        "Execute the complete task using the appropriate professional agents. Own integration and verification. " +
        "Call finish_step for each accepted step using its step_id and actual evidence IDs, existing artifact paths, or the final text deliverable. " +
        "Record blocked or failed steps explicitly. Ending a reply never completes plan steps.";
      if (this.plan?.steps.length) this.setStep(0, "active");
      const finished = await this.agentLoop(this.buildApiMessages(this.turnView(turnMessages), directive), token, approvalContext);
      if (cancelled()) return;
      if (this.plan) {
        settlePlan(this.plan, currentTask()?.signal.aborted === true);
        if (!finished && this.taskOutcome !== "partial" && this.plan.steps[0]?.status === "blocked") this.setStep(0, "failed");
      }
    } catch (error) {
      if (cancelled()) return;
      this.proState!.checking = false;
      this.proState!.error = describeError(error);
      if (error instanceof ProPreflightError) this.proState!.fallbacks = error.fallbacks;
      throw error;
    } finally {
      if (!cancelled()) {
        this.planning = false;
        this.subagent = null;
        this.retrying = null;
        this.proState!.checking = false;
        this.publishLive();
      }
    }
    if (!cancelled()) this.onTurnFinished();
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
    if (!planFirstEnabled(this.mode)) return null;
    const request = lastRequestText(this.messages);
    if (!request.trim()) return null;
    // One action is not a plan: run the turn in one pass, as the terminal does.
    if (!needsPlan(request)) return null;
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
      if (token === this.turnToken) {
        this.planning = false;
        this.retrying = null;
        this.publishLive();
      }
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
    const prompt = this.mode === "pro" ? loadProPrompt("main_model") : loadAgentPrompt(this.activeAgentMode);
    const api: ApiMessage[] = [
      { role: "system", content: (directive ? `${prompt}\n\n${directive}` : prompt) +
        (currentTask() ? `\n\n${currentTask()!.runtime.instructions()}` : "") },
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
    const tools = this.mode === "pro" ? [...getProToolDefinitions(), FINISH_STEP_DEFINITION] : [
      ...getToolDefinitions(),
      ...(this.activeAgentMode === "ptc" ? [(await import("../llm/codemode.js")).getCodeToolDefinition()] : []),
    ];
    const team = this.proTeam;
    let emptyReplies = 0;
    try {
      while (true) {
        if (token !== this.turnToken || this.paused) return false;
        // Match the terminal: long tasks can keep using tools until the model
        // finishes, while older tool results are trimmed near the context limit.
        apiMessages = this.trimApiMessages(apiMessages);
        if (currentTask()) await prepareContext({
          messages: apiMessages, tools, capacity: team?.contextWindow("main_model") ?? modelContextWindow(this.provider, this.model, this.mode),
          createClient: () => team?.client("main_model") ?? new LLMClient(this.model, this.provider, this.intensity),
          stream: { signal: currentTask()!.runtime.signal, cancelled: () => token !== this.turnToken || this.paused },
          onUsage: usage => { this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion; },
        });
        const client = team ? team.client("main_model") : new LLMClient(this.model, this.provider, this.intensity);
        let text = "";
        this.streamingContent = "";
        this.publishLive();
        for await (const chunk of client.streamTurn(apiMessages, tools, {
          maxOutputTokens: outputAllowance(team?.contextWindow("main_model") ?? modelContextWindow(this.provider, this.model, this.mode)),
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
        if (currentTask()?.signal.aborted || client.outcome?.status === "cancelled") {
          this.taskOutcome = "cancelled";
          this.streamingContent = null;
          this.messages.push({ role: "assistant", content: `[Task stopped: ${String(currentTask()?.signal.reason ?? "Task cancelled")}]\n${currentTask()?.runtime.partialReport() ?? ""}` });
          return false;
        }
        if (client.outcome?.error?.code.endsWith("_budget") && currentTask()) {
          const report = await finalTaskReport(currentTask()!.runtime,
            () => team?.client("main_model") ?? new LLMClient(this.model, this.provider, this.intensity),
            usage => { this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion; }, apiMessages);
          if (token !== this.turnToken || this.paused) return false;
          this.taskOutcome = "partial";
          this.streamingContent = null;
          this.messages.push({ role: "assistant", content: report });
          return false;
        }
        if (client.outcome?.status === "failed") {
          const recorded = currentTask()?.runtime.evidence.length ? currentTask()!.runtime.partialReport() : "";
          const message = client.outcome.error?.message ?? "Model request failed";
          this.taskOutcome = recorded ? "partial" : "failed";
          this.streamingContent = null;
          this.messages.push({ role: "assistant", content: text +
            (text.includes(message) ? "" : `\n[Error: ${message}]`) + (recorded ? `\n\n${recorded}` : "") });
          return false;
        }
        const toolCalls = client.toolCalls;
        if (text.trim()) {
          this.messages.push({ role: "assistant", content: text });
        }
        if (text.trim() || toolCalls.length > 0) {
          // The assistant message and the tool results it produced must stay
          // paired: a `tool` message without its `tool_calls` parent is
          // rejected by every OpenAI-compatible endpoint. The reasoning is the
          // thinking that produced the calls, which DeepSeek requires back.
          apiMessages.push({
            role: "assistant",
            content: text,
            reasoning_content: client.reasoningContent ?? "",
            ...(client.anthropicContent.length ? { anthropic_content: client.anthropicContent } : {}),
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
        this.save();
        this.publishLive();

        if (toolCalls.length === 0) {
          if (!text.trim() && emptyReplies++ === 0) continue;
          if (!text.trim()) {
            this.taskOutcome = "failed";
            this.messages.push({ role: "assistant", content: "[Error: Pro main model returned an empty completion.]" });
            return false;
          }
          const success = client.outcome ? client.outcome.status === "completed" : !/\[Error:/.test(text);
          if (!success) this.taskOutcome = "failed";
          return success;
        }
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
            currentTask()?.runtime.recordTool(call.name, args, denied, "denied");
            apiMessages.push({ role: "tool", content: denied, tool_call_id: call.id });
            this.save();
            this.publishLive();
            continue;
          }

          let result: string;
          try {
            result = await this.runTool(call.name, args, toolMsg, token, apiMessages, approvalContext);
          } catch (err) {
            if (err instanceof TaskControlError && err.code.endsWith("_budget")) {
              toolMsg.result = `[Not executed: ${describeError(err)}]`;
              this.save();
              throw err;
            }
            if (token === this.turnToken) this.taskOutcome = "failed";
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
          if (this.disposed) return false;
          toolMsg.result = result;
          this.save();
          if (token !== this.turnToken || this.paused) return false;
          apiMessages.push({ role: "tool", content: toolMsg.evidenceId
            ? `${result}\n[Task evidence: ${toolMsg.evidenceId}; status=${toolMsg.executionStatus}]` : result, tool_call_id: call.id });
          this.publishLive();
        }
        this.save();
      }
    } catch (err) {
      if (token !== this.turnToken) return false;
      if (err instanceof TaskControlError && err.code.endsWith("_budget") && currentTask()) {
        const report = await finalTaskReport(currentTask()!.runtime,
          () => team?.client("main_model") ?? new LLMClient(this.model, this.provider, this.intensity),
          usage => { this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion; }, apiMessages);
        if (token !== this.turnToken || this.paused) return false;
        this.taskOutcome = "partial";
        this.streamingContent = null;
        this.messages.push({ role: "assistant", content: report });
        return false;
      }
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
    signal = currentTask()?.runtime.signal ?? this.turnAbort?.signal,
    createReviewerClient?: () => LLMClient,
  ): Promise<ApprovalDecision> {
    context = pluginApprovalContext(context);
    const linked = linkSignals(signal, currentTask()?.signal);
    signal = linked.signal;
    try {
      currentTask()?.runtime.assertTool(tool, args);
      const plugins = currentTask()?.runtime.plugins;
      if (plugins) await plugins.guardTool(tool, args);
    }
    catch (error) { linked.dispose(); return { approved: false, source: "input", reason: error instanceof Error ? error.message : String(error) }; }
    const risk = assessToolCall(tool, args, this.dir);
    if (!risk) { linked.dispose(); return { approved: true, source: "prompt", reason: "routine call" }; }
    const approvalToken = this.turnToken;
    const team = this.proTeam;
    const gate = new ApprovalGate({
      askHuman: () =>
        new Promise<boolean | null>((resolve) => {
          if (approvalToken !== this.turnToken || this.paused || this.disposed || signal?.aborted === true) {
            resolve(false);
            return;
          }
          this.pendingApproval = { tool, args, risk, resolve };
          this.publishLive();
        }),
      reviewer: () => this.reviewerModel(),
      ...(createReviewerClient ? { createReviewerClient } : {}),
      ...(this.mode === "pro" && team ? {
        createReviewerClient: () => team.client("confirm_model"),
        reviewerSystemPrompt: () => loadProPrompt("confirm_model"),
      } : {}),
      cancelled: () => approvalToken !== this.turnToken || this.paused || this.disposed || signal?.aborted === true,
      autoApprovalEnabled: () => this.approvalMode === "auto",
      extremeAutoApprovalEnabled: () => loadConfig(this.mode).auto_approve_extreme_risk === true,
      onReview: (info) => {
        if (approvalToken !== this.turnToken || this.paused || this.disposed || signal?.aborted === true) return;
        this.reviewing = info
          ? {
            total: info.total, round: info.round ?? 1, rounds: info.rounds ?? 1,
            request: liveApprovalDetails(tool, args, risk, this.dir),
          }
          : null;
        this.publishLive();
      },
    });
    const abortApproval = () => {
      const pending = this.pendingApproval;
      if (pending?.args !== args) return;
      this.pendingApproval = null;
      pending.resolve(false);
      this.publishLive();
    };
    signal.addEventListener("abort", abortApproval, { once: true });
    try {
      return await gate.decide({ tool, args, cwd: this.dir, ...context, risk });
    } finally {
      signal.removeEventListener("abort", abortApproval);
      linked.dispose();
    }
  }

  /** Reviewer model: `approval_model` when set, otherwise the chat model. */
  private reviewerModel(): { model: ModelInfo; provider: string; intensity: string } {
    const name = String(loadConfig(this.mode).approval_model ?? "").trim();
    const found = name ? findModel(name) : null;
    if (found) {
      const usable = resolveModel(found.model.name, found.provider);
      if (usable.ok) {
        return { model: usable.model, provider: found.provider, intensity: this.intensity };
      }
    }
    return { model: this.model, provider: this.provider, intensity: this.intensity };
  }

  private async runProgram(args: Record<string, unknown>, token: number, apiMessages: ApiMessage[], approvalContext: ApprovalContext): Promise<string> {
    if (this.activeAgentMode !== "ptc") return "[Error: execute_ts requires PTC mode]";
    const { executeCodeProgram, ProgramToolDenied } = await import("../llm/codemode.js");
    const signal = currentTask()?.runtime.signal ?? this.turnAbort?.signal;
    const cancelled = () => token !== this.turnToken || this.paused || signal?.aborted;
    const result = await executeCodeProgram(args, {
      signal,
      onPlan: plan => {
        if (cancelled()) return;
        this.plan = plan;
        if (currentTask()) currentTask()!.runtime.plan = plan;
        this.save(); this.publishLive();
      },
      onStep: (index, status) => { if (!cancelled()) this.setStep(index, status); },
      call: async (name, callArgs, programSignal) => {
        if (cancelled() || programSignal?.aborted) throw new Error("Execution cancelled");
        const message: Msg & { role: "tool" } = { role: "tool", name, arguments: callArgs, result: "…" };
        this.messages.push(message);
        this.save(); this.publishLive();
        const stopApproval = () => {
          if (this.pendingApproval?.args !== callArgs) return;
          const pending = this.pendingApproval;
          this.pendingApproval = null;
          pending.resolve(false);
          this.publishLive();
        };
        programSignal?.addEventListener("abort", stopApproval, { once: true });
        try {
          const decision = await this.requestApproval(name, callArgs, {
            ...approvalContext, context: captureApprovalContext(apiMessages).context,
          }, programSignal);
          if (cancelled() || programSignal?.aborted) throw new Error("Execution cancelled");
          if (!decision.approved) {
            message.result = `[Not executed: ${decision.reason}]`;
            throw new ProgramToolDenied(`Approval denied: ${decision.reason}. Do not retry or work around this denial.`);
          }
          const value = await this.runTool(name, callArgs, message, token, apiMessages, approvalContext, programSignal);
          message.result = value;
          if (cancelled() || programSignal?.aborted) throw new Error("Execution cancelled");
          return value;
        } catch (error) {
          if (message.result === "…") message.result = `[Error: ${error instanceof Error ? error.message : String(error)}]`;
          throw error;
        } finally {
          programSignal?.removeEventListener("abort", stopApproval);
          if (this.messages.includes(message)) { this.save(); this.publishLive(); }
        }
      },
    });
    if (!cancelled()) { this.save(); this.publishLive(); }
    return result;
  }

  // ---- sub-agents ------------------------------------------------------

  /**
   * Run one approved tool call. `delegate` runs a child agent instead of
   * touching the filesystem, so it is handled here, where the session's model,
   * approval gate and abort signal live.
   */
  private async runTool(
    name: string, args: Record<string, unknown>, toolMsg: Msg & { role: "tool" },
    token: number, apiMessages: ApiMessage[], approvalContext: ApprovalContext,
    executionSignal?: AbortSignal,
  ): Promise<string> {
    const runtime = currentTask()?.runtime;
    const execute = () => this.dispatchTool(name, args, toolMsg, token, apiMessages, approvalContext, executionSignal);
    if (!runtime) return execute();
    const result = await runtime.tool(name, args, execute);
    const evidence = runtime.evidence.at(-1);
    if (evidence && this.mode === "pro") {
      toolMsg.evidenceId = evidence.id;
      toolMsg.executionStatus = evidence.status;
    }
    return result;
  }

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
    toolMsg: Msg & { role: "tool" },
    token: number,
    apiMessages: ApiMessage[],
    approvalContext: ApprovalContext,
    signal = currentTask()?.runtime.signal ?? this.turnAbort?.signal,
  ): Promise<string> {
    if (name === FINISH_STEP_TOOL && currentTask()) {
      const result = finishPlanStep(this.plan, args, currentTask()!.runtime);
      this.save(); this.publishLive();
      return result;
    }
    if (this.mode === "pro" && (name === "call_pro_agent" || name === DELEGATE_TOOL)) {
      const team = this.proTeam;
      if (!team) return "[Error: Pro models have not passed preflight]";
      return team.call(String(args.role ?? "backend_output_model") as ProRole, String(args.task ?? ""),
        `${typeof args.context === "string" ? args.context : ""}\n\nCurrent user request: ${approvalContext.prompt}\n` +
        captureApprovalContext(apiMessages).context, 1, args.read_only === true,
        Array.isArray(args.write_paths) ? args.write_paths.filter((p): p is string => typeof p === "string") : undefined);
    }
    if (name === "execute_ts") return this.runProgram(args, token, apiMessages, approvalContext);
    if (name !== DELEGATE_TOOL) return executeTool(name, args, this.dir, signal);
    return this.delegate(args, toolMsg, token, apiMessages, approvalContext, signal);
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
    executionSignal?: AbortSignal,
  ): Promise<string> {
    const task = String(args.task ?? "").trim();
    if (!task) return "[Error: delegate needs a task: what should the sub-agent do?]";
    const context = typeof args.context === "string" ? args.context.trim() : "";
    const approval = { ...approvalContext, context: captureApprovalContext(apiMessages).context };
    const maxRounds = subAgentRounds(loadConfig(this.mode).subagent_max_rounds);
    const runtime = currentTask()?.runtime;
    const signal = executionSignal ?? runtime?.signal ?? this.turnAbort?.signal;
    const stopped = () => token !== this.turnToken || this.paused || signal?.aborted === true;
    const run = await runSubAgentTask({
      runtime, signal,
      readOnly: args.read_only === true,
      writePaths: Array.isArray(args.write_paths) ? args.write_paths.filter((p): p is string => typeof p === "string") : undefined,
      contextWindow: modelContextWindow(this.provider, this.model, this.mode),
      createClient: () => new LLMClient(this.model, this.provider, this.intensity),
      system: loadSubAgentPrompt(),
      task: buildSubAgentTask({ task, context, cwd: this.dir, rounds: maxRounds }),
      tools: getSubAgentToolDefinitions(),
      maxRounds,
      approve: (name, callArgs) => this.requestApproval(name, callArgs, approval, signal),
      execute: (name, callArgs) =>
        name === DELEGATE_TOOL
          ? Promise.resolve("[Error: sub-agents cannot delegate further]")
          : executeTool(name, callArgs, this.dir, signal),
      onProgress: (label) => {
        if (stopped()) return;
        this.subagent = label;
        toolMsg.result = `… ${label}`;
        this.publishLive();
      },
      onUsage: (usage) => {
        if (stopped()) return;
        this.tokens.prompt += usage.prompt;
        this.tokens.completion += usage.completion;
      },
      onRetry: (notice) => {
        if (stopped()) return;
        this.retrying = notice;
        this.publishLive();
      },
      cancelled: stopped,
    });
    if (!stopped()) {
    this.subagent = null;
    this.retrying = null;
    toolMsg.result = TOOL_PENDING;
    this.publishLive();
    }
    return formatSubAgentResult(run);
  }

  // ---- compression -----------------------------------------------------

  private compressThreshold(): number {
    if (this.mode === "pro") {
      const setting = this.proState?.models.find((entry) => entry.role === "main_model");
      const tier = loadProModels().tier.find((entry) => entry.name === setting?.tier);
      const capacity = tier?.["model-setting"].find((entry) => entry.type === "main_model")?.context_window;
      if (capacity) return Math.max(1, Math.floor(capacity * 0.8));
    }
    return contextCompressionThreshold(this.provider, this.model, this.mode);
  }

  /** Trim old tool results in a long turn without changing the saved history. */
  private trimApiMessages(apiMessages: ApiMessage[]): ApiMessage[] {
    const threshold = this.compressThreshold();
    if (threshold <= 0 || this.lastPromptTokens < threshold) return apiMessages;
    const toolIdx: number[] = [];
    for (let i = 0; i < apiMessages.length; i++) {
      if (apiMessages[i].role === "tool") toolIdx.push(i);
    }
    const dropCount = toolIdx.length - COMPACT_KEEP;
    if (dropCount <= 0) return apiMessages;
    const copy = apiMessages.slice();
    for (let k = 0; k < dropCount; k++) {
      copy[toolIdx[k]] = { ...copy[toolIdx[k]], content: "[tool output omitted to save context]" };
    }
    return copy;
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
      summary = await (this.proTeam?.client("main_model") ?? new LLMClient(this.model, this.provider, this.intensity)).summarize(transcript, {
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
    return "";
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
        this.mode,
        this.proPreset ?? undefined,
        this.agentMode,
        this.taskRuntime?.snapshot() ?? this.lastTask,
        this.fastState,
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
