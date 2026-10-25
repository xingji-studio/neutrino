// Finished turns fold on their own, in the terminal and in the browser.
//
//   * a turn collapses only once the model has finished it: never while it is
//     streaming, and never because the user pressed ESC ESC,
//   * the complete round is one click away, and nothing is dropped from the
//     transcript, the disk copy or the model's context,
//   * short exchanges stay open, because hiding two lines helps nobody,
//   * reopening a saved conversation starts folded, and
//   * both UIs apply exactly the same threshold.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-turn-fold-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { ChatScreen, TURN_FOLD_MIN_BLOCKS, TURN_FOLD_MIN_CHARS } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { Buffer: ScreenBuffer } = await import("../dist/terminal/buffer.js");
const { loadSession, saveConfig } = await import("../dist/config.js");
const { defaultState } = await import("../dist/state.js");
const webTurns = await import("../web/turns.js");

saveConfig({});

// The browser module cannot import from dist, so the two copies of the rule are
// held together here.
assert.equal(webTurns.TURN_FOLD_MIN_BLOCKS, TURN_FOLD_MIN_BLOCKS, "block threshold matches the terminal");
assert.equal(webTurns.TURN_FOLD_MIN_CHARS, TURN_FOLD_MIN_CHARS, "character threshold matches the terminal");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out: ${label}`);
}

// A reply whose first line is a harmless summary and whose body is unmistakable,
// so a test can tell "the preview is shown" from "everything is shown".
const MARKER = "END-OF-SECRET";
const BODY = `SECRET-BODY ${"z".repeat(TURN_FOLD_MIN_CHARS)} ${MARKER}`;
const reply = (tag) => `Short summary for ${tag}.\n\n${BODY}`;

const originalStream = LLMClient.prototype.streamTurn;
let scripted = [];
LLMClient.prototype.streamTurn = async function* () {
  this.toolCalls = [];
  const next = scripted.shift() ?? { text: "ok" };
  yield next.text;
  // Lets a test freeze a turn mid-stream, the way a paused turn really looks.
  if (next.wait) await next.wait;
};

const screens = [];

// ---- terminal ----------------------------------------------------------

function makeScreen(loaded) {
  const screen = new ChatScreen("");
  screen.app = { width: 100, height: 40, state: defaultState(), render() {}, popScreen() {}, showToast() {} };
  if (loaded) {
    screen.loadedMessages = loaded.messages;
    screen.loadedContext = loaded.context ?? null;
  }
  screen.onActivate();
  screens.push(screen);
  return screen;
}

function draw(screen, w = 100, h = 40) {
  screen.app.width = w;
  screen.app.height = h;
  const buf = new ScreenBuffer(w, h);
  screen.render(buf);
  return buf;
}

const rows = (buf) => buf.cells.map((row) => row.map((cell) => cell.ch).join("").trimEnd());
const textOf = (buf) => rows(buf).join("\n");
const rowOf = (buf, needle) => rows(buf).findIndex((row) => row.includes(needle));
const countOf = (buf, needle) => rows(buf).filter((row) => row.includes(needle)).length;
function clickRow(screen, buf, needle) {
  const y = rowOf(buf, needle);
  assert.ok(y >= 0, `row "${needle}" is on screen`);
  screen.onMouse({ type: "click", x: 4, y, button: 0 });
}

try {
  // 1. The model finishes -> the turn folds; one click brings it all back.
  {
    const screen = makeScreen();
    scripted = [{ text: reply("turn one") }];
    screen.liveSend("FIRST PROMPT");
    await waitFor(() => !screen.busy, "first turn to finish");

    let buf = draw(screen);
    let text = textOf(buf);
    assert.ok(text.includes("▸ You: FIRST PROMPT"), "the folded turn names the prompt");
    assert.match(text, /2 messages folded/);
    assert.ok(text.includes("Neutrino: Short summary for turn one."), "the fold previews the answer");
    assert.ok(text.includes("click to expand"));
    assert.ok(!text.includes(MARKER), "the body is folded away once the turn is finished");

    // Nothing was lost: transcript, saved session and fold agree.
    assert.equal(screen.messages.filter((m) => m.role !== "system").length, 2);
    const saved = loadSession(screen.sessionId);
    assert.equal(saved.messages.length, 2);
    assert.ok(saved.messages[1].content.includes(MARKER), "the saved transcript keeps the whole reply");

    clickRow(screen, buf, "▸ You: FIRST PROMPT");
    buf = draw(screen);
    text = textOf(buf);
    assert.ok(text.includes(MARKER), "expanding shows the complete answer");
    assert.ok(text.includes("FIRST PROMPT"), "and the original prompt");
    assert.ok(text.includes("click to collapse"));
    assert.ok(!text.includes("▸ You:"), "the header switches to its expanded form");

    clickRow(screen, buf, "▾ 2 messages");
    buf = draw(screen);
    assert.ok(!textOf(buf).includes(MARKER), "clicking again folds the turn");
    assert.equal(screen.messages.filter((m) => m.role !== "system").length, 2, "folding deletes nothing");
  }

  // 2. Every finished turn folds, not just the newest one.
  {
    const screen = makeScreen();
    scripted = [{ text: reply("turn one") }, { text: reply("turn two") }];
    screen.liveSend("FIRST PROMPT");
    await waitFor(() => !screen.busy, "first turn to finish");
    screen.liveSend("SECOND PROMPT");
    await waitFor(() => !screen.busy, "second turn to finish");

    const buf = draw(screen);
    assert.equal(countOf(buf, "▸ You:"), 2, "both finished turns are folded");
    assert.ok(textOf(buf).includes("▸ You: SECOND PROMPT"));
    assert.ok(!textOf(buf).includes(MARKER));
  }

  // 3. A short exchange is left open: two lines are not worth a click.
  {
    const screen = makeScreen();
    scripted = [{ text: "SHORT-ANSWER" }];
    screen.liveSend("SHORT-PROMPT");
    await waitFor(() => !screen.busy, "short turn to finish");
    const text = textOf(draw(screen));
    assert.ok(text.includes("SHORT-PROMPT") && text.includes("SHORT-ANSWER"), "short turns stay readable");
    assert.ok(!text.includes("▸ You:"), "a short turn is not folded");
  }

  // 4. ESC ESC pauses without folding; the next prompt folds the old turn.
  {
    const screen = makeScreen();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    scripted = [{ text: `First line of the partial answer.\n\nPAUSED-BODY ${"p".repeat(TURN_FOLD_MIN_CHARS)}`, wait: gate }];
    screen.liveSend("LONG PROMPT");
    await waitFor(() => screen.busy && (screen.streamingContent ?? "").length > 0, "the reply to start");

    screen.onKey({ name: "escape", ctrl: false, meta: false, shift: false });
    screen.onKey({ name: "escape", ctrl: false, meta: false, shift: false });
    assert.equal(screen.paused, true, "ESC ESC pauses the turn");
    let text = textOf(draw(screen));
    assert.ok(text.includes("PAUSED-BODY"), "a paused turn stays open for reading");
    assert.ok(!text.includes("▸ You:"), "pausing is not finishing, so nothing folds");
    release();

    scripted = [{ text: "short" }];
    screen.liveSend("NEXT PROMPT");
    await waitFor(() => !screen.busy, "the second turn to finish");
    text = textOf(draw(screen));
    assert.ok(text.includes("▸ You: LONG PROMPT"), "the next prompt folds the earlier turn");
    assert.ok(!text.includes("PAUSED-BODY"), "and its body is folded away with it");
    assert.ok(text.includes("NEXT PROMPT"), "the newest turn is still open");
  }

  // 5. Reopening history starts folded, and expands on a click.
  {
    const screen = makeScreen({
      messages: [
        { role: "user", content: "SAVED PROMPT" },
        { role: "assistant", content: reply("saved turn") },
      ],
    });
    let buf = draw(screen);
    assert.ok(textOf(buf).includes("▸ You: SAVED PROMPT"), "history opens compact");
    assert.ok(!textOf(buf).includes(MARKER));
    clickRow(screen, buf, "▸ You: SAVED PROMPT");
    buf = draw(screen);
    assert.ok(textOf(buf).includes(MARKER), "a reopened turn still expands completely");
  }

  // 6. A folded turn inside the compressed prefix needs both clicks.
  {
    const screen = makeScreen({
      messages: [
        { role: "user", content: "ARCHIVED PROMPT" },
        { role: "assistant", content: reply("archived turn") },
        { role: "user", content: "RECENT PROMPT" },
        { role: "assistant", content: "short answer" },
      ],
      context: { end: 2, summary: "earlier summary" },
    });
    let buf = draw(screen);
    let text = textOf(buf);
    assert.ok(text.includes("▸ Earlier conversation (2 messages)"), "the prefix folds first");
    assert.ok(!text.includes("▸ You: ARCHIVED PROMPT"), "the archived turn is hidden with it");

    clickRow(screen, buf, "▸ Earlier conversation");
    buf = draw(screen);
    text = textOf(buf);
    assert.ok(text.includes("▸ You: ARCHIVED PROMPT"), "the turn fold appears under the prefix");
    assert.ok(!text.includes(MARKER), "and it still hides its own body");

    clickRow(screen, buf, "▸ You: ARCHIVED PROMPT");
    assert.ok(textOf(draw(screen)).includes(MARKER), "both folds open to the whole round");
  }

  // 7. Clearing the conversation clears the fold bookkeeping too.
  {
    const screen = makeScreen();
    scripted = [{ text: reply("turn one") }, { text: "fresh" }];
    screen.liveSend("FIRST PROMPT");
    await waitFor(() => !screen.busy, "the turn to finish");
    screen.onKey({ name: "l", ctrl: true, meta: false, shift: false });
    assert.equal(screen.finishedTurns.size, 0);
    assert.equal(screen.expandedTurns.size, 0);
    screen.liveSend("AFTER CLEAR");
    await waitFor(() => !screen.busy, "the new turn to finish");
    const text = textOf(draw(screen));
    assert.ok(!text.includes("FIRST PROMPT"), "the cleared turn is gone");
    assert.ok(text.includes("AFTER CLEAR"), "the new turn is open");
  }

  console.log("ok tui: folds on completion, stays open while paused, keeps every message, nests with compression");

  // ---- browser ---------------------------------------------------------

  // The list renderer and the fold are read straight out of web/app.js, like the
  // browser's own history test does, against a minimal DOM stand-in.
  class Element {
    children = [];
    parent = null;
    open = false;
    events = new Map();
    className = "";
    scrollTop = 0;
    classList = { add: (name) => { this.className += ` ${name}`; }, toggle() {}, remove() {} };
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
  const grab = (name) => {
    const found = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
    assert.ok(found, `${name} exists in web/app.js`);
    return found[0];
  };
  const pane = new Element();
  pane.root = true;
  const browserState = { openTurns: new Set(), openContext: null };
  const context = vm.createContext({
    state: browserState,
    el: { messages: pane },
    document: { createElement: () => new Element() },
    turnFolds: webTurns.turnFolds,
    turnPreview: webTurns.turnPreview,
    turnRanges: webTurns.turnRanges,
    truncate(value, max) {
      const text = String(value ?? "");
      return text.length > max ? `${text.slice(0, max)}…` : text;
    },
    renderMessage(message, index) {
      const element = new Element();
      element.message = message;
      element.index = index;
      return element;
    },
    isNearBottom: () => false,
    scrollToBottom() { throw new Error("folding must not jump to the bottom"); },
  });
  vm.runInContext(
    `${grab("renderTurnFold")}\n${grab("renderMessageList")}\nglobalThis.renderList = renderMessageList;`,
    context,
  );
  const renderList = context.renderList;

  const longTurn = [
    { role: "user", content: "BROWSER PROMPT" },
    { role: "assistant", content: reply("browser turn") },
  ];
  const shortTurn = [
    { role: "user", content: "thanks" },
    { role: "assistant", content: "anytime" },
  ];

  // A saved transcript: the long turn folds, the short one stays readable.
  renderList([...longTurn, ...shortTurn], null, { readOnly: true, active: false });
  assert.equal(pane.children.length, 3, "one fold plus the two short messages");
  let fold = pane.children[0];
  assert.equal(fold.className, "turn");
  assert.equal(fold.open, false, "a finished turn starts folded");
  assert.equal(fold.children[0].children[1].textContent, "You: BROWSER PROMPT");
  assert.match(fold.children[0].children[2].textContent, /2 messages · Short summary for browser turn\./);
  assert.match(fold.children[0].children[2].children[0].textContent, /click to expand/);
  assert.equal(fold.children[1].children.length, 0, "a folded turn builds no hidden DOM");
  assert.deepEqual(pane.children.slice(1).map((element) => element.index), [2, 3]);
  assert.equal(pane.children[1].message.content, "thanks", "the short turn is not folded");

  // Opening it renders the complete round; closing drops it again.
  fold.open = true;
  fold.fire("toggle");
  assert.ok(browserState.openTurns.has(0), "the opened turn is remembered");
  assert.deepEqual(fold.children[1].children.map((element) => element.index), [0, 1]);
  assert.ok(fold.children[1].children[1].message.content.includes(MARKER), "the whole answer is available");
  assert.match(fold.children[0].children[2].children[0].textContent, /click to collapse/);

  // A repaint (a streamed token elsewhere) keeps it open and populated.
  renderList([...longTurn, ...shortTurn], "streaming", { readOnly: false, active: true });
  fold = pane.children[0];
  assert.equal(fold.open, true, "a repaint does not collapse what the reader opened");
  assert.equal(fold.children[1].children.length, 2);

  fold.open = false;
  fold.fire("toggle");
  assert.equal(browserState.openTurns.has(0), false);
  assert.equal(fold.children[1].children.length, 0, "closing frees the DOM again");

  // The turn being answered never folds, however long it is: the reader is
  // watching it. `active` covers both streaming and a paused turn.
  const running = [...shortTurn, ...longTurn];
  for (const options of [{ active: true }, { active: true, paused: true }]) {
    browserState.openTurns.clear();
    renderList(running, null, { readOnly: false, ...options });
    assert.deepEqual(
      pane.children.map((element) => element.message?.content?.split("\n")[0] ?? element.className),
      ["thanks", "anytime", "BROWSER PROMPT", "Short summary for browser turn."],
      "the turn in flight stays open while its predecessors fold",
    );
  }

  // Once it finishes, it folds like every other completed turn.
  renderList(running, null, { readOnly: false, active: false });
  assert.equal(pane.children[0].message.content, "thanks", "the short turn is still open");
  assert.equal(pane.children[2].className, "turn", "the finished long turn is folded");
  assert.equal(pane.children[2].open, false);

  // The server keeps sending everything: the browser only chooses what to draw.
  const webModel = { name: "test", url: "", api_key: "", supports_streaming: true };
  const session = new WebSession({
    id: "fold-live", provider: "test", model: "test", intensity: "High",
    cwd: process.cwd(), messages: [],
  }, webModel);
  session.start();
  try {
    scripted = [{ text: reply("web turn") }];
    session.liveSend("WEB PROMPT");
    await waitFor(() => session.liveSnapshot().busy, "the web turn to start");
    await waitFor(() => !session.liveSnapshot().busy, "the web turn to finish");
    const snapshot = session.liveSnapshot();
    assert.equal(snapshot.busy, false, "busy tells the browser the turn is finished");
    assert.equal(snapshot.messages.length, 2);
    assert.ok(snapshot.messages[1].content.includes(MARKER), "the live snapshot carries the whole reply");
    assert.equal(loadSession("fold-live").messages.length, 2, "and so does the saved session");
  } finally {
    session.dispose();
  }

  console.log("ok web: folds finished turns, keeps the running one open, loses no message");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  for (const screen of screens) screen.onDeactivate();
  fs.rmSync(testHome, { recursive: true, force: true });
}

console.log("TURN FOLD TESTS PASSED");
