import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import {
  CONTEXT_WINDOW_OPTIONS,
  DEFAULT_CONTEXT_WINDOW,
  contextWindow,
  CONFIG_FILE,
  INTENSITY_LEVELS,
  getModelsByProvider,
  loadConfig,
  loadModels,
  saveConfig,
  saveModels,
} from "../config.js";
import { drawHeader } from "../header.js";
import { centerVertically, drawHint } from "../ui.js";
import { hashWebPassword } from "../web/auth.js";

/** The settings that can be changed here, top to bottom. */
const ROWS = ["intensity", "compress", "approval_model", "extreme_approval", "sound", "web_console", "web_password"] as const;
type RowId = (typeof ROWS)[number];

export class SettingsScreen extends Screen {
  private intensityIdx = 2;
  private contextTokens = DEFAULT_CONTEXT_WINDOW;
  private contextChanged = false;
  /** 0 = same model as the chat, otherwise index + 1 into `models`. */
  private approvalModelIdx = 0;
  /** 0 = off (human only), 1 = on (two independent assessments). */
  private extremeIdx = 0;
  /** 0 = silent, 1 = audible cue on turn end and on approval requests. */
  private soundIdx = 1;
  /** 0 = web UI off, 1 = mounted alongside the terminal. */
  private webIdx = 1;
  /** Only a row the user actually touched rewrites the saved default. */
  private webChanged = false;
  private models: string[] = [];
  private rowIdx = 0;
  private lastHoverX = -1;
  private lastHoverY = -1;
  private editingPassword = false;
  private passwordDraft = "";
  private passwordMessage = "Press Enter to change";

  onActivate(): void {
    const config = loadConfig();
    const current = String(config.default_intensity ?? "High");
    const i = INTENSITY_LEVELS.indexOf(current);
    this.intensityIdx = i >= 0 ? i : 2;

    const state = this.app.state;
    const model = getModelsByProvider()[state.selectedProvider]?.find((m) => m.name === state.selectedModelName);
    this.contextTokens = contextWindow(model?.context_window);
    this.contextChanged = false;

    this.models = Object.values(getModelsByProvider()).flatMap((list) => list.map((m) => m.name));
    const currentApproval = String(config.approval_model ?? "");
    const approvalAt = currentApproval ? this.models.indexOf(currentApproval) : -1;
    this.approvalModelIdx = approvalAt >= 0 ? approvalAt + 1 : 0;
    this.extremeIdx = config.auto_approve_extreme_risk === true ? 1 : 0;
    this.soundIdx = config.sound_alerts === false ? 0 : 1;
    // A console started by an explicit flag is on even if the saved default is
    // off, so reflect what is actually running first.
    this.webIdx = (this.app.state.webUrl || config.web_console !== false) ? 1 : 0;
    this.webChanged = false;
  }

  /** Change the value of a row by `delta` steps and persist it immediately. */
  private cycle(row: RowId, delta: number): void {
    if (row === "web_password") {
      this.editingPassword = true;
      this.passwordDraft = "";
      this.passwordMessage = "Type new password";
      return;
    }
    if (row === "intensity") {
      const n = INTENSITY_LEVELS.length;
      this.intensityIdx = (this.intensityIdx + delta + n) % n;
    } else if (row === "approval_model") {
      const n = this.models.length + 1;
      this.approvalModelIdx = (this.approvalModelIdx + delta + n) % n;
    } else if (row === "extreme_approval") {
      // A switch, not a list: any nudge flips it.
      this.extremeIdx = this.extremeIdx === 1 ? 0 : 1;
    } else if (row === "sound") {
      this.soundIdx = this.soundIdx === 1 ? 0 : 1;
    } else if (row === "web_console") {
      this.webIdx = this.webIdx === 1 ? 0 : 1;
      this.webChanged = true;
      this.save();
      // Mount or unmount immediately; a failed bind is shown as a toast and
      // the saved preference stays on so the next launch tries again.
      void this.app.setWebConsole(this.webIdx === 1);
      return;
    } else {
      const options = [...new Set([...CONTEXT_WINDOW_OPTIONS, this.contextTokens])].sort((a, b) => a - b);
      const i = options.indexOf(this.contextTokens);
      this.contextTokens = options[(i + delta + options.length) % options.length];
      this.contextChanged = true;
    }
    this.save();
  }

  onKey(key: Key): void {
    if (this.editingPassword) {
      if (key.name === "escape") {
        this.editingPassword = false;
        this.passwordDraft = "";
        this.passwordMessage = "Press Enter to change";
      } else if (key.name === "enter" || key.name === "return") {
        try {
          const hash = hashWebPassword(this.passwordDraft);
          const config = loadConfig();
          config.web_password_hash = hash;
          saveConfig(config);
          this.editingPassword = false;
          this.passwordDraft = "";
          this.passwordMessage = "Saved permanently";
        } catch (error) {
          this.passwordMessage = error instanceof Error ? error.message : "Could not save password";
        }
      } else if (key.name === "backspace") {
        this.passwordDraft = Array.from(this.passwordDraft).slice(0, -1).join("");
      } else if (key.ctrl && key.name === "u") {
        this.passwordDraft = "";
      } else if (key.char && !key.ctrl && !key.meta) {
        this.passwordDraft = (this.passwordDraft + key.char).slice(0, 256);
      }
      this.app.render();
      return;
    }
    if (key.name === "up") {
      this.rowIdx = (this.rowIdx + ROWS.length - 1) % ROWS.length;
      this.app.render();
    } else if (key.name === "down") {
      this.rowIdx = (this.rowIdx + 1) % ROWS.length;
      this.app.render();
    } else if (key.name === "left") {
      this.cycle(ROWS[this.rowIdx], -1);
      this.app.render();
    } else if (key.name === "right") {
      this.cycle(ROWS[this.rowIdx], 1);
      this.app.render();
    } else if (key.name === "enter" || key.name === "return") {
      if (ROWS[this.rowIdx] === "web_password") this.cycle("web_password", 1);
      else this.save();
      this.app.render();
    } else if (key.name === "escape") {
      this.save();
      this.app.popScreen();
    }
  }

  onMouse(ev: MouseEvent): void {
    if (this.editingPassword) return;
    const layout = this.layout();
    if (!layout) return;

    if (ev.type === "move") {
      if (ev.x === this.lastHoverX && ev.y === this.lastHoverY) return;
      this.lastHoverX = ev.x;
      this.lastHoverY = ev.y;
      for (let i = 0; i < layout.rowYs.length; i++) {
        if (ev.y === layout.rowYs[i] && i !== this.rowIdx) {
          this.rowIdx = i;
          this.app.render();
          return;
        }
      }
      return;
    }

    if (ev.type === "wheel") {
      this.cycle(ROWS[this.rowIdx], ev.dir === -1 ? -1 : 1);
      this.app.render();
      return;
    }

    if (ev.type === "click") {
      if (ev.button === 2) {
        this.save();
        this.app.popScreen();
        return;
      }
      for (let i = 0; i < layout.rowYs.length; i++) {
        if (ev.y === layout.rowYs[i]) {
          if (this.rowIdx === i) {
            // Clicking the already-selected row advances its value.
            this.cycle(ROWS[i], 1);
          } else {
            this.rowIdx = i;
          }
          this.app.render();
          return;
        }
      }
      if (ev.y === layout.hintY) {
        this.save();
        this.app.popScreen();
      }
    }
  }

  onPaste(text: string): void {
    if (!this.editingPassword) return;
    this.passwordDraft = (this.passwordDraft + text).slice(0, 256);
    this.app.render();
  }

  onDeactivate(): void {
    this.passwordDraft = "";
    this.editingPassword = false;
  }

  private rowTexts(): { label: string; value: string }[] {
    return [
      { label: "Default intensity", value: INTENSITY_LEVELS[this.intensityIdx] },
      { label: "Model context (80%)", value: `${this.contextTokens.toLocaleString("en-US")} tokens` },
      {
        label: "Approval reviewer model",
        value: this.approvalModelIdx === 0 ? "Same as chat" : this.models[this.approvalModelIdx - 1] ?? "Same as chat",
      },
      {
        label: "Extreme-risk auto-approval",
        // Names the mechanism: three separate review rounds, not three reviewers
        // sitting in one panel.
        value: this.extremeIdx === 1 ? "On (3 separate rounds)" : "Off (human only)",
      },
      {
        label: "Sound alerts",
        value: this.soundIdx === 1 ? "On (turn end, approvals)" : "Off",
      },
      {
        label: "Web console",
        value: this.webIdx === 0
          ? "Off"
          : this.app.state.webUrl
            ? `On · ${this.app.state.webUrl}`
            : "On (not running)",
      },
      {
        label: "Web password",
        value: this.editingPassword ? "*".repeat(Math.min(this.passwordDraft.length, 24)) || "Type new password" : this.passwordMessage,
      },
    ];
  }

  private layout(): { rowYs: number[]; hintY: number; labelW: number } | null {
    const h = this.app.height;
    const rows = this.rowTexts();
    const labelW = Math.max(...rows.map((r) => r.label.length));
    // title, blank, model, blank, option rows, blank, hint
    const total = 6 + rows.length;
    const top = centerVertically(h, total);
    const rowYs = rows.map((_, i) => top + 4 + i);
    const hintY = top + 5 + rows.length;
    if (hintY > h - 1) return null;
    return { rowYs, hintY, labelW };
  }

  private save(): void {
    const config = loadConfig();
    config.default_intensity = INTENSITY_LEVELS[this.intensityIdx];
    if (this.contextChanged) {
      const data = loadModels();
      const state = this.app.state;
      const model = data.providers.find((p) => p.name === state.selectedProvider)?.models.find((m) => m.name === state.selectedModelName);
      if (model) {
        model.context_window = this.contextTokens;
        saveModels(data);
      }
      this.contextChanged = false;
    }
    config.approval_model = this.approvalModelIdx === 0 ? "" : this.models[this.approvalModelIdx - 1] ?? "";
    config.auto_approve_extreme_risk = this.extremeIdx === 1;
    config.sound_alerts = this.soundIdx === 1;
    if (this.webChanged) {
      config.web_console = this.webIdx === 1;
      this.webChanged = false;
    }
    saveConfig(config);
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const h = buf.height;

    const rows = this.rowTexts();
    const labelW = Math.max(...rows.map((r) => r.label.length));
    const total = 6 + rows.length;
    const top = centerVertically(h, total);

    let y = top;
    buf.centerText(y, "Settings", { fg: C.accent, bold: true });
    y += 2;
    buf.centerText(y, `Model: ${this.app.state.selectedProvider}/${this.app.state.selectedModelName}`, {
      fg: C.assistant,
    });
    y += 2;

    for (let i = 0; i < rows.length; i++) {
      const selected = i === this.rowIdx;
      const marker = selected ? "▸ " : "  ";
      const label = rows[i].label.padEnd(labelW);
      const value = selected && ROWS[i] !== "web_password" ? `◂ ${rows[i].value} ▸` : rows[i].value;
      const text = marker + label + "   " + value;
      if (selected) {
        buf.centerText(y, " " + text + " ", { fg: C.accent, bg: C.highlightBg, bold: true });
      } else {
        buf.centerText(y, text, { fg: C.assistant });
      }
      y += 1;
    }

    y += 1;
    if (y < h) {
      buf.centerText(y, this.editingPassword ? this.passwordMessage : `config: ${CONFIG_FILE}`, { fg: C.dim });
      y += 1;
    }
    if (y < h) {
      drawHint(buf, y, this.editingPassword
        ? "Type or paste password  ·  Enter save  ·  Esc cancel"
        : "↑/↓ select  ·  ←/→ change  ·  Enter apply  ·  right-click back  ·  Esc back");
    }
  }
}
