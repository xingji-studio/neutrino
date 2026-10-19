import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { flushSessionCheckpoints } from "../persistence.js";

const NEUTRINO_DIR = path.join(os.homedir(), ".neutrino");

/**
 * Escape sequences that undo everything the TUI switches on.
 *
 * Mouse tracking is disabled before the alternate screen is left, and the
 * cursor is restored before the screen swap, so the shell never inherits a
 * half-configured terminal. Order matters: `?1049l` must come last or the
 * remaining writes would land on the main screen.
 */
export const TUI_TEARDOWN =
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l" + // mouse tracking off
  "\x1b[?25h" + // cursor visible
  "\x1b[0m" + // default attributes
  "\x1b[?1049l"; // back to the main screen

/** Whether a TUI has claimed the terminal and its state still needs undoing. */
let active = false;
let restored = false;
let installed = false;

/** Called once the renderer has entered the alternate screen and raw mode. */
export function markTuiActive(): void {
  // Unconditional: only the renderer calls this, and the renderer is only ever
  // constructed once the app has decided it owns a real terminal.
  active = true;
  restored = false;
}

/**
 * Puts the terminal back into a usable state, synchronously and at most once.
 *
 * Everything here has to work while the process is dying: no promises, no
 * asynchronous writes, and every step individually guarded so one failure
 * cannot skip the rest (a broken `setRawMode` must not leave the cursor
 * hidden, for example).
 */
export function restoreTerminalSync(): boolean {
  if (!active || restored) return false;
  let outputRestored = false;
  let inputRestored = false;
  try {
    // fd 1 write is the only one guaranteed to be flushed by a dying process;
    // `process.stdout.write` may queue the bytes and lose them at exit.
    const bytes = Buffer.from(TUI_TEARDOWN);
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(1, bytes, offset, bytes.length - offset);
      if (written === 0) throw new Error("terminal write made no progress");
      offset += written;
    }
    outputRestored = true;
  } catch {
    try {
      process.stdout.write(TUI_TEARDOWN);
    } catch {
      // The terminal is gone; there is nothing left to restore.
    }
  }
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
    inputRestored = true;
  } catch {
    // stdin already closed, or not a TTY we can reconfigure.
  }
  // A queued or failed write must not disarm the synchronous exit retry.
  restored = outputRestored && inputRestored;
  return restored;
}

/** Appends a crash entry to `~/.neutrino/crash.log` and returns the path. */
export function writeCrashLog(kind: string, err: unknown): string | null {
  const detail =
    err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  const entry = `[${new Date().toISOString()}] ${kind} pid=${process.pid}\n${detail}\n\n`;
  try {
    fs.mkdirSync(NEUTRINO_DIR, { recursive: true });
    const file = path.join(NEUTRINO_DIR, "crash.log");
    fs.appendFileSync(file, entry, "utf8");
    return file;
  } catch {
    return null;
  }
}

/**
 * Installs process-wide handlers that restore the terminal before the process
 * dies.
 *
 * Without this, any throw that escapes a timer, a stream callback or a floating
 * promise kills the process with raw mode still on and the alternate screen
 * still active. The visible result is a terminal that works but spews
 * `[<b>;<x>;<y>M` mouse reports at the shell prompt, because the shell now
 * receives the mouse events the TUI asked the terminal to send.
 */
export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  let flushed = false;
  const finalize = (): boolean => {
    restoreTerminalSync();
    if (flushed) return true;
    flushed = true;
    return flushSessionCheckpoints();
  };
  process.on("exit", () => {
    if (!finalize()) {
      try {
        fs.writeSync(2, "\nneutrino: some conversation changes could not be saved; check disk access and crash.log.\n");
      } catch {
        // The crash log is the remaining record if stderr is unavailable.
      }
    }
  });

  // These signals otherwise bypass Node's exit hook, including Ctrl+Break on
  // Windows. SIGINT/SIGTERM are handled by App.quit (or the web server).
  process.on("SIGHUP", () => process.exit(129));
  process.on("SIGBREAK", () => process.exit(149));

  const fatal = (kind: string, err: unknown): void => {
    // Restore first: the terminal must be usable even if logging itself fails.
    const saved = finalize();
    const file = writeCrashLog(kind, err);
    const detail =
      err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
    try {
      const tail = file ? `\nFull log: ${file}` : "";
      fs.writeSync(2,
        `\nneutrino stopped: ${kind}\n\n${detail}\n\n` +
          (saved
            ? "Check history for the latest saved conversation snapshots."
            : "Some conversation changes could not be saved; check disk access and crash.log.") +
          `${tail}\n`,
      );
    } catch {
      // stderr is gone too; the crash log is the only record.
    }
    process.exit(1);
  };

  process.on("uncaughtException", (err) => fatal("uncaught exception", err));
  process.on("unhandledRejection", (err) => fatal("unhandled rejection", err));
}
