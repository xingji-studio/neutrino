import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key } from "../terminal/input.js";
import { C } from "../colors.js";
import { drawHeader } from "../header.js";
import { drawTabButton } from "../ui.js";
import type { AgentId } from "../agents.js";
import { AgentHistoryScreen } from "./agentHistory.js";

const AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
];

export class AgentSelectScreen extends Screen {
  private selectedIdx = 0;
  private scrollBtn = 0;

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

    const listTop = 5;
    const btnH = 3;
    const stride = btnH;
    const hintRow = h - 1;
    const maxVisible = Math.max(1, Math.floor((hintRow - listTop) / stride));

    if (this.selectedIdx < this.scrollBtn) this.scrollBtn = this.selectedIdx;
    if (this.selectedIdx >= this.scrollBtn + maxVisible) this.scrollBtn = this.selectedIdx - maxVisible + 1;
    if (this.scrollBtn < 0) this.scrollBtn = 0;

    let y = listTop;
    for (let i = this.scrollBtn; i < AGENTS.length; i++) {
      if (y + btnH > hintRow) break;
      drawTabButton(buf, 1, y, w - 2, AGENTS[i].label, i === this.selectedIdx, "left");
      y += stride;
    }

    buf.centerText(hintRow, "↑/↓ select  ·  Enter open  ·  Esc back", { fg: C.dim });
  }
}
