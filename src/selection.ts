import type { Buffer } from "./terminal/buffer.js";
import { C } from "./colors.js";

export interface Point {
  x: number;
  y: number;
}

/**
 * A mouse text selection. `anchor` is the cell where the drag started and
 * `cursor` is the cell currently under the pointer; either may be above/left of
 * the other, so consumers normalise before use.
 */
export interface Selection {
  anchor: Point;
  cursor: Point;
}

/** Order the two ends of a selection into reading order (top-left first). */
export function normalizeSelection(sel: Selection): { start: Point; end: Point } {
  const { anchor: a, cursor: b } = sel;
  if (a.y < b.y || (a.y === b.y && a.x <= b.x)) return { start: a, end: b };
  return { start: b, end: a };
}

/** Index of the last non-blank cell on a row, or -1 when the row is empty. */
function lastContentCol(buf: Buffer, y: number): number {
  const row = buf.cells[y];
  for (let x = row.length - 1; x >= 0; x--) {
    if (row[x].ch !== " ") return x;
  }
  return -1;
}

/**
 * Paint the selection highlight directly onto the rendered buffer. Working on
 * the buffer (rather than on each screen) means the highlight automatically
 * follows whatever is on screen — chat output, the input box, menus, …
 *
 * Intermediate lines stop at the last non-blank cell so a multi-line selection
 * doesn't paint a block out to the right edge of the terminal.
 */
export function applySelection(buf: Buffer, sel: Selection): void {
  const { start, end } = normalizeSelection(sel);
  const y0 = Math.max(0, start.y);
  const y1 = Math.min(buf.height - 1, end.y);
  for (let y = y0; y <= y1; y++) {
    const x0 = y === start.y ? Math.max(0, start.x) : 0;
    const x1 = y === end.y ? Math.min(buf.width - 1, end.x) : lastContentCol(buf, y);
    if (x1 < x0) continue;
    for (let x = x0; x <= x1; x++) {
      const cell = buf.cells[y][x];
      if (!cell) continue;
      cell.style = {
        fg: C.white,
        bg: C.selection,
        bold: cell.style.bold,
        italic: cell.style.italic,
      };
    }
  }
}

/**
 * Extract the plain text covered by a selection. Trailing whitespace is trimmed
 * per line (shell-style) and wide-character continuation cells are skipped, so
 * the result can be pasted straight back into a terminal.
 */
export function selectionText(buf: Buffer, sel: Selection): string {
  const { start, end } = normalizeSelection(sel);
  const y0 = Math.max(0, start.y);
  const y1 = Math.min(buf.height - 1, end.y);
  const lines: string[] = [];
  for (let y = y0; y <= y1; y++) {
    const x0 = y === start.y ? Math.max(0, start.x) : 0;
    let x1 = y === end.y ? end.x : buf.width - 1;
    let line = "";
    for (let x = x0; x <= Math.min(buf.width - 1, x1); x++) {
      const cell = buf.cells[y][x];
      if (!cell || cell.ch === "") continue; // "" is the tail of a wide glyph
      line += cell.ch;
    }
    lines.push(line.replace(/[ \t]+$/, ""));
  }
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
