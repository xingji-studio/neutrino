import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { INTENSITY_LEVELS, MODEL_FILE, loadConfig, saveConfig } from "../config.js";
import { drawHeader } from "../header.js";
import { centerVertically, drawHint } from "../ui.js";

export class SettingsScreen extends Screen {
  private intensityIdx = 2;
  private lastHoverX = -1;
  private lastHoverY = -1;

  onActivate(): void {
    const config = loadConfig();
    const current = String(config.default_intensity ?? "High");
    const i = INTENSITY_LEVELS.indexOf(current);
    this.intensityIdx = i >= 0 ? i : 2;
  }

  onKey(key: Key): void {
    if (key.name === "up") {
      this.intensityIdx = (this.intensityIdx + INTENSITY_LEVELS.length - 1) % INTENSITY_LEVELS.length;
      this.app.render();
    } else if (key.name === "down") {
      this.intensityIdx = (this.intensityIdx + 1) % INTENSITY_LEVELS.length;
      this.app.render();
    } else if (key.name === "enter" || key.name === "return") {
      this.save();
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
      for (let i = 0; i < layout.optionYs.length; i++) {
        if (ev.y === layout.optionYs[i] && i !== this.intensityIdx) {
          this.intensityIdx = i;
          this.app.render();
          return;
        }
      }
      return;
    }

    if (ev.type === "wheel") {
      this.intensityIdx =
        (this.intensityIdx + (ev.dir === -1 ? -1 : 1) + INTENSITY_LEVELS.length) % INTENSITY_LEVELS.length;
      this.app.render();
      return;
    }

    if (ev.type === "click") {
      if (ev.button === 2) {
        this.save();
        this.app.popScreen();
        return;
      }
      for (let i = 0; i < layout.optionYs.length; i++) {
        if (ev.y === layout.optionYs[i]) {
          this.intensityIdx = i;
          this.save();
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

  private layout(): { optionYs: number[]; hintY: number } | null {
    const h = this.app.height;
    const lines: string[] = [
      "Settings",
      "",
      `Model: ${this.app.state.selectedProvider}/${this.app.state.selectedModelName}`,
      `Default intensity:`,
    ];
    const total = lines.length + INTENSITY_LEVELS.length + 2;
    const top = centerVertically(h, total);
    const optionYs = INTENSITY_LEVELS.map((_, i) => top + 4 + i);
    const hintY = top + 4 + INTENSITY_LEVELS.length + 2;
    if (hintY > h - 1) return null;
    return { optionYs, hintY };
  }

  private save(): void {
    const config = loadConfig();
    config.default_intensity = INTENSITY_LEVELS[this.intensityIdx];
    saveConfig(config);
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const h = buf.height;

    const lines: string[] = [
      "Settings",
      "",
      `Model: ${this.app.state.selectedProvider}/${this.app.state.selectedModelName}`,
      `Default intensity:`,
    ];

    const content: { text: string; selected: boolean }[] = INTENSITY_LEVELS.map((l, i) => ({
      text: l,
      selected: i === this.intensityIdx,
    }));

    const total = lines.length + content.length + 2;
    const top = centerVertically(h, total);
    let y = top;

    buf.centerText(y, lines[0], { fg: C.accent, bold: true });
    y += 2;
    buf.centerText(y, lines[2], { fg: C.assistant });
    y += 1;
    buf.centerText(y, lines[3], { fg: C.dim });
    y += 1;

    for (const c of content) {
      const text = (c.selected ? "▸ " : "  ") + c.text;
      buf.centerText(y, text, c.selected ? { fg: C.accent, bg: C.highlightBg } : { fg: C.assistant });
      y += 1;
    }

    y += 1;
    buf.centerText(y, `model.json: ${MODEL_FILE}`, { fg: C.dim });
    y += 1;
    if (y < h) {
      drawHint(buf, y, "↑/↓ change  ·  Enter apply  ·  click to choose  ·  right-click back  ·  Esc back");
    }
  }
}
