import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { drawHeader } from "../header.js";
import { drawHint, drawTabButton, inRect } from "../ui.js";
import type { AgentId } from "../agents.js";
import { AgentHistoryScreen } from "./agentHistory.js";

const AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
];

const LIST_TOP = 5;
const BTN_H = 3;
const BTN_X = 1;

export class AgentSelectScreen extends Screen {
  private selectedIdx = 0;
  private scrollBtn = 0;
  private lastHoverX = -1;
  private lastHoverY = -1;

  onActivate(): void {
    this.selectedIdx = 0;
    this.scrollBtn = 0;
  }

  private move(delta: number): void {
    if (AGENTS.length === 0) return;
    let idx = this.selectedIdx + delta;
    if (idx < 0) idx = AGENTS.length - 1;
    if (idx >= AGENTS.length) idx = 0;
    this.selectedIdx = idx;
    this.app.render();
  }

  onKey(key: Key): void {
    if (key.name === "up") this.move(-1);
    else if (key.name === "down") this.move(1);
    else if (key.name === "enter" || key.name === "return") this.confirm();
    else if (key.name === "escape") this.app.popScreen();
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type === "move") {
      if (ev.x === this.lastHoverX && ev.y === this.lastHoverY) return;
      this.lastHoverX = ev.x;
      this.lastHoverY = ev.y;
      const i = this.indexAtRow(ev.y);
      if (i >= 0 && i !== this.selectedIdx) {
        this.selectedIdx = i;
        this.app.render();
      }
      return;
    }
    if (ev.type === "wheel") {
      this.move(ev.dir === -1 ? -1 : 1);
      return;
    }
    if (ev.type === "click") {
      if (ev.button === 2) {
        this.app.popScreen();
        return;
      }
      const i = this.indexAtRow(ev.y);
      if (i < 0) return;
      if (!inRect(ev.x, ev.y, { x: BTN_X, y: LIST_TOP + (i - this.scrollBtn) * BTN_H, w: this.app.width - 2, h: BTN_H })) {
        return;
      }
      this.selectedIdx = i;
      this.confirm();
    }
  }

  private indexAtRow(y: number): number {
    const h = this.app.height;
    const hintRow = h - 1;
    const maxVisible = Math.max(1, Math.floor((hintRow - LIST_TOP) / BTN_H));
    const i = Math.floor((y - LIST_TOP) / BTN_H) + this.scrollBtn;
    if (i < 0 || i >= AGENTS.length) return -1;
    if (LIST_TOP + (i - this.scrollBtn) * BTN_H + BTN_H > hintRow) return -1;
    return i;
  }

  private confirm(): void {
    const agent = AGENTS[this.selectedIdx];
    if (!agent) return;
    this.app.pushScreen(new AgentHistoryScreen(agent.id, agent.label));
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);

    const w = buf.width;
    const h = buf.height;

    buf.centerText(2, "Other Agents", { fg: C.accent, bold: true });
    buf.centerText(3, "Select an agent to open its history", { fg: C.white });

    const btnH = BTN_H;
    const stride = btnH;
    const hintRow = h - 1;
    const maxVisible = Math.max(1, Math.floor((hintRow - LIST_TOP) / stride));

    if (this.selectedIdx < this.scrollBtn) this.scrollBtn = this.selectedIdx;
    if (this.selectedIdx >= this.scrollBtn + maxVisible) this.scrollBtn = this.selectedIdx - maxVisible + 1;
    if (this.scrollBtn < 0) this.scrollBtn = 0;

    let y = LIST_TOP;
    for (let i = this.scrollBtn; i < AGENTS.length; i++) {
      if (y + btnH > hintRow) break;
      drawTabButton(buf, BTN_X, y, w - 2, AGENTS[i].label, i === this.selectedIdx, "left");
      y += stride;
    }

    drawHint(buf, hintRow, "↑/↓ select  ·  Enter open  ·  click to open  ·  right-click back  ·  Esc back");
  }
}
