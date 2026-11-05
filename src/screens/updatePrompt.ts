import type { Buffer } from "../terminal/buffer.js";
import { Screen } from "../terminal/screen.js";
import type { Key, MouseEvent } from "../terminal/input.js";
import { C, type Style } from "../colors.js";
import { drawHeader } from "../header.js";
import { drawHint, drawTabButton, inRect, wrapText } from "../ui.js";
import { MANUAL_UPDATE_COMMAND, installUpdate, type UpdateStatus } from "../update.js";

const TITLE_ROW = 2;
const META_ROW = 3;
const BODY_TOP = 5;
const BUTTON_H = 3;
const BUTTON_X = 1;
const BODY_X = 3;

type Phase = "prompt" | "installing" | "updated" | "failed";

interface Line {
  text: string;
  style: Style;
}

/**
 * The "a newer Neutrino is published" notice.
 *
 * It is pushed over the start screen only, never over a conversation: the
 * answer arrives a moment after launch, and stealing a chat the user has
 * already opened would be worse than a missed notice.
 *
 * Confirming runs npm here, in this process; the running code is not replaced,
 * so a successful update ends by telling the user to restart. A failed one
 * shows the command to run by hand, because npm usually fails for a reason the
 * user has to fix (permissions, a proxy, an offline machine).
 */
export class UpdatePromptScreen extends Screen {
  private phase: Phase = "prompt";
  /** Why the install failed, or which version landed. */
  private detail = "";
  private selectedIdx = 0;
  private lastHoverX = -1;
  private lastHoverY = -1;
  private readonly current: string;
  private readonly latest: string;

  constructor(status: UpdateStatus) {
    super();
    this.current = status.currentVersion;
    this.latest = status.latestVersion;
  }

  /** The buttons drawn right now; a click always lands on one of these. */
  private buttons(): string[] {
    if (this.phase === "prompt") return ["Update now", "Later"];
    if (this.phase === "installing") return [];
    return ["Close"];
  }

  private buttonRow(index: number): number {
    const count = this.buttons().length;
    const top = this.app.height - 1 - count * BUTTON_H;
    return top + index * BUTTON_H;
  }

  /** Columns the body paragraphs may use before wrapping. */
  private bodyWidth(): number {
    return Math.max(10, this.app.width - BODY_X * 2);
  }

  private start(): void {
    if (this.phase !== "prompt") return;
    this.phase = "installing";
    this.selectedIdx = 0;
    this.app.render();
    void installUpdate().then((result) => {
      this.phase = result.ok ? "updated" : "failed";
      this.detail = result.ok
        ? result.version || this.latest
        : result.error || "npm did not report a reason.";
      this.selectedIdx = 0;
      this.app.render();
    });
  }

  private close(): void {
    if (this.phase === "installing") return;
    this.app.popScreen();
  }

  private activate(index: number): void {
    const label = this.buttons()[index];
    if (!label) return;
    if (label === "Update now") this.start();
    else this.close();
  }

  private move(delta: number): void {
    const count = this.buttons().length;
    if (count === 0) return;
    this.selectedIdx = (this.selectedIdx + delta + count) % count;
    this.app.render();
  }

  onKey(key: Key): void {
    if (key.name === "up") this.move(-1);
    else if (key.name === "down") this.move(1);
    else if (key.name === "return" || key.name === "enter") this.activate(this.selectedIdx);
    else if (key.name === "escape") this.close();
  }

  onMouse(ev: MouseEvent): void {
    const count = this.buttons().length;
    const indexAt = (x: number, y: number): number => {
      for (let i = 0; i < count; i++) {
        if (inRect(x, y, { x: BUTTON_X, y: this.buttonRow(i), w: this.app.width - 2, h: BUTTON_H })) return i;
      }
      return -1;
    };
    if (ev.type === "move") {
      if (ev.x === this.lastHoverX && ev.y === this.lastHoverY) return;
      this.lastHoverX = ev.x;
      this.lastHoverY = ev.y;
      const hover = indexAt(ev.x, ev.y);
      if (hover >= 0 && hover !== this.selectedIdx) {
        this.selectedIdx = hover;
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
        this.close();
        return;
      }
      const index = indexAt(ev.x, ev.y);
      if (index < 0) return;
      this.selectedIdx = index;
      this.activate(index);
    }
  }

  /** What the dialog says, in the order it is drawn. */
  private body(): Line[] {
    const normal: Style = { fg: C.white };
    const note: Style = { fg: C.dim };
    if (this.phase === "installing") {
      return [
        { text: `Installing Neutrino ${this.latest} with npm…`, style: normal },
        { text: "This can take a minute. Neutrino keeps running while npm works.", style: note },
      ];
    }
    if (this.phase === "updated") {
      return [
        { text: `Neutrino ${this.detail} was installed.`, style: { fg: C.green, bold: true } },
        { text: "Restart Neutrino to run the new version: this terminal keeps the old one until it exits.", style: normal },
      ];
    }
    if (this.phase === "failed") {
      return [
        { text: "The automatic update failed. Neutrino was not changed.", style: { fg: C.red, bold: true } },
        { text: this.detail, style: normal },
        { text: "Update by hand with:", style: note },
        { text: MANUAL_UPDATE_COMMAND, style: { fg: C.accent, bold: true } },
      ];
    }
    return [
      { text: `Neutrino ${this.latest} is available.`, style: normal },
      { text: "Update now installs it with npm. Restart Neutrino afterwards to use it.", style: note },
    ];
  }

  render(buf: Buffer): void {
    drawHeader(buf, this.app.state);

    const h = buf.height;
    const title = this.phase === "prompt" ? "Update available"
      : this.phase === "installing" ? "Updating Neutrino"
        : this.phase === "updated" ? "Update installed"
          : "Update failed";
    buf.centerText(TITLE_ROW, title, { fg: C.accent, bold: true });
    buf.centerText(META_ROW, `Running ${this.current} · Published ${this.latest}`, { fg: C.dim });

    // Body paragraphs wrap to the terminal width so a narrow window still reads,
    // and stop above the buttons so the two can never overlap.
    const width = this.bodyWidth();
    const bodyEnd = h - 1 - this.buttons().length * BUTTON_H;
    let y = BODY_TOP;
    for (const line of this.body()) {
      for (const piece of wrapText(line.text, width)) {
        if (y >= bodyEnd) break;
        buf.writeText(BODY_X, y, piece, line.style);
        y++;
      }
    }

    const buttons = this.buttons();
    for (let i = 0; i < buttons.length; i++) {
      drawTabButton(buf, BUTTON_X, this.buttonRow(i), buf.width - BUTTON_X * 2, buttons[i], i === this.selectedIdx);
    }

    const hint = this.phase === "installing"
      ? "npm is running; this screen closes when it finishes"
      : buttons.length > 1
        ? "↑/↓ select · Enter confirm · click to choose · Esc later"
        : "Enter or Esc close";
    drawHint(buf, h - 1, hint);
  }
}
