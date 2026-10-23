import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { App } from "../dist/app.js";
import { ChatScreen } from "../dist/screens/chat.js";
import { Buffer as Frame } from "../dist/terminal/buffer.js";
import { Renderer } from "../dist/terminal/renderer.js";
import { C } from "../dist/colors.js";
import { Term } from "./emu.mjs";

class TestApp extends App {
  restoreSelection() {}
}
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
const selected = cell => cell.style.bg === C.selection;
const app = new TestApp();
app.width = 100;
app.height = 30;
const screen = new ChatScreen();
screen.app = app;
screen.messages = Array.from({ length: 100 }, (_, i) => ({ role: "assistant", content: `reply ${i} 中文 **bold** ` + "some text ".repeat(20) }));
app.screens = [screen];
let layouts = 0;
const buildLines = screen.buildLines.bind(screen);
screen.buildLines = width => { layouts++; return buildLines(width); };
const frames = [];
app.renderer.render = (frame, forceRows) => frames.push({ frame, forceRows });
try {
  app.render();
  const content = app.contentBuffer;
  app.handleMouse({ type: "click", x: 5, y: 3, button: 0 });
  for (let i = 0; i < 200; i++) {
    app.handleMouse({ type: "move", x: 10 + i % 50, y: 3 + i % 10, drag: true });
  }
  assert.deepEqual(app.state.selection.cursor, { x: 59, y: 12 });
  assert.equal(frames.length, 1, "input bursts must not enqueue a frame per move");
  await tick();
  assert.equal(frames.length, 2, "one frame displays the most recent pointer position");
  assert.equal(layouts, 1, "selection does not rebuild or wrap conversation history");
  assert.deepEqual(frames[1].forceRows, [], "selection updates do not repaint unrelated input rows");
  assert.ok(selected(app.lastBuffer.cells[3][8]));
  assert.ok(!selected(content.cells[3][8]), "selection must not mutate the cached content");

  app.handleMouse({ type: "move", x: 8, y: 3, drag: true });
  await tick();
  assert.ok(selected(app.lastBuffer.cells[3][8]));
  assert.ok(!selected(app.lastBuffer.cells[3][9]), "shrinking the selection removes old highlights");
  assert.ok(!selected(app.lastBuffer.cells[4][5]));
  const painted = frames.length;
  for (let i = 0; i < 100; i++) app.handleMouse({ type: "move", x: 8, y: 3, drag: true });
  await tick();
  assert.equal(frames.length, painted, "duplicate cell reports do no rendering work");

  app.handleMouse({ type: "move", x: 5, y: 3, drag: true });
  await tick();
  assert.deepEqual(app.state.selection.cursor, app.state.selection.anchor, "dragging back to the anchor shrinks the selection");
  assert.ok(!selected(app.lastBuffer.cells[3][6]));

  screen.messages.push({ role: "assistant", content: "new streamed content" });
  app.render();
  assert.equal(layouts, 2, "real content changes refresh the cache");
  assert.notEqual(app.contentBuffer, content);
  app.handleMouse({ type: "move", x: 9, y: 3, drag: true });
  await tick();
  assert.equal(layouts, 2);
  app.dispatchEvent({ type: "key", key: { name: "escape", ctrl: false, meta: false, shift: false, char: "\x1b", sequence: "\x1b" } });
  assert.equal(app.state.selection, null);
  assert.ok(app.lastBuffer.cells.every(row => row.every(cell => !selected(cell))));

  // Release before the next frame must flush the latest position immediately.
  // Select blank rows so this test never touches the system clipboard.
  app.screens = [{ render() {}, scrollbar() { return null; }, showsCursor() { return false; }, alwaysRepaintRows() { return []; }, onMouse() {} }];
  app.render();
  app.handleMouse({ type: "click", x: 2, y: 2, button: 0 });
  app.handleMouse({ type: "move", x: 5, y: 2, drag: true });
  assert.ok(app.selectionTimer);
  app.handleMouse({ type: "release", x: 9, y: 2, button: 0 });
  assert.equal(app.selectionTimer, null);
  assert.deepEqual(app.state.selection.cursor, { x: 9, y: 2 });
  assert.ok(selected(app.lastBuffer.cells[2][9]));
} finally {
  for (const timer of [app.selectionTimer, app.cursorTimer, app.blinkTimer, app.toastTimer]) clearTimeout(timer);
}
console.log("ok selection bursts reuse layout, skip duplicate cells and flush the final position");

class SlowOutput extends EventEmitter {
  chunks = [];
  blocked = true;
  write(chunk) { this.chunks.push(chunk); return !this.blocked; }
}
const renderer = new Renderer();
const output = new SlowOutput();
renderer.out = output;
const makeFrame = text => {
  const frame = new Frame(40, 8);
  frame.writeText(2, 2, text);
  return frame;
};
renderer.render(makeFrame("first"));
for (let i = 0; i < 200; i++) renderer.render(makeFrame(`frame ${i}`), [7]);
assert.equal(output.chunks.length, 1, "a slow terminal must not build a queue of old frames");
assert.equal(output.listenerCount("drain"), 1);
output.blocked = false;
output.emit("drain");
assert.equal(output.chunks.length, 2);
assert.ok(output.chunks[1].includes("frame 199"));
assert.ok(!output.chunks[1].includes("frame 198"));
const term = new Term(40, 8);
output.chunks.forEach(chunk => term.feed(chunk));
assert.equal(term.rowText(2).trim(), "frame 199");
assert.equal(output.listenerCount("drain"), 0);

// Periodic drift repair must survive output congestion even if the latest
// frame is identical to the one already accepted by the terminal.
output.blocked = true;
renderer.render(makeFrame("frame 199"), [2]);
renderer.repaint();
renderer.render(makeFrame("frame 199"));
const beforeDrain = output.chunks.length;
output.blocked = false;
output.emit("drain");
assert.equal(output.chunks.length, beforeDrain + 1);
const repaired = output.chunks.at(-1);
for (let y = 0; y < 8; y++) assert.ok(repaired.includes(`\x1b[${y + 1};1H`));

output.blocked = true;
renderer.render(makeFrame("last"));
const resized = new Frame(60, 10);
resized.writeText(2, 9, "after resize");
renderer.render(resized);
output.blocked = false;
output.emit("drain");
const resizedTerm = new Term(60, 10);
resizedTerm.feed(output.chunks.at(-1));
assert.equal(resizedTerm.rowText(9).trim(), "after resize");

output.blocked = true;
renderer.render(makeFrame("before quit"));
renderer.render(makeFrame("must not draw after quit"));
const beforeQuit = output.chunks.length;
renderer.dispose();
assert.equal(output.listenerCount("drain"), 0);
output.emit("drain");
assert.equal(output.chunks.length, beforeQuit);
console.log("ok slow output keeps the latest frame, preserves drift repair and cleans up on quit");
