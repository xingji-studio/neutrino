import type { Buffer } from "./terminal/buffer.js";
import { C } from "./colors.js";
import type { AppState } from "./state.js";
import { truncateByWidth } from "./width.js";

export function drawHeader(buf: Buffer, state: AppState): void {
  const w = buf.width;

  if (state.approval) {
    // A tool call is waiting for an answer: the whole bar turns orange so it
    // cannot be missed while the agent sits paused mid-turn.
    const bg = C.orange;
    buf.fillRect(0, 0, w, 1, { bg });
    buf.centerText(0, "Request Approval", { fg: C.black, bg, bold: true });
    return;
  }

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
  if (state.webUrl) {
    // A short reminder that the browser console is live; the startup message
    // prints the full addresses when more than one works.
    text += `  ·  web ${state.webUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }
  text = truncateByWidth(text, w);
  buf.centerText(0, text, { fg: C.accent, bg: C.highlightBg, bold: true });
}
