import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key } from "../terminal/input.js";
import { C } from "../colors.js";
import { loadLogo } from "../config.js";
import { drawHeader } from "../header.js";
import { centerVertically, drawInputBox, drawTabButton } from "../ui.js";

const TABS = ["Model", "History", "Settings"];
const LOGO = loadLogo();

const FOCUS_COUNT = TABS.length + 1; // input box + 3 tabs

export class StartScreen extends Screen {
  private inputValue = "";
  private cursor = 0;
  private focusIdx = 0; // 0 = input box, 1..3 = tabs

  onKey(key: Key): void {
    if (key.name === "left" || key.name === "up") {
      this.move(-1);
      return;
    }
    if (key.name === "right" || key.name === "down") {
      this.move(1);
      return;
    }
    if (key.name === "return") {
      if (this.focusIdx === 0) {
        const text = this.inputValue.trim();
        if (text) this.app.startNewChat(text);
      } else {
        this.enterTab();
      }
      return;
    }
    if (this.focusIdx !== 0) return;
    if (key.name === "backspace") {
      if (this.cursor > 0) {
        this.inputValue =
          this.inputValue.slice(0, this.cursor - 1) + this.inputValue.slice(this.cursor);
        this.cursor--;
        this.app.render();
      }
      return;
    }
    if (key.name === "delete") {
      if (this.cursor < this.inputValue.length) {
        this.inputValue =
          this.inputValue.slice(0, this.cursor) + this.inputValue.slice(this.cursor + 1);
        this.app.render();
      }
      return;
    }
    if (key.name === "home") {
      this.cursor = 0;
      this.app.render();
      return;
    }
    if (key.name === "end") {
      this.cursor = this.inputValue.length;
      this.app.render();
      return;
    }
    if (key.ctrl && key.name === "u") {
      this.inputValue = "";
      this.cursor = 0;
      this.app.render();
      return;
    }
    if (!key.ctrl && !key.meta && key.name.length === 1) {
      this.inputValue =
        this.inputValue.slice(0, this.cursor) + key.name + this.inputValue.slice(this.cursor);
      this.cursor++;
      this.app.render();
    }
  }

  private move(delta: number): void {
    this.focusIdx = (this.focusIdx + delta + FOCUS_COUNT) % FOCUS_COUNT;
    this.app.render();
  }

  private enterTab(): void {
    if (this.focusIdx === 1) this.app.openModelConfig();
    else if (this.focusIdx === 2) this.app.openHistory();
    else this.app.openSettings();
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);

    const w = buf.width;
    const h = buf.height;
    const inputW = Math.min(78, w - 4);
    const inputX = Math.floor((w - inputW) / 2);

    const logoLines = LOGO.replace(/\n+$/, "").split("\n");
    const logoMax = logoLines.reduce((m, l) => Math.max(m, l.length), 0);
    const logoX = Math.max(0, Math.floor((w - logoMax) / 2));
    const gap = 1;
    const inputBoxH = 3;
    const tabH = 3;
    const contentH = logoLines.length + 1 + inputBoxH + gap + tabH;
    const top = centerVertically(h, contentH);

    let y = top;
    for (const line of logoLines) {
      buf.writeText(logoX, y, line, { fg: C.accent, bold: true });
      y++;
    }
    y += 1;

    drawInputBox(buf, inputX, y, inputW, this.inputValue, this.cursor, {
      active: this.focusIdx === 0,
      placeholder: "Type a message to start a new chat...",
    });
    y += inputBoxH + gap;

    const tabGap = 2;
    const tabInner = inputW - tabGap * (TABS.length - 1);
    const baseW = Math.floor(tabInner / TABS.length);
    const extra = tabInner - baseW * TABS.length;
    let tx = inputX;
    for (let i = 0; i < TABS.length; i++) {
      const tw = baseW + (i < extra ? 1 : 0);
      drawTabButton(buf, tx, y, tw, TABS[i], i === this.focusIdx - 1);
      tx += tw + tabGap;
    }

    const hintY = y + tabH + 1;
    if (hintY < h) {
      buf.centerText(hintY, "←/→ / ↑/↓ switch  ·  Enter confirm  ·  Ctrl+E model  ·  Ctrl+Q quit", {
        fg: C.dim,
      });
    }
  }
}
