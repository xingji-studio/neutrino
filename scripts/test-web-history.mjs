// Exercise the real browser list renderer with a small DOM stand-in. Original
// AI messages render lazily on disclosure; user input stays fully visible.
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
messages[0].content = "original 0\n\nUSER INPUT SECOND PARAGRAPH\n\n```js\nconst keep = 'USER CODE END';\n```";
messages[2] = { role: "tool", name: "read_file", arguments: { path: "fixture" }, result: "x".repeat(12000) };
const context = { end: 4, summary: "a summary for model context" };
render(messages, null, { context, readOnly: true });
assert.equal(pane.children[0].message.content, messages[0].content, "all user paragraphs and code stay outside the disclosure");
let disclosure = pane.children[1];
assert.equal(disclosure.open, false, "earlier history is collapsed by default");
assert.match(disclosure.children[0].textContent, /Earlier conversation · 3 messages/);
assert.equal(disclosure.children[1].children.length, 0, "collapsed history does not build a huge hidden DOM");
assert.deepEqual(pane.children.slice(2).map(element => element.index), [4, 5, 6, 7]);

disclosure.open = true;
disclosure.fire("toggle");
assert.equal(state.openContext, 4);
assert.deepEqual(disclosure.children[1].children.map(element => element.message), messages.slice(1, 4));
assert.ok(disclosure.children[1].children.every(element => element.message.role !== "user"), "users are never duplicated inside the fold");
assert.equal(disclosure.children[1].children[1].index, 2, "nested tool disclosures keep original indices");
assert.equal(disclosure.children[1].children[1].message.result.length, 12000);

// Streaming repaints must preserve both the expanded history and reader position.
const detached = disclosure;
render(messages, "streaming reply", { context });
disclosure = pane.children[1];
assert.equal(disclosure.open, true);
assert.equal(disclosure.children[1].children.length, 3);
assert.equal(pane.children[0].message.content, messages[0].content, "streaming preserves the full user input");
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
assert.equal(pane.children[1].open, false);
assert.equal(pane.children[0].message.content, messages[0].content, "collapsing again keeps user input visible");

state.openContext = 4;
render(messages, null, { context: { end: 6, summary: "new summary" } });
assert.equal(pane.children[1].open, false, "a new compressed prefix starts collapsed");
assert.equal(pane.children[0].index, 0);
assert.equal(pane.children[2].index, 4, "every archived user message keeps its position");
const first = pane.children[1];
const second = pane.children[3];
assert.equal(second.open, false, "each archived AI segment starts folded");
second.open = true;
second.fire("toggle");
assert.equal(state.openContext, 6);
assert.equal(first.open, true, "opening history reveals all archived AI segments");
const visibleMessages = () => pane.children.flatMap(element => element.message ? [element] : element.children[1].children);
assert.deepEqual(visibleMessages().map(element => element.index), [0, 1, 2, 3, 4, 5, 6, 7], "expanded history preserves transcript order without duplicating users");
assert.deepEqual(visibleMessages().map(element => element.message), messages, "expansion preserves every complete original");
first.open = false;
first.fire("toggle");
assert.equal(state.openContext, null);
assert.equal(second.open, false, "closing history folds all archived AI segments");
assert.deepEqual(visibleMessages().map(element => element.index), [0, 4, 6, 7], "all user input stays visible after history is folded again");

render(messages, null, { context: { end: 5, summary: "boundary ends on a user message" } });
assert.deepEqual(pane.children.filter(element => element.message).map(element => element.index), [0, 4, 5, 6, 7], "a prefix ending at a prompt preserves the prompt and following reply");
render(messages, null, { context: { end: 1, summary: "only a user message" } });
assert.equal(pane.children.length, messages.length, "a prefix containing only user input has nothing to fold");
for (const invalid of [{ end: 100, summary: "invalid" }, { end: 4.5, summary: "invalid" }, { end: 4, summary: "" }, null]) {
  render(messages, null, { context: invalid });
  assert.equal(pane.children.length, messages.length, "invalid metadata must never hide originals");
}
console.log("ok web history: default disclosure, complete originals, stable tools, streaming state and scroll position");
