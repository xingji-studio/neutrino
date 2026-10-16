/**
 * Text hygiene for anything that will be drawn into the terminal Buffer.
 *
 * The renderer copies a cell's glyph straight into the output stream, so a cell
 * that somehow holds a *control* character turns into a command the terminal
 * executes: an ESC sequence can move the cursor, clear the screen or leave the
 * alternate buffer, and a TAB shifts the rest of the row. Tool output (ANSI
 * colours from `ls --color`, `git`, `npm`, progress bars, …), file contents and
 * pasted text routinely carry such bytes, so they must be neutralised before
 * they can reach the screen.
 *
 * `sanitizeText` is the *display-side* cleanup: it removes whole escape
 * sequences (not just the ESC byte, which would leave `[31m` behind as literal
 * text), expands tabs so every character's measured width matches what the
 * terminal will draw, and drops any remaining control code. Newlines are kept
 * because the wrapping/markdown layer needs them to lay text out.
 */

// Control Sequence Introducer: ESC [ params intermediates final
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Operating System Command: ESC ] … (BEL | ST)
const OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;
// Device Control / Privacy Message / Application Program Command … ST
const DCS = /\x1b[P^_X][\s\S]*?\x1b\\/g;
// Two-character Fe/Fs/Fp escapes (ESC 7, ESC =, ESC (B, …)
const ESC_SIMPLE = /\x1b[ -/]*[@-~]/g;
// A lone ESC that nothing else matched.
const ESC_LONE = /\x1b/g;

/** Remove ANSI/VT escape sequences from `text`. */
export function stripAnsi(text: string): string {
  return text
    .replace(OSC, "")
    .replace(DCS, "")
    .replace(CSI, "")
    .replace(ESC_SIMPLE, "")
    .replace(ESC_LONE, "");
}

// C0 controls (except LF, which the layout engine needs) plus DEL and C1.
const OTHER_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export interface SanitizeOptions {
  /** How many spaces a tab expands to. Defaults to 4. */
  tabWidth?: number;
  /** When true, newlines are also collapsed to spaces (for single-line fields
   *  such as the chat input). Defaults to false. */
  singleLine?: boolean;
}

/**
 * Make `text` safe to render: normalise newlines, drop escape sequences, expand
 * tabs and remove every other control code. The result contains no character
 * the terminal would interpret as a command, so it can never corrupt the grid.
 */
export function sanitizeText(text: string, opts: SanitizeOptions = {}): string {
  const tabWidth = opts.tabWidth ?? 4;
  let s = text.replace(/\r\n?/g, "\n");
  s = stripAnsi(s);
  if (tabWidth > 0) s = s.replace(/\t/g, " ".repeat(tabWidth));
  s = s.replace(OTHER_CONTROLS, "");
  if (opts.singleLine) s = s.replace(/\s*\n\s*/g, " ");
  return s;
}

/** True if `ch` is a character the terminal would treat as a control code. */
export function isControlChar(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 32 || (cp >= 0x7f && cp <= 0x9f);
}
