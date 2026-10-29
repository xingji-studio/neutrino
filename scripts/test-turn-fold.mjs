// A finished turn folds the work it took — never the answer it produced.
//
//   * the reply of a finished turn always stays on screen; the fold only hides
//     the process around it (prompt body, thinking, tool calls),
//   * a turn collapses only once the model has finished it: never while it is
//     streaming, and never because the user pressed ESC ESC,
//   * a turn with nothing worth hiding stays open, however long its answer,
//   * the complete round is one click away, and nothing is dropped from the
//     transcript, the disk copy or the model's context,
//   * reopening a saved conversation starts folded, and
//   * both UIs apply exactly the same rule.
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

// An answer whose body is unmistakable, so a test can tell "the reply is on
// screen" from "the work around it is", and a thinking step long enough that
// hiding it is worth a click.
const MARKER = "END-OF-SECRET";
const reply = (tag) => `Short summary for ${tag}.\n\nSECRET-BODY ${"z".repeat(TURN_FOLD_MIN_CHARS)} ${MARKER}`;
const THINKING = `Let me look into that. ${"t".repeat(TURN_FOLD_MIN_CHARS)}`;
const toolCall = (file, result) => ({ role: "tool", name: "read_file", arguments: { path: file }, result });

/** One turn that took real work: prompt, thinking, a tool call, then the answer. */
const workTurn = (prompt, tag) => [
  { role: "user", content: prompt },
  { role: "assistant", content: THINKING },
  toolCall("src/screens/chat.ts", "line one\nline two"),
  { role: "assistant", content: reply(tag) },
];

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
function clickRow(screen, buf, needle) {
  const y = rowOf(buf, needle);
  assert.ok(y >= 0, `row "${needle}" is on screen`);
  screen.onMouse({ type: "click", x: 4, y, button: 0 });
}

try {
  // 1. A plain answer is never folded: there is no work to hide, and folding the
  //    reply would hide the only thing the reader asked for.
  {
    const screen = makeScreen({
      messages: [{ role: "user", content: "PLAIN PROMPT" }, { role: "assistant", content: reply("plain turn") }],
    });
    const text = textOf(draw(screen));
    assert.ok(text.includes("PLAIN PROMPT"), "the prompt stays on screen");
    assert.ok(text.includes("Neutrino:"), "the reply keeps its label");
    assert.ok(text.includes("Short summary for plain turn."), "and its first line");
    assert.ok(text.includes(MARKER), "a long answer on its own stays fully readable");
    assert.ok(!text.includes("messages folded"), "with no work behind it, nothing folds");
  }

  // 2. A turn that did real work folds that work, and keeps its answer.
  {
    const screen = makeScreen({ messages: workTurn("FIRST PROMPT", "turn one") });
    let buf = draw(screen);
    let text = textOf(buf);
    assert.ok(text.includes("You: FIRST PROMPT"), "the folded turn names the prompt");
    assert.match(text, /3 of 4 messages folded/);
    assert.ok(text.includes("click to expand"));
    assert.ok(text.includes(MARKER), "the whole answer stays on screen while the work is folded");
    assert.ok(!text.includes("Let me look into that"), "the thinking is folded away");
    assert.ok(!text.includes("read_file"), "the tool call is folded away too");

    // Nothing was lost: the fold is presentation only.
    const transcript = screen.messages.filter((m) => m.role !== "system");
    assert.equal(transcript.length, 4, "the transcript keeps every message");
    assert.ok(transcript[3].content.includes(MARKER), "including the whole reply");

    // One click brings the whole round back.
    clickRow(screen, buf, "You: FIRST PROMPT");
    buf = draw(screen);
    text = textOf(buf);
    assert.ok(text.includes("Let me look into that"), "expanding shows the thinking");
    assert.ok(text.includes("read_file"), "and the tool call");
    assert.ok(text.includes("FIRST PROMPT"), "and the original prompt");
    assert.ok(text.includes(MARKER), "while the answer was never taken away");
    assert.ok(text.includes("click to collapse"));
    assert.ok(!text.includes("You: FIRST PROMPT"), "the header switches to its expanded form");

    clickRow(screen, buf, "click to collapse");
    text = textOf(draw(screen));
    assert.ok(!text.includes("Let me look into that"), "clicking again folds the work");
    assert.ok(text.includes(MARKER), "and leaves the answer in place");
    assert.equal(screen.messages.filter((m) => m.role !== "system").length, 4, "folding deletes nothing");
  }

  // 3. A live turn that only answers: finished or not, it never folds.
  {
    const screen = makeScreen();
    scripted = [{ text: reply("turn one") }, { text: "fresh answer" }];
    screen.liveSend("LONG PROMPT");
    await waitFor(() => !screen.busy, "the first turn to finish");
    let text = textOf(draw(screen));
    assert.ok(text.includes(MARKER), "the answer of the finished turn is on screen");
    assert.ok(!text.includes("messages folded"), "a turn with no work behind it is not folded");

    screen.liveSend("SECOND PROMPT");
    await waitFor(() => !screen.busy, "the second turn to finish");
    text = textOf(draw(screen));
    assert.ok(text.includes(MARKER), "an earlier answer keeps its place too");
    assert.ok(text.includes("fresh answer"), "and so does the newest one");
    assert.ok(!text.includes("messages folded"), "nothing to hide, nothing to fold");
  }

  // 4. Every turn with work folds, and each keeps its own answer.
  {
    const screen = makeScreen({
      messages: [
        ...workTurn("FIRST PROMPT", "turn one"),
        { role: "user", content: "SECOND PROMPT" },
        { role: "assistant", content: "short answer" },
      ],
    });
    const text = textOf(draw(screen));
    assert.ok(text.includes("You: FIRST PROMPT"), "the older turn with work is folded");
    assert.ok(text.includes(MARKER), "its answer is still on screen");
    assert.ok(text.includes("SECOND PROMPT") && text.includes("short answer"), "the newest short turn stays open");
  }

  // 5. ESC ESC pauses without folding; the next prompt does not fold a turn that
  //    has no work to hide.
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
    assert.ok(!text.includes("messages folded"), "pausing is not finishing, so nothing folds");
    release();

    scripted = [{ text: "short" }];
    screen.liveSend("NEXT PROMPT");
    await waitFor(() => !screen.busy, "the second turn to finish");
    text = textOf(draw(screen));
    assert.ok(text.includes("PAUSED-BODY"), "the earlier answer keeps its place");
    assert.ok(!text.includes("messages folded"), "and it has no work to fold, so it stays open");
    assert.ok(text.includes("NEXT PROMPT"), "the newest turn is open");
  }

  // 6. A folded turn inside the compressed prefix needs both clicks — and the
  //    archived answer comes back with the second one.
  {
    const screen = makeScreen({
      messages: [
        ...workTurn("ARCHIVED PROMPT", "archived turn"),
        { role: "user", content: "RECENT PROMPT" },
        { role: "assistant", content: "short answer" },
      ],
      context: { end: 4, summary: "earlier summary" },
    });
    let buf = draw(screen);
    let text = textOf(buf);
    assert.ok(text.includes("Earlier conversation (4 messages)"), "the prefix folds first");
    assert.ok(!text.includes("ARCHIVED PROMPT"), "the archived turn is hidden with it");

    clickRow(screen, buf, "Earlier conversation");
    buf = draw(screen);
    text = textOf(buf);
    assert.ok(text.includes("You: ARCHIVED PROMPT"), "the turn fold appears under the prefix");
    assert.ok(!text.includes("Let me look into that"), "and it still hides its own work");
    assert.ok(text.includes(MARKER), "while the archived answer is back on screen");

    clickRow(screen, buf, "You: ARCHIVED PROMPT");
    text = textOf(draw(screen));
    assert.ok(text.includes("Let me look into that"), "both folds open to the work");
    assert.ok(text.includes(MARKER), "and to the answer");
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

  console.log("ok tui: folds the work, keeps every answer, stays open while paused, nests with compression");

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

  // The rule itself, checked directly: an answer alone never folds, work does.
  assert.equal(
    webTurns.turnFolds([
      { role: "user", content: "hi" },
      { role: "assistant", content: "x".repeat(TURN_FOLD_MIN_CHARS + 40) },
    ]),
    false,
    "a long answer on its own never folds",
  );
  assert.equal(webTurns.turnFolds(workTurn("prompt", "tag")), true, "a turn with work behind it folds");

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
    turnAnswerIndex: webTurns.turnAnswerIndex,
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

  const longTurn = workTurn("BROWSER PROMPT", "browser turn");
  const shortTurn = [
    { role: "user", content: "thanks" },
    { role: "assistant", content: "anytime" },
  ];

  // A saved transcript: the turn with work folds, the answer comes with it, and
  // the short turn stays readable.
  renderList([...longTurn, ...shortTurn], null, { readOnly: true, active: false });
  assert.equal(pane.children.length, 3, "one folded group plus the two short messages");
  let group = pane.children[0];
  assert.equal(group.className, "turn-group");
  let fold = group.children[0];
  assert.equal(fold.className, "turn");
  assert.equal(fold.open, false, "a finished turn starts folded");
  assert.equal(fold.children[0].children[1].textContent, "You: BROWSER PROMPT");
  assert.equal(fold.children[0].children[2].textContent, "3 of 4 messages folded");
  assert.match(fold.children[0].children[2].children[0].textContent, /click to expand/);
  assert.equal(fold.children[1].children.length, 0, "a folded turn builds no hidden DOM");
  assert.deepEqual(pane.children.slice(1).map((element) => element.index), [4, 5]);
  assert.equal(pane.children[1].message.content, "thanks", "the short turn is not folded");

  // The answer is part of the group, outside the fold, and never dropped.
  const answer = group.children[1];
  assert.ok(answer.message.content.includes(MARKER), "the whole answer is on screen while folded");
  assert.equal(answer.index, 3, "it keeps its original index");

  // Opening it renders the work only; the answer is not duplicated.
  fold.open = true;
  fold.fire("toggle");
  assert.ok(browserState.openTurns.has(0), "the opened turn is remembered");
  assert.deepEqual(fold.children[1].children.map((element) => element.index), [0, 1, 2], "the work is rendered on demand");
  assert.match(fold.children[0].children[2].children[0].textContent, /click to collapse/);
  assert.equal(group.children[1], answer, "the answer stays where it was");

  // A repaint (a streamed token elsewhere) keeps it open and populated.
  renderList([...longTurn, ...shortTurn], "streaming", { readOnly: false, active: true });
  group = pane.children[0];
  fold = group.children[0];
  assert.equal(fold.open, true, "a repaint does not collapse what the reader opened");
  assert.equal(fold.children[1].children.length, 3);

  fold.open = false;
  fold.fire("toggle");
  assert.equal(browserState.openTurns.has(0), false);
  assert.equal(fold.children[1].children.length, 0, "closing frees the DOM again");
  assert.ok(group.children[1].message.content.includes(MARKER), "and the answer stays on screen");

  // The turn being answered never folds, however long it is: the reader is
  // watching it. `active` covers both streaming and a paused turn.
  const running = [...shortTurn, ...longTurn];
  for (const options of [{ active: true }, { active: true, paused: true }]) {
    browserState.openTurns.clear();
    renderList(running, null, { readOnly: false, ...options });
    assert.deepEqual(
      pane.children.map((element) => element.index),
      [0, 1, 2, 3, 4, 5],
      "the turn in flight stays fully open",
    );
    assert.ok(!pane.children.some((element) => element.className === "turn-group"), "nothing folds while it runs");
  }

  // Once it finishes, it folds like every other completed turn — answer kept.
  renderList(running, null, { readOnly: false, active: false });
  assert.equal(pane.children[0].message.content, "thanks", "the short turn is still open");
  assert.equal(pane.children[2].className, "turn-group", "the finished turn is folded");
  assert.equal(pane.children[2].children[0].open, false);
  assert.ok(pane.children[2].children[1].message.content.includes(MARKER), "and its answer is rendered");

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

  console.log("ok web: folds the work, keeps the answer, keeps the running turn open, loses no message");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  for (const screen of screens) screen.onDeactivate();
  fs.rmSync(testHome, { recursive: true, force: true });
}

console.log("TURN FOLD TESTS PASSED");
