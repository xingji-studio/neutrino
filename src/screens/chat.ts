import path from "node:path";
import type { Buffer } from "../terminal/buffer.js";
import { Screen, type ScrollbarHandle } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C, type Style } from "../colors.js";
import {
  findModel,
  findConfiguredModel,
  intensityForModel,
  contextCompressionThreshold,
  modelContextWindow,
  sessionDir,
  loadConfig,
  loadPlannerPrompt,
  loadStepPrompt,
  loadSubAgentPrompt,
  normalizeApprovalMode,
  planFirstEnabled,
  loadPrompt,
  loadAgentPrompt,
  normalizeAgentMode,
  type AgentMode,
  saveSession,
  type ModelInfo,
  type SessionMessage,
  type TokenUsage,
  type ResolvedModelSelection,
  type ApprovalMode,
} from "../config.js";
import { drawHeader } from "../header.js";
import { computeInputWindow, cursorFromColumn, drawInputBox, drawScrollbar, wrapText, approvalToggle, drawApprovalToggle, inRect } from "../ui.js";
import { drawSpans, renderMarkdownText, type Line, type Span } from "../markdown.js";
import { ellipsize, displayWidth } from "../width.js";
import { sanitizeText } from "../sanitize.js";
import { TaskRuntime, TaskControlError, currentTask, linkSignals, taskLimits, taskBudgetScope, resumeTaskSnapshot, type AgentStatus, type TaskSnapshot } from "../llm/runtime.js";
import { prepareContext, outputAllowance, finalTaskReport } from "../llm/context.js";
import { FINISH_STEP_TOOL, FINISH_STEP_DEFINITION, finishPlanStep, preparePlan, settlePlan } from "../llm/plan.js";
import { LLMClient, describeError } from "../llm/client.js";
import { formatDelay } from "../llm/retry.js";
import {
  advancePlan,
  buildPlannerInput,
  lastRequestText,
  needsPlan,
  parsePlan,
  planCardRows,
  planMessage,
  planRowsWidth,
  planTranscript,
  renderStepDirective,
  resumePlan,
  stopPlan,
  type PlanRow,
  type PlanRowKind,
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
import { ApprovalGate, captureApprovalContext, describeApprovalIntent, statedReason, type ApprovalDecision, type ApprovalContext } from "../llm/approval.js";
import {
  COMPACT_KEEP,
  COMPACT_MAX_CHARS_PER_MESSAGE,
  planCompaction,
  transcriptFor,
  modelHistory,
  normalizeContext,
  type ConversationContext,
} from "../compact.js";
import { hub, liveApprovalDetails, type LiveAgent, type LiveMeta, type LiveSnapshot, type LiveWireMessage, type ModelChangeResult, type LiveReviewProgress } from "../web/hub.js";
import { SessionCheckpoint } from "../persistence.js";
import { writeCrashLog } from "../terminal/restore.js";

interface ApiMessage {
  role: string;
  content?: string;
  /** Thinking text echoed back on an assistant tool-call message. */
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ToolMsg {
  role: "tool";
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

type Msg =
  | { role: "user" | "assistant" | "system"; content: string }
  | { role: "summary"; content: string; count: number }
  | ToolMsg;

const TOOLS = getToolDefinitions();
/** A sub-agent gets the same tools minus delegation: one level, never a tree. */
const SUB_AGENT_TOOLS = getSubAgentToolDefinitions();

/**
 * A finished turn folds its *work* away — the thinking and the tool calls —
 * while the full user prompt and final reply always stay on screen. Doing
 * that is only worth a click when the work is substantial: four or more blocks,
 * or roughly six wrapped lines of text. Short exchanges stay readable without a
 * click. `web/turns.js` applies the same rule in the browser, so both UIs fold
 * exactly the same turns.
 */
export const TURN_FOLD_MIN_BLOCKS = 4;
export const TURN_FOLD_MIN_CHARS = 600;

function parseArgs(s: string): Record<string, unknown> {
  if (!s || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}


/**
 * How each kind of info-card row is drawn.
 *
 * The three step states are deliberately distinct: the step being worked on is a
 * lit bar, steps still to come are normal text, and finished steps recede into
 * the dark so the eye lands on what is happening now.
 */
function planRowStyle(kind: PlanRowKind): Style {
  switch (kind) {
    case "header":
      return { fg: C.accent, bg: C.black, bold: true };
    case "step-active":
      return { fg: C.accent, bg: C.highlightBg, bold: true };
    case "step-done":
      return { fg: C.dim, bg: C.black };
    case "step-pending":
      return { fg: C.assistant, bg: C.black };
    case "step-failed":
      return { fg: C.red, bg: C.black, bold: true };
    case "connector":
    case "more":
      return { fg: C.dim, bg: C.black };
    default:
      return { fg: C.assistant, bg: C.black };
  }
}

export class ChatScreen extends Screen implements LiveAgent {
  initialMessage: string;
  loadedMessages: SessionMessage[] | null = null;
  loadedCwd: string | null = null;
  sessionId: string | null = null;
  loadedProvider: string | null = null;
  loadedModel: string | null = null;
  loadedIntensity: string | null = null;
  loadedTokens: TokenUsage | null = null;
  loadedContext: ConversationContext | null = null;
  loadedApprovalMode: ApprovalMode | null = null;
  loadedPlan: PlanState | null = null;
  loadedTask: TaskSnapshot | undefined;
  loadedAgentMode: AgentMode | null = null;
  private approvalMode: ApprovalMode = "request";

  modelProvider = "DeepSeek";
  model: ModelInfo = { name: "deepseek-chat", url: "https://api.deepseek.com/v1", api_key: "", supports_streaming: true };
  intensity = "High";

  private tokens: TokenUsage = { prompt: 0, completion: 0 };
  private showInfo = false;

  // ---- plan-first turns ----
  /** The plan of the turn being worked on, or the last one. */
  private plan: PlanState | null = null;
  /** True while the planner agent is writing the steps. */
  private planning = false;
  /** What the sub-agent is doing, or null when none is running. */
  private subagent: string | null = null;

  private messages: Msg[] = [];
  private streamingContent: string | null = null;
  private saveError: string | null = null;
  /** Why a busy turn is silent: a transient network failure being retried. */
  private retryNotice: string | null = null;
  private checkpoint = new SessionCheckpoint(() => {
    const saved = this.writeSession();
    this.publishLive();
    return saved;
  });
  private busy = false;
  private paused = false;
  private queued: string | null = null;
  private taskRuntime: TaskRuntime | null = null;
  private lastTask: TaskSnapshot | undefined;
  private taskOutcome: AgentStatus = "completed";
  private turnToken = 0;
  private agentMode: AgentMode = "standard";
  private activeAgentMode: AgentMode = "standard";
  private turnAbort: AbortController | null = null;
  private inputValue = "";
  private cursor = 0;
  private scrollTop = 0;
  private followBottom = true;
  private scrollbarGeom: { x: number; top: number; bottom: number; total: number; viewport: number } | null = null;
  private lastEscTime = 0;
  private initialized = false;

  // ---- auto context compression ----
  /** Prompt tokens of the most recent request — the best proxy for how large
   *  the current context has grown. Reset once the history is compressed. */
  private lastPromptTokens = 0;
  private compressing = false;
  private context: ConversationContext | null = null;
  private expandedContext = false;
  private contextLines = new Set<number>();
  private contextRows = new Set<number>();

  // ---- collapsible tool output ----
  /** Message indices whose tool output is expanded (everything starts
   *  collapsed). */
  private expandedTools = new Set<number>();
  /** For each line produced by buildLines, the tool message index it belongs
   *  to, or -1 when it is not part of a tool block. */
  private toolLineIndex: number[] = [];
  /** Terminal row -> tool message index, rebuilt each render for hit-testing. */
  private toolRows = new Map<number, number>();

  // ---- collapsible turns ----
  /** First message index of every turn whose reply has finished. A transcript
   *  loaded from disk starts finished: reopening history reviews past work. */
  private finishedTurns = new Set<number>();
  /** Turns the reader opened; a finished turn stays folded unless listed here. */
  private expandedTurns = new Set<number>();
  /** First message index of the turn being answered right now, if any. */
  private activeTurnStart: number | null = null;
  /** For each built line, the folded turn it belongs to (-1 = none). Only the
   *  header lines carry it, so clicks inside a tool block still target the tool. */
  private turnLineIndex: number[] = [];
  /** Terminal row -> folded turn start, rebuilt each render for hit-testing. */
  private turnRows = new Map<number, number>();

  // ---- web bridge ----
  private liveKey: string | null = null;
  private liveDir = process.cwd();

  // ---- approval gate ---------------------------------------------------

  /** Non-null while a tool call is waiting for a human decision. */
  private pendingApproval: {
    tool: string;
    args: Record<string, unknown>;
    risk: RiskAssessment;
    resolve(approved: boolean | null): void;
  } | null = null;
  private reviewing: LiveReviewProgress | null = null;
  /** Decisions taken by the gate, keyed by the tool message (survives
   * context compression, which renumbers the array). */
  private approvals = new Map<ToolMsg, ApprovalDecision>();
  /** Hit boxes of the approval card, rebuilt on every render. */
  private approvalButtons: {
    approve: { x: number; y: number; w: number };
    deny: { x: number; y: number; w: number };
  } | null = null;

  constructor(initialMessage = "") {
    super();
    this.initialMessage = initialMessage;
  }

  onActivate(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.agentMode = normalizeAgentMode(this.loadedAgentMode);
    this.approvalMode = normalizeApprovalMode(this.loadedApprovalMode ?? loadConfig().approval_mode);
    const st = this.app.state;
    this.modelProvider = this.loadedProvider ?? st.selectedProvider;
    this.model = {
      name: this.loadedModel ?? st.selectedModelName,
      url: st.selectedModelUrl,
      api_key: st.selectedModelApiKey,
      supports_streaming: st.selectedModelStreaming,
    };
    // The selected-state snapshot has no room for provider options; re-read the
    // thinking-mode flag from model.json so a hand-configured endpoint keeps it.
    const configured = findConfiguredModel(this.modelProvider, this.model.name);
    if (configured) {
      if (typeof configured.reasoning === "boolean") this.model.reasoning = configured.reasoning;
      this.model.intensity = configured.intensity;
    }
    const savedIntensity = this.loadedIntensity ?? st.selectedIntensity;
    this.intensity = intensityForModel(configured, savedIntensity, loadConfig().default_intensity);
    // A resumed transcript can carry a level its model no longer accepts; the
    // header and the next request must show and use the level actually in use.
    if (this.intensity !== savedIntensity) this.app.state.selectedIntensity = this.intensity;
    if (this.loadedTokens) {
      this.tokens = { prompt: this.loadedTokens.prompt, completion: this.loadedTokens.completion };
    }
    this.messages.push({
      role: "system",
      content: `Model: ${this.modelProvider}/${this.model.name} | Intensity: ${this.intensity}`,
    });
    for (const m of this.loadedMessages ?? []) {
      this.messages.push(m as Msg);
    }
    // Everything already on disk was answered, so history opens compact.
    for (const start of this.userMessageIndexes()) this.finishedTurns.add(start);
    this.plan = resumePlan(this.loadedPlan);
    this.lastTask = resumeTaskSnapshot(this.loadedTask);
    this.context = normalizeContext(this.loadedContext, this.messages.filter((m) => m.role !== "system").length);
    this.liveDir = this.loadedCwd ?? process.cwd();
    this.checkpoint.register();
    this.liveKey = hub.register(this);
    this.publishLive();
    if (this.initialMessage) {
      this.send(this.initialMessage);
    } else {
      this.app.render();
    }
  }

  onDeactivate(): void {
    // Never leave the agent awaiting a decision nobody can give.
    if (this.pendingApproval) this.settleApproval(false);
    // A turn can continue after returning to the menu. Keep its exit checkpoint
    // registered until it finishes, including while a tool is still running.
    if (this.busy) this.save();
    else this.checkpoint.dispose();
    hub.unregister(this.liveKey);
    this.liveKey = null;
  }

  // ---- web bridge (see src/web/hub.ts) ---------------------------------

  liveCwd(): string {
    return this.liveDir;
  }

  liveConfigure(selection: ResolvedModelSelection): ModelChangeResult {
    if (this.busy || this.pendingApproval) {
      return { ok: false, error: "pause the current turn before changing models" };
    }
    this.modelProvider = selection.provider;
    this.model = { ...selection.model };
    this.intensity = intensityForModel(this.model, selection.intensity, loadConfig().default_intensity);
    Object.assign(this.app.state, {
      selectedProvider: this.modelProvider, selectedModelName: this.model.name,
      selectedModelUrl: this.model.url, selectedModelApiKey: this.model.api_key,
      selectedModelStreaming: this.model.supports_streaming, selectedIntensity: this.intensity,
    });
    const header = this.messages.find((m) => m.role === "system");
    if (header?.role === "system") header.content = `Model: ${this.modelProvider}/${this.model.name} | Intensity: ${this.intensity}`;
    this.save();
    this.app.render();
    this.publishLive();
    return { ok: true };
  }

  liveMeta(): LiveMeta {
    return {
      sessionId: this.sessionId,
      title: this.liveTitle(),
      provider: this.modelProvider,
      model: this.model.name,
      intensity: this.intensity,
      approvalMode: this.approvalMode,
      agentMode: this.agentMode,
      activeAgentMode: this.busy ? this.activeAgentMode : this.agentMode,
      task: this.taskRuntime?.snapshot() ?? this.lastTask,
      busy: this.busy,
      paused: this.paused,
      queued: this.queued,
      compressing: this.compressing,
      saveError: this.saveError,
      tokens: { prompt: this.tokens.prompt, completion: this.tokens.completion },
      subagent: this.subagent,
      approval: this.pendingApproval
        ? liveApprovalDetails(this.pendingApproval.tool, this.pendingApproval.args, this.pendingApproval.risk, this.liveDir)
        : null,
      reviewing: this.reviewing,
    };
  }

  liveSnapshot(key: string): LiveSnapshot {
    const messages: LiveWireMessage[] = [];
    for (const message of this.messages) {
      if (message.role === "system") continue;
      if (message.role === "summary") {
        messages.push({ role: "summary", content: message.content, count: message.count });
      } else if (message.role === "tool") {
        messages.push({ role: "tool", name: message.name, arguments: message.arguments, result: message.result });
      } else {
        messages.push({ role: message.role, content: message.content });
      }
    }
    return {
      ...this.liveMeta(),
      key,
      cwd: this.liveDir,
      messages,
      streamingContent: this.streamingContent,
      context: this.context,
      plan: this.plan,
    };
  }

  livePause(): void {
    if (this.paused || (!this.busy && !this.queued)) return;
    this.paused = true;
    this.subagent = null;
    this.retryNotice = null;
    this.reviewing = null;
    this.planning = false;
    this.turnAbort?.abort();
    this.turnToken++;
    // A queued decision would otherwise keep the agent awaiting forever.
    if (this.pendingApproval) this.settleApproval(false);
    this.busy = false;
    this.app.state.isThinking = false;
    this.retainStreamingContent();
    this.haltPlan();
    this.save();
    this.app.render();
    this.publishLive();
  }

  liveResume(): void {
    if (this.paused) this.togglePause();
  }

  /** Answer the pending call from the web UI. */
  liveApprove(approved: boolean): boolean {
    if (!this.pendingApproval) return false;
    this.settleApproval(approved);
    return true;
  }

  liveSetAgentMode(mode: AgentMode): ModelChangeResult {
    this.agentMode = mode;
    this.save();
    this.publishLive();
    return { ok: true };
  }

  liveSetApprovalMode(mode: ApprovalMode): void {
    if (this.approvalMode === mode) return;
    this.approvalMode = mode;
    if (this.pendingApproval) this.settleApproval(null);
    this.save();
    this.app.render();
    this.publishLive();
  }

  /**
   * Start a fresh conversation in the same working directory. Used by Ctrl+L
   * and by the browser's Clear button, so both screens behave identically. The
   * previous transcript is saved first and is never overwritten.
   */
  liveClear(): void {
    this.save();
    if (this.saveError) {
      this.app.render();
      return;
    }
    this.turnAbort?.abort();
    this.turnToken++;
    this.taskRuntime = null;
    this.lastTask = undefined;
    if (this.pendingApproval) this.settleApproval(false);
    this.busy = false;
    this.paused = false;
    this.queued = null;
    this.compressing = false;
    this.retryNotice = null;
    this.app.state.isThinking = false;
    this.lastPromptTokens = 0;
    this.sessionId = null;
    this.context = null;
    this.expandedContext = false;
    this.plan = null;
    this.planning = false;
    this.subagent = null;
    const sysText = this.messages[0] && this.messages[0].role === "system" ? this.messages[0].content : "";
    this.messages = [{ role: "system", content: sysText }];
    this.expandedTools.clear();
    this.finishedTurns.clear();
    this.expandedTurns.clear();
    this.activeTurnStart = null;
    this.streamingContent = null;
    this.scrollTop = 0;
    this.followBottom = true;
    this.publishLive();
    this.app.render();
  }

  liveSend(text: string): void {
    if (!text.trim()) return;
    this.send(text);
    this.publishLive();
  }

  private liveTitle(): string {
    for (const message of this.messages) {
      if (message.role === "user") {
        const title = message.content.replace(/\s+/g, " ").trim();
        return title.length > 80 ? title.slice(0, 80) : title;
      }
    }
    return "";
  }

  private publishLive(): void {
    hub.notify(this.liveKey);
  }

  private approvalToggleY(height = this.app.height): number {
    // Short terminals need the space above the input for the approval card.
    return this.pendingApproval && height < 13 ? 1 : height - 5;
  }

  /**
   * The input row is persistent chrome: it is drawn with absolute positioning
   * and must survive any terminal-side drift (ConPTY reflow, a stray scroll).
   * Repainting it every frame makes the input area self-healing — the log can
   * never end up "covering" it.
   */
  alwaysRepaintRows(): number[] {
    const h = this.app.height;
    const rows: number[] = [];
    for (let y = h - 5; y <= h - 1; y++) if (y >= 0) rows.push(y);
    if (this.pendingApproval && h < 13) rows.push(1);
    return rows;
  }

  showsCursor(): boolean {
    // The chat input is always focused; a cursor is drawn when it holds text.
    return this.inputValue.length > 0;
  }

  onPaste(text: string): void {
    if (!text) return;
    // A pasted tab/ESC would otherwise sit in the input box and be re-emitted
    // by the renderer on every frame, corrupting the rows around it.
    text = sanitizeText(text, { singleLine: true });
    if (!text) return;
    if (this.showInfo) this.showInfo = false;
    this.inputValue =
      this.inputValue.slice(0, this.cursor) + text + this.inputValue.slice(this.cursor);
    this.cursor += text.length;
    this.app.render();
  }

  onKey(key: Key): void {
    if (key.ctrl && key.name === "a") {
      this.liveSetApprovalMode(this.approvalMode === "auto" ? "request" : "auto");
      return;
    }
    // A pending approval is modal: it owns the keyboard until answered.
    if (this.pendingApproval) {
      const name = key.name.toLowerCase();
      if (name === "y" || name === "return") this.settleApproval(true);
      else if (name === "n" || name === "escape") this.settleApproval(false);
      return;
    }
    // The card is the plan: Ctrl+P shows it even when the pointer is elsewhere.
    if (key.ctrl && key.name === "p") {
      this.showInfo = !this.showInfo;
      this.app.render();
      return;
    }

    if (this.showInfo) {
      this.showInfo = false;
      this.app.render();
      if (key.name === "escape") return;
    }
    if (key.name === "escape") {
      const now = Date.now();
      if (now - this.lastEscTime < 400) {
        this.lastEscTime = 0;
        this.togglePause();
      } else {
        this.lastEscTime = now;
      }
      return;
    }
    if (key.name === "return") {
      const text = this.inputValue.trim();
      if (text) this.send(text);
      return;
    }
    if (key.name === "up") {
      this.followBottom = false;
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      this.app.render();
      return;
    }
    if (key.name === "down") {
      this.scrollTop += 1;
      this.app.render();
      return;
    }
    if (key.name === "pageup") {
      this.followBottom = false;
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      this.app.render();
      return;
    }
    if (key.name === "pagedown") {
      this.scrollTop += 10;
      this.app.render();
      return;
    }
    if (key.name === "left") {
      if (this.cursor > 0) {
        this.cursor--;
        this.app.render();
      }
      return;
    }
    if (key.name === "right") {
      if (this.cursor < this.inputValue.length) {
        this.cursor++;
        this.app.render();
      }
      return;
    }
    if (key.name === "backspace") {
      if (this.cursor > 0) {
        this.inputValue = this.inputValue.slice(0, this.cursor - 1) + this.inputValue.slice(this.cursor);
        this.cursor--;
        this.app.render();
      }
      return;
    }
    if (key.name === "delete") {
      if (this.cursor < this.inputValue.length) {
        this.inputValue = this.inputValue.slice(0, this.cursor) + this.inputValue.slice(this.cursor + 1);
        this.app.render();
      }
      return;
    }
    if (key.name === "home") {
      this.cursor = 0;
      this.app.render();
      return;
    }
    if (key.name === "end") {
      this.cursor = this.inputValue.length;
      this.app.render();
      return;
    }
    if (key.ctrl && key.name === "b") {
      this.save();
      this.app.popScreen();
      return;
    }
    if (key.ctrl && key.name === "l") {
      this.liveClear();
      return;
    }
    if (key.ctrl && key.name === "u") {
      this.inputValue = "";
      this.cursor = 0;
      this.app.render();
      return;
    }
    if (!key.ctrl && !key.meta && key.name.length === 1) {
      this.inputValue = this.inputValue.slice(0, this.cursor) + key.name + this.inputValue.slice(this.cursor);
      this.cursor++;
      this.app.render();
    }
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type === "click") {
      if (ev.button === 2) return; // right click: no-op in chat
      if (inRect(ev.x, ev.y, approvalToggle(this.app.width, this.approvalToggleY(), this.approvalMode))) {
        this.liveSetApprovalMode(this.approvalMode === "auto" ? "request" : "auto");
        return;
      }

      // The approval card floats over the log: test its buttons first.
      const buttons = this.approvalButtons;
      if (this.pendingApproval && buttons) {
        const hit = (r: { x: number; y: number; w: number }) =>
          ev.y === r.y && ev.x >= r.x && ev.x < r.x + r.w;
        if (hit(buttons.approve)) {
          this.settleApproval(true);
          return;
        }
        if (hit(buttons.deny)) {
          this.settleApproval(false);
          return;
        }
      }
      // header row: right corner toggles token stats, the rest opens model config
      if (ev.y === 0) {
        if (ev.x >= this.app.width - 3) {
          this.showInfo = !this.showInfo;
        } else {
          this.app.openModelConfig();
        }
        this.app.render();
        return;
      }
      if (this.showInfo) {
        this.showInfo = false;
        this.app.render();
        return;
      }
      // click on the input box -> focus and position the cursor
      const inputY = this.app.height - 4;
      const inW = Math.max(12, this.app.width - 2);
      if (ev.y === inputY + 1 && ev.x >= 3 && ev.x < 3 + (inW - 4)) {
        const innerW = inW - 4;
        const col = Math.min(innerW - 1, ev.x - 3);
        const win = computeInputWindow(this.inputValue, this.cursor, innerW);
        this.cursor = cursorFromColumn(this.inputValue, col, win);
        this.app.render();
        return;
      }
      // A click inside the conversation log toggles a tool block open/closed.
      if (this.contextRows.has(ev.y)) {
        this.expandedContext = !this.expandedContext;
        this.followBottom = false;
        this.scrollTop = Math.min(this.scrollTop, Math.min(...this.contextLines));
        this.app.render();
        return;
      }
      const turn = this.turnRows.get(ev.y);
      if (turn !== undefined) {
        this.toggleTurn(turn);
        return;
      }
      const tool = this.toolRows.get(ev.y);
      if (tool !== undefined) {
        this.toggleTool(tool);
        return;
      }
      return;
    }
    if (ev.type === "wheel") {
      if (ev.dir === -1) {
        this.followBottom = false;
        this.scrollTop = Math.max(0, this.scrollTop - 3);
      } else {
        this.scrollTop += 3;
      }
      this.app.render();
    }
  }

  scrollbar(): ScrollbarHandle | null {
    const g = this.scrollbarGeom;
    if (!g || g.total <= g.viewport) return null;
    return {
      x: g.x,
      top: g.top,
      bottom: g.bottom,
      total: g.total,
      viewport: g.viewport,
      offset: this.scrollTop,
      scrollTo: (offset: number) => {
        const maxScroll = Math.max(0, g.total - g.viewport);
        this.scrollTop = Math.max(0, Math.min(offset, maxScroll));
        // Dragging to the very bottom resumes auto-following new output.
        this.followBottom = this.scrollTop >= maxScroll;
        this.app.render();
      },
    };
  }

  private togglePause(): void {
    if (!this.busy && !this.queued) return;
    this.paused = !this.paused;
    if (this.paused) {
      this.reviewing = null;
      this.planning = false;
      this.subagent = null;
      this.retryNotice = null;
      this.turnAbort?.abort();
    this.turnToken++;
      this.busy = false;
      this.app.state.isThinking = false;
      this.retainStreamingContent();
      // The loop that ran the plan is gone with the paused turn.
      this.haltPlan();
      this.save();
    }
    this.app.render();
    this.maybeFlushQueue();
    this.publishLive();
  }

  private maybeFlushQueue(): void {
    if (this.queued) {
      this.queued = null;
      this.startTurn();
    }
  }

  // ---- plan-first turns -------------------------------------------------

  /**
   * Run the planner agent over the current request.
   *
   * Returns null rather than throwing in every case where there is no usable
   * plan — planning switched off, a one-step request, a provider that fails, an
   * answer that is not a plan. The turn then runs exactly as it did before
   * plan-first existed; a plan is an improvement, never a new way to fail.
   */
  private async makePlan(token: number): Promise<PlanState | null> {
    if (!planFirstEnabled()) return null;
    const request = lastRequestText(this.messages);
    if (!request.trim()) return null;
    // A request that is one action is not planned: the planner round-trip would
    // cost more than the steps are worth, and the worker states its steps in its
    // own answer. The card then shows the token counts, not a one-line plan.
    if (!needsPlan(request)) return null;
    this.planning = true;
    this.app.render();
    this.publishLive();
    try {
      const client = new LLMClient(this.model, this.modelProvider, this.intensity);
      const answer = await client.complete(
        loadPlannerPrompt(),
        buildPlannerInput({ request, cwd: this.liveDir, transcript: planTranscript(this.messages) }),
        {
          onRetry: (notice) => {
            this.retryNotice =
              `Planning — network hiccup, retrying in ${formatDelay(notice.delayMs)} ` +
              `(attempt ${notice.attempt}/${notice.attempts})`;
            this.app.render();
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
        this.retryNotice = null;
        this.app.render();
        this.publishLive();
      }
    }
  }

  /** Move the plan to one step and show it: the card follows every transition. */
  private setStep(index: number, status: PlanStepStatus): void {
    if (!advancePlan(this.plan, index, status)) return;
    this.save();
    this.publishLive();
    this.app.render();
  }

  /** A turn that can no longer continue must not leave a step looking alive. */
  private haltPlan(): void {
    stopPlan(this.plan);
  }

  /**
   * One user turn.
   *
   * A planned turn is answered in two passes: the planner writes the steps, then
   * the worker executes them one at a time, top to bottom, each with the whole
   * plan in its system prompt and the instruction to do only its own step. That
   * keeps the work of a long request explicit — the card shows exactly which
   * step is running and which are done — and keeps every step verifiable on its
   * own. Without a plan the turn runs in one pass, as before.
   */
  private async runTurn(token: number, turnMessages: Msg[], approvalContext: ApprovalContext): Promise<void> {
    const runtime = new TaskRuntime({
      request: approvalContext.prompt, priorUserRequests: approvalContext.priorUserRequests,
      cwd: this.liveDir, signal: this.turnAbort?.signal, limits: taskLimits(loadConfig("standard")),
      budgetScope: taskBudgetScope(loadConfig("standard")),
      journalDir: path.join(sessionDir("standard"), "tasks", path.basename(this.sessionId || "unsaved")),
    });
    this.taskRuntime = runtime;
    this.taskOutcome = "completed";
    let failed = false;
    try {
      await runtime.run(() => this.runTaskTurn(token, turnMessages, approvalContext));
    } catch (error) { failed = true; throw error; }
    finally {
      await runtime.drain();
      if (runtime.signal.aborted) settlePlan(runtime.plan ?? null, true);
      runtime.finish(runtime.signal.aborted ? "cancelled" : failed ? "failed" :
        runtime.plan?.steps.some(step => step.status === "failed") ? "failed" :
        runtime.plan?.steps.some(step => !["done", "skipped"].includes(step.status)) ? "partial" : this.taskOutcome);
      if (this.taskRuntime === runtime) {
        if (runtime.signal.aborted && token === this.turnToken && this.busy && !this.paused) {
          if ((this.taskOutcome as AgentStatus) !== "cancelled") this.messages.push({ role: "assistant", content: `[Task stopped: ${String(runtime.signal.reason)}]\n${runtime.partialReport()}` });
          this.streamingContent = null;
          this.onTurnFinished(false);
        }
        if (this.taskRuntime === runtime) {
          this.lastTask = runtime.snapshot();
          this.save(); this.publishLive();
        }
      }
    }
  }

  private async runTaskTurn(token: number, turnMessages: Msg[], approvalContext: ApprovalContext): Promise<void> {
    // Shrink the history before building the request when it has outgrown the
    // configured budget.
    await this.autoCompress(token);
    if (token !== this.turnToken) return;

    if (this.activeAgentMode !== "standard") this.plan = null;
    const plan = this.activeAgentMode === "standard" ? await this.makePlan(token) : null;
    if (token !== this.turnToken) return;

    if (plan) {
      this.plan = plan;
      if (currentTask()) currentTask()!.runtime.plan = plan;
      // The plan is an ordinary assistant message: it is saved, folded, replayed
      // and sent back to the model exactly like any other answer, so later turns
      // (and the user) still know what was agreed.
      this.messages.push({ role: "assistant", content: planMessage(plan) });
      // Opening the card is the point of planning: the steps were asked for up
      // front, so they are shown up front. A click or Esc closes it again.
      this.showInfo = true;
      this.save();
      this.publishLive();
      this.app.render();

      const template = loadStepPrompt();
      for (let i = 0; i < plan.steps.length; i++) {
        if (token !== this.turnToken) return;
        this.setStep(i, "active");
        const directive = renderStepDirective(template, plan, i);
        const finished = await this.agentLoop(
          this.buildApiMessages(this.turnView(turnMessages), directive),
          token,
          approvalContext,
        );
        if (token !== this.turnToken) return;
        this.setStep(i, currentTask()?.signal.aborted ? "cancelled" : finished ? "done" : "failed");
        // A step that failed stops the plan: the remaining steps assumed this one
        // succeeded, and the user has to see the failure before anything runs on
        // top of it.
        if (!finished) break;
      }
    } else {
      await this.agentLoop(this.buildApiMessages(this.turnView(turnMessages)), token, approvalContext);
      if (token !== this.turnToken) return;
    }
    this.onTurnFinished();
  }

  /**
   * The transcript this turn may see: the messages it started with plus what it
   * has added since — the plan message, replies, tool calls and results.
   *
   * A user message that arrives while the turn runs is queued for the *next*
   * turn, so it is deliberately not part of this one: the model and the approval
   * reviewers must always judge the same request.
   */
  private turnView(snapshot: Msg[]): Msg[] {
    const view = snapshot.slice();
    for (let i = snapshot.length; i < this.messages.length; i++) {
      if (this.messages[i].role !== "user") view.push(this.messages[i]);
    }
    return view;
  }

  private send(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.messages.push({ role: "user", content: trimmed });
    // Create the history entry before requesting a model or executing tools.
    this.save();
    this.inputValue = "";
    this.cursor = 0;
    this.followBottom = true;
    this.publishLive();

    if (this.busy && !this.paused) {
      this.queued = trimmed;
      this.app.render();
      return;
    }

    this.startTurn();
  }

  private startTurn(): void {
    if (this.taskRuntime?.settling) {
      const previous = this.taskRuntime;
      this.queued = lastRequestText(this.messages);
      this.paused = false;
      void previous.drain().then(() => {
        if (this.taskRuntime === previous && this.queued && !this.paused) {
          this.queued = null;
          this.startTurn();
        }
      });
      this.publishLive();
      return;
    }
    // Sending closes every earlier turn, including one left unfinished by
    // ESC ESC: it is folded from here on, but never while it is still paused.
    const starts = this.userMessageIndexes();
    const active = starts.length > 0 ? starts[starts.length - 1] : null;
    for (const start of starts) if (start !== active) this.finishedTurns.add(start);
    this.activeTurnStart = active;
    const turnMessages = this.messages.slice();
    const approvalContext = captureApprovalContext(turnMessages);
    this.busy = true;
    this.paused = false;
    this.app.state.isThinking = true;
    this.activeAgentMode = this.agentMode;
    this.turnAbort?.abort();
    this.turnAbort = new AbortController();
    const token = ++this.turnToken;
    this.streamingContent = "";
    this.app.render();
    this.publishLive();
    void this.runTurn(token, turnMessages, approvalContext).catch((err) => {
      if (token === this.turnToken) this.failTurn(err);
    });
  }

  /**
   * Ends a turn that failed before or around the agent loop.
   *
   * The turn body is a floating promise, so anything thrown outside the loop's
   * own try/catch would otherwise surface as an unhandled rejection, which Node
   * turns into a fatal error. Ending the turn here keeps the app alive and the
   * failure visible in the transcript.
   */
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
      // If even the cleanup fails, force the idle state so the UI stays usable.
      this.busy = false;
      this.paused = false;
      this.app.state.isThinking = false;
      try {
        this.app.render();
      } catch {
        // The app-level render guard reports this one.
      }
    }
  }

  private buildApiMessages(messages = this.messages, directive = ""): ApiMessage[] {
    // A step directive extends the system prompt rather than adding a user
    // message: the plan is an instruction, not something the user just said.
    const prompt = loadAgentPrompt(this.activeAgentMode);
    const system = (directive ? `${prompt}\n\n${directive}` : prompt) +
      (currentTask() ? `\n\n${currentTask()!.runtime.instructions()}` : "");
    const api: ApiMessage[] = [{ role: "system", content: system }];
    for (const m of modelHistory(messages, this.context)) {
      if (m.role === "user" || m.role === "assistant") {
        api.push({ role: m.role, content: m.content });
      } else if (m.role === "summary") {
        // A compressed summary is fed back to the model as its own prior output.
        api.push({ role: "assistant", content: m.content });
      }
    }
    return api;
  }

  /**
   * One agent conversation: request, tool calls, request again, until the model
   * answers without asking for a tool.
   *
   * Returns true when the model finished on its own and false when the turn was
   * cut short (paused, superseded, or failed). The caller owns the turn's end,
   * because a planned turn runs this once per step.
   */
  private async agentLoop(apiMessages: ApiMessage[], token: number, approvalContext: ApprovalContext): Promise<boolean> {
    const tools = this.activeAgentMode === "ptc"
      ? [...TOOLS, (await import("../llm/codemode.js")).getCodeToolDefinition()] : TOOLS;
    let emptyReplies = 0;
    try {
      while (true) {
        if (token !== this.turnToken) return false;
        // Keep the payload inside budget during a long single turn: once the
        // context is too large, drop the body of older tool results.
        apiMessages = this.trimApiMessages(apiMessages);
        if (currentTask()) await prepareContext({
          messages: apiMessages, tools, capacity: modelContextWindow(this.modelProvider, this.model, "standard"),
          createClient: () => new LLMClient(this.model, this.modelProvider, this.intensity),
          stream: { signal: currentTask()!.runtime.signal, cancelled: () => token !== this.turnToken || this.paused },
          onUsage: usage => { this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion; },
        });
        const client = new LLMClient(this.model, this.modelProvider, this.intensity);
        let content = "";
        let hasContent = false;
        let aborted = false;

        for await (const chunk of client.streamTurn(apiMessages, tools, {
          maxOutputTokens: outputAllowance(modelContextWindow(this.modelProvider, this.model)),
          // A retried request can go quiet for up to 160s, so the status line
          // says why instead of looking hung. The moment the user pauses or a
          // newer turn takes over, the backoff is dropped instead of waited out.
          onRetry: (notice) => {
            this.retryNotice =
              `Network hiccup — retrying in ${formatDelay(notice.delayMs)} ` +
              `(attempt ${notice.attempt}/${notice.attempts}): ${notice.reason}`;
            this.app.render();
          },
          cancelled: () => token !== this.turnToken || this.paused,
        })) {
          this.retryNotice = null;
          if (token !== this.turnToken || this.paused) {
            aborted = true;
            break;
          }
          content += chunk;
          hasContent = true;
          this.streamingContent = content;
          this.checkpoint.schedule();
          this.app.render();
          this.publishLive();
        }

        this.retryNotice = null;

        if (token !== this.turnToken) {
          // Pause already retained the partial reply. A stale stream must not
          // overwrite the buffer belonging to a newer turn.
          return false;
        }

        if (client.usage) {
          this.tokens.prompt += client.usage.prompt;
          this.tokens.completion += client.usage.completion;
          this.lastPromptTokens = client.usage.prompt;
        } else {
          this.tokens.completion += Math.max(1, Math.ceil(content.length / 4));
        }

        if (aborted || this.paused) {
          if (content) this.messages.push({ role: "assistant", content });
          this.streamingContent = null;
          this.app.render();
          return false;
        }

        if (currentTask()?.signal.aborted || client.outcome?.status === "cancelled") {
          this.taskOutcome = "cancelled";
          this.streamingContent = null;
          this.messages.push({ role: "assistant", content: `[Task stopped: ${String(currentTask()?.signal.reason ?? "Task cancelled")}]\n${currentTask()?.runtime.partialReport() ?? ""}` });
          return false;
        }
        if (client.outcome?.error?.code.endsWith("_budget") && currentTask()) {
          const report = await finalTaskReport(currentTask()!.runtime,
            () => new LLMClient(this.model, this.modelProvider, this.intensity),
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
          this.messages.push({ role: "assistant", content: content +
            (content.includes(message) ? "" : `\n[Error: ${message}]`) + (recorded ? `\n\n${recorded}` : "") });
          return false;
        }
        const toolCalls = client.toolCalls;
        if (toolCalls.length === 0) {
          if (!content.trim() && emptyReplies++ === 0) continue;
          if (!content.trim()) {
            this.taskOutcome = "failed";
            if (!content.trim()) this.messages.push({ role: "assistant", content: "[Error: model returned an empty completion.]" });
            else this.messages.push({ role: "assistant", content });
            return false;
          }
          if (hasContent) this.messages.push({ role: "assistant", content });
          this.streamingContent = null;
          break;
        }

        if (hasContent) this.messages.push({ role: "assistant", content });
        this.streamingContent = null;
        this.save();

        apiMessages.push({
          role: "assistant",
          content,
          // DeepSeek's thinking mode needs the reasoning behind a tool call
          // returned with it; without it the next request is a 400.
          reasoning_content: client.reasoningContent ?? "",
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const tc of toolCalls) {
          if (token !== this.turnToken || this.paused) return false;
          const args = parseArgs(tc.arguments);
          const toolMsg: ToolMsg = { role: "tool", name: tc.name, arguments: args, result: "" };
          this.messages.push(toolMsg);
          this.save();
          this.publishLive();
          this.app.render();

          // Risky calls stop here until a human (or the reviewer agent) clears
          // them. The loop awaits a promise that the UI resolves.
          const decision = await this.requestApproval(tc.name, args, {
            ...approvalContext,
            context: captureApprovalContext(apiMessages).context,
          });
          if (token !== this.turnToken || this.paused) return false;
          if (decision.source !== "prompt" && decision.source !== "input") {
            this.approvals.set(toolMsg, decision);
          }
          if (!decision.approved) {
            // A malformed request was never shown to anyone, so there is no
            // verdict to respect and the right move is a corrected retry.
            toolMsg.result =
              decision.source === "input"
                ? `[Not executed: ${decision.reason}]`
                : `[Not executed: approval denied (${decision.source}): ${decision.reason}] ` +
                  describeApprovalIntent(approvalContext) +
                  "Do not retry this call unchanged; ask the user how to proceed.";
            apiMessages.push({ role: "tool", tool_call_id: tc.id, content: toolMsg.result });
            this.save();
            this.publishLive();
            this.app.render();
            continue;
          }

          let result: string;
          try { result = await this.runTool(tc.name, args, toolMsg, token, apiMessages, approvalContext); }
          catch (error) {
            toolMsg.result = `[Not executed: ${describeError(error)}]`;
            this.save();
            throw error;
          }
          // A clear starts a different transcript while an old tool may finish.
          if (!this.messages.includes(toolMsg)) return false;
          toolMsg.result = result;
          this.save();
          if (token !== this.turnToken || this.paused) return false;
          apiMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
          this.publishLive();
          this.app.render();
        }
      }
      return true;
    } catch (e) {
      if (token !== this.turnToken) return false;
      if (e instanceof TaskControlError && e.code.endsWith("_budget") && currentTask()) {
        const report = await finalTaskReport(currentTask()!.runtime,
          () => new LLMClient(this.model, this.modelProvider, this.intensity),
          usage => { this.tokens.prompt += usage.prompt; this.tokens.completion += usage.completion; }, apiMessages);
        if (token !== this.turnToken || this.paused) return false;
        this.taskOutcome = "partial";
        this.streamingContent = null;
        this.messages.push({ role: "assistant", content: report });
        return false;
      }
      this.taskOutcome = "failed";
      const err = describeError(e);
      this.messages.push({ role: "assistant", content: (this.streamingContent ?? "") + `\n[Error: ${err}]` });
      this.streamingContent = null;
      return false;
    }
  }

  /**
   * Ends the turn. `finished` is false when the turn was cut short (ESC ESC,
   * Ctrl+C): a paused turn is not a completed one and stays open for reading.
   */
  private onTurnFinished(finished = true): void {
    if (finished && this.activeTurnStart !== null) this.finishedTurns.add(this.activeTurnStart);
    this.activeTurnStart = null;
    this.busy = false;
    this.paused = false;
    this.app.state.isThinking = false;
    this.save();
    this.app.render();
    this.maybeFlushQueue();
    this.publishLive();
    if (!this.busy && !this.liveKey) this.checkpoint.dispose();
    // After the queue flush: a queued prompt that took over immediately is not
    // the end of the user's work, and ringing then would be a false alarm.
    // Hosts are stubbed in tests, hence the optional call.
    if (!this.busy) this.app.bell?.("turn");
  }

  // ---- approval gate ---------------------------------------------------

  /** Classify a tool call and, when it is risky, run it past the gate. */
  private async requestApproval(
    tool: string,
    args: Record<string, unknown>,
    context = captureApprovalContext(this.messages),
    signal = currentTask()?.runtime.signal ?? this.turnAbort?.signal,
  ): Promise<ApprovalDecision> {
    const linked = linkSignals(signal, currentTask()?.signal);
    signal = linked.signal;
    try { currentTask()?.runtime.assertTool(tool, args); }
    catch (error) { linked.dispose(); return { approved: false, source: "input", reason: error instanceof Error ? error.message : String(error) }; }
    const risk = assessToolCall(tool, args, this.liveDir);
    if (!risk) { linked.dispose(); return { approved: true, source: "prompt", reason: "routine call" }; }
    const approvalToken = this.turnToken;
    const cancelled = () => approvalToken !== this.turnToken || this.paused || signal?.aborted === true;
    const gate = new ApprovalGate({
      cancelled,
      askHuman: () => cancelled() ? Promise.resolve(false) : this.askHuman(tool, args, risk),
      reviewer: () => this.reviewerModel(),
      autoApprovalEnabled: () => this.approvalMode === "auto",
      extremeAutoApprovalEnabled: () => loadConfig().auto_approve_extreme_risk === true,
      // Reviews happen before any card is shown, so without this the app looks
      // frozen while the independent assessments run.
      onReview: (info) => {
        if (cancelled()) return;
        this.reviewing = info ? {
          total: info.total, round: info.round ?? 1, rounds: info.rounds ?? 1,
          request: liveApprovalDetails(tool, args, risk, this.liveDir),
        } : null;
        this.publishLive();
        if (!info) {
          this.app.showToast("");
          return;
        }
        // Delete-class calls are reviewed from scratch three times; name the round
        // so a long wait does not look like a hang.
        const rounds = info.rounds ?? 1;
        const which = rounds > 1 ? `round ${info.round ?? 1} of ${rounds}, ` : "";
        this.app.showToast(
          `independent review running (${which}${info.total} reviewer${info.total > 1 ? "s" : ""})...`,
        );
      },
    });
    const abortApproval = () => {
      if (this.pendingApproval?.args === args) this.settleApproval(false);
    };
    signal.addEventListener("abort", abortApproval, { once: true });
    try {
      return await gate.decide({ tool, args, cwd: this.liveDir, ...context, risk });
    } finally {
      signal.removeEventListener("abort", abortApproval);
      linked.dispose();
    }
  }

  /** Park the turn until the user answers; the header turns orange meanwhile. */
  private askHuman(tool: string, args: Record<string, unknown>, risk: RiskAssessment): Promise<boolean | null> {
    return new Promise<boolean | null>((resolve) => {
      this.pendingApproval = { tool, args, risk, resolve };
      this.app.state.approval = { tool, level: risk.level };
      // The card floats over the same corner the approval card needs on a short
      // terminal, and a decision the user cannot see is not a decision. The plan
      // stays open one click away.
      this.showInfo = false;
      this.app.bell?.("approval");
      this.app.render();
      this.publishLive();
    });
  }

  /** Answer the pending request (keyboard, mouse, or the web UI). */
  private settleApproval(approved: boolean | null): void {
    const pending = this.pendingApproval;
    if (!pending) return;
    this.pendingApproval = null;
    this.app.state.approval = null;
    this.approvalButtons = null;
    pending.resolve(approved);
    this.app.render();
    this.publishLive();
  }

  /** Reviewer model: `approval_model` when set, otherwise the chat model. */
  private reviewerModel(): { model: ModelInfo; provider: string; intensity: string } {
    const name = String(loadConfig().approval_model ?? "").trim();
    const found = name ? findModel(name) : null;
    if (found) return { model: found.model, provider: found.provider, intensity: this.intensity };
    return { model: this.model, provider: this.modelProvider, intensity: this.intensity };
  }

  /** Orange card listing the pending call and its buttons. */
  private drawApprovalCard(buf: Buffer, logTop: number, inputY: number): void {
    const pending = this.pendingApproval;
    if (!pending) return;
    const boxW = Math.max(24, Math.min(buf.width - 2, 78));
    // A ten-row terminal has no room for the risk line as well, and losing the
    // buttons under the input would leave the call impossible to answer, so the
    // card drops the secondary line instead of overflowing.
    const compact = inputY - logTop + 1 < 6;
    const boxH = compact ? 5 : 6;
    const boxX = 1;
    const boxY = Math.max(logTop, inputY - boxH - 1);

    buf.fillRect(boxX, boxY, boxW, boxH, { bg: C.orangeBg });
    buf.drawBox(boxX, boxY, boxW, boxH, { fg: C.orange });
    // Same treatment as the header: the two read as a single alert.
    buf.fillRect(boxX + 1, boxY, boxW - 2, 1, { bg: C.orange });
    buf.writeText(boxX + 2, boxY, "Request Approval", { fg: C.black, bg: C.orange, bold: true });

    const tag = pending.risk.level === "extreme" ? "EXTREME RISK" : "HIGH RISK";
    const tagX = boxX + boxW - 2 - tag.length;
    if (tagX > boxX + 22) {
      buf.writeText(tagX, boxY, tag, { fg: C.black, bg: C.orange, bold: true });
    }

    const summary = sanitizeText(pending.risk.summary, { singleLine: true });
    buf.writeText(boxX + 2, boxY + 1, ellipsize(summary, boxW - 4), {
      fg: C.assistant,
      bg: C.orangeBg,
    });
    // Two different claims, kept apart on purpose: "Why" is what the agent says
    // the call is for, "Flag" is what the risk scan actually detected.
    const whyLabel = "Why: ";
    const why = sanitizeText(statedReason(pending.args) ?? "the agent gave no reason", {
      singleLine: true,
    });
    buf.writeText(boxX + 2, boxY + 2, whyLabel, { fg: C.orange, bg: C.orangeBg, bold: true });
    buf.writeText(
      boxX + 2 + whyLabel.length,
      boxY + 2,
      ellipsize(why, Math.max(0, boxW - 4 - whyLabel.length)),
      { fg: C.assistant, bg: C.orangeBg },
    );
    if (!compact) {
      const flagLabel = "Flag: ";
      const flag = sanitizeText(pending.risk.reasons[0] ?? "", { singleLine: true });
      buf.writeText(boxX + 2, boxY + 3, flagLabel, { fg: C.dim, bg: C.orangeBg, bold: true });
      buf.writeText(
        boxX + 2 + flagLabel.length,
        boxY + 3,
        ellipsize(flag, Math.max(0, boxW - 4 - flagLabel.length)),
        { fg: C.dim, bg: C.orangeBg },
      );
    }

    const approve = "[ Y ] Approve";
    const deny = "[ N ] Deny";
    const by = boxY + boxH - 2;
    const denyX = boxX + 2 + approve.length + 3;
    buf.writeText(boxX + 2, by, approve, { fg: C.black, bg: C.orange, bold: true });
    buf.writeText(denyX, by, deny, { fg: C.orange, bg: C.orangeBg, bold: true });
    this.approvalButtons = {
      approve: { x: boxX + 2, y: by, w: approve.length },
      deny: { x: denyX, y: by, w: deny.length },
    };
  }

  // ---- sub-agents ------------------------------------------------------

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
        this.app.render();
      },
      onStep: (index, status) => { if (!cancelled()) this.setStep(index, status); },
      call: async (name, callArgs, programSignal) => {
        if (cancelled() || programSignal?.aborted) throw new Error("Execution cancelled");
        const message: ToolMsg = { role: "tool", name, arguments: callArgs, result: "…" };
        this.messages.push(message);
        this.save(); this.publishLive();
        this.app.render();
        const stopApproval = () => {
          if (this.pendingApproval?.args !== callArgs) return;
          this.settleApproval(false);
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
          if (this.messages.includes(message)) { this.save(); this.publishLive(); this.app.render(); }
        }
      },
    });
    if (!cancelled()) { this.save(); this.publishLive(); this.app.render(); }
    return result;
  }

  /**
   * Run one approved tool call. `delegate` is handled here rather than inside
   * tools.ts: a sub-agent has to share this turn's model, approval gate, working
   * directory and abort signal, and only the session knows about those.
   */
  private async runTool(
    name: string, args: Record<string, unknown>, toolMsg: ToolMsg,
    token: number, apiMessages: ApiMessage[], approvalContext: ApprovalContext,
    executionSignal?: AbortSignal,
  ): Promise<string> {
    const runtime = currentTask()?.runtime;
    const execute = () => this.dispatchTool(name, args, toolMsg, token, apiMessages, approvalContext, executionSignal);
    if (!runtime) return execute();
    const result = await runtime.tool(name, args, execute);
    return result;
  }

  private async dispatchTool(
    name: string,
    args: Record<string, unknown>,
    toolMsg: ToolMsg,
    token: number,
    apiMessages: ApiMessage[],
    approvalContext: ApprovalContext,
    signal = currentTask()?.runtime.signal ?? this.turnAbort?.signal,
  ): Promise<string> {
    if (name === "execute_ts") return this.runProgram(args, token, apiMessages, approvalContext);
    if (name !== DELEGATE_TOOL) return executeTool(name, args, this.liveDir, signal);
    return this.delegate(args, toolMsg, token, apiMessages, approvalContext, signal);
  }

  /**
   * Run a sub-agent for one `delegate` call and return its report.
   *
   * The child gets its own conversation, the parent's tools (minus delegation)
   * and the parent's approval gate; what it does in between is deliberately not
   * part of this transcript. While it runs, its current phase is shown in the
   * status line and in the tool block, so a quiet log still has an explanation.
   */
  private async delegate(
    args: Record<string, unknown>,
    toolMsg: ToolMsg,
    token: number,
    apiMessages: ApiMessage[],
    approvalContext: ApprovalContext,
    executionSignal?: AbortSignal,
  ): Promise<string> {
    const task = String(args.task ?? "").trim();
    if (!task) return "[Error: delegate needs a task: what should the sub-agent do?]";
    const context = typeof args.context === "string" ? args.context.trim() : "";
    const approval = { ...approvalContext, context: captureApprovalContext(apiMessages).context };
    const maxRounds = subAgentRounds(loadConfig().subagent_max_rounds);
    const runtime = currentTask()?.runtime;
    const signal = executionSignal ?? runtime?.signal ?? this.turnAbort?.signal;
    const stopped = () => token !== this.turnToken || this.paused || signal?.aborted === true;
    const run = await runSubAgentTask({
      runtime, signal,
      readOnly: args.read_only === true,
      writePaths: Array.isArray(args.write_paths) ? args.write_paths.filter((p): p is string => typeof p === "string") : undefined,
      contextWindow: modelContextWindow(this.modelProvider, this.model, "standard"),
      createClient: () => new LLMClient(this.model, this.modelProvider, this.intensity),
      system: loadSubAgentPrompt(),
      task: buildSubAgentTask({ task, context, cwd: this.liveDir, rounds: maxRounds }),
      tools: SUB_AGENT_TOOLS,
      maxRounds,
      approve: (name, callArgs) => this.requestApproval(name, callArgs, approval, signal),
      execute: (name, callArgs) =>
        name === DELEGATE_TOOL
          ? Promise.resolve("[Error: sub-agents cannot delegate further]")
          : executeTool(name, callArgs, this.liveDir, signal),
      onProgress: (label) => {
        if (stopped()) return;
        this.subagent = label;
        // The tool block is what a reader of the transcript sees while the child
        // works; the status line says the same thing at the top of the screen.
        toolMsg.result = `… ${label}`;
        this.app.render();
        this.publishLive();
      },
      onUsage: (usage) => {
        if (stopped()) return;
        this.tokens.prompt += usage.prompt;
        this.tokens.completion += usage.completion;
      },
      onRetry: (notice) => {
        if (stopped()) return;
        this.retryNotice =
          `Sub-agent — network hiccup, retrying in ${formatDelay(notice.delayMs)} ` +
          `(attempt ${notice.attempt}/${notice.attempts})`;
        this.app.render();
      },
      cancelled: () => token !== this.turnToken || this.paused || signal?.aborted === true,
    });
    // The final report replaces the live marker, and the status line goes back
    // to the parent's own state.
    if (!stopped()) {
    this.subagent = null;
    this.retryNotice = null;
    toolMsg.result = "";
    this.app.render();
    this.publishLive();
    }
    return formatSubAgentResult(run);
  }

  // ---- turn folding ----------------------------------------------------

  /** First message index of every turn: a turn starts at a user message and
   *  ends where the next one begins. */
  private userMessageIndexes(): number[] {
    const starts: number[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === "user") starts.push(i);
    }
    return starts;
  }

  private turnEnd(start: number): number {
    for (let i = start + 1; i < this.messages.length; i++) {
      if (this.messages[i].role === "user") return i;
    }
    return this.messages.length;
  }

  /**
   * A finished turn is only worth folding when the work it hides is substantial.
   * Whether it is folded right now is a separate question (`expandedTurns`), and
   * its user input and reply are never part of what it hides.
   */
  private turnHides(start: number, end: number): boolean {
    if (!this.finishedTurns.has(start)) return false;
    const answer = this.turnAnswer(start, end);
    let blocks = 0;
    let chars = 0;
    for (let i = start; i < end; i++) {
      // User input and the reply stay on screen, so neither counts toward the
      // folding threshold, however long either one is.
      if (i === answer) continue;
      const m = this.messages[i];
      if (m.role === "assistant") {
        blocks++;
        chars += m.content.length;
      }
    }
    return blocks >= TURN_FOLD_MIN_BLOCKS || chars >= TURN_FOLD_MIN_CHARS;
  }

  /**
   * The index of the turn's reply: its last assistant message. A fold hides the
   * work that led to the answer, so this message is always rendered.
   */
  private turnAnswer(start: number, end: number): number {
    for (let i = end - 1; i > start; i--) {
      if (this.messages[i].role === "assistant") return i;
    }
    return -1;
  }

  /** For every message, the reply of the turn it belongs to (-1 = none). */
  private turnAnswers(): number[] {
    const answers = new Array<number>(this.messages.length).fill(-1);
    let start = -1;
    let answer = -1;
    const close = (end: number): void => {
      if (start < 0 || answer < 0) return;
      for (let i = start; i < end; i++) answers[i] = answer;
    };
    for (let i = 0; i < this.messages.length; i++) {
      const role = this.messages[i].role;
      if (role === "user") {
        close(i);
        start = i;
        answer = -1;
      } else if (role === "assistant") {
        answer = i;
      }
    }
    close(this.messages.length);
    return answers;
  }

  /** For every message, the first index of the turn folding it (-1 = none). */
  private turnMap(): number[] {
    const map = new Array<number>(this.messages.length).fill(-1);
    for (const start of this.userMessageIndexes()) {
      const end = this.turnEnd(start);
      if (!this.turnHides(start, end)) continue;
      for (let i = start; i < end; i++) map[i] = start;
    }
    return map;
  }

  /** The header standing in for a folded turn, or the way back into one. */
  private pushTurnHeader(
    start: number,
    end: number,
    width: number,
    add: (line: Line, tool?: number, turn?: number) => void,
  ): void {
    const count = end - start;
    if (this.expandedTurns.has(start)) {
      // Open: the messages below say everything, so the line is only the way
      // back. Reserve the room the hint needs so a narrow terminal keeps it.
      const hint = " — click to collapse";
      const label = `▾ ${count} message${count === 1 ? "" : "s"}`;
      add(
        {
          spans: [
            { text: ellipsize(label, Math.max(10, width - displayWidth(hint))), style: { fg: C.dim, bold: true } },
            { text: hint, style: { fg: C.dim } },
          ],
        },
        -1,
        start,
      );
      return;
    }
    const answer = this.turnAnswer(start, end);
    const hidden = this.messages.slice(start, end).filter((message, offset) =>
      message.role !== "user" && message.role !== "system" && start + offset !== answer,
    ).length;
    const meta = `${hidden} of ${count} message${count === 1 ? "" : "s"} folded`;
    add({ spans: [{ text: ellipsize(`▸ ${meta} — click to expand`, width), style: { fg: C.dim } }] }, -1, start);
  }

  /** Fold or unfold one turn. */
  private toggleTurn(start: number): void {
    if (this.expandedTurns.has(start)) this.expandedTurns.delete(start);
    else this.expandedTurns.add(start);
    // Expanding pushes the rest of the log down, so do not snap to the bottom.
    this.followBottom = false;
    this.app.render();
  }

  /** Expand/collapse the tool block belonging to message `index`. */
  private toggleTool(index: number): void {
    if (this.expandedTools.has(index)) this.expandedTools.delete(index);
    else this.expandedTools.add(index);
    this.app.render();
  }

  /** Compress at 80% of the current model's context capacity. */
  private compressThreshold(): number {
    return contextCompressionThreshold(this.modelProvider, this.model);
  }

  /**
   * Summarise only the model's history. Original messages stay in the transcript
   * and on disk; the UI folds the summarised prefix until the reader expands it.
   */
  private async autoCompress(token: number): Promise<void> {
    const threshold = this.compressThreshold();
    if (threshold <= 0 || this.lastPromptTokens < threshold) return;

    const rest = this.messages.filter((m) => m.role !== "system");
    const items = modelHistory(this.messages, this.context).map((m) => ({
      role: m.role,
      content: m.role === "tool" ? m.result : (m as { content?: string }).content ?? "",
      name: m.role === "tool" ? m.name : undefined,
    }));
    const plan = planCompaction(items, COMPACT_KEEP);
    if (!plan) return;
    const end = rest.length - plan.tail.length;
    if (end <= (this.context?.end ?? 0)) return;

    const transcript = transcriptFor(plan.head, COMPACT_MAX_CHARS_PER_MESSAGE);
    this.compressing = true;
    this.publishLive();
    this.app.render();

    const snapshotLen = this.messages.length;
    let summary = "";
    try {
      summary = await this.summarizeTranscript(transcript, () => token !== this.turnToken);
    } catch {
      summary = "";
    }

    this.compressing = false;
    this.publishLive();
    if (token !== this.turnToken) return;
    // Keep the summary boundary tied to this snapshot if a user queued another
    // message while summarising; retry against the new snapshot next turn.
    if (this.messages.length !== snapshotLen) {
      this.app.render();
      return;
    }

    const content = summary
      ? `[Context summary]\n${summary}`
      : "Earlier messages are preserved in history, but could not be summarized for this request.";
    this.context = { end, summary: content };
    this.expandedContext = false;
    // The context is small again; its real size is re-learned from the next reply.
    this.lastPromptTokens = 0;
    this.save();
  }

  /**
   * Summarise a transcript produced by `transcriptFor`. Split out so tests can
   * stub it without touching the network.
   */
  protected async summarizeTranscript(transcript: string, cancelled?: () => boolean): Promise<string> {
    const client = new LLMClient(this.model, this.modelProvider, this.intensity);
    // Compression runs before the turn proper: a pause or a newer message must
    // be able to abandon it instead of waiting out the retry backoff.
    const text = await client.summarize(transcript, { cancelled });
    if (client.usage) {
      this.tokens.prompt += client.usage.prompt;
      this.tokens.completion += client.usage.completion;
    }
    return text;
  }

  /**
   * Keep the outbound payload within budget during a long single turn: once the
   * context is over the threshold, blank out all but the most recent tool
   * results. Their full text stays in the visible log, which is collapsible.
   */
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
    const chatMessages: SessionMessage[] = [];
    for (const m of this.messages) {
      if (m.role === "user" || m.role === "assistant" || m.role === "tool") {
        chatMessages.push(m);
      } else if (m.role === "summary") {
        // Persist a compressed summary as a plain assistant message.
        chatMessages.push({ role: "assistant", content: m.content });
      }
    }
    // Snapshot the partial reply without adding it to the in-memory transcript:
    // the final reply will replace this snapshot, rather than duplicate it.
    if (this.streamingContent) {
      chatMessages.push({ role: "assistant", content: this.streamingContent });
    }
    if (chatMessages.length === 0) return true;
    try {
      this.sessionId = saveSession(
        chatMessages,
        this.model.name,
        this.modelProvider,
        this.intensity,
        this.liveDir,
        this.sessionId ?? undefined,
        this.tokens,
        this.context,
        this.approvalMode,
        this.plan,
        "standard",
        undefined,
        this.agentMode,
        this.taskRuntime?.snapshot() ?? this.lastTask,
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

  private buildLines(width: number): Line[] {
    const lines: Line[] = [];
    // Parallel map from rendered line -> owning tool message index (-1 = none),
    // used to turn a click on any line of a tool block into an expand/collapse.
    const toolLineIndex: number[] = [];
    // Same idea for a folded turn. Only its header lines point at the turn, so
    // the messages of an expanded turn keep their own click targets.
    const turnLineIndex: number[] = [];
    const add = (line: Line, tool = -1, turn = -1): void => {
      lines.push(line);
      toolLineIndex.push(tool);
      turnLineIndex.push(turn);
    };
    const pushText = (text: string, style: Style, tool = -1): void => {
      for (const ln of wrapText(text, width)) add({ spans: [{ text: ln, style }] }, tool);
    };
    const pushMarkdown = (text: string, style: Style): void => {
      for (const ln of renderMarkdownText(text, width, style)) add(ln);
    };

    const context = normalizeContext(this.context, this.messages.filter((m) => m.role !== "system").length);
    // Which turn owns each message: [] -> first index of that turn, -1 = none.
    const turns = this.turnMap();
    // Per message, the reply of its turn: a folded turn always renders that one.
    const answers = this.turnAnswers();
    this.contextLines.clear();
    let recordIndex = 0;
    for (let mi = 0; mi < this.messages.length; mi++) {
      const m = this.messages[mi];
      const turn = m.role === "system" ? -1 : turns[mi];
      let archived = false;
      if (m.role !== "system") {
        if (recordIndex === 0 && context) {
          this.contextLines.add(lines.length);
          add({ spans: [{ text: `${this.expandedContext ? "▾" : "▸"} Earlier conversation (${context.end} messages) — click to ${this.expandedContext ? "collapse" : "expand"}`, style: { fg: C.amber, bold: true } }] });
        }
        archived = context !== null && recordIndex < context.end;
        recordIndex++;
      }
      const folded = turn >= 0 && !this.expandedTurns.has(turn);
      const reply = folded && answers[mi] === mi;
      if (m.role === "system") {
        pushText(sanitizeText(m.content), { fg: C.dim });
      } else if (m.role === "user") {
        add({ spans: [{ text: "You:", style: { fg: C.accent, bold: true } }] });
        pushMarkdown(sanitizeText(m.content), { fg: C.user });
        add({ spans: [] });
        // The fold control follows the complete prompt, which stays visible
        // even when the turn or the earlier conversation is collapsed.
        if (turn === mi && !(archived && !this.expandedContext)) {
          this.pushTurnHeader(mi, this.turnEnd(mi), width, add);
        }
      } else if ((archived && !this.expandedContext) || (folded && !reply)) {
        // Only AI output is hidden. Every message remains in the transcript,
        // on disk and in the request; the controls reveal it again.
      } else if (m.role === "assistant") {
        add({ spans: [{ text: "Neutrino:", style: { fg: C.accent, bold: true } }] });
        pushMarkdown(sanitizeText(m.content), { fg: C.assistant });
        add({ spans: [] });
      } else if (m.role === "summary") {
        add({
          spans: [
            {
              text: `✂ Context compressed (${m.count} earlier messages)`,
              style: { fg: C.amber, bold: true },
            },
          ],
        });
        pushText(sanitizeText(m.content), { fg: C.dim });
        add({ spans: [] });
      } else if (m.role === "tool") {
        // Header + the command/path always show; the (often huge) output body is
        // collapsed by default and toggled by clicking the block.
        add({ spans: [{ text: `⚙ ${m.name}`, style: { fg: C.toolHeader, bold: true } }] }, mi);
        // The line under the tool name is the call's own material: a command, a
        // path, or — for `delegate` — the task handed to the sub-agent.
        const argText = sanitizeText(
          (m.arguments.command as string) ?? (m.arguments.path as string) ?? (m.arguments.query as string) ?? (m.arguments.task as string) ?? "",
          { singleLine: true },
        );
        if (argText) add({ spans: [{ text: "  " + argText, style: { fg: C.dim } }] }, mi);

        const decision = this.approvals.get(m);
        if (decision) {
          const verdict = decision.approved ? "approved" : "denied";
          add(
            {
              spans: [
                {
                  text: `  ${decision.approved ? "✓" : "✗"} ${verdict} by ${decision.source} — ${ellipsize(
                    sanitizeText(decision.reason, { singleLine: true }),
                    Math.max(12, width - 12),
                  )}`,
                  style: { fg: decision.approved ? C.green : C.orange },
                },
              ],
            },
            mi,
          );
        }
        // Command output routinely carries ANSI colours and tabs; clean it once
        // so the collapsed line count and the expanded body agree.
        const body = sanitizeText(m.result || "");
        if (this.expandedTools.has(mi)) {
          pushText(body || "(no output)", { fg: C.dim }, mi);
          add({ spans: [{ text: "  ▾ click to collapse", style: { fg: C.toolHeader } }] }, mi);
        } else {
          const n = body ? body.split("\n").length : 0;
          const summary = n > 0 ? `${n} line${n === 1 ? "" : "s"} hidden` : "no output";
          add({ spans: [{ text: `  ▸ ${summary} — click to expand`, style: { fg: C.dim } }] }, mi);
        }
        add({ spans: [] });
      }
      if (context && archived && recordIndex === context.end && this.expandedContext) {
        this.contextLines.add(lines.length);
        add({ spans: [{ text: "▾ Collapse earlier conversation", style: { fg: C.amber } }] });
        add({ spans: [] });
      }
    }
    if (this.streamingContent !== null) {
      add({ spans: [{ text: "Neutrino:", style: { fg: C.accent, bold: true } }] });
      pushMarkdown(sanitizeText(this.streamingContent), { fg: C.assistant });
    }
    this.toolLineIndex = toolLineIndex;
    this.turnLineIndex = turnLineIndex;
    return lines;
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    let status = "";
    let statusStyle: Style = { fg: C.dim };
    if (this.saveError) {
      status = `History save failed: ${sanitizeText(this.saveError, { singleLine: true })}`;
      statusStyle = { fg: C.orange, bold: true };
    } else if (this.taskRuntime?.snapshot().state === "cancelling") {
      status = "Stopping tasks…";
      statusStyle = { fg: C.amber, bold: true };
    } else if (this.compressing) {
      status = "Compressing context…";
      statusStyle = { fg: C.amber, bold: true };
    } else if (this.planning) {
      status = "Planning the steps…";
      statusStyle = { fg: C.accent, bold: true };
    } else if (this.queued) {
      status = "Will send when paused or idle...";
      statusStyle = { fg: C.amber };
    } else if (this.paused) {
      status = "PAUSED — press ESC ESC to resume";
      statusStyle = { fg: C.amber, bold: true };
    } else if (this.retryNotice) {
      status = this.retryNotice;
      statusStyle = { fg: C.amber, bold: true };
    } else if (this.subagent) {
      status = `Sub-agent — ${this.subagent}`;
      statusStyle = { fg: C.green, bold: true };
    } else if (this.busy) {
      status = "Streaming... press Ctrl+C or ESC ESC to pause";
      statusStyle = { fg: C.dim };
    }
    if (status && this.approvalToggleY(h) !== 1) buf.centerText(1, status.slice(0, w), statusStyle);

    const inputY = h - 4;
    const logTop = 2;
    const logBottom = inputY - 2;
    const viewH = Math.max(1, logBottom - logTop + 1);

    const lines = this.buildLines(Math.max(10, w - 4));
    const maxScroll = Math.max(0, lines.length - viewH);
    if (this.followBottom) this.scrollTop = maxScroll;
    if (this.scrollTop > maxScroll) {
      this.scrollTop = maxScroll;
      this.followBottom = true;
    }
    if (this.scrollTop < 0) this.scrollTop = 0;

    // Remember the bar's geometry so a drag on the last column can scroll the
    // log (see the scrollbar() method).
    this.scrollbarGeom =
      lines.length > viewH
        ? { x: w - 1, top: logTop, bottom: logBottom, total: lines.length, viewport: viewH }
        : null;

    // Remember which tool block (if any) each visible row belongs to, so a
    // click can expand/collapse it (see the onMouse handler).
    this.toolRows.clear();
    this.contextRows.clear();
    this.turnRows.clear();
    for (let y = logTop; y <= logBottom; y++) {
      const li = this.scrollTop + (y - logTop);
      if (li >= lines.length) break;
      const tool = this.toolLineIndex[li];
      if (tool !== undefined && tool >= 0) this.toolRows.set(y, tool);
      const turn = this.turnLineIndex[li];
      if (turn !== undefined && turn >= 0) this.turnRows.set(y, turn);
      if (this.contextLines.has(li)) this.contextRows.add(y);
      drawSpans(buf, 2, y, lines[li].spans, Math.max(4, w - 4));
    }

    // A scrollbar on the right edge of the log, shown only when the
    // conversation overflows the visible area.
    drawScrollbar(buf, w - 1, logTop, logBottom, lines.length, viewH, this.scrollTop);

    if (this.pendingApproval) this.drawApprovalCard(buf, logTop, inputY);
    else this.approvalButtons = null;

    const inW = Math.max(12, w - 2);
    drawApprovalToggle(buf, this.approvalToggleY(h), this.approvalMode);
    drawInputBox(buf, 1, inputY, inW, this.inputValue, this.cursor, {
      active: true,
      dimmed: this.busy,
      cursorOn: this.app.state.cursorOn,
      placeholder: "Type a message...",
    });

    const hintY = h - 1;
    const hints = "Enter send · Ctrl+P plan · Ctrl+C pause · ESC ESC pause · Ctrl+A approval · Ctrl+B menu · Ctrl+L clear · drag to copy";
    const hintW = displayWidth(hints);
    const hintX = Math.max(0, w - 1 - hintW);
    const pathAvail = Math.max(0, hintX - 2);
    buf.writeText(1, hintY, ellipsize(process.cwd(), pathAvail), { fg: C.dim });
    buf.writeText(hintX, hintY, hints, { fg: C.dim });

    this.renderInfoOverlay(buf);
  }

  private renderInfoOverlay(buf: Buffer): void {
    const w = buf.width;
    const h = buf.height;
    // A plan in flight tints the corner marker, so the card stays findable once
    // the user has closed it.
    const running = this.plan?.steps.some((step) => step.status === "active") ?? false;
    buf.set(w - 2, 0, "ⓘ", running
      ? { fg: C.black, bg: C.accent, bold: true }
      : { fg: C.accent, bg: C.highlightBg, bold: true });
    if (!this.showInfo) return;

    // The card floats in the top-right corner of the log. It is never wider than
    // the conversation and never taller than the space above the input box, so a
    // long step title or a short terminal cannot push it over the composer.
    const contentW = Math.max(18, Math.min(56, w - 6));
    const maxRows = Math.max(1, h - 8);
    const rows = this.infoCardRows(contentW, maxRows);
    const boxW = Math.min(Math.max(6, w - 2), Math.max(14, planRowsWidth(rows) + 4));
    const boxH = Math.min(rows.length + 2, Math.max(3, h - 6));
    const boxX = Math.max(0, w - 1 - boxW);
    const boxY = 1;

    buf.fillRect(boxX, boxY, boxW, boxH, { bg: C.black });
    buf.drawBox(boxX, boxY, boxW, boxH, { fg: C.accent });
    for (let i = 0; i < rows.length; i++) {
      const y = boxY + 1 + i;
      if (y >= boxY + boxH - 1) break;
      if (rows[i].kind === "step-active") {
        // The running step is a full-width bar rather than coloured text: it is
        // the one row the reader should find without reading the list.
        buf.fillRect(boxX + 1, y, boxW - 2, 1, { bg: C.highlightBg });
      }
      buf.writeText(boxX + 2, y, ellipsize(rows[i].text, Math.max(1, boxW - 4)), planRowStyle(rows[i].kind));
    }
  }

  /**
   * What the card shows: the plan as a vertical timeline, then the token counts.
   * Without a plan it is exactly the token card it has always been. One row is
   * kept for the counts, so a long plan cannot push them out of the card.
   */
  private infoCardRows(width: number, maxRows: number): PlanRow[] {
    const plan = this.plan;
    if (!plan) {
      const total = this.tokens.prompt + this.tokens.completion;
      return [
        { kind: "header", text: "Tokens" },
        { kind: "line", text: `Prompt: ${this.tokens.prompt}` },
        { kind: "line", text: `Completion: ${this.tokens.completion}` },
        { kind: "line", text: `Total: ${total}` },
      ];
    }
    const rows = planCardRows(plan, { width, maxRows: Math.max(1, maxRows - 1) });
    rows.push({ kind: "line", text: `Tokens ${this.tokens.prompt} → ${this.tokens.completion}` });
    return rows;
  }
}
