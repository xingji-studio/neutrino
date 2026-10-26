import type { Buffer } from "./terminal/buffer.js";
import { C } from "./colors.js";

export interface Point {
  x: number;
  y: number;
}

/** A point in *content* space: a line of the scrollable log, plus a column. */
export interface LinePoint {
  line: number;
  x: number;
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

/** Order the two ends of a line-space selection into reading order. */
export function orderLinePoints(a: LinePoint, b: LinePoint): { start: LinePoint; end: LinePoint } {
  if (a.line < b.line || (a.line === b.line && a.x <= b.x)) return { start: a, end: b };
  return { start: b, end: a };
}

/**
 * Index of the last cell on a row that holds real content, or -1 when the row
 * has none. UI chrome (a scrollbar) and blank cells are ignored, so a highlight
 * never spills over the scrollbar column.
 */
function lastContentCol(buf: Buffer, y: number): number {
  const row = buf.cells[y];
  for (let x = row.length - 1; x >= 0; x--) {
    const cell = row[x];
    if (!cell.chrome && cell.ch !== " ") return x;
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
      if (!cell || cell.chrome) continue; // never highlight the scrollbar
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
 * Extract the plain text covered by a selection.
 *
 * Three kinds of cell are skipped so the result is clean, pasteable text:
 *   - UI chrome (the scrollbar), which is never content;
 *   - wide-character continuation cells (`""`), which would duplicate a CJK
 *     glyph;
 *   - trailing blanks, trimmed per line (shell-style).
 *
 * Intermediate lines are copied out to the buffer's full width and only then
 * trimmed, which keeps indentation intact while dropping the padding on the
 * right. Skipping the scrollbar *before* trimming is what lets that trim
 * actually reach the end of the text instead of stopping at the bar.
 */
export function selectionText(buf: Buffer, sel: Selection): string {
  const { start, end } = normalizeSelection(sel);
  const y0 = Math.max(0, start.y);
  const y1 = Math.min(buf.height - 1, end.y);
  const lines: string[] = [];
  for (let y = y0; y <= y1; y++) {
    const x0 = y === start.y ? Math.max(0, start.x) : 0;
    const x1 = y === end.y ? Math.min(buf.width - 1, end.x) : buf.width - 1;
    let line = "";
    for (let x = x0; x <= x1; x++) {
      const cell = buf.cells[y][x];
      if (!cell || cell.chrome || cell.ch === "") continue;
      line += cell.ch;
    }
    lines.push(line.replace(/[ \t]+$/, ""));
  }
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/**
 * One buffer row as column-indexed text: `cells[x]` is what column `x` holds,
 * or `""` for a cell that never copies (UI chrome, and the tail of a
 * double-width glyph).
 *
 * Keeping the column index is the point: it lets a row be sliced by column
 * later, after the frame it came from is long gone. A drag that scrolls the log
 * needs exactly that, because the rows it started on leave the screen while the
 * selection keeps growing.
 */
export function rowCells(buf: Buffer, y: number): string[] {
  const row = buf.cells[y];
  if (!row) return [];
  const cells: string[] = new Array<string>(row.length);
  for (let x = 0; x < row.length; x++) {
    const cell = row[x];
    cells[x] = !cell || cell.chrome || cell.ch === "" ? "" : cell.ch;
  }
  return cells;
}

/**
 * Extract the text of a selection expressed in content lines (`rowSelectionText`
 * is to `selectionText` what `LinePoint` is to `Point`).
 *
 * `getRow` supplies the cells of a line — from the current frame while the line
 * is on screen, from the snapshot taken during the drag once it has scrolled
 * away, or `null` for a line that was never captured. Trailing blanks and edge
 * blank lines are trimmed exactly like `selectionText`, so both paths produce
 * the same text for a selection that fits on one screen.
 */
export function rowSelectionText(
  getRow: (line: number) => readonly string[] | null,
  start: LinePoint,
  end: LinePoint,
): string {
  const lines: string[] = [];
  for (let line = start.line; line <= end.line; line++) {
    const row = getRow(line);
    if (!row) {
      // Never captured (a line that scrolled past without being drawn). Keep
      // the line count honest instead of glueing its neighbours together.
      lines.push("");
      continue;
    }
    const x0 = line === start.line ? Math.max(0, start.x) : 0;
    const x1 = line === end.line ? Math.min(row.length - 1, end.x) : row.length - 1;
    let text = "";
    for (let x = x0; x <= x1; x++) text += row[x] ?? "";
    lines.push(text.replace(/[ \t]+$/, ""));
  }
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}
