import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

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
 * Tells the guard the terminal is already back to normal, so the `exit`
 * handler does not write a second teardown sequence over the shell.
 */
export function markTerminalRestored(): void {
  restored = true;
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
  restored = true;
  const seq = TUI_TEARDOWN;
  try {
    // fd 1 write is the only one guaranteed to be flushed by a dying process;
    // `process.stdout.write` may queue the bytes and lose them at exit.
    fs.writeSync(1, seq);
  } catch {
    try {
      process.stdout.write(seq);
    } catch {
      // The terminal is gone; there is nothing left to restore.
    }
  }
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
  } catch {
    // stdin already closed, or not a TTY we can reconfigure.
  }
  return true;
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

  process.on("exit", () => restoreTerminalSync());

  const fatal = (kind: string, err: unknown): void => {
    // Restore first: the terminal must be usable even if logging itself fails.
    restoreTerminalSync();
    const file = writeCrashLog(kind, err);
    const detail =
      err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
    try {
      const tail = file ? `\nFull log: ${file}` : "";
      process.stderr.write(
        `\nneutrino stopped: ${kind}\n\n${detail}\n\n` +
          `The terminal was restored and your conversation is saved.${tail}\n`,
      );
    } catch {
      // stderr is gone too; the crash log is the only record.
    }
    process.exit(1);
  };

  process.on("uncaughtException", (err) => fatal("uncaught exception", err));
  process.on("unhandledRejection", (err) => fatal("unhandled rejection", err));
}
