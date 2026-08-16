import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key } from "../terminal/input.js";
import { C } from "../colors.js";
import { INTENSITY_LEVELS, getModelsByProvider, type ModelInfo } from "../config.js";
import { drawHeader } from "../header.js";
import { centerVertically } from "../ui.js";

export class ModelSelectScreen extends Screen {
  private level = 0;
  private providers: string[] = [];
  private modelMap: Record<string, ModelInfo[]> = {};
  private selectedProviderIdx = 0;
  private selectedModelIdx = 0;
  private selectedIntensityIdx = 2;

  onActivate(): void {
    const map = getModelsByProvider();
    this.providers = Object.keys(map);
    this.modelMap = map;
    this.selectedProviderIdx = 0;
    this.selectedModelIdx = 0;
    this.selectedIntensityIdx = 2;
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

    const title = "Model Selection";
    let subtitle = "";
    if (this.level === 0) subtitle = "Select a provider";
    else if (this.level === 1) subtitle = this.providers[this.selectedProviderIdx] ?? "";
    else subtitle = `Model: ${this.currentModelName()} - Select Intensity`;

    const contentLines: { text: string; selected: boolean }[] = list.map((name, i) => ({
      text: name,
      selected: i === idx,
    }));

    const totalLines = 1 + 1 + 1 + contentLines.length;
    const top = centerVertically(h, totalLines);

    let y = top;
    buf.centerText(y, title, { fg: C.accent, bold: true });
    y += 1;
    buf.centerText(y, subtitle, { fg: C.assistant });
    y += 1;

    for (const line of contentLines) {
      const prefix = line.selected ? "▸ " : "  ";
      const text = prefix + line.text;
      buf.centerText(y, text, line.selected ? { fg: C.accent, bg: C.highlightBg } : { fg: C.assistant });
      y += 1;
    }

    const hintY = y + 1;
    if (hintY < h) {
      buf.centerText(hintY, "↑/↓ navigate  ·  Enter confirm  ·  Esc back", { fg: C.dim });
    }
  }

  private currentModelName(): string {
    const models = this.modelMap[this.providers[this.selectedProviderIdx]] ?? [];
    return models[this.selectedModelIdx]?.name ?? "";
  }
}
