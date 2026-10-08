import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { INTENSITY_LEVELS, getModelsByProvider, type ModelInfo } from "../config.js";
import { drawHeader } from "../header.js";
import { drawHint, drawTabButton, inRect } from "../ui.js";

const LIST_TOP = 5;
const BTN_H = 3;
const BTN_X = 1;

export class ModelSelectScreen extends Screen {
  private level = 0;
  private providers: string[] = [];
  private modelMap: Record<string, ModelInfo[]> = {};
  private selectedProviderIdx = 0;
  private selectedModelIdx = 0;
  private selectedIntensityIdx = 2;
  private scrollBtn = 0;
  private lastHoverX = -1;
  private lastHoverY = -1;

  onActivate(): void {
    const map = getModelsByProvider();
    this.providers = Object.keys(map);
    this.modelMap = map;
    this.selectedProviderIdx = 0;
    this.selectedModelIdx = 0;
    this.selectedIntensityIdx = 2;
    this.scrollBtn = 0;
  }

  private currentList(): string[] {
    if (this.level === 0) return this.providers;
    if (this.level === 1) return (this.modelMap[this.providers[this.selectedProviderIdx]] ?? []).map((m) => m.name);
    return INTENSITY_LEVELS;
  }

  private currentIdx(): number {
    if (this.level === 0) return this.selectedProviderIdx;
    if (this.level === 1) return this.selectedModelIdx;
    return this.selectedIntensityIdx;
  }

  private setIdx(idx: number): void {
    if (this.level === 0) this.selectedProviderIdx = idx;
    else if (this.level === 1) this.selectedModelIdx = idx;
    else this.selectedIntensityIdx = idx;
  }

  private move(delta: number): void {
    const list = this.currentList();
    if (list.length === 0) return;
    let idx = this.currentIdx() + delta;
    if (idx < 0) idx = list.length - 1;
    if (idx >= list.length) idx = 0;
    this.setIdx(idx);
    if (this.level === 0) this.selectedModelIdx = 0;
    this.app.render();
  }

  private confirm(): void {
    if (this.level === 0) {
      if (this.providers.length === 0) return;
      this.level = 1;
      this.selectedModelIdx = 0;
      this.scrollBtn = 0;
      this.app.render();
      return;
    }
    if (this.level === 1) {
      const models = this.modelMap[this.providers[this.selectedProviderIdx]] ?? [];
      if (models.length === 0) return;
      this.level = 2;
      this.scrollBtn = 0;
      this.app.render();
      return;
    }
    const providerName = this.providers[this.selectedProviderIdx];
    const models = this.modelMap[providerName] ?? [];
    const model = models[this.selectedModelIdx];
    if (!model) return;
    const intensity = INTENSITY_LEVELS[this.selectedIntensityIdx];
    this.app.setModelConfig(providerName, model, intensity);
    this.app.popScreen();
  }

  private goBack(): void {
    if (this.level > 0) {
      this.level--;
      this.scrollBtn = 0;
      this.app.render();
    } else {
      this.app.popScreen();
    }
  }

  /** Map a terminal row to the list index rendered there, if any. */
  private indexAtRow(y: number): number {
    const list = this.currentList();
    const h = this.app.height;
    const hintRow = h - 1;
    const maxVisible = Math.max(1, Math.floor((hintRow - LIST_TOP) / BTN_H));
    const i = Math.floor((y - LIST_TOP) / BTN_H) + this.scrollBtn;
    if (i < 0 || i >= list.length) return -1;
    const visibleRow = LIST_TOP + (i - this.scrollBtn) * BTN_H;
    if (visibleRow + BTN_H > hintRow) return -1;
    return i;
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type === "move") {
      if (ev.x === this.lastHoverX && ev.y === this.lastHoverY) return;
      this.lastHoverX = ev.x;
      this.lastHoverY = ev.y;
      const list = this.currentList();
      if (list.length === 0) return;
      const i = this.indexAtRow(ev.y);
      if (i >= 0 && i !== this.currentIdx()) {
        this.setIdx(i);
        this.app.render();
      }
      return;
    }
    if (ev.type === "wheel") {
      this.move(ev.dir === -1 ? -1 : 1);
      return;
    }
    if (ev.type === "click") {
      if (ev.button === 2) {
        this.goBack();
        return;
      }
      if (ev.y < LIST_TOP || ev.y >= this.app.height - 1) return;
      const i = this.indexAtRow(ev.y);
      if (i < 0) return;
      if (!inRect(ev.x, ev.y, { x: BTN_X, y: LIST_TOP + (i - this.scrollBtn) * BTN_H, w: this.app.width - 2, h: BTN_H })) {
        return;
      }
      this.setIdx(i);
      this.confirm();
      return;
    }
  }

  onKey(key: Key): void {
    if (key.name === "up") this.move(-1);
    else if (key.name === "down") this.move(1);
    else if (key.name === "enter" || key.name === "return") this.confirm();
    else if (key.name === "escape") this.goBack();
    else if (key.name === "left") this.goBack();
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);

    const w = buf.width;
    const h = buf.height;
    const list = this.currentList();
    const idx = this.currentIdx();

    buf.centerText(2, "Model Selection", { fg: C.accent, bold: true });

    let subtitle = "";
    if (this.level === 0) subtitle = "Select a provider";
    else if (this.level === 1) subtitle = this.providers[this.selectedProviderIdx] ?? "";
    else subtitle = `Model: ${this.currentModelName()} - Select Intensity`;
    buf.centerText(3, subtitle, { fg: C.white });

    const btnH = BTN_H;
    const btnGap = 0;
    const stride = btnH + btnGap;
    const hintRow = h - 1;
    const maxVisible = Math.max(1, Math.floor((hintRow - LIST_TOP) / stride));

    if (idx < this.scrollBtn) this.scrollBtn = idx;
    if (idx >= this.scrollBtn + maxVisible) this.scrollBtn = idx - maxVisible + 1;
    if (this.scrollBtn < 0) this.scrollBtn = 0;

    let y = LIST_TOP;
    for (let i = this.scrollBtn; i < list.length; i++) {
      if (y + btnH > hintRow) break;
      drawTabButton(buf, BTN_X, y, w - 2, list[i], i === idx, "left");
      y += stride;
    }

    drawHint(buf, hintRow, "↑/↓ select  ·  Enter confirm  ·  click to choose  ·  right-click back  ·  Esc back");
  }

  private currentModelName(): string {
    const models = this.modelMap[this.providers[this.selectedProviderIdx]] ?? [];
    return models[this.selectedModelIdx]?.name ?? "";
  }
}
