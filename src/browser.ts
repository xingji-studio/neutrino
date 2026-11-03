import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Where the browser console's Pro workspace lives, given the console's base
 * URL.
 *
 * The base comes straight from the running server, but it is normalised here
 * anyway: a trailing slash must not produce `//pro`, and a URL that already
 * points at `/pro` must not become `/pro/pro`. A missing/blank base yields the
 * path alone instead of throwing, so a half-configured console can still be
 * reported instead of crashing the click that asked for it.
 */
export function proModeUrl(baseUrl: string): string {
  const base = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  if (/\/pro$/i.test(base)) return base;
  return `${base}/pro`;
}

/**
 * Open `url` in the user's default browser. Fire-and-forget: the child is
 * detached, its stdio is ignored and it is unref'd so the terminal is never
 * held open (or blocked) by the browser. Every failure is swallowed — opening
 * a browser is best-effort and must never take the TUI down.
 */
export function openInBrowser(url: string): void {
  try {
    let command: string;
    let args: string[];
    if (process.platform === "win32") {
      // `start` is a cmd built-in. The empty "" is the (required) window title,
      // so a quoted URL is never mistaken for one.
      command = "cmd";
      args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    // A missing opener (xdg-open is not installed everywhere) is reported
    // asynchronously; without a listener that 'error' event would crash the
    // whole process.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Best-effort only.
  }
}
