import type { Buffer } from "./terminal/buffer.js";
import { C } from "./colors.js";
import type { AppState } from "./state.js";
import { truncateByWidth } from "./width.js";

export function drawHeader(buf: Buffer, state: AppState): void {
  const w = buf.width;

  if (state.isThinking) {
    // Flashing indicator: the whole bar alternates between highlighted and
    // dark while the agent is working, so the user always notices it.
    const on = state.blinkOn;
    const bg = on ? C.highlightBg : C.black;
    const fg = on ? C.accent : C.dim;
    const text = "⚡ thinking";
    buf.fillRect(0, 0, w, 1, { bg });
    buf.centerText(0, text, { fg, bg, bold: true });
    return;
  }

  buf.fillRect(0, 0, w, 1, { bg: C.highlightBg });
  let text: string = `${state.selectedProvider}/${state.selectedModelName} | ${state.selectedIntensity}`;
  text = truncateByWidth(text, w);
  buf.centerText(0, text, { fg: C.accent, bg: C.highlightBg, bold: true });
}
