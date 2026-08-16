import type { Buffer } from "./buffer.js";
import type { Key, MouseEvent } from "./input.js";
import type { App } from "../app.js";

export abstract class Screen {
  app!: App;

  abstract onKey(key: Key): void;

  onMouse(_ev: MouseEvent): void {}

  abstract render(buf: Buffer): void;

  onActivate(): void {}

  onDeactivate(): void {}
}
