import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { loadLogo, loadVersion } from "../config.js";
import { drawHeader } from "../header.js";
import {
  centerVertically,
  computeInputWindow,
  cursorFromColumn,
  drawHint,
  drawInputBox,
  drawTabButton,
  inRect,
} from "../ui.js";

const TABS = ["Model", "History", "Settings"];
const LOGO = loadLogo();

const FOCUS_COUNT = TABS.length + 1; // input box + 3 tabs
const INPUT_H = 3;
const TAB_H = 3;

interface Layout {
  inputX: number;
  inputY: number;
  inputW: number;
  tabY: number;
  tabs: { x: number; w: number }[];
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export class StartScreen extends Screen {
  private inputValue = "";
  private cursor = 0;
  private focusIdx = 0; // 0 = input box, 1..3 = tabs
  private hoverIdx = -1; // -1 = nothing, 0 = input box, 1..3 = tabs
  private lastHoverX = -1;
  private lastHoverY = -1;

  showsCursor(): boolean {
    // The input cursor is only drawn for the focused, non-empty input box.
    return this.focusIdx === 0 && this.inputValue.length > 0;
  }

  onKey(key: Key): void {
    // When the input box is focused and holds text, left/right move the text
    // cursor instead of switching between the input box and the tabs. When the
    // input box is empty (or another control is focused), left/right switch.
    // Up/down always switch.
    if (key.name === "left" || key.name === "right") {
      if (this.focusIdx === 0 && this.inputValue.length > 0) {
        this.moveCursor(key.name === "left" ? -1 : 1);
      } else {
        this.move(key.name === "left" ? -1 : 1);
      }
      return;
    }
    if (key.name === "up") {
      this.move(-1);
      return;
    }
    if (key.name === "down") {
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

  onMouse(ev: MouseEvent): void {
    if (ev.type === "move") {
      // avoid redundant work when the pointer hasn't moved to a new cell
      if (ev.x === this.lastHoverX && ev.y === this.lastHoverY) return;
      this.lastHoverX = ev.x;
      this.lastHoverY = ev.y;

      const layout = this.layout();
      let hover = -1;
      if (layout && inRect(ev.x, ev.y, { x: layout.inputX, y: layout.inputY, w: layout.inputW, h: INPUT_H })) {
        hover = 0;
      } else if (layout && ev.y >= layout.tabY && ev.y < layout.tabY + TAB_H) {
        for (let i = 0; i < layout.tabs.length; i++) {
          if (inRect(ev.x, ev.y, { x: layout.tabs[i].x, y: layout.tabY, w: layout.tabs[i].w, h: TAB_H })) {
            hover = i + 1;
            break;
          }
        }
      }
      if (hover !== this.hoverIdx) {
        this.hoverIdx = hover;
        this.app.render();
      }
      return;
    }

    if (ev.type === "click") {
      const layout = this.layout();
      if (!layout) return;
      if (ev.button === 2) return; // right click: no-op on start screen
      if (ev.y === 0) {
        this.app.openModelConfig();
        return;
      }
      if (inRect(ev.x, ev.y, { x: layout.inputX, y: layout.inputY, w: layout.inputW, h: INPUT_H })) {
        this.focusIdx = 0;
        if (ev.y === layout.inputY + 1 && ev.x >= layout.inputX + 2) {
          const innerW = layout.inputW - 4;
          const col = Math.min(innerW - 1, ev.x - (layout.inputX + 2));
          const win = computeInputWindow(this.inputValue, this.cursor, innerW);
          this.cursor = cursorFromColumn(this.inputValue, col, win);
        }
        this.app.render();
        return;
      }
      if (ev.y >= layout.tabY && ev.y < layout.tabY + TAB_H) {
        for (let i = 0; i < layout.tabs.length; i++) {
          if (inRect(ev.x, ev.y, { x: layout.tabs[i].x, y: layout.tabY, w: layout.tabs[i].w, h: TAB_H })) {
            this.focusIdx = i + 1;
            this.hoverIdx = i + 1;
            this.enterTab();
            return;
          }
        }
      }
      return;
    }
  }

  private layout(): Layout {
    const w = this.app.width;
    const h = this.app.height;
    const inputW = Math.min(78, w - 4);
    const inputX = Math.floor((w - inputW) / 2);
    const logoLines = LOGO.replace(/\n+$/, "").split("\n");
    const gap = 1;
    const contentH = logoLines.length + 1 + INPUT_H + gap + TAB_H;
    const inputY = centerVertically(h, contentH) + logoLines.length + 1;
    const tabY = inputY + INPUT_H + gap;
    const tabGap = 2;
    const tabInner = inputW - tabGap * (TABS.length - 1);
    const baseW = Math.floor(tabInner / TABS.length);
    const extra = tabInner - baseW * TABS.length;
    const tabs: { x: number; w: number }[] = [];
    let tx = inputX;
    for (let i = 0; i < TABS.length; i++) {
      const tw = baseW + (i < extra ? 1 : 0);
      tabs.push({ x: tx, w: tw });
      tx += tw + tabGap;
    }
    return { inputX, inputY, inputW, tabY, tabs };
  }

  private move(delta: number): void {
    this.focusIdx = (this.focusIdx + delta + FOCUS_COUNT) % FOCUS_COUNT;
    this.hoverIdx = -1;
    this.app.render();
  }

  /** Move the text cursor by one character, staying within bounds and on
   *  surrogate-pair boundaries. */
  private moveCursor(delta: -1 | 1): void {
    const len = this.inputValue.length;
    let next = Math.max(0, Math.min(len, this.cursor + delta));
    if (delta === 1) {
      if (next < len && isLowSurrogate(this.inputValue.charCodeAt(next))) {
        next = Math.min(len, next + 1);
      }
    } else if (next > 0 && isLowSurrogate(this.inputValue.charCodeAt(next))) {
      next = Math.max(0, next - 1);
    }
    if (next === this.cursor) return;
    this.cursor = next;
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
    const contentH = logoLines.length + 1 + INPUT_H + gap + TAB_H;
    const top = centerVertically(h, contentH);

    let y = top;
    for (const line of logoLines) {
      buf.writeText(logoX, y, line, { fg: C.accent, bold: true });
      y++;
    }
    y += 1;

    drawInputBox(buf, inputX, y, inputW, this.inputValue, this.cursor, {
      active: this.focusIdx === 0,
      cursorOn: this.app.state.cursorOn,
      placeholder: "Type a message to start a new chat...",
    });
    y += INPUT_H + gap;

    const tabGap = 2;
    const tabInner = inputW - tabGap * (TABS.length - 1);
    const baseW = Math.floor(tabInner / TABS.length);
    const extra = tabInner - baseW * TABS.length;
    let tx = inputX;
    for (let i = 0; i < TABS.length; i++) {
      const tw = baseW + (i < extra ? 1 : 0);
      const selected = i === this.focusIdx - 1 || i === this.hoverIdx - 1;
      drawTabButton(buf, tx, y, tw, TABS[i], selected);
      tx += tw + tabGap;
    }

    // The version label is pinned one row above the very bottom of the screen,
    // leaving the last row blank. It is read from package.json at runtime so it
    // can never drift out of sync with the published package version.
    const version = loadVersion();
    const versionY = h - 2;
    const showVersion = version.length > 0 && versionY >= 1;

    // The hint sits right below the tabs, but is dropped when it would land on
    // or below the reserved version row so the two never collide.
    const hintY = y + TAB_H + 1;
    if (hintY < h && (!showVersion || hintY < versionY)) {
      const nav = this.focusIdx === 0 && this.inputValue.length > 0
        ? "←/→ move cursor  ·  ↑/↓ switch"
        : "←/→ / ↑/↓ switch";
      drawHint(buf, hintY, `${nav}  ·  Enter confirm  ·  click to choose  ·  Ctrl+E model  ·  Ctrl+Q quit`);
    }

    if (showVersion) {
      buf.centerText(versionY, `v${version}`, { fg: C.dim });
    }
  }
}
