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

function cellWidth(ch: string): number {
  return ch ? wcwidth(ch.codePointAt(0) ?? 0) : 0;
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

  /**
   * Write a single cell, keeping the wide-glyph invariant intact. The renderer
   * (and the selection logic) rely on the rule that a `""` cell is *always* the
   * right half of a double-width glyph at `x - 1`. If the invariant is broken an
   * orphan tail is left behind: the renderer skips it, so that column is never
   * repainted and a stale glyph from the previous frame stays on screen (the
   * "residual line" bug). To preserve it we blank the *other* half whenever we
   * overwrite one half of a wide glyph.
   */
  private overwriteCell(x: number, y: number, ch: string, style: Style): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const row = this.cells[y];
    const prev = row[x];
    if (prev.ch === "" && x > 0) {
      // We're overwriting a wide glyph's tail: blank its head.
      row[x - 1] = { ch: " ", style: row[x - 1].style };
    } else if (cellWidth(prev.ch) === 2 && x + 1 < this.width) {
      // We're overwriting a wide glyph's head: blank its tail.
      row[x + 1] = { ch: " ", style: row[x + 1].style };
    }
    row[x] = { ch, style: normalize(style) };
  }

  /**
   * Mark `x` as the tail (`""`) of the wide glyph at `x - 1`. Unlike
   * `overwriteCell` this never blanks the cell to the left, because that cell is
   * the glyph we are currently writing.
   */
  private writeTail(x: number, y: number, style: Style): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const row = this.cells[y];
    const prev = row[x];
    if (cellWidth(prev.ch) === 2 && x + 1 < this.width) {
      row[x + 1] = { ch: " ", style: row[x + 1].style };
    }
    row[x] = { ch: "", style: normalize(style) };
  }

  private writeChar(x: number, y: number, ch: string, style: Style): void {
    if (cellWidth(ch) === 2) {
      if (x + 1 >= this.width) {
        // No room for the tail: degrade to a space so the line never overflows
        // (which would make the terminal wrap and scroll).
        this.overwriteCell(x, y, " ", style);
        return;
      }
      this.overwriteCell(x, y, ch, style);
      this.writeTail(x + 1, y, style);
      return;
    }
    this.overwriteCell(x, y, ch, style);
  }

  set(x: number, y: number, ch: string, style: Style = EMPTY_STYLE): void {
    if (ch === "\r" || ch === "\n") return;
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.writeChar(x, y, ch, style);
  }

  writeText(x: number, y: number, text: string, style: Style = EMPTY_STYLE): void {
    if (y < 0 || y >= this.height) return;
    let col = x;
    for (const ch of text) {
      const w = wcwidth(ch.codePointAt(0) ?? 0);
      if (w === 0) {
        // Combining mark: attach it to the glyph immediately to the left.
        const px = col - 1;
        if (px >= 0 && px < this.width && this.cells[y][px].ch !== "") {
          this.cells[y][px].ch += ch;
        }
        continue;
      }
      if (col >= this.width) break;
      if (col < 0) {
        col += w;
        continue;
      }
      this.writeChar(col, y, ch, style);
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
