import type { Buffer } from "./terminal/buffer.js";
import { C } from "./colors.js";
import type { AppState } from "./state.js";
import { truncateByWidth } from "./width.js";

export function drawHeader(buf: Buffer, state: AppState): void {
  const w = buf.width;
  buf.fillRect(0, 0, w, 1, { bg: C.highlightBg });
  let text: string;
  if (state.isThinking) {
    text = "thinking";
  } else {
    text = `${state.selectedProvider}/${state.selectedModelName} | ${state.selectedIntensity}`;
  }
  text = truncateByWidth(text, w);
  buf.centerText(0, text, { fg: C.accent, bg: C.highlightBg, bold: true });
}
