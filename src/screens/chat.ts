import type { Buffer } from "../terminal/buffer.js";
import { Screen, type ScrollbarHandle } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C, type Style } from "../colors.js";
import {
  findModel,
  contextCompressionThreshold,
  loadConfig,
  normalizeApprovalMode,
  loadPrompt,
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
import { LLMClient, describeError } from "../llm/client.js";
import { executeTool, getToolDefinitions } from "../llm/tools.js";
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

/**
 * A finished turn only folds into a one-line summary when hiding it saves real
 * space: four or more visible blocks, or roughly six wrapped lines of text.
 * Short exchanges stay readable without a click. `web/turns.js` applies the
 * same rule in the browser, so both UIs fold exactly the same turns.
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
  private approvalMode: ApprovalMode = "request";

  modelProvider = "DeepSeek";
  model: ModelInfo = { name: "deepseek-chat", url: "https://api.deepseek.com/v1", api_key: "", supports_streaming: true };
  intensity = "High";

  private tokens: TokenUsage = { prompt: 0, completion: 0 };
  private showInfo = false;

  private messages: Msg[] = [];
  private streamingContent: string | null = null;
  private saveError: string | null = null;
  private checkpoint = new SessionCheckpoint(() => {
    const saved = this.writeSession();
    this.publishLive();
    return saved;
  });
  private busy = false;
  private paused = false;
  private queued: string | null = null;
  private turnToken = 0;
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
    this.approvalMode = normalizeApprovalMode(this.loadedApprovalMode ?? loadConfig().approval_mode);
    const st = this.app.state;
    this.modelProvider = this.loadedProvider ?? st.selectedProvider;
    this.model = {
      name: this.loadedModel ?? st.selectedModelName,
      url: st.selectedModelUrl,
      api_key: st.selectedModelApiKey,
      supports_streaming: st.selectedModelStreaming,
    };
    this.intensity = this.loadedIntensity ?? st.selectedIntensity;
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
    this.intensity = selection.intensity;
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
      busy: this.busy,
      paused: this.paused,
      queued: this.queued,
      compressing: this.compressing,
      saveError: this.saveError,
      tokens: { prompt: this.tokens.prompt, completion: this.tokens.completion },
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
    };
  }

  livePause(): void {
    if (this.paused || (!this.busy && !this.queued)) return;
    this.paused = true;
    this.turnToken++;
    // A queued decision would otherwise keep the agent awaiting forever.
    if (this.pendingApproval) this.settleApproval(false);
    this.busy = false;
    this.app.state.isThinking = false;
    this.retainStreamingContent();
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

  liveSetApprovalMode(mode: ApprovalMode): void {
    if (this.approvalMode === mode) return;
    this.approvalMode = mode;
    if (this.pendingApproval) this.settleApproval(null);
    this.save();
    this.app.render();
    this.publishLive();
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
      // Clearing starts a fresh conversation; do not overwrite the old history.
      this.save();
      if (this.saveError) {
        this.app.render();
        return;
      }
      this.turnToken++;
      this.busy = false;
      this.paused = false;
      this.queued = null;
      this.compressing = false;
      this.app.state.isThinking = false;
      this.lastPromptTokens = 0;
      this.sessionId = null;
      this.context = null;
      this.expandedContext = false;
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
      this.turnToken++;
      this.busy = false;
      this.app.state.isThinking = false;
      this.retainStreamingContent();
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
    const token = ++this.turnToken;
    this.streamingContent = "";
    this.app.render();
    this.publishLive();
    void (async () => {
      // Shrink the history before building the request when it has outgrown the
      // configured budget.
      await this.autoCompress(token);
      if (token !== this.turnToken) return;
      const apiMessages = this.buildApiMessages(turnMessages);
      await this.agentLoop(apiMessages, token, approvalContext);
    })().catch((err) => {
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

  private buildApiMessages(messages = this.messages): ApiMessage[] {
    const api: ApiMessage[] = [{ role: "system", content: loadPrompt() }];
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

  private async agentLoop(apiMessages: ApiMessage[], token: number, approvalContext: ApprovalContext): Promise<void> {
    try {
      while (true) {
        if (token !== this.turnToken) return;
        // Keep the payload inside budget during a long single turn: once the
        // context is too large, drop the body of older tool results.
        apiMessages = this.trimApiMessages(apiMessages);
        const client = new LLMClient(this.model, this.modelProvider, this.intensity);
        let content = "";
        let hasContent = false;
        let aborted = false;

        for await (const chunk of client.streamTurn(apiMessages, TOOLS)) {
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

        if (token !== this.turnToken) {
          // Pause already retained the partial reply. A stale stream must not
          // overwrite the buffer belonging to a newer turn.
          return;
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
          this.onTurnFinished(false);
          return;
        }

        const toolCalls = client.toolCalls;
        if (toolCalls.length === 0) {
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
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });

        for (const tc of toolCalls) {
          if (token !== this.turnToken || this.paused) return;
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
          if (token !== this.turnToken || this.paused) return;
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

          const result = await executeTool(tc.name, args, this.liveDir);
          // A clear starts a different transcript while an old tool may finish.
          if (!this.messages.includes(toolMsg)) return;
          toolMsg.result = result;
          this.save();
          if (token !== this.turnToken || this.paused) return;
          apiMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
          this.publishLive();
          this.app.render();
        }
      }
      this.onTurnFinished();
    } catch (e) {
      if (token !== this.turnToken) return;
      const err = describeError(e);
      this.messages.push({ role: "assistant", content: (this.streamingContent ?? "") + `\n[Error: ${err}]` });
      this.streamingContent = null;
      this.onTurnFinished();
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
  ): Promise<ApprovalDecision> {
    const risk = assessToolCall(tool, args, this.liveDir);
    if (!risk) return { approved: true, source: "prompt", reason: "routine call" };
    const gate = new ApprovalGate({
      askHuman: () => this.askHuman(tool, args, risk),
      reviewer: () => this.reviewerModel(),
      autoApprovalEnabled: () => this.approvalMode === "auto",
      extremeAutoApprovalEnabled: () => loadConfig().auto_approve_extreme_risk === true,
      // Reviews happen before any card is shown, so without this the app looks
      // frozen while the independent assessments run.
      onReview: (info) => {
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
    return gate.decide({ tool, args, cwd: this.liveDir, ...context, risk });
  }

  /** Park the turn until the user answers; the header turns orange meanwhile. */
  private askHuman(tool: string, args: Record<string, unknown>, risk: RiskAssessment): Promise<boolean | null> {
    return new Promise<boolean | null>((resolve) => {
      this.pendingApproval = { tool, args, risk, resolve };
      this.app.state.approval = { tool, level: risk.level };
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
   * A finished turn is only worth folding when it hides something substantial.
   * Whether it is folded right now is a separate question (`expandedTurns`).
   */
  private turnHides(start: number, end: number): boolean {
    if (!this.finishedTurns.has(start)) return false;
    let blocks = 0;
    let chars = 0;
    for (let i = start; i < end; i++) {
      const m = this.messages[i];
      if (m.role === "user" || m.role === "assistant") {
        blocks++;
        chars += m.content.length;
      }
    }
    return blocks >= TURN_FOLD_MIN_BLOCKS || chars >= TURN_FOLD_MIN_CHARS;
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

  /**
   * The first line of the first message in `role` (the last one with `last`).
   * Only one line: the preview is a signpost, and the full text is a click away.
   */
  private turnPreview(start: number, end: number, role: "user" | "assistant", last = false): string {
    const slice = this.messages.slice(start, end);
    for (const m of last ? slice.reverse() : slice) {
      if (m.role !== role) continue;
      const line = sanitizeText(m.content)
        .split("\n")
        .map((part) => part.trim())
        .find((part) => part.length > 0);
      if (line) return line;
    }
    return "";
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
    const you = `You: ${this.turnPreview(start, end, "user") || "(no text)"}`;
    add({ spans: [{ text: ellipsize(`▸ ${you}`, width), style: { fg: C.amber, bold: true } }] }, -1, start);
    const reply = this.turnPreview(start, end, "assistant", true);
    const meta = `${count} message${count === 1 ? "" : "s"} folded`;
    add(
      {
        spans: [
          {
            text: ellipsize(`  ${meta}${reply ? ` · Neutrino: ${reply}` : ""} — click to expand`, width),
            style: { fg: C.dim },
          },
        ],
      },
      -1,
      start,
    );
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
      summary = await this.summarizeTranscript(transcript);
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
  protected async summarizeTranscript(transcript: string): Promise<string> {
    const client = new LLMClient(this.model, this.modelProvider, this.intensity);
    const text = await client.summarize(transcript);
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
      // A foldable turn always shows its control line first; its messages then
      // render normally when the reader has opened it.
      if (m.role !== "system" && turn === mi && !(archived && !this.expandedContext)) {
        this.pushTurnHeader(mi, this.turnEnd(mi), width, add);
      }
      if (m.role === "system") {
        pushText(sanitizeText(m.content), { fg: C.dim });
      } else if ((archived && !this.expandedContext) || (turn >= 0 && !this.expandedTurns.has(turn))) {
        // Hidden, by the collapsed "Earlier conversation" fold or by the turn's
        // own fold. Either way the message stays in the transcript, on disk and
        // in the request; the header above says how to get it back on screen.
      } else if (m.role === "user") {
        add({ spans: [{ text: "You:", style: { fg: C.accent, bold: true } }] });
        pushMarkdown(sanitizeText(m.content), { fg: C.user });
        add({ spans: [] });
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
        const argText = sanitizeText(
          (m.arguments.command as string) ?? (m.arguments.path as string) ?? "",
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
      if (context && archived && recordIndex === context.end) {
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
    } else if (this.compressing) {
      status = "Compressing context…";
      statusStyle = { fg: C.amber, bold: true };
    } else if (this.queued) {
      status = "Will send when paused or idle...";
      statusStyle = { fg: C.amber };
    } else if (this.paused) {
      status = "PAUSED — press ESC ESC to resume";
      statusStyle = { fg: C.amber, bold: true };
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
    const hints = "Enter send · Ctrl+C pause · ESC ESC pause · Ctrl+A approval · Ctrl+B menu · Ctrl+L clear · drag to copy";
    const hintW = displayWidth(hints);
    const hintX = Math.max(0, w - 1 - hintW);
    const pathAvail = Math.max(0, hintX - 2);
    buf.writeText(1, hintY, ellipsize(process.cwd(), pathAvail), { fg: C.dim });
    buf.writeText(hintX, hintY, hints, { fg: C.dim });

    this.renderInfoOverlay(buf);
  }

  private renderInfoOverlay(buf: Buffer): void {
    const w = buf.width;
    buf.set(w - 2, 0, "ⓘ", { fg: C.accent, bg: C.highlightBg, bold: true });
    if (!this.showInfo) return;

    const total = this.tokens.prompt + this.tokens.completion;
    const lines = [
      "Tokens",
      `Prompt: ${this.tokens.prompt}`,
      `Completion: ${this.tokens.completion}`,
      `Total: ${total}`,
    ];
    let contentW = 8;
    for (const l of lines) contentW = Math.max(contentW, displayWidth(l));
    let boxW = contentW + 4;
    if (boxW > w - 2) boxW = Math.max(6, w - 2);
    const boxX = w - 1 - boxW;
    const boxY = 1;
    const boxH = lines.length + 2;

    buf.fillRect(boxX, boxY, boxW, boxH, { bg: C.black });
    buf.drawBox(boxX, boxY, boxW, boxH, { fg: C.accent });
    for (let i = 0; i < lines.length; i++) {
      const style = i === 0 ? { fg: C.accent, bg: C.black, bold: true } : { fg: C.assistant, bg: C.black };
      buf.writeText(boxX + 2, boxY + 1 + i, lines[i].slice(0, boxW - 4), style);
    }
  }
}
