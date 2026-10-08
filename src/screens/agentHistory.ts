import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { drawHeader } from "../header.js";
import { truncateByWidth } from "../width.js";
import { drawHint } from "../ui.js";
import {
  listAgentSessions,
  loadAgentMessages,
  type AgentId,
  type AgentSessionMeta,
} from "../agents.js";
import { AgentConversationScreen } from "./agentConversation.js";

const LIST_TOP = 5;

export class AgentHistoryScreen extends Screen {
  private agent: AgentId;
  private label: string;
  private sessions: AgentSessionMeta[] = [];
  private selectedIdx = 0;
  private scrollTop = 0;
  private lastHoverX = -1;
  private lastHoverY = -1;
  private rows: string[] = [];
  private itemBounds: { start: number; end: number }[] = [];

  constructor(agent: AgentId, label: string) {
    super();
    this.agent = agent;
    this.label = label;
  }

  onActivate(): void {
    this.sessions = listAgentSessions(this.agent);
    this.selectedIdx = 0;
    this.scrollTop = 0;
    this.rows = [];
    this.itemBounds = [];
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
    if (ev.type === "move") {
      if (ev.x === this.lastHoverX && ev.y === this.lastHoverY) return;
      this.lastHoverX = ev.x;
      this.lastHoverY = ev.y;
      const idx = this.itemIndexAtRow(ev.y);
      if (idx >= 0 && idx !== this.selectedIdx) {
        this.selectedIdx = idx;
        this.app.render();
      }
      return;
    }
    if (ev.type === "wheel") {
      this.scrollTop = Math.max(0, this.scrollTop + (ev.dir === -1 ? -3 : 3));
      this.app.render();
      return;
    }
    if (ev.type === "click") {
      if (ev.button === 2) {
        this.app.popScreen();
        return;
      }
      const idx = this.itemIndexAtRow(ev.y);
      if (idx < 0) return;
      this.selectedIdx = idx;
      this.loadSelected();
    }
  }

  private itemIndexAtRow(y: number): number {
    if (y < LIST_TOP) return -1;
    const h = this.app.height;
    const listBottom = h - 2;
    if (y >= listBottom) return -1;
    const ri = this.scrollTop + (y - LIST_TOP);
    if (ri < 0 || ri >= this.rows.length) return -1;
    for (let i = 0; i < this.itemBounds.length; i++) {
      if (ri >= this.itemBounds[i].start && ri < this.itemBounds[i].end) return i;
    }
    return -1;
  }

  private loadSelected(): void {
    if (this.selectedIdx < 0 || this.selectedIdx >= this.sessions.length) return;
    const s = this.sessions[this.selectedIdx];
    const messages = loadAgentMessages(this.agent, s.id);
    this.app.pushScreen(new AgentConversationScreen(`${this.label} · ${s.title || s.id}`, messages));
  }

  private buildRows(): void {
    const rows: string[] = [];
    const itemBounds: { start: number; end: number }[] = [];
    for (const s of this.sessions) {
      const start = rows.length;
      const created = (s.updated_at || s.created_at || "").slice(0, 19);
      rows.push(`${created} | ${s.title || s.id}`);
      if (s.model) rows.push(`    ${s.model}`);
      itemBounds.push({ start, end: rows.length });
    }
    this.rows = rows;
    this.itemBounds = itemBounds;
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    buf.centerText(2, this.label, { fg: C.accent, bold: true });
    buf.centerText(3, "Select a session to view", { fg: C.dim });

    const listBottom = h - 2;
    const viewH = Math.max(1, listBottom - LIST_TOP);

    if (this.sessions.length === 0) {
      buf.centerText(LIST_TOP + 1, "No sessions yet", { fg: C.dim });
      drawHint(buf, listBottom, "Esc back");
      return;
    }

    this.buildRows();

    if (this.selectedIdx < 0) this.selectedIdx = 0;
    if (this.selectedIdx >= this.itemBounds.length) this.selectedIdx = Math.max(0, this.itemBounds.length - 1);

    const selected = this.itemBounds[this.selectedIdx];
    const firstRowOfSelected = selected.start;

    if (firstRowOfSelected < this.scrollTop) this.scrollTop = firstRowOfSelected;
    if (firstRowOfSelected >= this.scrollTop + viewH) this.scrollTop = firstRowOfSelected - viewH + 1;
    if (this.scrollTop > this.rows.length - viewH) this.scrollTop = Math.max(0, this.rows.length - viewH);

    for (let y = LIST_TOP; y < listBottom; y++) {
      const ri = this.scrollTop + (y - LIST_TOP);
      if (ri < 0 || ri >= this.rows.length) break;
      const isSelected = ri >= selected.start && ri < selected.end;
      const isSelectedFirst = ri === selected.start;
      const text = (isSelectedFirst ? "▸ " : "  ") + this.rows[ri];
      buf.writeText(0, y, truncateByWidth(text, w), isSelected ? { fg: C.accent, bg: C.highlightBg } : { fg: C.assistant });
    }

    drawHint(buf, listBottom, "↑/↓ select  ·  Enter view  ·  click to view  ·  right-click back  ·  Esc back");
  }
}
