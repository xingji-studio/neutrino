// Regression tests for the vertical scrollbar drawn on the conversation
// ("context") log. Verifies the thumb size/position math and that it is hidden
// when the content fits, both directly and through a real ChatScreen render.
import { Buffer } from "../dist/terminal/buffer.js";
import { drawScrollbar, scrollbarGeometry, offsetFromThumbTop } from "../dist/ui.js";
import { ChatScreen } from "../dist/screens/chat.js";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

// Read the scrollbar column (x) for rows top..bottom as a string of "█"/"│"/" ".
function column(buf, x, top, bottom) {
  let s = "";
  for (let y = top; y <= bottom; y++) s += buf.cells[y][x].ch || " ";
  return s;
}

function firstThumb(track) {
  return track.indexOf("█");
}
function thumbLen(track) {
  let n = 0;
  for (const c of track) if (c === "█") n++;
  return n;
}

// ---------------------------------------------------------------------------
// 1. Hidden when everything fits
// ---------------------------------------------------------------------------
{
  const buf = new Buffer(20, 10);
  drawScrollbar(buf, 19, 0, 9, 5, 10, 0); // total(5) <= viewport(10)
  assert(column(buf, 19, 0, 9).trim() === "", "scrollbar should be hidden when it fits");
}

// ---------------------------------------------------------------------------
// 2. Thumb size is proportional, min 1
// ---------------------------------------------------------------------------
{
  const buf = new Buffer(20, 10);
  drawScrollbar(buf, 19, 0, 9, 100, 10, 0); // trackH=10, viewport=10, total=100
  const track = column(buf, 19, 0, 9);
  assert(track.length === 10, "track should span the full range");
  assert(thumbLen(track) === 1, `10/100 of a 10-cell track => 1-cell thumb, got ${thumbLen(track)}`);
}

{
  const buf = new Buffer(20, 10);
  drawScrollbar(buf, 19, 0, 9, 20, 10, 0); // half visible
  const track = column(buf, 19, 0, 9);
  assert(thumbLen(track) === 5, `half visible => half-height thumb, got ${thumbLen(track)}`);
}

// ---------------------------------------------------------------------------
// 3. Thumb position tracks the offset
// ---------------------------------------------------------------------------
{
  const bufTop = new Buffer(20, 10);
  drawScrollbar(bufTop, 19, 0, 9, 50, 10, 0);
  const top = column(bufTop, 19, 0, 9);
  assert(firstThumb(top) === 0, `offset 0 => thumb at top, got ${firstThumb(top)}`);

  const bufBottom = new Buffer(20, 10);
  drawScrollbar(bufBottom, 19, 0, 9, 50, 10, 40); // maxOffset = 40
  const bottom = column(bufBottom, 19, 0, 9);
  assert(
    firstThumb(bottom) + thumbLen(bottom) === 10,
    `offset at max => thumb flush with bottom, got end ${firstThumb(bottom) + thumbLen(bottom)}`,
  );

  // Monotonic non-decreasing position across the scroll range.
  let prev = -1;
  for (let off = 0; off <= 40; off++) {
    const buf = new Buffer(20, 10);
    drawScrollbar(buf, 19, 0, 9, 50, 10, off);
    const p = firstThumb(column(buf, 19, 0, 9));
    assert(p >= prev, `thumb position should be monotonic (off=${off})`);
    prev = p;
  }
}

// ---------------------------------------------------------------------------
// 4. Integrated with a real ChatScreen render
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

function chatColumn(msgs) {
  const w = 60;
  const h = 16;
  const app = stubApp(w, h);
  const screen = new ChatScreen("");
  screen.app = app;
  screen.messages = msgs;
  const buf = new Buffer(w, h);
  screen.render(buf);
  // log area is rows 2 .. (h-4)-2
  return column(buf, w - 1, 2, h - 6);
}

{
  // Short conversation: no overflow, no scrollbar.
  const short = chatColumn([{ role: "system", content: "Model: x" }]);
  assert(short.trim() === "", "short chat should have no scrollbar");

  // Long conversation: overflow, scrollbar present in the last column.
  const longMsgs = [{ role: "system", content: "Model: x" }];
  for (let i = 0; i < 40; i++) longMsgs.push({ role: "assistant", content: `line ${i}` });
  const long = chatColumn(longMsgs);
  assert(long.includes("█"), "long chat should show a scrollbar thumb");

  // Following the bottom puts the thumb at the bottom of the track.
  const end = firstThumb(long) + thumbLen(long);
  assert(end === long.length, `follow-bottom thumb should reach the bottom, got ${end}/${long.length}`);
}

// ---------------------------------------------------------------------------
// 5. Drag maths: dragging the thumb maps a row to an offset, and feeding that
//    offset back reproduces the same thumb row (so the thumb stays put).
// ---------------------------------------------------------------------------
{
  const g = scrollbarGeometry(0, 9, 100, 10, 0);
  assert(g.maxOffset === 90, `maxOffset should be total - viewport, got ${g.maxOffset}`);
  assert(offsetFromThumbTop(g, 0) === 0, "thumb at the top => offset 0");
  assert(
    offsetFromThumbTop(g, g.maxThumbTop) === g.maxOffset,
    "thumb at the bottom => max offset",
  );

  for (let t = 0; t <= g.maxThumbTop; t++) {
    const off = offsetFromThumbTop(g, t);
    const back = scrollbarGeometry(0, 9, 100, 10, off);
    assert(back.thumbTop === t, `drag round-trip should be idempotent (t=${t}, back=${back.thumbTop})`);
  }

  // Out-of-range thumb positions are clamped, never wrapping around.
  assert(offsetFromThumbTop(g, -5) === 0, "thumb above the track clamps to offset 0");
  assert(offsetFromThumbTop(g, 999) === g.maxOffset, "thumb below the track clamps to max offset");
}

// ---------------------------------------------------------------------------
// 6. ChatScreen exposes a draggable scrollbar handle
// ---------------------------------------------------------------------------
{
  const w = 60;
  const h = 16;
  const app = stubApp(w, h);
  const screen = new ChatScreen("");
  screen.app = app;
  const msgs = [{ role: "system", content: "Model: x" }];
  for (let i = 0; i < 60; i++) msgs.push({ role: "assistant", content: `line ${i}` });
  screen.messages = msgs;
  screen.render(new Buffer(w, h));

  const bar = screen.scrollbar();
  assert(bar, "an overflowing chat should expose a scrollbar handle");
  assert(bar.x === w - 1, `handle sits in the right column, got ${bar.x}`);
  assert(bar.top === 2 && bar.bottom === h - 6, "handle spans the chat log area");

  bar.scrollTo(0);
  assert(screen.scrollTop === 0, "scrollTo(0) scrolls to the very top");
  assert(screen.followBottom === false, "scrolling away from the bottom stops following");

  bar.scrollTo(999999);
  assert(screen.scrollTop === bar.total - bar.viewport, "scrollTo clamps to the bottom");
  assert(screen.followBottom === true, "reaching the bottom resumes follow-bottom");

  // Driving the handle by thumb row (as a drag does) reaches the top again.
  const g = scrollbarGeometry(bar.top, bar.bottom, bar.total, bar.viewport, 0);
  bar.scrollTo(offsetFromThumbTop(g, 0));
  assert(screen.scrollTop === 0, "dragging the thumb to the top scrolls home");

  // A conversation that fits shows no handle (nothing to drag).
  const short = new ChatScreen("");
  short.app = app;
  short.messages = [{ role: "system", content: "Model: x" }];
  short.render(new Buffer(w, h));
  assert(short.scrollbar() === null, "a short chat should expose no scrollbar handle");
}

console.log(failures === 0 ? "\nSCROLLBAR TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
