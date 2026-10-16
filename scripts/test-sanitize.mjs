// Regression tests for text hygiene.
//
// The renderer copies a cell's glyph straight into the output stream, so a cell
// holding a control character turns into a command the terminal executes: an
// ESC sequence can move the cursor, clear the screen or leave the alternate
// buffer, and a TAB shifts the rest of the row. Tool output (ANSI colours, tabs,
// progress bars), file contents and pasted text all carry such bytes, so they
// must be neutralised. The symptom when they leak is rows — typically the ones
// around the input box — being smeared, swallowed or shifted, which is what
// scrolling (e.g. dragging the scrollbar) brings into view.
import { Buffer } from "../dist/terminal/buffer.js";
import { Renderer } from "../dist/terminal/renderer.js";
import { ChatScreen } from "../dist/screens/chat.js";
import { sanitizeText, stripAnsi, isControlChar } from "../dist/sanitize.js";
import { displayWidth } from "../dist/width.js";
import { Term } from "./emu.mjs";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function assertEq(got, want, msg) {
  if (got !== want) fail(`${msg}\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`);
}
function bufRow(cells) {
  return cells.map((c) => c.ch).filter((c) => c !== "").join("").trimEnd();
}

// ---------------------------------------------------------------------------
// 1. sanitizeText / stripAnsi
// ---------------------------------------------------------------------------
{
  assertEq(stripAnsi("\x1b[31mred\x1b[0m"), "red", "SGR colours are removed");
  assertEq(stripAnsi("\x1b[2Jcleared"), "cleared", "erase-screen is removed");
  assertEq(stripAnsi("a\x1b[3;4Hb"), "ab", "cursor positioning is removed");
  assertEq(stripAnsi("\x1b]0;title\x07x"), "x", "OSC titles are removed");
  assertEq(stripAnsi("\x1b]52;c;aGk=\x07x"), "x", "OSC 52 clipboard is removed");
  assertEq(stripAnsi("\x1b[?1049h x"), " x", "private-mode sequences are removed");
  // The whole sequence goes, not just the ESC byte (which would leave "[31m").
  assert(!stripAnsi("\x1b[31mred\x1b[0m").includes("[31m"), "the parameters go too");
  assertEq(stripAnsi("plain"), "plain", "plain text is untouched");

  assertEq(sanitizeText("a\tb"), "a    b", "tabs expand to 4 spaces");
  assertEq(sanitizeText("a\r\nb"), "a\nb", "CRLF normalises to LF");
  assertEq(sanitizeText("a\rb"), "a\nb", "bare CR normalises to LF");
  assertEq(sanitizeText("keep\nthis"), "keep\nthis", "newlines are kept for the layout engine");
  assertEq(sanitizeText("x\x07y\x00z"), "xyz", "other control codes are dropped");
  assertEq(sanitizeText("a\nb", { singleLine: true }), "a b", "singleLine collapses newlines");
  assertEq(sanitizeText("\x1b[31mred\x1b[0m\tX"), "red    X", "escapes + tab together");

  // Anything the sanitizer returns must be safe to hand to a terminal.
  for (const s of ["\x1b[2J", "\t", "\x1b", "\x07", "\x1b]0;x\x07", "\x1b[?25l"]) {
    const out = sanitizeText(s);
    for (const ch of out) {
      if (isControlChar(ch) && ch !== "\n") fail(`sanitizeText left a control char in ${JSON.stringify(s)}`);
    }
  }
  assert(isControlChar("\t") && isControlChar("\x1b") && isControlChar("\x7f"), "isControlChar spots codes");
  assert(isControlChar("\n"), "LF is a control code, and a cell must never hold one");
  assert(isControlChar("\n"), "LF is a control code, and a cell must never hold one");
  assert(!isControlChar("a") && !isControlChar("中") && !isControlChar("█"), "isControlChar leaves glyphs alone");
}

// ---------------------------------------------------------------------------
// 2. The Buffer can never hold a control character, and widths do not drift
// ---------------------------------------------------------------------------
{
  const src = "a\x1bb\tc\x00d";
  assertEq(displayWidth(src), 6, "reference width counts codes as 1 (and NUL as 0)");

  const buf = new Buffer(12, 2);
  buf.writeText(0, 0, src, {});
  const row = buf.cells[0].map((c) => c.ch).join("");
  assertEq(row.slice(0, 6), "a b cd", "control chars become spaces, in place");
  for (let x = 0; x < 12; x++) {
    if (isControlChar(buf.cells[0][x].ch)) fail(`Buffer.writeText stored a control char at x=${x}`);
  }

  buf.set(3, 1, "\x1b", {});
  assert(!isControlChar(buf.cells[1][3].ch), "Buffer.set neutralises a control char");
}

// ---------------------------------------------------------------------------
// 3. The renderer never emits a raw control character, even if a cell holds one
// ---------------------------------------------------------------------------
{
  const term = new Term(20, 4);
  const r = new Renderer();
  r.out = { write: (s) => term.feed(s) };
  const buf = new Buffer(20, 4);
  // Force rogue cells in directly, bypassing Buffer's own guard.
  buf.cells[1][2] = { ch: "\x1b[2J", style: {} };
  buf.cells[2][0] = { ch: "\t", style: {} };
  r.render(buf, []);
  assert(!term.rawControl, "renderer emitted a raw control character");
  assert(!term.scrolled, "renderer cleared/scrolled the screen via a rogue cell");
}

// ---------------------------------------------------------------------------
// 4. End-to-end: adversarial chat content renders cleanly
// ---------------------------------------------------------------------------
function stubApp(w, h) {
  return {
    width: w,
    height: h,
    state: {
      selectedProvider: "DeepSeek",
      selectedModelName: "deepseek-chat",
      selectedModelUrl: "",
      selectedModelApiKey: "",
      selectedModelStreaming: true,
      selectedIntensity: "High",
      isThinking: false,
      blinkOn: false,
      cursorOn: true,
      selection: null,
    },
    render() {},
    popScreen() {},
    openModelConfig() {},
  };
}

function adversarial(w, h, expandTool) {
  const term = new Term(w, h);
  const renderer = new Renderer();
  renderer.out = { write: (s) => term.feed(s) };

  const app = stubApp(w, h);
  const screen = new ChatScreen("");
  screen.app = app;
  screen.messages = [
    { role: "system", content: "Model: DeepSeek/deepseek-chat" },
    { role: "user", content: "hello \x1b[2Jworld\twith tab\x07" },
    // Code blocks keep tabs; inline code can too.
    { role: "assistant", content: "```sh\n\tls --color\n\x1b[31mred\x1b[0m\n```\nand `a\tb` inline" },
    {
      role: "tool",
      name: "run_command",
      arguments: { command: "ls --color=always\t." },
      result: "\x1b[31mred\x1b[0m\tcol2\r\nline2 \x1b[1;33myellow\x1b[0m\r\n\x1b[2J\x1b[Hclear",
    },
    { role: "assistant", content: "done ✅ 中文内容" },
  ];
  if (expandTool) screen.expandedTools.add(3);

  // Several frames, as if the log were scrolling into view.
  for (let i = 0; i < 3; i++) {
    const buf = new Buffer(w, h);
    screen.render(buf);
    renderer.render(buf, screen.alwaysRepaintRows());
    if (term.rawControl) fail(`raw control char emitted (${w}x${h}, expandTool=${expandTool}, frame ${i})`);
    if (term.scrolled) fail(`terminal scrolled (${w}x${h}, expandTool=${expandTool}, frame ${i})`);
    // The terminal must show exactly the intended frame.
    for (let y = 0; y < h; y++) {
      const want = bufRow(buf.cells[y]);
      const got = term.rowText(y).trimEnd();
      if (want !== got) {
        fail(`frame mismatch (${w}x${h}) row ${y}\n  want |${want}|\n  got  |${got}|`);
        break;
      }
    }
    // Scrolling the log brings other lines into view; re-render each step.
    screen.scrollTop = Math.max(0, screen.scrollTop - 2);
    screen.followBottom = false;
  }

  // The visible text kept the payload but lost the escapes.
  const all = term.grid.map((_, y) => term.rowText(y)).join("\n");
  assert(all.includes("red"), "the payload text survives");
  assert(!all.includes("[31m") && !all.includes("[0m"), "ANSI parameters never reach the screen");
  assert(!all.includes("col2\t"), "no raw tab in the output");
}

for (const [w, h] of [[80, 24], [60, 16], [100, 30]]) {
  adversarial(w, h, false);
  adversarial(w, h, true);
}
console.log("ok   adversarial chat content renders clean");

// ---------------------------------------------------------------------------
// 5. Pasted text: control bytes never enter the input value
// ---------------------------------------------------------------------------
{
  const app = stubApp(60, 16);
  const screen = new ChatScreen("");
  screen.app = app;
  screen.onPaste("before\t\x1b[31mmid\x1b[0m\nafter");
  assertEq(screen.inputValue, "before    mid after", "paste is sanitised to one clean line");
  assertEq(screen.cursor, screen.inputValue.length, "cursor follows the sanitised paste");
  for (const ch of screen.inputValue) {
    if (isControlChar(ch)) fail("paste left a control char in the input value");
  }
}

console.log(failures === 0 ? "\nSANITIZE TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
