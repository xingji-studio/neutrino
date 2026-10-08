import process from "node:process";
import { Buffer } from "./terminal/buffer.js";
import { InputReader, type InputEvent } from "./terminal/input.js";
import { Renderer } from "./terminal/renderer.js";
import { Screen } from "./terminal/screen.js";
import { defaultState, type AppState } from "./state.js";
import { loadConfig, saveConfig, type ModelInfo, type SessionData } from "./config.js";
import { ChatScreen } from "./screens/chat.js";
import { HistoryScreen } from "./screens/history.js";
import { AgentSelectScreen } from "./screens/agentSelect.js";
import { ModelSelectScreen } from "./screens/modelSelect.js";
import { SettingsScreen } from "./screens/settings.js";
import { StartScreen } from "./screens/start.js";

const CURSOR_BLINK_MS = 530;

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
    screen.onActivate();
    this.render();
  }

  popScreen(): void {
    const screen = this.screens.pop();
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
    this.renderer.render(buf);
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
    if (ev.type === "key") {
      const k = ev.key;
      if (k.ctrl && (k.name === "c" || k.name === "q")) {
        this.quit();
        return;
      }
      this.wakeCursor();
      if (k.ctrl && (k.name === "m" || k.name === "e")) {
        this.openModelConfig();
        return;
      }
      this.top?.onKey(k);
    } else {
      if (ev.event.type === "click") this.wakeCursor();
      this.top?.onMouse(ev.event);
    }
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
    this.input.stop();
    this.renderer.dispose();
    process.exit(0);
  }
}
