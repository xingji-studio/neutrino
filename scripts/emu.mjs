// A tiny terminal emulator good enough to detect *residual* cells: it tracks
// absolute cursor positioning (CUP), ignores SGR, and models autowrap + wide
// characters the way xterm does. Feed it the bytes that Renderer produces and
// compare the resulting grid with the Buffer the frame was built from.
//
// It also models the control characters that a renderer must never emit
// (TAB/CR/LF) and flags any other raw control byte, so a cell containing a
// stray control code shows up both as a grid mismatch and as `rawControl`.
import { wcwidth } from "../dist/width.js";

export class Term {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.grid = Array.from({ length: h }, () => new Array(w).fill(" "));
    this.x = 0;
    this.y = 0;
    this.wrap = false;
    this.scrolled = false;
    /** Set when the stream contained a raw control character (other than the
     *  escape sequences a renderer legitimately emits). */
    this.rawControl = false;
  }

  feed(s) {
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === "\x1b") {
        if (s[i + 1] === "[") {
          let j = i + 2;
          while (j < s.length && !/[A-Za-z]/.test(s[j])) j++;
          this.csi(s.slice(i + 2, j), s[j] ?? "");
          i = j + 1;
        } else if (s[i + 1] === "]") {
          // OSC … BEL/ST
          let j = i + 2;
          while (j < s.length && s[j] !== "\x07" && !(s[j] === "\x1b" && s[j + 1] === "\\")) j++;
          i = s[j] === "\x07" ? j + 1 : j + 2;
        } else {
          i += 2;
        }
        continue;
      }
      this.print(c);
      i++;
    }
  }

  csi(params, final) {
    this.wrap = false;
    if (final === "H" || final === "f") {
      const parts = params.split(";").map((n) => parseInt(n, 10));
      const r = parts[0] || 1;
      const cc = parts[1] || 1;
      this.y = r - 1;
      this.x = cc - 1;
    }
  }

  print(ch) {
    const cp = ch.codePointAt(0) ?? 0;
    // Control characters a renderer must never emit: model what the terminal
    // would do with them instead of treating them as glyphs.
    if (cp < 32 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      this.rawControl = true;
      this.wrap = false;
      if (ch === "\t") {
        this.x = Math.min(this.w - 1, (Math.floor(this.x / 8) + 1) * 8);
      } else if (ch === "\r") {
        this.x = 0;
      } else if (ch === "\n") {
        this.x = 0;
        this.y++;
        if (this.y >= this.h) {
          this.scrollUp();
          this.y = this.h - 1;
        }
      }
      return;
    }
    if (this.wrap) {
      this.x = 0;
      this.y++;
      this.wrap = false;
      if (this.y >= this.h) {
        this.scrollUp();
        this.y = this.h - 1;
      }
    }
    const w = Math.max(1, wcwidth(cp));
    if (this.y >= 0 && this.y < this.h && this.x >= 0 && this.x < this.w) {
      this.grid[this.y][this.x] = ch;
    }
    if (w === 2 && this.x + 1 < this.w) this.grid[this.y][this.x + 1] = "\u0000";
    this.x += w;
    if (this.x >= this.w) {
      this.x = this.w - 1;
      this.wrap = true;
    }
  }

  scrollUp() {
    this.scrolled = true;
    this.grid.shift();
    this.grid.push(new Array(this.w).fill(" "));
  }

  rowText(y) {
    return this.grid[y].filter((c) => c !== "\u0000").join("");
  }
}
