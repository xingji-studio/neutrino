import process from "node:process";
import { Buffer } from "./terminal/buffer.js";
import { InputReader, type InputEvent, type MouseEvent } from "./terminal/input.js";
import { Renderer } from "./terminal/renderer.js";
import { installCrashGuard, writeCrashLog } from "./terminal/restore.js";
import { Screen } from "./terminal/screen.js";
import { defaultState, type AppState } from "./state.js";
import { loadConfig, saveConfig, type ModelInfo, type SessionData } from "./config.js";
import { C } from "./colors.js";
import { applySelection, selectionText } from "./selection.js";
import { offsetFromThumbTop, scrollbarGeometry } from "./ui.js";
import { copyToClipboard } from "./clipboard.js";
import { ChatScreen } from "./screens/chat.js";
import { HistoryScreen } from "./screens/history.js";
import { AgentSelectScreen } from "./screens/agentSelect.js";
import { ModelSelectScreen } from "./screens/modelSelect.js";
import { SettingsScreen } from "./screens/settings.js";
import { StartScreen } from "./screens/start.js";
import { startWebServer, type WebServerHandle } from "./web/server.js";

const CURSOR_BLINK_MS = 530;
const TOAST_MS = 1600;
const INTERRUPT_WINDOW_MS = 1500;
const SELECTION_FRAME_MS = 16;
const EXIT_HINT = "press ctrl+shift+c or press ctrl+c 3 times to exit";
// How often the whole frame is re-emitted as a safety net, so terminal-side
// drift (ConPTY reflow, stray scroll) can never leave any row stale for long.
// Re-emitting the cached frame is a no-op when nothing drifted.
const REPAINT_MS = 2000;

export class App {
  state: AppState = defaultState();
  width: number;
  height: number;

  private screens: Screen[] = [];
  private renderer = new Renderer();
  private input = new InputReader();
  private running = false;
  private sizeTimer: NodeJS.Timeout | null = null;
  private blinkTimer: NodeJS.Timeout | null = null;
  private cursorTimer: NodeJS.Timeout | null = null;
  private toastTimer: NodeJS.Timeout | null = null;
  private repaintTimer: NodeJS.Timeout | null = null;
  private toast = "";
  private toastPosition: "top" | "bottom" = "bottom";
  private interruptCount = 0;
  private lastInterruptTime = 0;
  // Consecutive failed renders. A screen that cannot draw itself is fatal;
  // a single bad frame is not.
  private renderFailures = 0;
  // Most recently rendered frame. Kept so a selection can be turned back into
  // text without having to re-run the screen's render.
  private lastBuffer: Buffer | null = null;
  // Cache the screen without selection so dragging never reflows the history.
  private contentBuffer: Buffer | null = null;
  private selectionTimer: NodeJS.Timeout | null = null;
  // Mouse selection bookkeeping. `pressed` is true between a left-button press
  // and its release; `pressStart` is where the press landed, used as the anchor
  // once the pointer starts moving (i.e. once it becomes a drag). A plain click
  // never moves, so it is forwarded to the screen and leaves no selection.
  private pressed = false;
  private pressStart: { x: number; y: number } | null = null;
  // Active scrollbar drag: how many rows below the thumb's top the press
  // landed, so the thumb stays under the pointer as it moves.
  private barDrag: { grab: number } | null = null;
  private resizeHandler = () => this.onResize();
  private webHandle: WebServerHandle | null = null;

  constructor() {
    this.width = process.stdout.columns || 80;
    this.height = process.stdout.rows || 24;
    this.restoreSelection();
  }

  private readSize(): { width: number; height: number } {
    return {
      width: process.stdout.columns || 80,
      height: process.stdout.rows || 24,
    };
  }

  private syncSize(): boolean {
    const size = this.readSize();
    if (size.width !== this.width || size.height !== this.height) {
      this.width = size.width;
      this.height = size.height;
      return true;
    }
    return false;
  }

  private restoreSelection(): void {
    const config = loadConfig();
    this.state.selectedProvider = String(config.selected_provider ?? this.state.selectedProvider);
    this.state.selectedModelName = String(config.selected_model ?? this.state.selectedModelName);
    this.state.selectedIntensity = String(config.selected_intensity ?? this.state.selectedIntensity);
    this.state.selectedModelUrl = String(config.selected_model_url ?? this.state.selectedModelUrl);
    this.state.selectedModelApiKey = String(config.selected_model_api_key ?? this.state.selectedModelApiKey);
    this.state.selectedModelStreaming = Boolean(config.selected_model_streaming ?? true);
  }

  /**
   * Mount the browser UI on the given port. Safe to call once; subsequent calls
   * return the already-running server.
   */
  async enableWeb(port: number, host?: string, auth = true): Promise<WebServerHandle> {
    if (this.webHandle) return this.webHandle;
    this.webHandle = await startWebServer({ port, host, auth });
    return this.webHandle;
  }

  async start(): Promise<void> {
    // Installed before anything touches the terminal: from here on, a crash
    // restores mouse tracking, raw mode and the alternate screen instead of
    // handing the shell a terminal that types mouse reports.
    installCrashGuard();
    this.renderer.init();
    this.input.start((ev) => this.handleEvent(ev));
    process.stdout.on("resize", this.resizeHandler);
    process.on("SIGINT", () => this.handleInterrupt());
    process.on("SIGTERM", () => this.quit());
    this.sizeTimer = setInterval(() => {
      if (this.syncSize()) this.render();
    }, 200);
    this.repaintTimer = setInterval(() => this.renderer.repaint(), REPAINT_MS);
    this.pushScreen(new StartScreen());
  }

  private onResize(): void {
    if (this.syncSize()) this.render();
  }

  get top(): Screen | undefined {
    return this.screens[this.screens.length - 1];
  }

  pushScreen(screen: Screen): void {
    screen.app = this;
    this.screens.push(screen);
    this.resetMouse();
    this.state.selection = null;
    screen.onActivate();
    this.render();
  }

  popScreen(): void {
    const screen = this.screens.pop();
    this.resetMouse();
    this.state.selection = null;
    screen?.onDeactivate();
    this.render();
  }

  render(selectionOnly = false): void {
    if (this.selectionTimer) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }
    try {
      if (selectionOnly && this.contentBuffer
        && this.contentBuffer.width === this.width && this.contentBuffer.height === this.height) {
        this.renderBuffer(this.contentBuffer);
      } else {
        this.renderFrame();
      }
      this.renderFailures = 0;
    } catch (err) {
      // Rendering runs from timers and stream callbacks too, so an escaping
      // throw here is equally fatal.
      this.renderFailures++;
      if (this.renderFailures === 1) this.noteInternalError("render", err);
      // A screen that cannot be drawn at all means there is no UI left; stop
      // instead of spinning on a broken frame every 60 ms.
      if (this.renderFailures > 30) this.quit(1);
    }
  }

  private noteInternalError(kind: string, err: unknown): void {
    const file = writeCrashLog(kind, err);
    const detail = err instanceof Error ? err.message : String(err);
    const where = file ? ` - details in ${file}` : "";
    this.showToast(`internal error (${kind}): ${detail}${where}`);
  }

  private renderFrame(): void {
    // Start/stop the "thinking" blink animation. While the agent is thinking,
    // a timer toggles the blink phase and re-renders so the top status bar
    // flashes to draw the user's attention.
    if (this.state.isThinking && !this.blinkTimer) {
      this.state.blinkOn = true;
      this.blinkTimer = setInterval(() => {
        this.state.blinkOn = !this.state.blinkOn;
        this.render();
      }, 500);
    } else if (!this.state.isThinking && this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
      this.state.blinkOn = false;
    }

    // The text cursor blinks whenever the top screen shows one. The timer is
    // only kept alive while needed so idle screens don't repaint needlessly.
    this.updateCursorBlink();

    const buf = new Buffer(this.width, this.height);
    this.top?.render(buf);
    this.contentBuffer = buf;
    this.renderBuffer(buf, this.top?.alwaysRepaintRows() ?? []);
  }

  private renderBuffer(content: Buffer, forceRows: readonly number[] = []): void {
    // The selection overlay is painted over the finished frame, so it works on
    // every screen (chat log, input box, menus, …) without each having to know
    // about selection at all.
    let buf = content;
    if (this.state.selection) {
      buf = new Buffer(content.width, content.height);
      buf.cells = content.cells.map((row) => row.map((cell) => ({ ...cell })));
      applySelection(buf, this.state.selection);
    }
    this.drawToast(buf);
    this.lastBuffer = buf;

    this.renderer.render(buf, forceRows);
  }

  private scheduleSelectionRender(): void {
    if (!this.selectionTimer) {
      this.selectionTimer = setTimeout(() => this.render(true), SELECTION_FRAME_MS);
    }
  }

  private drawToast(buf: Buffer): void {
    if (!this.toast) return;
    const y = this.toastPosition === "top" ? 0 : buf.height - 1;
    buf.fillRect(0, y, buf.width, 1, { bg: C.black });
    buf.centerText(y, ` ${this.toast} `, { fg: C.black, bg: C.accent, bold: true });
  }

  private updateCursorBlink(): void {
    const want = this.top?.showsCursor() ?? false;
    if (want && !this.cursorTimer) {
      this.cursorTimer = setInterval(() => {
        this.state.cursorOn = !this.state.cursorOn;
        this.render();
      }, CURSOR_BLINK_MS);
    } else if (!want && this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = null;
      this.state.cursorOn = true;
    }
  }

  /** Reset the blink phase so the cursor is solid right after an interaction. */
  private wakeCursor(): void {
    this.state.cursorOn = true;
  }

  private handleEvent(ev: InputEvent): void {
    try {
      this.dispatchEvent(ev);
    } catch (err) {
      // This runs inside a stdin 'data' callback, where a throw is an uncaught
      // exception that would kill the app mid-keystroke.
      this.noteInternalError("input handler", err);
    }
  }

  private dispatchEvent(ev: InputEvent): void {
    const interrupt = ev.type === "key" && ev.key.ctrl && ev.key.name === "c";
    if (!interrupt && (ev.type !== "mouse" || ev.event.type === "click" || ev.event.type === "wheel")) {
      this.interruptCount = 0;
    }
    if (ev.type === "paste") {
      // Pasted text arrives with its newlines already flattened to spaces, so
      // it is inserted into the input instead of being submitted.
      this.resetMouse();
      this.wakeCursor();
      this.top?.onPaste(ev.text);
      return;
    }
    if (ev.type === "key") {
      const k = ev.key;
      // Leave an active drag/selection untouched by the terminal copy shortcut.
      if (k.ctrl && k.name === "c" && !k.shift && this.state.selection) {
        this.interruptCount = 0;
        return;
      }
      // Any keystroke ends a pending mouse gesture (in case a release was lost).
      this.resetMouse();
      if (k.ctrl && k.name === "q") {
        this.quit();
        return;
      }
      if (k.ctrl && k.name === "c") {
        if (k.shift) this.quit();
        else this.handleInterrupt();
        return;
      }
      if (k.name === "escape" && this.state.selection) {
        this.state.selection = null;
        this.render();
        return;
      }
      this.wakeCursor();
      if (k.ctrl && (k.name === "m" || k.name === "e")) {
        this.openModelConfig();
        return;
      }
      this.top?.onKey(k);
    } else {
      this.handleMouse(ev.event);
    }
  }

  private handleMouse(ev: MouseEvent): void {
    if (ev.type === "click") {
      this.wakeCursor();
      // A left-press on the scrollbar starts a thumb drag rather than a text
      // selection or a click on the screen behind it.
      if (ev.button === 0) {
        const bar = this.top?.scrollbar();
        if (bar && ev.x >= bar.x && ev.y >= bar.top && ev.y <= bar.bottom) {
          const g = scrollbarGeometry(bar.top, bar.bottom, bar.total, bar.viewport, bar.offset);
          let grab = ev.y - bar.top - g.thumbTop;
          if (grab < 0 || grab >= g.thumbH) {
            // Pressed the groove: centre the thumb under the pointer.
            grab = Math.floor(g.thumbH / 2);
            const thumbTop = Math.max(0, Math.min(ev.y - bar.top - grab, g.maxThumbTop));
            bar.scrollTo(offsetFromThumbTop(g, thumbTop));
          }
          this.barDrag = { grab };
          this.pressed = false;
          this.pressStart = null;
          if (this.state.selection) this.state.selection = null;
          this.render();
          return;
        }
      }
      this.pressed = true;
      this.pressStart = { x: ev.x, y: ev.y };
      if (this.state.selection) {
        this.state.selection = null;
        this.render();
      }
      // Forward immediately so plain clicks (focus, tabs, header, …) keep
      // working even in terminals that don't report button releases.
      this.top?.onMouse(ev);
      return;
    }

    if (ev.type === "move") {
      // A release can be lost (the pointer left the window, the terminal did
      // not report button-up, …). Motion with no button held means the gesture
      // is over, so drop any stale press/drag instead of letting a bare hover
      // keep scrolling the log or grow a phantom selection.
      if (!ev.drag) {
        this.pressed = false;
        this.pressStart = null;
        this.barDrag = null;
      }
      if (this.barDrag) {
        const bar = this.top?.scrollbar();
        if (bar) {
          const g = scrollbarGeometry(bar.top, bar.bottom, bar.total, bar.viewport, bar.offset);
          const thumbTop = Math.max(0, Math.min(ev.y - bar.top - this.barDrag.grab, g.maxThumbTop));
          bar.scrollTo(offsetFromThumbTop(g, thumbTop));
        }
        return;
      }
      if (this.pressed && this.pressStart) {
        const s = this.pressStart;
        const sel = this.state.selection;
        if ((ev.x !== s.x || ev.y !== s.y || sel)
          && (!sel || ev.x !== sel.cursor.x || ev.y !== sel.cursor.y)) {
          // The pointer left the press cell, so this is a drag: grow/shrink the
          // selection instead of forwarding a hover to the screen.
          this.state.selection = { anchor: s, cursor: { x: ev.x, y: ev.y } };
          this.scheduleSelectionRender();
        }
        return;
      }
      this.top?.onMouse(ev);
      return;
    }

    if (ev.type === "release") {
      // A release can arrive before the queued frame (or the final move).
      if (this.pressed && this.pressStart && this.state.selection) {
        this.state.selection = { anchor: this.pressStart, cursor: { x: ev.x, y: ev.y } };
      }
      if (this.selectionTimer) this.render(true);
      const sel = this.state.selection;
      this.pressed = false;
      this.pressStart = null;
      this.barDrag = null;
      if (sel) {
        if (this.lastBuffer) {
          const text = selectionText(this.lastBuffer, sel);
          if (text.trim().length > 0) {
            copyToClipboard(text);
            this.showToast(`Copied ${text.length} char${text.length === 1 ? "" : "s"}`);
            return;
          }
        }
        this.render();
      }
      return;
    }

    if (ev.type === "wheel") {
      if (this.state.selection) this.state.selection = null;
      this.top?.onMouse(ev);
    }
  }

  private resetMouse(): void {
    this.pressed = false;
    this.pressStart = null;
    this.barDrag = null;
  }

  private handleInterrupt(): void {
    if (this.state.selection) {
      this.interruptCount = 0;
      return;
    }
    const now = Date.now();
    this.interruptCount = now - this.lastInterruptTime <= INTERRUPT_WINDOW_MS
      ? this.interruptCount + 1 : 1;
    this.lastInterruptTime = now;
    if (this.interruptCount >= 3) {
      this.quit();
      return;
    }
    // A model/settings overlay can sit above the current conversation.
    const chat = [...this.screens].reverse().find((screen) => screen instanceof ChatScreen);
    const meta = chat instanceof ChatScreen ? chat.liveMeta() : null;
    if (chat instanceof ChatScreen && meta?.busy && !meta.paused) {
      chat.livePause();
      return;
    }
    this.showToast(EXIT_HINT, "top");
  }

  // Public so screens can surface transient status (e.g. "reviewing 3/3").
  /**
   * Audible cue for something the user is waiting on.
   *
   * Silent when `sound_alerts` is off, so the bell stays a preference rather
   * than unavoidable noise. A pending approval rings twice: it is the one event
   * that actually blocks the agent, and a single blip is easy to miss.
   */
  bell(kind: "turn" | "approval" = "turn"): void {
    try {
      if (loadConfig().sound_alerts === false) return;
    } catch {
      // A config we cannot read must not swallow the cue.
    }
    this.renderer.bell(kind === "approval" ? 2 : 1);
  }

  showToast(text: string, position: "top" | "bottom" = "bottom"): void {
    this.toast = text;
    this.toastPosition = position;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.toast = "";
      this.render();
    }, TOAST_MS);
    this.render();
  }

  setModelConfig(providerName: string, model: ModelInfo, intensity: string): void {
    this.state.selectedProvider = providerName;
    this.state.selectedModelName = model.name;
    this.state.selectedModelUrl = model.url;
    this.state.selectedModelApiKey = model.api_key ?? "";
    this.state.selectedModelStreaming = model.supports_streaming ?? true;
    this.state.selectedIntensity = intensity;

    const config = loadConfig();
    config.selected_provider = providerName;
    config.selected_model = model.name;
    config.selected_intensity = intensity;
    config.selected_model_url = model.url;
    config.selected_model_api_key = model.api_key ?? "";
    config.selected_model_streaming = model.supports_streaming ?? true;
    saveConfig(config);
  }

  startNewChat(text: string): void {
    this.restoreSelection();
    this.pushScreen(new ChatScreen(text));
  }

  loadSession(data: SessionData): void {
    const screen = new ChatScreen("");
    screen.sessionId = data.id;
    screen.loadedMessages = data.messages ?? [];
    screen.loadedCwd = data.cwd ?? null;
    screen.loadedProvider = data.provider || null;
    screen.loadedModel = data.model || null;
    screen.loadedIntensity = data.intensity || null;
    screen.loadedTokens = data.tokens ?? null;
    screen.loadedContext = data.context ?? null;
    screen.loadedApprovalMode = data.approval_mode ?? null;
    if (data.provider) this.state.selectedProvider = data.provider;
    if (data.model) this.state.selectedModelName = data.model;
    if (data.intensity) this.state.selectedIntensity = data.intensity;
    this.pushScreen(screen);
  }

  openModelConfig(): void {
    if (this.screens.some((s) => s instanceof ModelSelectScreen)) return;
    this.pushScreen(new ModelSelectScreen());
  }

  openHistory(): void {
    if (this.screens.some((s) => s instanceof HistoryScreen)) return;
    this.pushScreen(new HistoryScreen());
  }

  openAgentSelect(): void {
    if (this.screens.some((s) => s instanceof AgentSelectScreen)) return;
    this.pushScreen(new AgentSelectScreen());
  }

  openSettings(): void {
    if (this.screens.some((s) => s instanceof SettingsScreen)) return;
    this.pushScreen(new SettingsScreen());
  }

  quit(exitCode = 0): void {
    if (this.running) return;
    this.running = true;
    if (this.sizeTimer) clearInterval(this.sizeTimer);
    if (this.repaintTimer) {
      clearInterval(this.repaintTimer);
      this.repaintTimer = null;
    }
    if (this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
    }
    if (this.cursorTimer) {
      clearInterval(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    if (this.selectionTimer) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }
    // Disable mouse reporting before input returns to cooked/echo mode.
    this.renderer.dispose();
    try {
      this.input.stop();
    } catch {
      // Terminal restoration has already run, even if stdin is unusable.
    }
    void this.webHandle?.close();
    process.exit(exitCode);
  }
}
