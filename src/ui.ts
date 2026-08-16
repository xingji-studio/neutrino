import type { Buffer } from "./terminal/buffer.js";
import { C, type Style } from "./colors.js";
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

  let endCp = chars.length;
  let acc = 0;
  for (let i = startCp; i < chars.length; i++) {
    if (acc + widths[i] > innerW) {
      endCp = i;
      break;
    }
    acc += widths[i];
  }

  const visible = chars.slice(startCp, endCp).join("");
  buf.writeText(innerX, innerY, visible, textStyle);

  const cursorScreenCol = cursorCol - prefixW;
  if (active && cursorScreenCol >= 0 && cursorScreenCol < innerW) {
    buf.set(innerX + cursorScreenCol, innerY, " ", { fg: C.black, bg: C.accent });
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
): void {
  const h = 3;
  const labelW = displayWidth(label);
  const lx = x + Math.floor((w - labelW) / 2);
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
