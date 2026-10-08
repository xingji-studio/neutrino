import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { deleteSession, listSessions, loadSession, type SessionMeta } from "../config.js";
import { drawHeader } from "../header.js";
import { drawHint } from "../ui.js";

const LIST_TOP = 5;

export class HistoryScreen extends Screen {
  private sessions: SessionMeta[] = [];
  private selectedIdx = 0;
  private scrollTop = 0;
  private lastHoverX = -1;
  private lastHoverY = -1;
  private rows: string[] = [];
  private itemBounds: { start: number; end: number }[] = [];

  onActivate(): void {
    this.sessions = listSessions();
    this.selectedIdx = this.sessions.length > 0 ? 1 : 0;
    this.scrollTop = 0;
    this.rows = [];
    this.itemBounds = [];
  }

  private move(delta: number): void {
    const count = this.sessions.length + 1;
    this.selectedIdx = (this.selectedIdx + delta + count) % count;
    this.app.render();
  }

  onKey(key: Key): void {
    if (key.name === "up") this.move(-1);
    else if (key.name === "down") this.move(1);
    else if (key.name === "enter" || key.name === "return") this.loadSelected();
    else if (key.name === "delete") this.deleteSelected();
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

  /** Map a terminal row to the history item index (0 = "Open other Agent's history"). */
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
    if (this.selectedIdx === 0) {
      this.app.openAgentSelect();
      return;
    }
    const session = this.sessions[this.selectedIdx - 1];
    if (!session) return;
    const data = loadSession(session.id);
    if (data) {
      this.app.popScreen();
      this.app.loadSession(data);
    }
  }

  private deleteSelected(): void {
    if (this.selectedIdx === 0) return;
    const session = this.sessions[this.selectedIdx - 1];
    if (!session) return;
    deleteSession(session.id);
    this.sessions = listSessions();
    this.selectedIdx = Math.min(this.selectedIdx, this.sessions.length);
    this.app.render();
  }

  private buildRows(): void {
    const rows: string[] = [];
    const itemBounds: { start: number; end: number }[] = [];

    rows.push("Open other Agent's history");
    itemBounds.push({ start: 0, end: 1 });
    rows.push("");

    for (const s of this.sessions) {
      const start = rows.length;
      const created = (s.created_at || "").slice(0, 19);
      rows.push(`${created} | ${s.provider}/${s.model} (${s.intensity}) | ${s.message_count} msgs`);
      if (s.title) rows.push(`    ${s.title}`);
      if (s.cwd) rows.push(`    ${s.cwd}`);
      itemBounds.push({ start, end: rows.length });
    }

    this.rows = rows;
    this.itemBounds = itemBounds;
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    buf.centerText(2, "History", { fg: C.accent, bold: true });
    buf.centerText(3, "Select a session to load", { fg: C.dim });

    const listBottom = h - 2;
    const viewH = Math.max(1, listBottom - LIST_TOP);

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
      const row = this.rows[ri];
      const prefix = isSelectedFirst ? "▸ " : "  ";
      const style = isSelected ? { fg: C.accent, bg: C.highlightBg } : { fg: C.assistant };
      buf.writeText(0, y, (prefix + row).slice(0, w), style);
    }

    if (this.sessions.length === 0) {
      buf.centerText(LIST_TOP + 1, "No sessions yet", { fg: C.dim });
    }

    drawHint(buf, listBottom, "↑/↓ select  ·  Enter load  ·  click to load  ·  Delete delete  ·  right-click back  ·  Esc back");
  }
}
