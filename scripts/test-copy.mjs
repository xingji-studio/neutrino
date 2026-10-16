// Regression tests for "copying a selection drags in the scrollbar and the
// trailing padding".
//
// The conversation log draws its text only up to ~w-3, leaving the last column
// for the scrollbar. A multi-line selection is copied out to the buffer's full
// width and then trimmed per line — but the scrollbar glyph (│/█) is NOT
// whitespace, so the trailing-blank trim used to stop at the bar and the copy
// came out as "text<padding>█". The fix marks the bar as UI *chrome* and skips
// chrome both when trimming and when highlighting.
import { Buffer } from "../dist/terminal/buffer.js";
import { applySelection, selectionText } from "../dist/selection.js";
import { drawScrollbar } from "../dist/ui.js";
import { ChatScreen } from "../dist/screens/chat.js";
import { C } from "../dist/colors.js";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

const SEL = C.selection.join(",");
const isSel = (c) => c.style.bg && c.style.bg.join(",") === SEL;

// ---------------------------------------------------------------------------
// 1. A wide selection over a full scrollbar track copies neither the bar nor
//    the padding in front of it.
// ---------------------------------------------------------------------------
{
  const buf = new Buffer(20, 4);
  buf.writeText(0, 0, "alpha", {});
  buf.writeText(0, 1, "beta", {});
  buf.writeText(0, 2, "  gamma", {}); // indentation must survive
  drawScrollbar(buf, 19, 0, 3, 100, 2, 0); // overflows => whole track is drawn

  const bar = buf.cells.map((r) => r[19].ch).join("");
  assert(bar.includes("│") || bar.includes("█"), "test setup: scrollbar should be drawn");
  assert(buf.cells.every((r) => r[19].chrome === true), "scrollbar cells should be marked chrome");

  const text = selectionText(buf, { anchor: { x: 0, y: 0 }, cursor: { x: 19, y: 3 } });
  assert(!text.includes("│") && !text.includes("█"), `scrollbar leaked into copy: ${JSON.stringify(text)}`);
  assert(!/[ \t]$/m.test(text), `trailing whitespace leaked into copy: ${JSON.stringify(text)}`);
  assert(
    text === "alpha\nbeta\n  gamma",
    `unexpected copy text: ${JSON.stringify(text)}`,
  );
  console.log("ok   full-width copy excludes the scrollbar");
}

// ---------------------------------------------------------------------------
// 2. A selection that ends exactly on the scrollbar column still trims clean.
// ---------------------------------------------------------------------------
{
  const buf = new Buffer(16, 2);
  buf.writeText(0, 0, "one", {});
  buf.writeText(0, 1, "two", {});
  drawScrollbar(buf, 15, 0, 1, 50, 1, 0);
  const text = selectionText(buf, { anchor: { x: 0, y: 0 }, cursor: { x: 15, y: 1 } });
  assert(text === "one\ntwo", `single-column-end copy should be clean, got ${JSON.stringify(text)}`);
  console.log("ok   selection ending on the bar trims clean");
}

// ---------------------------------------------------------------------------
// 3. Highlighting never spills onto the scrollbar column.
// ---------------------------------------------------------------------------
{
  const buf = new Buffer(20, 3);
  buf.writeText(0, 0, "hello", {});
  buf.writeText(0, 1, "world", {});
  drawScrollbar(buf, 19, 0, 2, 100, 2, 0);
  applySelection(buf, { anchor: { x: 0, y: 0 }, cursor: { x: 19, y: 2 } });
  const barHighlighted = buf.cells.some((r) => isSel(r[19]));
  assert(!barHighlighted, "scrollbar column must not be highlighted");
  assert(isSel(buf.cells[0][0]), "content cells should still be highlighted");
  console.log("ok   scrollbar column is not highlighted");
}

// ---------------------------------------------------------------------------
// 4. End-to-end: a real ChatScreen log with an overflowing conversation.
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

{
  const w = 60;
  const h = 16;
  const app = stubApp(w, h);
  const screen = new ChatScreen("");
  screen.app = app;
  const msgs = [{ role: "system", content: "Model: DeepSeek/deepseek-chat" }];
  for (let i = 0; i < 40; i++) msgs.push({ role: "assistant", content: `reply number ${i}` });
  screen.messages = msgs;

  const buf = new Buffer(w, h);
  screen.render(buf);

  // The log lives in rows 2..h-6 and the bar is in the last column.
  const bar = screen.scrollbar();
  assert(bar, "an overflowing chat should expose a scrollbar");
  assert(bar.x === w - 1, `scrollbar should sit in the last column, got ${bar.x}`);

  // Drag-select several log lines, starting at the content margin (x=2) and
  // running all the way to the right edge.
  const sel = { anchor: { x: 2, y: 2 }, cursor: { x: w - 1, y: 6 } };
  const text = selectionText(buf, sel);
  assert(text.length > 0, "expected a non-empty selection");
  assert(!text.includes("│") && !text.includes("█"), `scrollbar leaked into chat copy: ${JSON.stringify(text)}`);
  assert(!/[ \t]$/m.test(text), `trailing whitespace leaked into chat copy: ${JSON.stringify(text)}`);
  console.log("ok   chat log copy is clean (" + JSON.stringify(text.split("\n")[0]) + " …)");
}

console.log(failures === 0 ? "\nCOPY TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
