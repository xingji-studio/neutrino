import type { Buffer } from "../terminal/buffer.js";
import { Screen, type ScrollbarHandle } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C, type Style } from "../colors.js";
import {
  loadConfig,
  loadPrompt,
  saveSession,
  type ModelInfo,
  type SessionMessage,
  type TokenUsage,
} from "../config.js";
import { drawHeader } from "../header.js";
import { computeInputWindow, cursorFromColumn, drawInputBox, drawScrollbar, wrapText } from "../ui.js";
import { drawSpans, renderMarkdownText, type Line, type Span } from "../markdown.js";
import { ellipsize, displayWidth } from "../width.js";
import { sanitizeText } from "../sanitize.js";
import { LLMClient, describeError } from "../llm/client.js";
import { executeTool, getToolDefinitions } from "../llm/tools.js";
import {
  COMPACT_KEEP,
  COMPACT_MAX_CHARS_PER_MESSAGE,
  planCompaction,
  transcriptFor,
} from "../compact.js";

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

function parseArgs(s: string): Record<string, unknown> {
  if (!s || !s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class ChatScreen extends Screen {
  initialMessage: string;
  loadedMessages: SessionMessage[] | null = null;
  sessionId: string | null = null;
  loadedProvider: string | null = null;
  loadedModel: string | null = null;
  loadedIntensity: string | null = null;
  loadedTokens: TokenUsage | null = null;

  modelProvider = "DeepSeek";
  model: ModelInfo = { name: "deepseek-chat", url: "https://api.deepseek.com/v1", api_key: "", supports_streaming: true };
  intensity = "High";

  private tokens: TokenUsage = { prompt: 0, completion: 0 };
  private showInfo = false;

  private messages: Msg[] = [];
  private streamingContent: string | null = null;
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

  // ---- collapsible tool output ----
  /** Message indices whose tool output is expanded (everything starts
   *  collapsed). */
  private expandedTools = new Set<number>();
  /** For each line produced by buildLines, the tool message index it belongs
   *  to, or -1 when it is not part of a tool block. */
  private toolLineIndex: number[] = [];
  /** Terminal row -> tool message index, rebuilt each render for hit-testing. */
  private toolRows = new Map<number, number>();

  constructor(initialMessage = "") {
    super();
    this.initialMessage = initialMessage;
  }

  onActivate(): void {
    if (this.initialized) return;
    this.initialized = true;
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
    if (this.initialMessage) {
      this.send(this.initialMessage);
    } else {
      this.app.render();
    }
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
      const sysText = this.messages[0] && this.messages[0].role === "system" ? this.messages[0].content : "";
      this.messages = [{ role: "system", content: sysText }];
      this.expandedTools.clear();
      this.streamingContent = null;
      this.scrollTop = 0;
      this.followBottom = true;
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
      this.save();
    }
    this.app.render();
    this.maybeFlushQueue();
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
    this.inputValue = "";
    this.cursor = 0;
    this.followBottom = true;

    if (this.busy && !this.paused) {
      this.queued = trimmed;
      this.app.render();
      return;
    }

    this.startTurn();
  }

  private startTurn(): void {
    this.busy = true;
    this.paused = false;
    this.app.state.isThinking = true;
    const token = ++this.turnToken;
    this.streamingContent = "";
    this.app.render();
    void (async () => {
      // Shrink the history before building the request when it has outgrown the
      // configured budget.
      await this.autoCompress(token);
      if (token !== this.turnToken) return;
      const apiMessages = this.buildApiMessages();
      await this.agentLoop(apiMessages, token);
    })();
  }

  private buildApiMessages(): ApiMessage[] {
    const api: ApiMessage[] = [{ role: "system", content: loadPrompt() }];
    for (const m of this.messages) {
      if (m.role === "user" || m.role === "assistant") {
        api.push({ role: m.role, content: m.content });
      } else if (m.role === "summary") {
        // A compressed summary is fed back to the model as its own prior output.
        api.push({ role: "assistant", content: m.content });
      }
    }
    return api;
  }

  private async agentLoop(apiMessages: ApiMessage[], token: number): Promise<void> {
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
          this.app.render();
        }

        if (client.usage) {
          this.tokens.prompt += client.usage.prompt;
          this.tokens.completion += client.usage.completion;
          this.lastPromptTokens = client.usage.prompt;
        } else {
          this.tokens.completion += Math.max(1, Math.ceil(content.length / 4));
        }

        if (token !== this.turnToken) {
          if (content) this.messages.push({ role: "assistant", content });
          this.streamingContent = null;
          this.app.render();
          return;
        }
        if (aborted || this.paused) {
          if (content) this.messages.push({ role: "assistant", content });
          this.streamingContent = null;
          this.app.render();
          this.onTurnFinished();
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
          this.app.render();
          const result = await executeTool(tc.name, args);
          if (token !== this.turnToken || this.paused) return;
          toolMsg.result = result;
          apiMessages.push({ role: "tool", tool_call_id: tc.id, content: result });
          this.app.render();
        }
      }
      this.onTurnFinished();
    } catch (e) {
      const err = describeError(e);
      this.messages.push({ role: "assistant", content: (this.streamingContent ?? "") + `\n[Error: ${err}]` });
      this.streamingContent = null;
      this.onTurnFinished();
    }
  }

  private onTurnFinished(): void {
    this.busy = false;
    this.paused = false;
    this.app.state.isThinking = false;
    this.save();
    this.app.render();
    this.maybeFlushQueue();
  }

  /** Expand/collapse the tool block belonging to message `index`. */
  private toggleTool(index: number): void {
    if (this.expandedTools.has(index)) this.expandedTools.delete(index);
    else this.expandedTools.add(index);
    this.app.render();
  }

  /** Auto-compress threshold in (estimated) prompt tokens; 0 means "off". */
  private compressThreshold(): number {
    const raw = loadConfig().context_compress_threshold;
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * Once the context has grown past the configured threshold, replace the older
   * part of the conversation with a model-written summary. Runs at the start of
   * a turn, before the request is built. If summarising fails the old messages
   * are simply dropped, so the context always shrinks.
   */
  private async autoCompress(token: number): Promise<void> {
    const threshold = this.compressThreshold();
    if (threshold <= 0 || this.lastPromptTokens < threshold) return;

    const system = this.messages.find((m) => m.role === "system");
    const rest = this.messages.filter((m) => m.role !== "system");
    const items = rest.map((m) => ({
      role: m.role,
      content: m.role === "tool" ? m.result : (m as { content?: string }).content ?? "",
      name: m.role === "tool" ? m.name : undefined,
      ref: m,
    }));
    const plan = planCompaction(items, COMPACT_KEEP);
    if (!plan) return;

    const transcript = transcriptFor(plan.head, COMPACT_MAX_CHARS_PER_MESSAGE);
    this.compressing = true;
    this.app.render();

    const snapshotLen = this.messages.length;
    let summary = "";
    try {
      summary = await this.summarizeTranscript(transcript);
    } catch {
      summary = "";
    }

    this.compressing = false;
    if (token !== this.turnToken) return;
    // A new message (queued by the user while we were summarising) would be
    // dropped by the swap below, so bail out and retry on the next turn.
    if (this.messages.length !== snapshotLen) {
      this.app.render();
      return;
    }

    const count = plan.head.length;
    const content = summary
      ? `[Context compressed]\n${summary}`
      : `[Context compressed]\n(${count} earlier messages were omitted to free up context.)`;
    const summaryMsg: Msg = { role: "summary", content, count };
    const kept = plan.tail.map((i) => i.ref);
    this.messages = system ? [system, summaryMsg, ...kept] : [summaryMsg, ...kept];
    // Message indices shifted, so any expanded tool block no longer lines up.
    this.expandedTools.clear();
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

  private save(): void {
    const chatMessages: SessionMessage[] = [];
    for (const m of this.messages) {
      if (m.role === "user" || m.role === "assistant" || m.role === "tool") {
        chatMessages.push(m);
      } else if (m.role === "summary") {
        // Persist a compressed summary as a plain assistant message.
        chatMessages.push({ role: "assistant", content: m.content });
      }
    }
    if (chatMessages.length === 0) return;
    try {
      this.sessionId = saveSession(
        chatMessages,
        this.model.name,
        this.modelProvider,
        this.intensity,
        process.cwd(),
        this.sessionId ?? undefined,
        this.tokens,
      );
    } catch {
      // ignore save errors
    }
  }

  private buildLines(width: number): Line[] {
    const lines: Line[] = [];
    // Parallel map from rendered line -> owning tool message index (-1 = none),
    // used to turn a click on any line of a tool block into an expand/collapse.
    const toolLineIndex: number[] = [];
    const add = (line: Line, tool = -1): void => {
      lines.push(line);
      toolLineIndex.push(tool);
    };
    const pushText = (text: string, style: Style, tool = -1): void => {
      for (const ln of wrapText(text, width)) add({ spans: [{ text: ln, style }] }, tool);
    };
    const pushMarkdown = (text: string, style: Style): void => {
      for (const ln of renderMarkdownText(text, width, style)) add(ln);
    };

    for (let mi = 0; mi < this.messages.length; mi++) {
      const m = this.messages[mi];
      if (m.role === "system") {
        pushText(sanitizeText(m.content), { fg: C.dim });
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
    }
    if (this.streamingContent !== null) {
      add({ spans: [{ text: "Neutrino:", style: { fg: C.accent, bold: true } }] });
      pushMarkdown(sanitizeText(this.streamingContent), { fg: C.assistant });
    }
    this.toolLineIndex = toolLineIndex;
    return lines;
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    let status = "";
    let statusStyle: Style = { fg: C.dim };
    if (this.compressing) {
      status = "Compressing context…";
      statusStyle = { fg: C.amber, bold: true };
    } else if (this.queued) {
      status = "Will send when paused or idle...";
      statusStyle = { fg: C.amber };
    } else if (this.paused) {
      status = "PAUSED — press ESC ESC to resume";
      statusStyle = { fg: C.amber, bold: true };
    } else if (this.busy) {
      status = "Streaming... press ESC ESC to pause";
      statusStyle = { fg: C.dim };
    }
    if (status) buf.centerText(1, status.slice(0, w), statusStyle);

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
    for (let y = logTop; y <= logBottom; y++) {
      const li = this.scrollTop + (y - logTop);
      if (li >= lines.length) break;
      const tool = this.toolLineIndex[li];
      if (tool !== undefined && tool >= 0) this.toolRows.set(y, tool);
      drawSpans(buf, 2, y, lines[li].spans, Math.max(4, w - 4));
    }

    // A scrollbar on the right edge of the log, shown only when the
    // conversation overflows the visible area.
    drawScrollbar(buf, w - 1, logTop, logBottom, lines.length, viewH, this.scrollTop);

    const inW = Math.max(12, w - 2);
    drawInputBox(buf, 1, inputY, inW, this.inputValue, this.cursor, {
      active: true,
      dimmed: this.busy,
      cursorOn: this.app.state.cursorOn,
      placeholder: "Type a message...",
    });

    const hintY = h - 1;
    const hints = "Enter send · ESC ESC pause · Ctrl+B menu · Ctrl+L clear · drag to copy";
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
