import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import {
  COMPRESS_THRESHOLD_OPTIONS,
  CONFIG_FILE,
  INTENSITY_LEVELS,
  getModelsByProvider,
  loadConfig,
  saveConfig,
} from "../config.js";
import { drawHeader } from "../header.js";
import { centerVertically, drawHint } from "../ui.js";

/** The settings that can be changed here, top to bottom. */
const ROWS = ["intensity", "compress", "approval_model", "extreme_approval"] as const;
type RowId = (typeof ROWS)[number];

export class SettingsScreen extends Screen {
  private intensityIdx = 2;
  private thresholdIdx = 3;
  /** 0 = same model as the chat, otherwise index + 1 into `models`. */
  private approvalModelIdx = 0;
  /** 0 = off (human only), 1 = on (three reviewers). */
  private extremeIdx = 0;
  private models: string[] = [];
  private rowIdx = 0;
  private lastHoverX = -1;
  private lastHoverY = -1;

  onActivate(): void {
    const config = loadConfig();
    const current = String(config.default_intensity ?? "High");
    const i = INTENSITY_LEVELS.indexOf(current);
    this.intensityIdx = i >= 0 ? i : 2;

    const threshold = Number(config.context_compress_threshold ?? 32000);
    const t = COMPRESS_THRESHOLD_OPTIONS.findIndex((o) => o.value === threshold);
    this.thresholdIdx = t >= 0 ? t : 3;

    this.models = Object.values(getModelsByProvider()).flatMap((list) => list.map((m) => m.name));
    const currentApproval = String(config.approval_model ?? "");
    const approvalAt = currentApproval ? this.models.indexOf(currentApproval) : -1;
    this.approvalModelIdx = approvalAt >= 0 ? approvalAt + 1 : 0;
    this.extremeIdx = config.auto_approve_extreme_risk === true ? 1 : 0;
  }

  /** Change the value of a row by `delta` steps and persist it immediately. */
  private cycle(row: RowId, delta: number): void {
    if (row === "intensity") {
      const n = INTENSITY_LEVELS.length;
      this.intensityIdx = (this.intensityIdx + delta + n) % n;
    } else if (row === "approval_model") {
      const n = this.models.length + 1;
      this.approvalModelIdx = (this.approvalModelIdx + delta + n) % n;
    } else if (row === "extreme_approval") {
      // A switch, not a list: any nudge flips it.
      this.extremeIdx = this.extremeIdx === 1 ? 0 : 1;
    } else {
      const n = COMPRESS_THRESHOLD_OPTIONS.length;
      this.thresholdIdx = (this.thresholdIdx + delta + n) % n;
    }
    this.save();
  }

  onKey(key: Key): void {
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
      this.save();
      this.app.render();
    } else if (key.name === "escape") {
      this.save();
      this.app.popScreen();
    }
  }

  onMouse(ev: MouseEvent): void {
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

  private rowTexts(): { label: string; value: string }[] {
    return [
      { label: "Default intensity", value: INTENSITY_LEVELS[this.intensityIdx] },
      { label: "Auto-compress context", value: COMPRESS_THRESHOLD_OPTIONS[this.thresholdIdx].label },
      {
        label: "Approval reviewer model",
        value: this.approvalModelIdx === 0 ? "Same as chat" : this.models[this.approvalModelIdx - 1] ?? "Same as chat",
      },
      {
        label: "Extreme-risk auto-approval",
        value: this.extremeIdx === 1 ? "On (3 reviewers)" : "Off (human only)",
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
    config.context_compress_threshold = COMPRESS_THRESHOLD_OPTIONS[this.thresholdIdx].value;
    config.approval_model = this.approvalModelIdx === 0 ? "" : this.models[this.approvalModelIdx - 1] ?? "";
    config.auto_approve_extreme_risk = this.extremeIdx === 1;
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
      const value = selected ? `◂ ${rows[i].value} ▸` : rows[i].value;
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
      buf.centerText(y, `config: ${CONFIG_FILE}`, { fg: C.dim });
      y += 1;
    }
    if (y < h) {
      drawHint(buf, y, "↑/↓ select  ·  ←/→ change  ·  Enter apply  ·  right-click back  ·  Esc back");
    }
  }
}
