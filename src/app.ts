import process from "node:process";
import { Buffer } from "./terminal/buffer.js";
import { InputReader, type InputEvent, type MouseEvent } from "./terminal/input.js";
import { Renderer } from "./terminal/renderer.js";
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

const CURSOR_BLINK_MS = 530;
const TOAST_MS = 1600;

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
  private toast = "";
  // Most recently rendered frame. Kept so a selection can be turned back into
  // text without having to re-run the screen's render.
  private lastBuffer: Buffer | null = null;
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

  async start(): Promise<void> {
    this.renderer.init();
    this.input.start((ev) => this.handleEvent(ev));
    process.stdout.on("resize", this.resizeHandler);
    process.on("SIGINT", () => this.quit());
    process.on("SIGTERM", () => this.quit());
    this.sizeTimer = setInterval(() => {
      if (this.syncSize()) this.render();
    }, 200);
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

  render(): void {
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
    this.lastBuffer = buf;

    // The selection overlay is painted over the finished frame, so it works on
    // every screen (chat log, input box, menus, …) without each having to know
    // about selection at all.
    if (this.state.selection) applySelection(buf, this.state.selection);
    this.drawToast(buf);

    this.renderer.render(buf);
  }

  private drawToast(buf: Buffer): void {
    if (!this.toast) return;
    const y = buf.height - 1;
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
      // Any keystroke ends a pending mouse gesture (in case a release was lost).
      this.resetMouse();
      if (k.ctrl && k.name === "q") {
        this.quit();
        return;
      }
      if (k.ctrl && k.name === "c") {
        // Ctrl+C copies the selection when there is one, otherwise it quits —
        // the usual terminal convention.
        if (this.state.selection) {
          this.copySelection();
          return;
        }
        this.quit();
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
        if (ev.x !== s.x || ev.y !== s.y) {
          // The pointer left the press cell, so this is a drag: grow/shrink the
          // selection instead of forwarding a hover to the screen.
          this.state.selection = { anchor: s, cursor: { x: ev.x, y: ev.y } };
          this.render();
        }
        return;
      }
      this.top?.onMouse(ev);
      return;
    }

    if (ev.type === "release") {
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

  private copySelection(): void {
    const sel = this.state.selection;
    if (!sel || !this.lastBuffer) return;
    const text = selectionText(this.lastBuffer, sel);
    if (text.trim().length === 0) return;
    copyToClipboard(text);
    this.showToast(`Copied ${text.length} char${text.length === 1 ? "" : "s"}`);
  }

  private showToast(text: string): void {
    this.toast = text;
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
    this.pushScreen(new ChatScreen(text));
  }

  loadSession(data: SessionData): void {
    const screen = new ChatScreen("");
    screen.sessionId = data.id;
    screen.loadedMessages = data.messages ?? [];
    screen.loadedProvider = data.provider || null;
    screen.loadedModel = data.model || null;
    screen.loadedIntensity = data.intensity || null;
    screen.loadedTokens = data.tokens ?? null;
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

  quit(): void {
    if (this.running) return;
    this.running = true;
    if (this.sizeTimer) clearInterval(this.sizeTimer);
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
    this.input.stop();
    this.renderer.dispose();
    process.exit(0);
  }
}
