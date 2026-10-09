import process from "node:process";

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  char: string;
  sequence: string;
}

export type MouseEvent =
  | { type: "wheel"; dir: -1 | 1; x: number; y: number }
  | { type: "click"; x: number; y: number; button: number }
  | { type: "move"; x: number; y: number; drag: boolean }
  | { type: "release"; x: number; y: number; button: number };

export type InputEvent =
  | { type: "key"; key: Key }
  | { type: "paste"; text: string }
  | { type: "mouse"; event: MouseEvent };

const ESC_TIMEOUT = 30;

// Bracketed paste: once enabled, the terminal wraps pasted text in
// ESC [ 2 0 0 ~ ... ESC [ 2 0 1 ~ so a paste can be told apart from typing.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Flatten a pasted blob so its line breaks become ordinary spaces. */
function flattenNewlines(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ");
}

/**
 * Heuristic used when a terminal does not speak bracketed paste: a chunk of raw
 * input counts as a paste when it carries a line break that is not merely the
 * chunk's trailing one. A single line break at the very end is a manual Enter,
 * and an all-whitespace chunk is just repeated Enter/space presses.
 */
function looksLikePaste(s: string): boolean {
  const body = s.replace(/(\r\n|\r|\n)$/, "");
  if (!/\r|\n/.test(body)) return false;
  if (/^\s*$/.test(s)) return false;
  return true;
}

/** Length of the longest suffix of `s` that prefixes `marker` (0 if none). */
function partialMarkerLength(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (s.slice(s.length - len) === marker.slice(0, len)) return len;
  }
  return 0;
}

export class InputReader {
  private decoder = new TextDecoder("utf-8");
  private pending = "";
  private state: "normal" | "esc" | "csi" = "normal";
  private csiBuf = "";
  private escTimer: NodeJS.Timeout | null = null;
  private inPaste = false;
  private pasteBuf = "";
  private handler: ((ev: InputEvent) => void) | null = null;
  private dataHandler = (chunk: Buffer) => this.onData(chunk);

  start(handler: (ev: InputEvent) => void): void {
    this.handler = handler;
    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", this.dataHandler);
  }

  stop(): void {
    const stdin = process.stdin;
    stdin.removeListener("data", this.dataHandler);
    if (this.escTimer) clearTimeout(this.escTimer);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }

  private onData(chunk: Buffer): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.process();
  }

  private process(): void {
    const s = this.pending;

    // An unwrapped multi-line paste (terminals without bracketed-paste support
    // deliver the raw text). Flatten it so the whole paste stays on one line
    // and nothing gets submitted — only a manual Enter submits.
    if (!this.inPaste && this.state === "normal" && !s.includes(PASTE_START) && looksLikePaste(s)) {
      this.pending = "";
      this.emitPaste(flattenNewlines(s));
      return;
    }

    let i = 0;
    while (i < s.length) {
      if (this.inPaste) {
        const end = s.indexOf(PASTE_END, i);
        if (end === -1) {
          // No terminator yet: buffer what we have, holding back a possible
          // partial terminator so it can be matched with the next chunk.
          const rest = s.slice(i);
          const keep = partialMarkerLength(rest, PASTE_END);
          this.pasteBuf += rest.slice(0, rest.length - keep);
          this.pending = rest.slice(rest.length - keep);
          return;
        }
        this.pasteBuf += s.slice(i, end);
        this.inPaste = false;
        this.emitPaste(flattenNewlines(this.pasteBuf));
        this.pasteBuf = "";
        i = end + PASTE_END.length;
        continue;
      }

      const c = s[i];
      if (this.state === "normal") {
        if (c === "\x1b") {
          this.state = "esc";
          this.scheduleEscTimeout();
          i++;
          continue;
        }
        const code = c.charCodeAt(0);
        if (c === "\r" || c === "\n") {
          this.emitKey("return", false, false, false, c);
          // A CRLF pair is one Return, not two.
          i += c === "\r" && s[i + 1] === "\n" ? 2 : 1;
          continue;
        }
        if (c === "\t") {
          this.emitKey("tab", false, false, false, c);
          i++;
          continue;
        }
        if (c === "\x7f" || c === "\x08") {
          this.emitKey("backspace", false, false, false, c);
          i++;
          continue;
        }
        if (code >= 1 && code <= 26) {
          const name = String.fromCharCode(code + 96);
          this.emitKey(name, true, false, false, c);
          i++;
          continue;
        }
        if (code === 0) {
          this.emitKey(" ", true, false, false, c);
          i++;
          continue;
        }
        this.emitKey(c, false, false, false, c);
        i++;
        continue;
      }

      if (this.state === "esc") {
        this.cancelEscTimeout();
        if (c === "[" || c === "O") {
          this.state = "csi";
          this.csiBuf = "";
          i++;
          continue;
        }
        if (c === "\x1b") {
          this.emitKey("escape", false, false, false, "\x1b");
          this.state = "esc";
          this.scheduleEscTimeout();
          i++;
          continue;
        }
        this.emitKey(c, false, true, false, "\x1b" + c);
        this.state = "normal";
        i++;
        continue;
      }

      // csi
      this.csiBuf += c;
      const cc = c.charCodeAt(0);
      if (cc >= 0x40 && cc <= 0x7e) {
        this.finishCsi();
        this.state = "normal";
      }
      i++;
    }
    this.pending = "";
  }

  private scheduleEscTimeout(): void {
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.state === "esc") {
        this.state = "normal";
        this.emitKey("escape", false, false, false, "\x1b");
      }
    }, ESC_TIMEOUT);
  }

  private cancelEscTimeout(): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  private finishCsi(): void {
    const s = this.csiBuf;
    const final = s[s.length - 1];
    if (final === "A") this.emitKey("up", false, false, false, "\x1b[A");
    else if (final === "B") this.emitKey("down", false, false, false, "\x1b[B");
    else if (final === "C") this.emitKey("right", false, false, false, "\x1b[C");
    else if (final === "D") this.emitKey("left", false, false, false, "\x1b[D");
    else if (final === "H") this.emitKey("home", false, false, false, "\x1b[H");
    else if (final === "F") this.emitKey("end", false, false, false, "\x1b[F");
    else if (final === "Z") this.emitKey("tab", false, false, true, "\x1b[Z");
    else if (final === "M" || final === "m") {
      if (s[0] === "<") this.handleMouse(s, final);
    } else if (final === "~") {
      const param = s.slice(0, -1);
      if (param === "3") this.emitKey("delete", false, false, false, "\x1b[3~");
      else if (param === "5") this.emitKey("pageup", false, false, false, "\x1b[5~");
      else if (param === "6") this.emitKey("pagedown", false, false, false, "\x1b[6~");
      else if (param === "1" || param === "7") this.emitKey("home", false, false, false, "\x1b[1~");
      else if (param === "4" || param === "8") this.emitKey("end", false, false, false, "\x1b[4~");
      else if (param === "200") {
        // Start of a bracketed paste.
        this.inPaste = true;
        this.pasteBuf = "";
      } else if (param === "201") {
        // End marker without a preceding start: ignore.
        this.inPaste = false;
      }
    }
  }

  /**
   * Parse SGR (extended) mouse sequences: ESC [ < b ; x ; y M/m
   *
   * `b` is a bit field: the low two bits are the button (0 left, 1 middle,
   * 2 right, 3 none/release), bit 5 (32) marks a motion event and bit 6 (64)
   * marks a wheel event. A trailing `M` is a press/motion while `m` is a
   * release. So motion with the left button held (a drag) is `b = 32`, whereas
   * plain hover is `b = 35` (32 | 3).
   */
  private handleMouse(s: string, final: string): void {
    const parts = s.slice(1).split(";");
    if (parts.length < 3) return;
    const b = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10) - 1;
    const y = parseInt(parts[2], 10) - 1;
    if (Number.isNaN(b) || Number.isNaN(x) || Number.isNaN(y)) return;

    const button = b & 3;
    const motion = (b & 32) !== 0;
    const wheel = (b & 64) !== 0;

    if (wheel) {
      this.emitMouse({ type: "wheel", dir: button === 0 ? -1 : 1, x, y });
      return;
    }
    if (final === "m") {
      this.emitMouse({ type: "release", x, y, button });
      return;
    }
    if (motion) {
      this.emitMouse({ type: "move", x, y, drag: button === 0 });
      return;
    }
    if (button !== 3) {
      this.emitMouse({ type: "click", x, y, button });
    }
  }

  private emitKey(
    name: string,
    ctrl: boolean,
    meta: boolean,
    shift: boolean,
    char: string,
  ): void {
    if (!this.handler) return;
    this.handler({
      type: "key",
      key: {
        name,
        ctrl,
        meta,
        shift,
        char,
        sequence: char,
      },
    });
  }

  private emitPaste(text: string): void {
    if (!this.handler || !text) return;
    this.handler({ type: "paste", text });
  }

  private emitMouse(event: MouseEvent): void {
    if (!this.handler) return;
    this.handler({ type: "mouse", event });
  }
}
