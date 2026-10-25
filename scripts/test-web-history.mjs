// Exercise the real browser list renderer with a small DOM stand-in. Original
// messages are rendered lazily on disclosure, and retain their stable indices.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { turnFolds, turnPreview, turnRanges } from "../web/turns.js";

class Element {
  children = [];
  parent = null;
  open = false;
  events = new Map();
  className = "";
  scrollTop = 37;
  classList = { add: name => { this.className += ` ${name}`; } };
  get childNodes() { return this.children; }
  get isConnected() { return this.root || Boolean(this.parent?.isConnected); }
  set innerHTML(_value) { this.replaceChildren(); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
  addEventListener(name, callback) { this.events.set(name, callback); }
  fire(name) { this.events.get(name)?.(); }
}

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const fn = source.match(/function renderMessageList\([\s\S]*?\n\}/)?.[0];
assert.ok(fn, "browser list renderer exists");
const pane = new Element();
pane.root = true;
const state = { openContext: null };
const render = vm.runInNewContext(`(${fn})`, {
  state,
  el: { messages: pane },
  document: { createElement: () => new Element() },
  renderMessage(message, index) {
    const element = new Element();
    element.message = message;
    element.index = index;
    return element;
  },
  isNearBottom: () => false,
  scrollToBottom() { throw new Error("reading earlier history must not jump to the bottom"); },
  // Turn folding shares its rule with the browser module; none of the turns in
  // this fixture is long enough to fold, which the stub below would report.
  turnFolds,
  turnPreview,
  turnRanges,
  renderTurnFold() { throw new Error("no turn in this fixture should fold"); },
});
const messages = Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `original ${index}` }));
messages[2] = { role: "tool", name: "read_file", arguments: { path: "fixture" }, result: "x".repeat(12000) };
const context = { end: 4, summary: "a summary for model context" };
render(messages, null, { context, readOnly: true });
let disclosure = pane.children[0];
assert.equal(disclosure.open, false, "earlier history is collapsed by default");
assert.match(disclosure.children[0].textContent, /Earlier conversation · 4 messages/);
assert.equal(disclosure.children[1].children.length, 0, "collapsed history does not build a huge hidden DOM");
assert.deepEqual(pane.children.slice(1).map(element => element.index), [4, 5, 6, 7]);

disclosure.open = true;
disclosure.fire("toggle");
assert.equal(state.openContext, 4);
assert.deepEqual(disclosure.children[1].children.map(element => element.message), messages.slice(0, 4));
assert.equal(disclosure.children[1].children[2].index, 2, "nested tool disclosures keep original indices");
assert.equal(disclosure.children[1].children[2].message.result.length, 12000);

// Streaming repaints must preserve both the expanded history and reader position.
const detached = disclosure;
render(messages, "streaming reply", { context });
disclosure = pane.children[0];
assert.equal(disclosure.open, true);
assert.equal(disclosure.children[1].children.length, 4);
assert.equal(pane.scrollTop, 37);
assert.equal(pane.children.at(-1).message.content, "streaming reply");
detached.open = false;
detached.fire("toggle");
assert.equal(state.openContext, 4, "a detached disclosure cannot reset the expansion state");

disclosure.open = false;
disclosure.fire("toggle");
assert.equal(state.openContext, null);
assert.equal(disclosure.children[1].children.length, 0);
render(messages, null, { context });
assert.equal(pane.children[0].open, false);

state.openContext = 4;
render(messages, null, { context: { end: 6, summary: "new summary" } });
assert.equal(pane.children[0].open, false, "a new compressed prefix starts collapsed");
for (const invalid of [{ end: 100, summary: "invalid" }, { end: 4.5, summary: "invalid" }, { end: 4, summary: "" }, null]) {
  render(messages, null, { context: invalid });
  assert.equal(pane.children.length, messages.length, "invalid metadata must never hide originals");
}
console.log("ok web history: default disclosure, complete originals, stable tools, streaming state and scroll position");
