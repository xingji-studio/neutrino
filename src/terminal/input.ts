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
  | { type: "click"; x: number; y: number; button: number };

export type InputEvent =
  | { type: "key"; key: Key }
  | { type: "mouse"; event: MouseEvent };

const ESC_TIMEOUT = 30;

export class InputReader {
  private decoder = new TextDecoder("utf-8");
  private pending = "";
  private state: "normal" | "esc" | "csi" = "normal";
  private csiBuf = "";
  private escTimer: NodeJS.Timeout | null = null;
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
    let i = 0;
    while (i < s.length) {
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
          i++;
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
    }
  }

  private handleMouse(s: string, final: string): void {
    const parts = s.slice(1).split(";");
    if (parts.length < 3) return;
    const b = parseInt(parts[0], 10);
    const x = parseInt(parts[1], 10) - 1;
    const y = parseInt(parts[2], 10) - 1;
    if (Number.isNaN(b) || Number.isNaN(x) || Number.isNaN(y)) return;
    if (b === 64) {
      this.emitMouse({ type: "wheel", dir: -1, x, y });
    } else if (b === 65) {
      this.emitMouse({ type: "wheel", dir: 1, x, y });
    } else if (final === "M" && (b === 0 || b === 1 || b === 2)) {
      this.emitMouse({ type: "click", x, y, button: b });
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

  private emitMouse(event: MouseEvent): void {
    if (!this.handler) return;
    this.handler({ type: "mouse", event });
  }
}
