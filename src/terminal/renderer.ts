import process from "node:process";
import type { Buffer } from "./buffer.js";
import { TUI_TEARDOWN, markTerminalRestored, markTuiActive } from "./restore.js";
import { type Style } from "../colors.js";
import { isControlChar } from "../sanitize.js";

function styleKey(st: Style): string {
  let k = "";
  if (st.fg) k += "f" + st.fg.join(",") + ";";
  if (st.bg) k += "b" + st.bg.join(",") + ";";
  if (st.bold) k += "B";
  if (st.dim) k += "d";
  if (st.inverse) k += "i";
  if (st.italic) k += "I";
  return k;
}

function sgr(st: Style): string {
  const codes: string[] = [];
  if (st.bold) codes.push("1");
  if (st.dim) codes.push("2");
  if (st.italic) codes.push("3");
  if (st.inverse) codes.push("7");
  if (st.fg) codes.push(`38;2;${st.fg[0]};${st.fg[1]};${st.fg[2]}`);
  if (st.bg) codes.push(`48;2;${st.bg[0]};${st.bg[1]};${st.bg[2]}`);
  if (codes.length === 0) return "\x1b[0m";
  return "\x1b[0;" + codes.join(";") + "m";
}

function rowSignature(row: import("./buffer.js").Cell[]): string {
  let out = "";
  for (let i = 0; i < row.length; i++) {
    const c = row[i];
    out += c.ch + "\u0000" + styleKey(c.style) + "\u0001";
  }
  return out;
}

export class Renderer {
  private prevSig: string[] = [];
  private disposed = false;
  private prevW = 0;
  private prevH = 0;
  private out = process.stdout;
  /**
   * The most recent frame and the rows that were force-repainted for it. Kept
   * so `repaint()` can re-emit the exact same frame — without re-running the
   * screen's (potentially expensive) render — to heal any drift the terminal
   * introduced behind our back.
   */
  private lastBuf: Buffer | null = null;
  private lastForce: readonly number[] = [];

  init(): void {
    // Tell the crash guard the terminal is ours *before* touching it, so a
    // crash that skips dispose() can still undo every switch below.
    markTuiActive();
    this.write("\x1b[?1049h"); // alternate screen
    this.write("\x1b[?25l"); // hide cursor
    this.write("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?1015h"); // mouse tracking (incl. any-event for hover)
    this.write("\x1b[?2004h"); // bracketed paste (so pastes can be told apart from typing)
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.write(TUI_TEARDOWN);
    // The terminal is back to normal, so the exit guard must not write again.
    markTerminalRestored();
  }

  /**
   * @param forceRows rows to repaint unconditionally, even when their contents
   *   are unchanged. Screens use this for persistent chrome (input box, hints)
   *   so that terminal-side drift can never leave it stale (see
   *   `Screen.alwaysRepaintRows`).
   */
  render(buf: Buffer, forceRows: readonly number[] = []): void {
    this.lastBuf = buf;
    this.lastForce = forceRows;
    this.draw(buf, forceRows);
  }

  /**
   * Re-emit the last frame in full. Cheap (no screen re-render) and visually a
   * no-op when nothing drifted, but it repairs rows the terminal moved on its
   * own (resize reflow, stray scroll). Called periodically as a safety net.
   */
  repaint(): void {
    if (!this.lastBuf) return;
    const all: number[] = [];
    for (let y = 0; y < this.lastBuf.height; y++) all.push(y);
    this.draw(this.lastBuf, all);
  }

  private draw(buf: Buffer, forceRows: readonly number[]): void {
    const w = buf.width;
    const h = buf.height;
    if (w !== this.prevW || h !== this.prevH) {
      this.prevSig = new Array(h).fill("");
      this.prevW = w;
      this.prevH = h;
    }
    const force = forceRows.length ? new Set(forceRows) : null;
    let out = "";
    for (let y = 0; y < h; y++) {
      const row = buf.cells[y];
      const sig = rowSignature(row);
      if (sig !== this.prevSig[y] || (force !== null && force.has(y))) {
        out += this.renderRow(y, row);
        this.prevSig[y] = sig;
      }
    }
    if (out) this.write(out);
  }

  private renderRow(y: number, row: import("./buffer.js").Cell[]): string {
    // Move to the row, reset attributes and erase the whole line first. The
    // erase is belt-and-braces: every cell is written below anyway, but this
    // guarantees no stale glyph can survive even if a row somehow ends up
    // shorter than what was on screen before (this is what produced the
    // "residual line above the input box" artefact).
    let s = `\x1b[${y + 1};1H\x1b[0m\x1b[K`;
    let lastKey = "";
    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (cell.ch === "") continue; // tail of the wide glyph to the left
      const sk = styleKey(cell.style);
      if (sk !== lastKey) {
        s += sgr(cell.style);
        lastKey = sk;
      }
      // Final safety net: the byte stream is the one place a stray control
      // character would be executed by the terminal (cursor moves, screen
      // clears, …). The Buffer already neutralises them; this guarantees it
      // even if a cell is ever populated by some other path.
      s += isControlChar(cell.ch) ? " " : cell.ch;
    }
    s += "\x1b[0m";
    return s;
  }

  private write(chunk: string): void {
    if (this.out.destroyed || this.out.writableEnded) return;
    try {
      this.out.write(chunk);
    } catch {
      // A terminal that vanished (closed window, dying conhost) must not take
      // the whole session down with it.
    }
  }
}
