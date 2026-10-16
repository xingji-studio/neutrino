// Regression tests for terminal-side *drift*.
//
// The renderer only repaints rows whose cells changed (that is what keeps
// redraws cheap). But the terminal can move its own contents behind our back —
// ConPTY reflowing the grid mid-resize, a size-race repaint, a stray scroll —
// and a diffed row then stays stale forever. The visible symptom is the chat
// input box being "swallowed" by the log: the 5 rows around it keep showing
// whatever drifted into them because their contents never change.
//
// The fix has two halves, both exercised here:
//   1. Screen.alwaysRepaintRows() — the input chrome is repainted every frame,
//      so it heals immediately (absolute positioning restores it in place).
//   2. Renderer.repaint()       — periodically re-emit the whole cached frame,
//      so drift anywhere else is repaired too.
import { Buffer } from "../dist/terminal/buffer.js";
import { Renderer } from "../dist/terminal/renderer.js";
import { ChatScreen } from "../dist/screens/chat.js";
import { Term } from "./emu.mjs";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function rowText(cells) {
  return cells.map((c) => c.ch).filter((c) => c !== "").join("");
}

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

// Shift the emulated terminal's contents up by one row, as an external scroll
// would, without touching the renderer's caches. `scrollUp` flags `scrolled`;
// reset it since this drift is *not* something our output caused.
function drift(term, rows = 1) {
  for (let i = 0; i < rows; i++) term.scrollUp();
  term.scrolled = false;
}

function checkRows(term, buf, ys, label) {
  let ok = true;
  for (const y of ys) {
    const want = rowText(buf.cells[y]).trimEnd();
    const got = term.rowText(y).trimEnd();
    if (want !== got) {
      ok = false;
      fail(`${label}: row ${y}\n  want |${want}|\n  got  |${got}|`);
    }
  }
  return ok;
}

// ---------------------------------------------------------------------------
const CJK = "中文测试内容渲染残留检测，这是一段较长的中文文本来测试换行与截断行为。";

function driftRepaired(w, h) {
  const term = new Term(w, h);
  const renderer = new Renderer();
  renderer.out = { write: (s) => term.feed(s) };
  const app = stubApp(w, h);
  const screen = new ChatScreen("");
  screen.app = app;
  const buf = new Buffer(w, h);
  screen.messages = [{ role: "system", content: "Model: DeepSeek/deepseek-chat | Intensity: High" }];
  screen.messages.push({ role: "user", content: "hello" });
  screen.messages.push({ role: "assistant", content: CJK.repeat(3) });

  // Seed many frames so the log is tall enough to be scrolled.
  for (let i = 0; i < 6; i++) {
    screen.messages.push({ role: "assistant", content: `line ${i} ${CJK}` });
  }
  screen.inputValue = "typing a reply";
  screen.cursor = screen.inputValue.length;

  const chrome = screen.alwaysRepaintRows();
  if (chrome.length === 0) fail("chat alwaysRepaintRows() returned no rows");
  if (!chrome.includes(h - 4)) fail(`chat chrome missing input box top (h-4=${h - 4})`);

  screen.render(buf);
  renderer.render(buf, chrome);

  // Now the terminal drifts. Re-rendering the *same* state must restore the
  // chrome rows purely from the forced repaint.
  drift(term, 1);
  screen.render(buf);
  renderer.render(buf, chrome);
  checkRows(term, buf, chrome, "chrome after external drift");

  // A second drift, deeper, still healed on the next frame.
  drift(term, 3);
  screen.render(buf);
  renderer.render(buf, chrome);
  checkRows(term, buf, chrome, "chrome after deeper drift");

  // The periodic safety net rebuilds the ENTIRE frame, not just the chrome.
  drift(term, 2);
  renderer.repaint();
  let whole = true;
  for (let y = 0; y < h; y++) {
    if (rowText(buf.cells[y]).trimEnd() !== term.rowText(y).trimEnd()) {
      whole = false;
      fail(`repaint() row ${y}: want |${rowText(buf.cells[y]).trimEnd()}| got |${term.rowText(y).trimEnd()}|`);
      break;
    }
  }
  if (term.scrolled) {
    fail("renderer caused a scroll");
    term.scrolled = false;
  }
  if (whole) console.log(`ok   drift-repaired ${w}x${h} (chrome ${chrome.length} rows)`);
}

// ---------------------------------------------------------------------------
// A standalone renderer check: forceRows repaints even when nothing changed,
// and a plain render with unchanged input emits nothing at all.
function rendererForce() {
  const w = 40;
  const h = 10;
  const term = new Term(w, h);
  const r = new Renderer();
  r.out = { write: (s) => term.feed(s) };
  const buf = new Buffer(w, h);
  buf.writeText(1, 1, "hello world");

  r.render(buf, []);
  drift(term, 1);
  r.render(buf, []); // no changes -> nothing emitted -> stays drifted
  if (term.rowText(1).trim() === "hello world") {
    fail("plain diff render unexpectedly repainted an unchanged row");
  }
  r.render(buf, [1]); // forced -> repainted
  if (term.rowText(1).trim() !== "hello world") {
    fail("forced row was not repainted");
  }
  console.log("ok   renderer forceRows");
}

for (const [w, h] of [
  [80, 24],
  [100, 30],
  [40, 12],
  [120, 40],
]) {
  driftRepaired(w, h);
}
rendererForce();

console.log(failures === 0 ? "\nDRIFT TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
