import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { deleteSession, listSessions, loadSession, type SessionMeta } from "../config.js";
import { drawHeader } from "../header.js";

export class HistoryScreen extends Screen {
  private sessions: SessionMeta[] = [];
  private selectedIdx = 0;
  private scrollTop = 0;

  onActivate(): void {
    this.sessions = listSessions();
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
    else if (key.name === "delete") this.deleteSelected();
    else if (key.name === "escape") this.app.popScreen();
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type === "wheel") {
      this.scrollTop = Math.max(0, this.scrollTop + (ev.dir === -1 ? -3 : 3));
      this.app.render();
    }
  }

  private loadSelected(): void {
    if (this.sessions.length === 0) return;
    const session = this.sessions[this.selectedIdx];
    const data = loadSession(session.id);
    if (data) {
      this.app.popScreen();
      this.app.loadSession(data);
    }
  }

  private deleteSelected(): void {
    if (this.sessions.length === 0) return;
    const session = this.sessions[this.selectedIdx];
    deleteSession(session.id);
    this.sessions = listSessions();
    this.selectedIdx = Math.min(this.selectedIdx, this.sessions.length - 1);
    this.app.render();
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    buf.centerText(2, "History", { fg: C.accent, bold: true });
    buf.centerText(3, "Select a session to load", { fg: C.dim });

    const listTop = 5;
    const listBottom = h - 2;
    const viewH = Math.max(1, listBottom - listTop);

    if (this.sessions.length === 0) {
      buf.centerText(listTop + 1, "No sessions yet", { fg: C.dim });
      buf.centerText(listBottom, "Esc back", { fg: C.dim });
      return;
    }

    const rows: { text: string; selected: boolean }[] = [];
    for (const s of this.sessions) {
      const created = (s.created_at || "").slice(0, 19);
      rows.push({
        text: `${created} | ${s.provider}/${s.model} (${s.intensity}) | ${s.message_count} msgs`,
        selected: false,
      });
      if (s.title) rows.push({ text: `    ${s.title}`, selected: false });
      if (s.cwd) rows.push({ text: `    ${s.cwd}`, selected: false });
    }

    if (this.selectedIdx >= this.sessions.length) this.selectedIdx = this.sessions.length - 1;
    if (this.selectedIdx < 0) this.selectedIdx = 0;

    let firstRowOfSelected = 0;
    for (let i = 0; i < this.selectedIdx; i++) {
      firstRowOfSelected += 1 + (this.sessions[i].title ? 1 : 0) + (this.sessions[i].cwd ? 1 : 0);
    }

    if (firstRowOfSelected < this.scrollTop) this.scrollTop = firstRowOfSelected;
    if (firstRowOfSelected >= this.scrollTop + viewH) this.scrollTop = firstRowOfSelected - viewH + 1;
    if (this.scrollTop > rows.length - viewH) this.scrollTop = Math.max(0, rows.length - viewH);

    const selectedSession = this.sessions[this.selectedIdx];
    const selectedRowsStart = firstRowOfSelected;
    const selectedRowsEnd = selectedRowsStart + 1 + (selectedSession.title ? 1 : 0) + (selectedSession.cwd ? 1 : 0);

    for (let y = listTop; y < listBottom; y++) {
      const ri = this.scrollTop + (y - listTop);
      if (ri < 0 || ri >= rows.length) break;
      const isSelected = ri >= selectedRowsStart && ri < selectedRowsEnd;
      const isSelectedFirst = ri === selectedRowsStart;
      const row = rows[ri];
      const text = (isSelectedFirst ? "▸ " : "  ") + row.text;
      buf.writeText(0, y, text.slice(0, w), isSelected ? { fg: C.accent, bg: C.highlightBg } : { fg: C.assistant });
    }

    buf.centerText(listBottom, "↑/↓ select  ·  Enter load  ·  Delete delete  ·  Esc back", { fg: C.dim });
  }
}
