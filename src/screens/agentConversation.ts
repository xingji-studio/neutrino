import type { Buffer } from "../terminal/buffer.js";
import { Screen, type ScrollbarHandle } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C } from "../colors.js";
import { drawHeader } from "../header.js";
import { drawHint, drawScrollbar } from "../ui.js";
import { drawSpans, renderMarkdownText, type Line } from "../markdown.js";
import { ellipsize } from "../width.js";
import type { AgentMessage } from "../agents.js";

export class AgentConversationScreen extends Screen {
  private title: string;
  private messages: AgentMessage[];
  private scrollTop = 0;
  private followBottom = true;
  private scrollbarGeom: { x: number; top: number; bottom: number; total: number; viewport: number } | null = null;

  constructor(title: string, messages: AgentMessage[]) {
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
    }
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
    const logBottom = h - 2;
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

    drawHint(buf, h - 1, "↑/↓ scroll  ·  wheel or drag the bar  ·  right-click back  ·  Esc back");
  }
}
