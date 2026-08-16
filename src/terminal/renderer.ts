import process from "node:process";
import type { Buffer } from "./buffer.js";
import { type Style } from "../colors.js";

function styleKey(st: Style): string {
  let k = "";
  if (st.fg) k += "f" + st.fg.join(",") + ";";
  if (st.bg) k += "b" + st.bg.join(",") + ";";
  if (st.bold) k += "B";
  if (st.dim) k += "d";
  if (st.inverse) k += "i";
  return k;
}

function sgr(st: Style): string {
  const codes: string[] = [];
  if (st.bold) codes.push("1");
  if (st.dim) codes.push("2");
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
  private prevW = 0;
  private prevH = 0;
  private out = process.stdout;

  init(): void {
    this.write("\x1b[?1049h"); // alternate screen
    this.write("\x1b[?25l"); // hide cursor
    this.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1015h"); // mouse tracking
  }

  dispose(): void {
    this.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1015l");
    this.write("\x1b[?25h");
    this.write("\x1b[?1049l");
    this.write("\x1b[0m");
  }

  render(buf: Buffer): void {
    const w = buf.width;
    const h = buf.height;
    if (w !== this.prevW || h !== this.prevH) {
      this.prevSig = new Array(h).fill("");
      this.prevW = w;
      this.prevH = h;
    }
    let out = "";
    for (let y = 0; y < h; y++) {
      const row = buf.cells[y];
      const sig = rowSignature(row);
      if (sig !== this.prevSig[y]) {
        out += this.renderRow(y, row);
        this.prevSig[y] = sig;
      }
    }
    if (out) this.write(out);
  }

  private renderRow(y: number, row: import("./buffer.js").Cell[]): string {
    let s = `\x1b[${y + 1};1H`;
    let lastKey = "";
    for (let x = 0; x < row.length; x++) {
      const cell = row[x];
      if (cell.ch === "") continue;
      const sk = styleKey(cell.style);
      if (sk !== lastKey) {
        s += sgr(cell.style);
        lastKey = sk;
      }
      s += cell.ch;
    }
    s += "\x1b[0m";
    return s;
  }

  private write(chunk: string): void {
    this.out.write(chunk);
  }
}
