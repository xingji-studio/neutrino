// Drag-select auto-scroll: holding a selection against the first/last row of
// the log scrolls it, and the selection keeps growing while it scrolls.
//
// The subtle part is that the anchor is *content*, not a screen row: once the
// log moves under it, the row it started on leaves the viewport. The anchor has
// to travel with that text (so the selection grows instead of sliding), the
// highlight has to stop at the log's edge (the rows it covers are off screen),
// and the copy has to include those rows even though no frame holds them any
// more. Those three claims are what this file checks.
import assert from "node:assert/strict";
import { App } from "../dist/app.js";
import { ChatScreen } from "../dist/screens/chat.js";
import { Buffer as Frame } from "../dist/terminal/buffer.js";
import { rowCells, rowSelectionText } from "../dist/selection.js";
import { C } from "../dist/colors.js";

class TestApp extends App {
  restoreSelection() {}
}

const W = 60;
const H = 16;

function setup(messages) {
  const app = new TestApp();
  app.width = W;
  app.height = H;
  const screen = new ChatScreen("");
  screen.app = app;
  screen.messages = messages ?? [
    { role: "system", content: "Model: DeepSeek/deepseek-chat" },
    ...Array.from({ length: 40 }, (_, i) => ({ role: "assistant", content: `reply number ${i}` })),
  ];
  app.screens = [screen];
  // Never touch the terminal: the assertions read the frame the app rendered.
  app.renderer.render = () => {};
  app.render();
  return { app, screen };
}

/** The text of every log line, exactly as the screen draws it. */
function logLines(screen) {
  return screen
    .buildLines(Math.max(10, W - 4))
    // The log is drawn at column 2, so a frame row carries that margin.
    .map((line) => ("  " + line.spans.map((span) => span.text).join("")).replace(/\s+$/, ""));
}

/** `rowSelectionText` trims blank lines at both edges; do the same to a range. */
function expectedText(lines, from, to) {
  const slice = lines.slice(from, to + 1);
  while (slice.length > 0 && slice[0] === "") slice.shift();
  while (slice.length > 0 && slice[slice.length - 1] === "") slice.pop();
  return slice.join("\n");
}

/** Wait for the deferred selection frame (SELECTION_FRAME_MS) to be painted. */
const frame = () => new Promise((resolve) => setTimeout(resolve, 30));

const isSelected = (cell) => cell.style.bg && cell.style.bg.join(",") === C.selection.join(",");

/**
 * Cells painted outside the log (or on the scrollbar column). A selection whose
 * anchor scrolled away must not claim the header, the input box or the bar.
 */
function strayHighlights(app, top, bottom) {
  const stray = [];
  for (let y = 0; y < app.lastBuffer.height; y++) {
    for (let x = 0; x < app.lastBuffer.width; x++) {
      if (!isSelected(app.lastBuffer.cells[y][x])) continue;
      if (y < top || y > bottom || x === W - 1) stray.push([y, x]);
    }
  }
  return stray;
}

const anyHighlight = (app) => app.lastBuffer.cells.some((row) => row.some(isSelected));

function stopTimers(app) {
  for (const timer of [app.selectionTimer, app.cursorTimer, app.blinkTimer, app.toastTimer]) clearTimeout(timer);
  app.stopDragScroll();
}

// ---------------------------------------------------------------------------
// 1. Dragging down against the bottom row scrolls the log and keeps growing the
//    selection; the copied text still starts on the line the drag began on.
// ---------------------------------------------------------------------------
{
  const { app, screen } = setup();
  const bar = screen.scrollbar();
  assert.ok(bar, "test setup: the log has to overflow for any of this to scroll");

  bar.scrollTo(0); // start at the top so there is room to scroll down
  const top = bar.top;
  const bottom = bar.bottom;
  const pressY = top + 3;
  const lines = logLines(screen);

  app.handleMouse({ type: "click", x: 0, y: pressY, button: 0 });
  // Park the drag on the last row of the log: one line scrolls immediately.
  app.handleMouse({ type: "move", x: W - 1, y: bottom, drag: true });
  assert.ok(app.dragScrollTimer, "parking a drag on the last log row starts scrolling");
  assert.equal(screen.scrollTop, 1, "the first line is revealed without waiting for a tick");

  for (let i = 0; i < 5; i++) app.dragScrollTick();
  assert.equal(screen.scrollTop, 6, "each tick scrolls one more line");

  // The anchor stayed on the line it was dropped on, which is now above the
  // viewport; the mark stayed on the row the pointer is parked on.
  const ends = app.lineSelection(screen.scrollbar());
  assert.equal(ends.start.line, 3, `anchor line should still be 3, got ${ends.start.line}`);
  assert.equal(app.state.selection.anchor.y, pressY - 6, "the anchor followed the text off screen");
  assert.equal(app.state.selection.cursor.y, bottom, "the mark stays on the edge being scrolled");

  // The highlight is drawn from the log's edge, not from the header above it.
  const painted = app.displaySelection(app.state.selection, W);
  assert.deepEqual(painted.anchor, { x: 0, y: top }, "an off-screen anchor is drawn from the log edge");
  assert.ok(anyHighlight(app), "the visible part of the selection is highlighted");
  assert.deepEqual(strayHighlights(app, top, bottom), [], "nothing outside the log is highlighted");

  // The copy spans everything from the anchor's line to the last revealed one,
  // including the rows that scrolled away.
  const endLine = 6 + (bottom - top);
  assert.equal(
    app.selectionToText(),
    expectedText(lines, 3, endLine),
    "the copied text must include the rows that scrolled out of view",
  );

  // Releasing keeps the content-space anchor instead of snapping back to the
  // press cell (and stops the timer).
  let asked = 0;
  app.selectionToText = () => {
    asked++;
    return "";
  };
  app.handleMouse({ type: "release", x: W - 1, y: bottom, button: 0 });
  assert.equal(asked, 1, "the release copies through the tracked text");
  assert.equal(app.dragScrollTimer, null, "releasing stops the auto-scroll");
  assert.equal(app.state.selection.anchor.y, pressY - 6, "the release keeps the scrolled anchor");
  stopTimers(app);
}

// ---------------------------------------------------------------------------
// 2. Dragging up from the bottom: the anchor scrolls out below the log, the
//    highlight is clipped to the log and the copy reaches down past the screen.
// ---------------------------------------------------------------------------
{
  const { app, screen } = setup();
  const bar = screen.scrollbar();
  const top = bar.top;
  const bottom = bar.bottom;
  const startOffset = bar.offset;
  assert.ok(startOffset > 6, "test setup: the log starts pinned to the bottom");
  const pressY = bottom - 1;
  const anchorLine = startOffset + (pressY - top);
  const lines = logLines(screen);

  // Press well inside the log and drag left, so the first and last line of the
  // selection are again copied whole (the anchor is the bottom end here).
  app.handleMouse({ type: "click", x: 40, y: pressY, button: 0 });
  app.handleMouse({ type: "move", x: 0, y: top, drag: true });
  assert.equal(screen.scrollTop, startOffset - 1, "parking on the first log row scrolls up at once");
  for (let i = 0; i < 4; i++) app.dragScrollTick();
  assert.equal(screen.scrollTop, startOffset - 5, "dragging up walks the log backwards");

  const painted = app.displaySelection(app.state.selection, W);
  assert.deepEqual(
    painted.anchor,
    { x: W - 1, y: bottom },
    "an anchor below the log is drawn from the log's bottom edge",
  );
  assert.ok(anyHighlight(app), "the visible part of the selection is highlighted");
  assert.deepEqual(strayHighlights(app, top, bottom), [], "nothing below the log is highlighted");

  const scrollTop = screen.scrollTop;
  assert.equal(
    app.selectionToText(),
    expectedText(lines, scrollTop, anchorLine),
    "the copied text must reach down to the rows that scrolled off the bottom",
  );
  stopTimers(app);
}

// ---------------------------------------------------------------------------
// 3. The auto-scroll stops where the log does, and never starts when there is
//    nothing to scroll.
// ---------------------------------------------------------------------------
{
  const { app, screen } = setup();
  const bar = screen.scrollbar();
  // The log starts pinned to the bottom, so a drag on the last row has nothing
  // left to reveal.
  app.handleMouse({ type: "click", x: 0, y: bar.bottom - 1, button: 0 });
  app.handleMouse({ type: "move", x: W - 1, y: bar.bottom, drag: true });
  assert.equal(app.dragScrollTimer, null, "no auto-scroll when the log is already at the end");
  stopTimers(app);
}

{
  const { app } = setup([{ role: "system", content: "Model: DeepSeek/deepseek-chat" }]);
  // A conversation that fits the screen has no scrollbar, so there is nothing to
  // auto-scroll: the selection stays a plain selection.
  app.handleMouse({ type: "click", x: 0, y: 3, button: 0 });
  app.handleMouse({ type: "move", x: W - 1, y: H - 1, drag: true });
  assert.equal(app.dragScrollTimer, null, "a screen without a scrollbar never auto-scrolls");
  assert.ok(app.state.selection, "the drag still selects on such a screen");
  stopTimers(app);
}

// ---------------------------------------------------------------------------
// 4. A lost button-up must not leave the timer running (a bare hover event ends
//    the gesture, exactly like the press/release bookkeeping does).
// ---------------------------------------------------------------------------
{
  const { app, screen } = setup();
  const bar = screen.scrollbar();
  bar.scrollTo(0);
  app.handleMouse({ type: "click", x: 0, y: bar.top + 3, button: 0 });
  app.handleMouse({ type: "move", x: W - 1, y: bar.bottom, drag: true });
  assert.ok(app.dragScrollTimer, "test setup: the drag is scrolling");
  app.handleMouse({ type: "move", x: W - 1, y: bar.bottom, drag: false });
  assert.equal(app.dragScrollTimer, null, "a hover event ends the gesture and its scrolling");
  stopTimers(app);
}

// ---------------------------------------------------------------------------
// 5. Row snapshots: column indexing survives chrome, wide glyphs and missing
//    lines, which is what makes a captured row sliceable later.
// ---------------------------------------------------------------------------
{
  const frame = new Frame(12, 2);
  frame.writeText(0, 0, "later row", {});
  frame.writeText(0, 1, "last row", {});
  frame.markChrome(11, 0); // a scrollbar column must never be copied

  const cells = rowCells(frame, 0);
  assert.equal(cells.length, 12, "a row keeps one entry per column");
  assert.equal(cells[11], "", "chrome is dropped");
  assert.equal(cells.join("").replace(/\s+$/, ""), "later row", "joining a row reproduces its text");

  // Line 0 has scrolled away and only exists as a snapshot; line 1 is on screen.
  const captured = new Map([
    [0, ["e", "a", "r", "l", "y"]],
    [1, rowCells(frame, 0)],
  ]);
  const getRow = (line) => captured.get(line) ?? null;
  assert.equal(
    rowSelectionText(getRow, { line: 0, x: 1 }, { line: 1, x: 4 }),
    "arly\nlater",
    "the first line is sliced from the anchor column, the last up to the mark",
  );
  assert.equal(
    rowSelectionText(getRow, { line: 0, x: 0 }, { line: 0, x: 4 }),
    "early",
    "a single-line selection in line space",
  );
  // A line that was never captured keeps its own row instead of merging its
  // neighbours into one.
  assert.equal(
    rowSelectionText(getRow, { line: 0, x: 0 }, { line: 2, x: 9 }),
    "early\nlater row",
    "uncaptured lines trim away like blank ones",
  );

  // Wide glyphs: the tail cell is empty, so the two halves cannot both copy.
  const wide = new Frame(8, 1);
  wide.writeText(0, 0, "你好", {});
  assert.deepEqual(rowCells(wide, 0).slice(0, 4), ["你", "", "好", ""]);
  assert.equal(rowCells(wide, 0).join("").trimEnd(), "你好");
}

// ---------------------------------------------------------------------------
// 6. A log that moves on its own (streamed output following the bottom, a
//    resize) carries the anchor along instead of letting different lines slide
//    under the selection.
// ---------------------------------------------------------------------------
{
  const { app, screen } = setup();
  const bar = screen.scrollbar();
  const top = bar.top;
  bar.scrollTo(20);
  const lines = logLines(screen);
  const pressY = top + 2;
  const anchorLine = 22;

  // A plain drag inside the log: no edge, so no auto-scroll.
  app.handleMouse({ type: "click", x: 0, y: pressY, button: 0 });
  app.handleMouse({ type: "move", x: W - 1, y: top + 3, drag: true });
  assert.equal(app.dragScrollTimer, null, "a drag in the middle of the log does not scroll");
  assert.equal(app.lineSelection(screen.scrollbar()).start.line, anchorLine, "test setup: anchor line");

  // Let the selection frame paint first, so the row it started on is captured
  // before it leaves the screen.
  await frame();

  // Something else scrolls the log by three lines (new output, a resize, …).
  screen.scrollbar().scrollTo(23);
  app.render();
  assert.equal(screen.scrollTop, 23, "test setup: the log moved underneath the drag");
  assert.equal(
    app.lineSelection(screen.scrollbar()).start.line,
    anchorLine,
    "the anchor stays on its line when the log moves by itself",
  );
  assert.equal(app.state.selection.anchor.y, pressY - 3, "and its row moves with the text");
  assert.equal(
    app.selectionToText(),
    expectedText(lines, anchorLine, 23 + (top + 3 - top)),
    "the copy still starts on the line the drag began on",
  );
  stopTimers(app);
}

// ---------------------------------------------------------------------------
// 7. The steps keep arriving on their own while the pointer stays parked, and
//    stopping the drag stops them.
// ---------------------------------------------------------------------------
{
  const { app, screen } = setup();
  const bar = screen.scrollbar();
  bar.scrollTo(0);
  app.handleMouse({ type: "click", x: 0, y: bar.top + 2, button: 0 });
  app.handleMouse({ type: "move", x: W - 1, y: bar.bottom, drag: true });
  const afterMove = screen.scrollTop;
  // DRAG_SCROLL_MS is 60ms, so a few steps land well inside this window.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(
    screen.scrollTop >= afterMove + 3,
    `the log keeps scrolling while the pointer is parked (${afterMove} -> ${screen.scrollTop})`,
  );
  assert.equal(app.state.selection.cursor.y, bar.bottom, "the mark stays on the edge throughout");

  stopTimers(app);
  const stopped = screen.scrollTop;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(screen.scrollTop, stopped, "a stopped drag stops scrolling");
}

console.log("DRAG-SCROLL SELECTION TESTS PASSED");
