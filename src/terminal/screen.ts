import type { Buffer } from "./buffer.js";
import type { Key, MouseEvent } from "./input.js";
import type { App } from "../app.js";

export abstract class Screen {
  app!: App;

  abstract onKey(key: Key): void;

  onMouse(_ev: MouseEvent): void {}

  abstract render(buf: Buffer): void;

  /** Whether this screen currently shows a blinking text cursor. Used by the
   *  app to run (or stop) the cursor blink timer. */
  showsCursor(): boolean {
    return false;
  }

  onActivate(): void {}

  onDeactivate(): void {}
}
