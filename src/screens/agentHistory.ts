import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { drawHeader } from "../header.js";
import { truncateByWidth } from "../width.js";
import {
  listAgentSessions,
  loadAgentMessages,
  type AgentId,
  type AgentSessionMeta,
} from "../agents.js";
import { AgentConversationScreen } from "./agentConversation.js";

export class AgentHistoryScreen extends Screen {
  private agent: AgentId;
  private label: string;
  private sessions: AgentSessionMeta[] = [];
  private selectedIdx = 0;
  private scrollTop = 0;

  constructor(agent: AgentId, label: string) {
    super();
    this.agent = agent;
    this.label = label;
  }

  onActivate(): void {
    this.sessions = listAgentSessions(this.agent);
    this.selectedIdx = 0;
    this.scrollTop = 0;
  }

  private move(delta: number): void {
    if (this.sessions.length === 0) return;
    this.selectedIdx = (this.selectedIdx + delta + this.sessions.length) % this.sessions.length;
    this.app.render();
  }

  onKey(key: Key): void {
    if (key.name === "up") this.move(-1);
    else if (key.name === "down") this.move(1);
    else if (key.name === "enter" || key.name === "return") this.loadSelected();
    else if (key.name === "escape") this.app.popScreen();
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type === "wheel") {
      this.scrollTop = Math.max(0, this.scrollTop + (ev.dir === -1 ? -3 : 3));
      this.app.render();
    }
  }

  private loadSelected(): void {
    if (this.selectedIdx < 0 || this.selectedIdx >= this.sessions.length) return;
    const s = this.sessions[this.selectedIdx];
    const messages = loadAgentMessages(this.agent, s.id);
    this.app.pushScreen(new AgentConversationScreen(`${this.label} · ${s.title || s.id}`, messages));
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    buf.centerText(2, this.label, { fg: C.accent, bold: true });
    buf.centerText(3, "Select a session to view", { fg: C.dim });

    const listTop = 5;
    const listBottom = h - 2;
    const viewH = Math.max(1, listBottom - listTop);

    if (this.sessions.length === 0) {
      buf.centerText(listTop + 1, "No sessions yet", { fg: C.dim });
      buf.centerText(listBottom, "Esc back", { fg: C.dim });
      return;
    }

    const rows: string[] = [];
    const itemBounds: { start: number; end: number }[] = [];
    for (const s of this.sessions) {
      const start = rows.length;
      const created = (s.updated_at || s.created_at || "").slice(0, 19);
      rows.push(`${created} | ${s.title || s.id}`);
      if (s.model) rows.push(`    ${s.model}`);
      itemBounds.push({ start, end: rows.length });
    }

    if (this.selectedIdx < 0) this.selectedIdx = 0;
    if (this.selectedIdx >= itemBounds.length) this.selectedIdx = itemBounds.length - 1;

    const selected = itemBounds[this.selectedIdx];
    const firstRowOfSelected = selected.start;

    if (firstRowOfSelected < this.scrollTop) this.scrollTop = firstRowOfSelected;
    if (firstRowOfSelected >= this.scrollTop + viewH) this.scrollTop = firstRowOfSelected - viewH + 1;
    if (this.scrollTop > rows.length - viewH) this.scrollTop = Math.max(0, rows.length - viewH);

    for (let y = listTop; y < listBottom; y++) {
      const ri = this.scrollTop + (y - listTop);
      if (ri < 0 || ri >= rows.length) break;
      const isSelected = ri >= selected.start && ri < selected.end;
      const isSelectedFirst = ri === selected.start;
      const text = (isSelectedFirst ? "▸ " : "  ") + rows[ri];
      buf.writeText(0, y, truncateByWidth(text, w), isSelected ? { fg: C.accent, bg: C.highlightBg } : { fg: C.assistant });
    }

    buf.centerText(listBottom, "↑/↓ select  ·  Enter view  ·  Esc back", { fg: C.dim });
  }
}
