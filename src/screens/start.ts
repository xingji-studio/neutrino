import { terminalUI } from "../plugins/terminal.js";
import type { OwnedUI } from "../plugins/host.js";
import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { loadLogo, loadVersion, loadConfig, saveConfig, normalizeApprovalMode } from "../config.js";
import { drawHeader } from "../header.js";
import {
  centerVertically,
  computeInputWindow,
  cursorFromColumn,
  drawHint,
  drawInputBox,
  drawTabButton,
  inRect,
  approvalToggle,
  drawApprovalToggle,
  drawHeaderButton,
  proModeButton,
  webModeButton,
} from "../ui.js";

const TABS = ["Model", "History", "Settings", "Plugins"];
const LOGO = loadLogo();


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
  private extensions: OwnedUI[] = [];
  private get tabs(): string[] { return [...TABS,...this.extensions.slice(0,Math.max(0,Math.floor(((this.app?.width ?? 80)-2)/10)-TABS.length)).map(item=>item.title)]; }
  private get focusCount(): number { return this.tabs.length + 2; }
  onActivate(): void { this.extensions=terminalUI().filter(item=>item.slot === "app.menu" || item.slot === "workspace.tabs"); }

  private get approvalMode() {
    return normalizeApprovalMode(loadConfig().approval_mode);
  }

  private toggleApproval(): void {
    const config = loadConfig();
    config.approval_mode = this.approvalMode === "auto" ? "request" : "auto";
    saveConfig(config);
    this.app.render();
  }

  private logoLines(): string[] {
    const lines = LOGO.replace(/\n+$/, "").split("\n");
    const count = Math.max(0, Math.min(lines.length, this.app.height - 13));
    return count ? lines.slice(-count) : [];
  }

  private inputValue = "";
  private cursor = 0;
  private focusIdx = 0; // 0 = input box, 1..3 = tabs, 4 = approval mode
  private hoverIdx = -1; // -1 = nothing, otherwise the control index
  private proHover = false; // pointer is over the Pro-mode button
  private webHover = false; // pointer is over the Web-mode button
  private lastHoverX = -1;
  private lastHoverY = -1;

  showsCursor(): boolean {
    // The input cursor is only drawn for the focused, non-empty input box.
    return this.focusIdx === 0 && this.inputValue.length > 0;
  }

  onPaste(text: string): void {
    if (!text) return;
    // A paste always targets the message box, so focus it first.
    this.focusIdx = 0;
    this.hoverIdx = -1;
    this.inputValue =
      this.inputValue.slice(0, this.cursor) + text + this.inputValue.slice(this.cursor);
    this.cursor += text.length;
    this.app.render();
  }

  onKey(key: Key): void {
    if (key.name === "tab") {
      this.move(key.shift ? -1 : 1);
      return;
    }
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
      } else if (this.focusIdx === this.focusCount - 1) {
        this.toggleApproval();
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

      const pro = proModeButton(this.app.width, this.app.height);
      const web = webModeButton(this.app.width, this.app.height);
      const proHover = pro !== null && inRect(ev.x, ev.y, pro);
      const webHover = web !== null && inRect(ev.x, ev.y, web);
      const layout = this.layout();
      let hover = -1;
      // While the pointer is over one of the top-left buttons no other control
      // is hovered underneath it: the boxes are opaque, so their neighbours
      // must not light up.
      if (!proHover && !webHover) {
        if (inRect(ev.x, ev.y, approvalToggle(this.app.width, this.app.height - 4, this.approvalMode))) {
          hover = this.focusCount - 1;
        } else if (layout && inRect(ev.x, ev.y, { x: layout.inputX, y: layout.inputY, w: layout.inputW, h: INPUT_H })) {
          hover = 0;
        } else if (layout && ev.y >= layout.tabY && ev.y < layout.tabY + TAB_H) {
          for (let i = 0; i < layout.tabs.length; i++) {
            if (inRect(ev.x, ev.y, { x: layout.tabs[i].x, y: layout.tabY, w: layout.tabs[i].w, h: TAB_H })) {
              hover = i + 1;
              break;
            }
          }
        }
      }
      if (proHover !== this.proHover || webHover !== this.webHover || hover !== this.hoverIdx) {
        this.proHover = proHover;
        this.webHover = webHover;
        this.hoverIdx = hover;
        this.app.render();
      }
      return;
    }

    if (ev.type === "click") {
      const layout = this.layout();
      if (!layout) return;
      if (ev.button === 2) return; // right click: no-op on start screen
      // The top-left buttons are controls of their own and are checked first:
      // a left click anywhere in a box opens its workspace instead of the
      // control below.
      const pro = proModeButton(this.app.width, this.app.height);
      if (ev.button === 0 && pro && inRect(ev.x, ev.y, pro)) {
        void this.app.openProMode();
        return;
      }
      const web = webModeButton(this.app.width, this.app.height);
      if (ev.button === 0 && web && inRect(ev.x, ev.y, web)) {
        void this.app.openWebMode();
        return;
      }
      if (ev.y >= 1 && inRect(ev.x, ev.y, approvalToggle(this.app.width, this.app.height - 4, this.approvalMode))) {
        this.focusIdx = this.focusCount - 1;
        this.toggleApproval();
        return;
      }
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

  /**
   * The message box, the tabs below it and the hint row are persistent chrome;
   * repainting them every frame keeps them self-healing against terminal-side
   * drift (see Screen.alwaysRepaintRows).
   */
  alwaysRepaintRows(): number[] {
    const { inputY, tabY } = this.layout();
    const h = this.app.height;
    const rows: number[] = [];
    for (let y = inputY; y <= tabY + TAB_H; y++) if (y >= 0 && y < h) rows.push(y);
    // The top-left buttons sit directly below the status bar; repainting their
    // rows makes them self-heal exactly like the input box and the tabs.
    for (let y = 1; y <= 3; y++) if (y >= 0 && y < h) rows.push(y);
    if (h - 4 >= 1) rows.push(h - 4);
    return rows;
  }

  private layout(): Layout {
    const w = this.app.width;
    const h = this.app.height;
    const inputW = Math.min(78, w - 4);
    const inputX = Math.floor((w - inputW) / 2);
    const logoLines = this.logoLines();
    const gap = 1;
    const logoGap = logoLines.length ? 1 : 0;
    const contentH = logoLines.length + logoGap + INPUT_H + gap + TAB_H;
    const inputY = this.contentTop(h, contentH) + logoLines.length + logoGap;
    const tabY = inputY + INPUT_H + gap;
    const tabGap = 2;
    const tabInner = inputW - tabGap * (this.tabs.length - 1);
    const baseW = Math.floor(tabInner / this.tabs.length);
    const extra = tabInner - baseW * this.tabs.length;
    const tabs: { x: number; w: number }[] = [];
    let tx = inputX;
    for (let i = 0; i < this.tabs.length; i++) {
      const tw = baseW + (i < extra ? 1 : 0);
      tabs.push({ x: tx, w: tw });
      tx += tw + tabGap;
    }
    return { inputX, inputY, inputW, tabY, tabs };
  }

  /**
   * First content row. The centered block normally floats in the middle, but
   * it must start below the top-left buttons when they are visible: the boxes
   * are opaque chrome and would otherwise clip the top of the logo.
   */
  private contentTop(height: number, contentH: number): number {
    const top = centerVertically(height - 4, contentH);
    const pro = proModeButton(this.app.width, height);
    return pro ? Math.max(top, pro.y + pro.h) : top;
  }

  private move(delta: number): void {
    this.focusIdx = (this.focusIdx + delta + this.focusCount) % this.focusCount;
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
    else if (this.focusIdx === 3) this.app.openSettings();
    else if (this.focusIdx === 4) this.app.openPlugins();
    else if (this.extensions[this.focusIdx-5]) this.app.openPluginContribution(this.extensions[this.focusIdx-5]);
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);

    const w = buf.width;
    const h = buf.height;
    const inputW = Math.min(78, w - 4);
    const inputX = Math.floor((w - inputW) / 2);

    const logoLines = this.logoLines();
    const logoMax = logoLines.reduce((m, l) => Math.max(m, l.length), 0);
    const logoX = Math.max(0, Math.floor((w - logoMax) / 2));
    const gap = 1;
    const logoGap = logoLines.length ? 1 : 0;
    const contentH = logoLines.length + logoGap + INPUT_H + gap + TAB_H;
    const top = this.contentTop(h, contentH);

    let y = top;
    for (const line of logoLines) {
      buf.writeText(logoX, y, line, { fg: C.accent, bold: true });
      y++;
    }
    y += logoGap;

    drawInputBox(buf, inputX, y, inputW, this.inputValue, this.cursor, {
      active: this.focusIdx === 0,
      cursorOn: this.app.state.cursorOn,
      placeholder: "Type a message to start a new chat...",
    });
    y += INPUT_H + gap;

    const tabGap = 2;
    const tabInner = inputW - tabGap * (this.tabs.length - 1);
    const baseW = Math.floor(tabInner / this.tabs.length);
    const extra = tabInner - baseW * this.tabs.length;
    let tx = inputX;
    for (let i = 0; i < this.tabs.length; i++) {
      const tw = baseW + (i < extra ? 1 : 0);
      const selected = i === this.focusIdx - 1 || i === this.hoverIdx - 1;
      drawTabButton(buf, tx, y, tw, this.tabs[i], selected);
      tx += tw + tabGap;
    }

    // The version label is pinned one row above the very bottom of the screen,
    // leaving the last row blank. It is read from package.json at runtime so it
    // can never drift out of sync with the published package version.
    const version = loadVersion();
    const versionY = h - 2;
    const showVersion = version.length > 0 && versionY >= 1;

    // Reserve the button row and the blank row between it and the version.
    const hintY = y + TAB_H + 1;
    const approvalY = h - 4;
    if (hintY < approvalY) {
      const nav = this.focusIdx === 0 && this.inputValue.length > 0
        ? "←/→ move cursor · ↑/↓ switch"
        : "←/→ / ↑/↓ switch";
      drawHint(buf, hintY, `${nav} · Enter confirm · drag to copy · Ctrl+E model · Ctrl+Q quit`);
    }

    if (showVersion) {
      buf.centerText(versionY, `v${version}`, { fg: C.dim });
    }
    drawApprovalToggle(buf, approvalY, this.approvalMode,
      this.focusIdx === this.focusCount - 1 || this.hoverIdx === this.focusCount - 1);

    // Painted last so their opaque footprints are never clipped by the
    // decorative content drawn before them. Hit testing shares the geometry.
    drawHeaderButton(buf, proModeButton(w, h), this.proHover);
    drawHeaderButton(buf, webModeButton(w, h), this.webHover);
  }
}
