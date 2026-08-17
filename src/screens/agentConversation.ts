import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C, type Style } from "../colors.js";
import { drawHeader } from "../header.js";
import { wrapText } from "../ui.js";
import { ellipsize } from "../width.js";
import type { AgentMessage } from "../agents.js";

interface Line {
  text: string;
  style: Style;
}

export class AgentConversationScreen extends Screen {
  private title: string;
  private messages: AgentMessage[];
  private scrollTop = 0;
  private followBottom = true;

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
    }
  }

  private buildLines(width: number): Line[] {
    const lines: Line[] = [];
    const push = (text: string, style: Style): void => {
      for (const ln of wrapText(text, width)) lines.push({ text: ln, style });
    };
    for (const m of this.messages) {
      if (m.role === "user") {
        lines.push({ text: "You:", style: { fg: C.accent, bold: true } });
        push(m.content, { fg: C.user });
        lines.push({ text: "", style: {} });
      } else {
        lines.push({ text: "Assistant:", style: { fg: C.accent, bold: true } });
        push(m.content, { fg: C.assistant });
        lines.push({ text: "", style: {} });
      }
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

    for (let y = logTop; y <= logBottom; y++) {
      const li = this.scrollTop + (y - logTop);
      if (li >= lines.length) break;
      const line = lines[li];
      buf.writeText(2, y, line.text.slice(0, w - 2), line.style);
    }

    buf.centerText(h - 1, "↑/↓ scroll  ·  Esc back", { fg: C.dim });
  }
}
