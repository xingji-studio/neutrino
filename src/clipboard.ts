import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Copy `text` to the system clipboard.
 *
 * Two independent, best-effort strategies are used so the copy works across as
 * many terminals as possible:
 *
 *   1. OSC 52 — a terminal escape sequence that asks the host terminal to put
 *      the (base64-encoded) text on the clipboard. This is the only strategy
 *      that also works over SSH, and is supported by Windows Terminal, iTerm2,
 *      Kitty, WezTerm, Alacritty, …
 *   2. A native helper process (`clip` / `pbcopy` / `wl-copy` / `xclip` / …),
 *      as a fallback for terminals that ignore OSC 52.
 *
 * Both are best-effort: any failure is silently ignored.
 */
export function copyToClipboard(text: string): void {
  if (!text) return;
  copyViaOsc52(text);
  copyViaNative(text);
}

function copyViaOsc52(text: string): void {
  try {
    const payload = Buffer.from(text, "utf8").toString("base64");
    // OSC 52 ; <selection> ; <base64> BEL
    process.stdout.write(`\x1b]52;c;${payload}\x07`);
  } catch {
    /* ignore */
  }
}

function copyViaNative(text: string): void {
  if (process.platform === "win32") {
    copyWindows(text);
    return;
  }
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.env.WAYLAND_DISPLAY
        ? [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ]
        : [
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
            ["wl-copy", []],
          ];
  pipeToFirstAvailable(candidates, text);
}

/** Spawn the first available helper and pipe the text into it. */
function pipeToFirstAvailable(candidates: Array<[string, string[]]>, text: string): void {
  let index = 0;
  const tryNext = (): void => {
    if (index >= candidates.length) return;
    const [cmd, args] = candidates[index++];
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      tryNext();
      return;
    }
    child.once("error", () => tryNext());
    child.once("spawn", () => {
      child.stdin?.end(text);
    });
    child.stdin?.on("error", () => {
      /* the helper closed early — ignore */
    });
  };
  tryNext();
}

/**
 * Windows: `clip.exe` decodes its input using the console code page, which
 * mangles non-ASCII text. Instead we drop the text in a temp file and let
 * PowerShell read it back as UTF-8 via the Unicode-aware Set-Clipboard cmdlet.
 */
function copyWindows(text: string): void {
  let tmp: string | null = null;
  try {
    tmp = path.join(os.tmpdir(), `neutrino-clip-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(tmp, text, "utf8");
    const script =
      `Set-Clipboard -Value ([IO.File]::ReadAllText(${psQuote(tmp)}, [Text.Encoding]::UTF8)); ` +
      `Remove-Item -LiteralPath ${psQuote(tmp)} -ErrorAction SilentlyContinue`;
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", () => {
      if (tmp) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* ignore */
  }
}

function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}
