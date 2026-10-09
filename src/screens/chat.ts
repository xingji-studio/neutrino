import type { Buffer } from "../terminal/buffer.js";
import { Screen, type ScrollbarHandle } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C, type Style } from "../colors.js";
import {
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
import { LLMClient } from "../llm/client.js";
import { executeTool, getToolDefinitions } from "../llm/tools.js";

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

  showsCursor(): boolean {
    // The chat input is always focused; a cursor is drawn when it holds text.
    return this.inputValue.length > 0;
  }

  onPaste(text: string): void {
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
    const apiMessages = this.buildApiMessages();
    this.streamingContent = "";
    this.app.render();
    void this.agentLoop(apiMessages, token);
  }

  private buildApiMessages(): ApiMessage[] {
    const api: ApiMessage[] = [{ role: "system", content: loadPrompt() }];
    for (const m of this.messages) {
      if (m.role === "user" || m.role === "assistant") {
        api.push({ role: m.role, content: m.content });
      }
    }
    return api;
  }

  private async agentLoop(apiMessages: ApiMessage[], token: number): Promise<void> {
    try {
      while (true) {
        if (token !== this.turnToken) return;
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
      const err = e instanceof Error ? e.message : String(e);
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

  private save(): void {
    const chatMessages = this.messages.filter(
      (m): m is SessionMessage => m.role === "user" || m.role === "assistant" || m.role === "tool",
    );
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
    const pushText = (text: string, style: Style): void => {
      for (const ln of wrapText(text, width)) {
        lines.push({ spans: [{ text: ln, style }] });
      }
    };
    for (const m of this.messages) {
      if (m.role === "system") {
        pushText(m.content, { fg: C.dim });
      } else if (m.role === "user") {
        lines.push({ spans: [{ text: "You:", style: { fg: C.accent, bold: true } }] });
        lines.push(...renderMarkdownText(m.content, width, { fg: C.user }));
        lines.push({ spans: [] });
      } else if (m.role === "assistant") {
        lines.push({ spans: [{ text: "Neutrino:", style: { fg: C.accent, bold: true } }] });
        lines.push(...renderMarkdownText(m.content, width, { fg: C.assistant }));
        lines.push({ spans: [] });
      } else if (m.role === "tool") {
        lines.push({ spans: [{ text: `⚙ ${m.name}`, style: { fg: C.toolHeader, bold: true } }] });
        const argText = (m.arguments.command as string) ?? (m.arguments.path as string) ?? "";
        if (argText) lines.push({ spans: [{ text: "  " + argText, style: { fg: C.dim } }] });
        pushText(m.result || "(no output)", { fg: C.dim });
        lines.push({ spans: [] });
      }
    }
    if (this.streamingContent !== null) {
      lines.push({ spans: [{ text: "Neutrino:", style: { fg: C.accent, bold: true } }] });
      lines.push(...renderMarkdownText(this.streamingContent, width, { fg: C.assistant }));
    }
    return lines;
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    let status = "";
    let statusStyle: Style = { fg: C.dim };
    if (this.queued) {
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

    for (let y = logTop; y <= logBottom; y++) {
      const li = this.scrollTop + (y - logTop);
      if (li >= lines.length) break;
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
