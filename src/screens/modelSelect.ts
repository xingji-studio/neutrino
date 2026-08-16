import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key } from "../terminal/input.js";
import { C } from "../colors.js";
import { INTENSITY_LEVELS, getModelsByProvider, type ModelInfo } from "../config.js";
import { drawHeader } from "../header.js";
import { drawTabButton } from "../ui.js";

export class ModelSelectScreen extends Screen {
  private level = 0;
  private providers: string[] = [];
  private modelMap: Record<string, ModelInfo[]> = {};
  private selectedProviderIdx = 0;
  private selectedModelIdx = 0;
  private selectedIntensityIdx = 2;
  private scrollBtn = 0;

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
      this.app.render();
      return;
    }
    if (this.level === 1) {
      const models = this.modelMap[this.providers[this.selectedProviderIdx]] ?? [];
      if (models.length === 0) return;
      this.level = 2;
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
      this.app.render();
    } else {
      this.app.popScreen();
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

    const listTop = 5;
    const btnH = 3;
    const btnGap = 0;
    const stride = btnH + btnGap;
    const hintRow = h - 1;
    const maxVisible = Math.max(1, Math.floor((hintRow - listTop) / stride));

    if (idx < this.scrollBtn) this.scrollBtn = idx;
    if (idx >= this.scrollBtn + maxVisible) this.scrollBtn = idx - maxVisible + 1;
    if (this.scrollBtn < 0) this.scrollBtn = 0;

    let y = listTop;
    for (let i = this.scrollBtn; i < list.length; i++) {
      if (y + btnH > hintRow) break;
      drawTabButton(buf, 1, y, w - 2, list[i], i === idx, "left");
      y += stride;
    }

    buf.centerText(hintRow, "↑/↓ select  ·  Enter confirm  ·  Esc back", { fg: C.dim });
  }

  private currentModelName(): string {
    const models = this.modelMap[this.providers[this.selectedProviderIdx]] ?? [];
    return models[this.selectedModelIdx]?.name ?? "";
  }
}
