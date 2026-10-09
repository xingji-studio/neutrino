import type { Buffer } from "./terminal/buffer.js";
import { C, type RGB, type Style } from "./colors.js";
import { displayWidth, truncateByWidth, wcwidth } from "./width.js";

function chunkByWidth(text: string, width: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  let curW = 0;
  for (const ch of text) {
    const w = wcwidth(ch.codePointAt(0) ?? 0);
    if (curW + w > width && cur.length > 0) {
      chunks.push(cur);
      cur = ch;
      curW = w;
    } else {
      cur += ch;
      curW += w;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) width = 1;
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of para.split(" ")) {
      const wordW = displayWidth(word);
      if (line.length === 0) {
        if (wordW <= width) {
          line = word;
          lineW = wordW;
        } else {
          const chunks = chunkByWidth(word, width);
          for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
          line = chunks[chunks.length - 1];
          lineW = displayWidth(line);
        }
        continue;
      }
      if (lineW + 1 + wordW <= width) {
        line += " " + word;
        lineW += 1 + wordW;
      } else {
        lines.push(line);
        if (wordW <= width) {
          line = word;
          lineW = wordW;
        } else {
          const chunks = chunkByWidth(word, width);
          for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
          line = chunks[chunks.length - 1];
          lineW = displayWidth(line);
        }
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface InputBoxOptions {
  active?: boolean;
  dimmed?: boolean;
  placeholder?: string;
  /** Blink phase of the text cursor. When false the cursor is hidden (the
   *  character underneath is shown normally). */
  cursorOn?: boolean;
}

export interface InputWindow {
  /** Index (in UTF-16 code points) of the first visible character. */
  startCp: number;
  /** Display columns before the visible window. */
  prefixW: number;
  /** Number of visible characters. */
  visibleCount: number;
}

/**
 * Compute which part of the input value is visible inside the box, given the
 * cursor position. Shared by `drawInputBox` and mouse click handling so the
 * rendered text and click-to-position-cursor always agree.
 */
export function computeInputWindow(value: string, cursorPos: number, innerW: number): InputWindow {
  const chars = Array.from(value);
  const widths = chars.map((ch) => wcwidth(ch.codePointAt(0) ?? 0));
  const cursorCp = Math.min(Array.from(value.slice(0, cursorPos)).length, chars.length);

  let cursorCol = 0;
  for (let i = 0; i < cursorCp; i++) cursorCol += widths[i];

  let startCp = 0;
  if (cursorCol >= innerW) {
    let acc = 0;
    startCp = cursorCp;
    while (startCp > 0) {
      const pw = widths[startCp - 1];
      if (acc + pw <= innerW - 1) {
        acc += pw;
        startCp--;
      } else {
        break;
      }
    }
  }

  let prefixW = 0;
  for (let i = 0; i < startCp; i++) prefixW += widths[i];

  let visibleCount = 0;
  let acc = 0;
  for (let i = startCp; i < chars.length; i++) {
    if (acc + widths[i] > innerW) break;
    acc += widths[i];
    visibleCount++;
  }

  return { startCp, prefixW, visibleCount };
}

/**
 * Map a column inside the input box (0-based, relative to the inner area) to a
 * cursor index in the full value.
 */
export function cursorFromColumn(value: string, col: number, win: InputWindow): number {
  const chars = Array.from(value);
  if (col <= 0) return win.startCp;
  let acc = 0;
  let i = win.startCp;
  while (i < chars.length) {
    const w = wcwidth(chars[i].codePointAt(0) ?? 0);
    if (col < acc + w) return i;
    acc += w;
    i++;
  }
  return i;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function inRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}

export function drawHint(buf: Buffer, y: number, text: string): void {
  const max = buf.width;
  const t = displayWidth(text) <= max ? text : truncateByWidth(text, max - 1) + "…";
  buf.centerText(y, t, { fg: C.dim });
}

export interface ScrollbarOptions {
  /** Colour of the groove. Defaults to `C.scrollTrack`. */
  track?: RGB;
  /** Colour of the thumb. Defaults to `C.scrollThumb`. */
  thumb?: RGB;
}

/**
 * Draw a vertical scrollbar in column `x`, spanning rows `top`..`bottom`
 * (inclusive). It is a no-op when everything fits, so callers can render it
 * unconditionally.
 *
 *   total    - total number of scrollable items/lines
 *   viewport - how many of them are visible at once
 *   offset   - index of the topmost visible item (i.e. the current scrollTop)
 *
 * The thumb length is proportional to `viewport / total` (at least one cell)
 * and its position is proportional to `offset / (total - viewport)`, matching
 * the usual GUI scrollbar behaviour.
 */
export interface ScrollbarGeometry {
  /** Height of the groove in cells. */
  trackH: number;
  /** Height of the thumb in cells (at least 1). */
  thumbH: number;
  /** Largest allowed top row of the thumb, relative to the groove. */
  maxThumbTop: number;
  /** Largest valid scroll offset (total - viewport). */
  maxOffset: number;
  /** Current top row of the thumb, relative to the groove. */
  thumbTop: number;
}

/**
 * Geometry of a vertical scrollbar, shared by the drawing code and the app's
 * hit-testing / dragging so the two can never disagree.
 */
export function scrollbarGeometry(
  top: number,
  bottom: number,
  total: number,
  viewport: number,
  offset: number,
): ScrollbarGeometry {
  const trackH = Math.max(0, bottom - top + 1);
  const thumbH = Math.max(1, Math.round((trackH * viewport) / total));
  const maxThumbTop = Math.max(0, trackH - thumbH);
  const maxOffset = Math.max(1, total - viewport);
  const clamped = Math.max(0, Math.min(offset, maxOffset));
  const thumbTop = maxThumbTop === 0 ? 0 : Math.round((maxThumbTop * clamped) / maxOffset);
  return { trackH, thumbH, maxThumbTop, maxOffset, thumbTop };
}

/**
 * Inverse of the thumb positioning above: the scroll offset that places the
 * thumb's top at 'thumbTop'. Used while dragging the thumb; feeding the result
 * back through scrollbarGeometry reproduces the same 'thumbTop'.
 */
export function offsetFromThumbTop(g: ScrollbarGeometry, thumbTop: number): number {
  if (g.maxThumbTop === 0) return 0;
  const t = Math.max(0, Math.min(thumbTop, g.maxThumbTop));
  return Math.round((g.maxOffset * t) / g.maxThumbTop);
}

export function drawScrollbar(
  buf: Buffer,
  x: number,
  top: number,
  bottom: number,
  total: number,
  viewport: number,
  offset: number,
  opts: ScrollbarOptions = {},
): void {
  const trackH = bottom - top + 1;
  if (trackH <= 0 || x < 0 || x >= buf.width) return;
  if (total <= viewport || viewport <= 0) return; // nothing to scroll: hide it

  const trackColor = opts.track ?? C.scrollTrack;
  const thumbColor = opts.thumb ?? C.scrollThumb;

  const g = scrollbarGeometry(top, bottom, total, viewport, offset);
  for (let i = 0; i < g.trackH; i++) {
    const isThumb = i >= g.thumbTop && i < g.thumbTop + g.thumbH;
    buf.set(x, top + i, isThumb ? "█" : "│", { fg: isThumb ? thumbColor : trackColor });
  }
}

export function drawInputBox(
  buf: Buffer,
  x: number,
  y: number,
  w: number,
  value: string,
  cursorPos: number,
  opts: InputBoxOptions = {},
): void {
  const active = opts.active ?? true;
  const dimmed = opts.dimmed ?? false;
  const placeholder = opts.placeholder ?? "";
  const cursorOn = opts.cursorOn ?? true;
  const h = 3;
  const innerX = x + 2;
  const innerW = w - 4;
  const innerY = y + 1;

  if (active) buf.fillRect(x, y, w, h, { bg: C.highlightBg });

  const textStyle: Style = dimmed
    ? { fg: C.dim, bg: C.highlightBg }
    : active
      ? { fg: C.white, bg: C.highlightBg }
      : { fg: C.dim };

  if (value.length === 0) {
    buf.writeText(innerX, innerY, truncateByWidth(placeholder, innerW), textStylePlaceholder(active));
    return;
  }

  const win = computeInputWindow(value, cursorPos, innerW);
  const chars = Array.from(value);
  // Codepoint index of the cursor (cursorPos is a UTF-16 offset).
  const cursorCp = Math.min(Array.from(value.slice(0, cursorPos)).length, chars.length);
  const visible = chars.slice(win.startCp, win.startCp + win.visibleCount).join("");
  buf.writeText(innerX, innerY, visible, textStyle);

  // Blinking block cursor. While it is "on" the character underneath is drawn
  // inside the block in the opposite colour so the text stays legible instead
  // of being hidden by the cursor.
  const cursorScreenCol = cursorColAt(chars, cursorCp, win);
  if (active && cursorOn && cursorScreenCol >= 0 && cursorScreenCol < innerW) {
    drawBlockCursor(buf, innerX + cursorScreenCol, innerY, chars, cursorCp, cursorScreenCol, innerW);
  }
}

function cursorColAt(chars: string[], cursorCp: number, win: InputWindow): number {
  let col = win.prefixW;
  for (let i = win.startCp; i < cursorCp; i++) {
    col += wcwidth(chars[i].codePointAt(0) ?? 0);
  }
  return col - win.prefixW;
}

/**
 * Draw a single block cursor cell. The glyph under the cursor (the character
 * immediately to its right) is rendered in the opposite colour — a dark glyph
 * on the accent block — so it remains readable. Past the end of the text, or
 * when the glyph would not fit, a solid block is drawn instead.
 */
function drawBlockCursor(
  buf: Buffer,
  x: number,
  y: number,
  chars: string[],
  cursorCp: number,
  col: number,
  innerW: number,
): void {
  const cursorStyle: Style = { fg: C.black, bg: C.accent };
  const ch = cursorCp < chars.length ? chars[cursorCp] : "";
  const cw = ch ? wcwidth(ch.codePointAt(0) ?? 0) : 0;
  if (ch && ch !== " " && cw >= 1 && col + cw <= innerW) {
    buf.writeText(x, y, ch, cursorStyle);
  } else {
    buf.set(x, y, " ", cursorStyle);
  }
}

function textStylePlaceholder(active: boolean): Style {
  return active ? { fg: C.dim, bg: C.highlightBg } : { fg: C.dim };
}

export function drawTabButton(
  buf: Buffer,
  x: number,
  y: number,
  w: number,
  label: string,
  selected: boolean,
  align: "center" | "left" = "center",
): void {
  const h = 3;
  const labelW = displayWidth(label);
  const lx = align === "left" ? x + 3 : x + Math.floor((w - labelW) / 2);
  if (selected) {
    buf.fillRect(x, y, w, h, { bg: C.highlightBg });
    buf.writeText(lx, y + 1, label, { fg: C.accent, bg: C.highlightBg, bold: true });
  } else {
    buf.writeText(lx, y + 1, label, { fg: C.dim });
  }
}

export function centerVertically(totalHeight: number, contentHeight: number): number {
  const top = Math.floor((totalHeight - contentHeight) / 2);
  return Math.max(1, top);
}
