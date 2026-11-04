import type { Buffer } from "../terminal/buffer.js";
import { Screen, type ScrollbarHandle } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { drawHeader } from "../header.js";
import { drawHint, drawScrollbar, inRect, type Rect } from "../ui.js";
import { drawSpans, renderMarkdownText, type Line } from "../markdown.js";
import { displayWidth, ellipsize, truncateByWidth } from "../width.js";
import type { AgentId, AgentMessage } from "../agents.js";
import { migrateAgentSession } from "../migration.js";

interface MigrationSource {
  agent: AgentId;
  id: string;
  cwd: string;
}

export class AgentConversationScreen extends Screen {
  private title: string;
  private messages: AgentMessage[];
  private scrollTop = 0;
  private followBottom = true;
  private scrollbarGeom: { x: number; top: number; bottom: number; total: number; viewport: number } | null = null;
  private migrateButton: Rect | null = null;
  private migrationError = "";

  constructor(title: string, messages: AgentMessage[], private source: MigrationSource) {
    super();
    this.title = title;
    this.messages = messages;
  }

  onKey(key: Key): void {
    if (key.name === "up") {
      this.followBottom = false;
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      this.app.render();
    } else if (key.name === "down") {
      this.scrollTop += 1;
      this.app.render();
    } else if (key.name === "pageup") {
      this.followBottom = false;
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      this.app.render();
    } else if (key.name === "pagedown") {
      this.scrollTop += 10;
      this.app.render();
    } else if (key.name === "escape") {
      this.app.popScreen();
    } else if (key.name === "enter" || key.name === "return" ||
        (!key.ctrl && !key.meta && key.char.toLowerCase() === "m")) {
      this.migrate();
    }
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type === "wheel") {
      if (ev.dir === -1) {
        this.followBottom = false;
        this.scrollTop = Math.max(0, this.scrollTop - 3);
      } else {
        this.scrollTop += 3;
      }
      this.app.render();
    } else if (ev.type === "click" && ev.button === 2) {
      this.app.popScreen();
    } else if (ev.type === "click" && ev.button === 0 && this.migrateButton &&
        inRect(ev.x, ev.y, this.migrateButton)) {
      this.migrate();
    }
  }

  private migrate(): void {
    if (!this.messages.length) return;
    try {
      const state = this.app.state;
      const session = migrateAgentSession(this.source.agent, this.source.id, this.source.cwd, {
        provider: state.selectedProvider, model: state.selectedModelName, intensity: state.selectedIntensity,
      });
      this.app.loadSession(session);
    } catch (error) {
      this.migrationError = error instanceof Error ? error.message : String(error);
      this.app.render();
    }
  }

  alwaysRepaintRows(): number[] {
    return [this.app.height - 3, this.app.height - 2, this.app.height - 1];
  }

  scrollbar(): ScrollbarHandle | null {
    const g = this.scrollbarGeom;
    if (!g || g.total <= g.viewport) return null;
    return {
      x: g.x,
      top: g.top,
      bottom: g.bottom,
      total: g.total,
      viewport: g.viewport,
      offset: this.scrollTop,
      scrollTo: (offset: number) => {
        const maxScroll = Math.max(0, g.total - g.viewport);
        this.scrollTop = Math.max(0, Math.min(offset, maxScroll));
        this.followBottom = this.scrollTop >= maxScroll;
        this.app.render();
      },
    };
  }

  private buildLines(width: number): Line[] {
    const lines: Line[] = [];
    for (const m of this.messages) {
      if (m.role === "user") {
        lines.push({ spans: [{ text: "You:", style: { fg: C.accent, bold: true } }] });
        lines.push(...renderMarkdownText(m.content, width, { fg: C.user }));
      } else {
        lines.push({ spans: [{ text: "Assistant:", style: { fg: C.accent, bold: true } }] });
        lines.push(...renderMarkdownText(m.content, width, { fg: C.assistant }));
      }
      lines.push({ spans: [] });
    }
    return lines;
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);
    const w = buf.width;
    const h = buf.height;

    buf.centerText(1, ellipsize(this.title, Math.max(10, w - 4)), { fg: C.dim });

    const logTop = 3;
    const logBottom = h - 4;
    const viewH = Math.max(1, logBottom - logTop + 1);
    const lines = this.buildLines(Math.max(10, w - 4));
    const maxScroll = Math.max(0, lines.length - viewH);
    if (this.followBottom) this.scrollTop = maxScroll;
    if (this.scrollTop > maxScroll) {
      this.scrollTop = maxScroll;
      this.followBottom = true;
    }
    if (this.scrollTop < 0) this.scrollTop = 0;

    // Expose the bar so the app can drag it (see the scrollbar() method).
    this.scrollbarGeom =
      lines.length > viewH
        ? { x: w - 1, top: logTop, bottom: logBottom, total: lines.length, viewport: viewH }
        : null;

    for (let y = logTop; y <= logBottom; y++) {
      const li = this.scrollTop + (y - logTop);
      if (li >= lines.length) break;
      drawSpans(buf, 2, y, lines[li].spans, Math.max(4, w - 4));
    }

    // Scrollbar on the right edge, visible only when the log overflows.
    drawScrollbar(buf, w - 1, logTop, logBottom, lines.length, viewH, this.scrollTop);

    if (this.migrationError) {
      buf.writeText(2, h - 3, ellipsize(`迁移失败：${this.migrationError}`, Math.max(0, w - 4)), { fg: C.red });
    }
    const label = truncateByWidth("[ 迁移会话 ]", Math.max(0, w - 2));
    const buttonWidth = displayWidth(label);
    this.migrateButton = { x: Math.max(0, w - buttonWidth - 2), y: h - 2, w: buttonWidth, h: 1 };
    buf.writeText(this.migrateButton.x, this.migrateButton.y, label, {
      fg: this.messages.length ? C.accent : C.dim, bg: C.highlightBg, bold: true,
    });
    for (let x = this.migrateButton.x; x < this.migrateButton.x + buttonWidth; x++) {
      buf.markChrome(x, this.migrateButton.y);
    }
    drawHint(buf, h - 1, "↑/↓ scroll  ·  M/Enter migrate  ·  right-click back  ·  Esc back");
  }
}
