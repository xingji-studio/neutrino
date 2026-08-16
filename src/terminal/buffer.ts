import { C, EMPTY_STYLE, type Style } from "../colors.js";
import { displayWidth, wcwidth } from "../width.js";

export interface Cell {
  ch: string;
  style: Style;
}

const emptyCell = (): Cell => ({ ch: " ", style: { bg: C.black } });

function normalize(style: Style): Style {
  return style.bg ? style : { ...style, bg: C.black };
}

export class Buffer {
  width: number;
  height: number;
  cells: Cell[][];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, emptyCell),
    );
  }

  set(x: number, y: number, ch: string, style: Style = EMPTY_STYLE): void {
    if (ch === "\r" || ch === "\n") return;
    if (y < 0 || y >= this.height || x < 0 || x >= this.width) return;
    this.cells[y][x] = { ch, style: normalize(style) };
  }

  writeText(x: number, y: number, text: string, style: Style = EMPTY_STYLE): void {
    if (y < 0 || y >= this.height) return;
    let col = x;
    for (const ch of text) {
      const w = wcwidth(ch.codePointAt(0) ?? 0);
      if (w === 0) {
        if (col - 1 >= x && col - 1 >= 0 && col - 1 < this.width) {
          this.cells[y][col - 1].ch += ch;
        }
        continue;
      }
      if (col >= this.width) break;
      if (col < 0) {
        col += w;
        continue;
      }
      this.cells[y][col] = { ch, style: normalize(style) };
      if (w === 2 && col + 1 < this.width) {
        this.cells[y][col + 1] = { ch: "", style: normalize(style) };
      }
      col += w;
    }
  }

  centerText(y: number, text: string, style: Style = EMPTY_STYLE): void {
    const w = displayWidth(text);
    const x = Math.floor((this.width - w) / 2);
    this.writeText(x, y, text, style);
  }

  fillRect(
    x: number,
    y: number,
    w: number,
    h: number,
    style: Style = EMPTY_STYLE,
  ): void {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        this.set(i, j, " ", style);
      }
    }
  }

  drawBox(x: number, y: number, w: number, h: number, style: Style = EMPTY_STYLE): void {
    if (w < 2 || h < 2) return;
    const top = "┌" + "─".repeat(w - 2) + "┐";
    const bottom = "└" + "─".repeat(w - 2) + "┘";
    this.writeText(x, y, top, style);
    for (let j = y + 1; j < y + h - 1; j++) {
      this.set(x, j, "│", style);
      this.set(x + w - 1, j, "│", style);
    }
    this.writeText(x, y + h - 1, bottom, style);
  }

  clear(): void {
    for (let j = 0; j < this.height; j++) {
      const row = this.cells[j];
      for (let i = 0; i < this.width; i++) {
        row[i] = { ch: " ", style: { bg: C.black } };
      }
    }
  }
}
