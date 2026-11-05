// The sidebar's status marks are the only place a reader sees what a
// conversation is doing without opening it: a blue dot once the turn finished,
// a turning ring while it runs, and amber while a tool call waits for a human.
// Amber is reserved for manual approval — an automatic review answers for the
// user, so that conversation is still just running.
//
// The blue dot asks for attention once: opening the conversation records it as
// seen and takes the dot away, and the next turn brings it back. The record
// belongs to the console and lives on the server (~/.neutrino/web.json), so it
// outlives both a reload and a restart of the process; the HTTP side of that is
// covered by scripts/test-web-seen.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { setLanguage, t } from "../web/i18n.js";

class Element {
  constructor() {
    this.classes = new Set();
    this.classList = {
      add: name => this.classes.add(name),
      remove: name => this.classes.delete(name),
      contains: name => this.classes.has(name),
    };
    this.className = "";
    this.innerHTML = "";
    this.title = "";
    this.listeners = new Map();
  }
  addEventListener(type, handler) {
    this.listeners.set(type, handler);
  }
  /** Play the click a reader makes on a sidebar row. */
  click() {
    this.listeners.get("click")?.();
  }
}

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");

// The stylesheet paints all three states, and the spinner is its own rotation
// rather than the pulse that painted the old "live" dot.
assert.match(styles, /\.session-state\.approval\s*\{[^}]*background: var\(--amber\)/,
  "waiting for approval is amber");
assert.match(styles, /\.session-state\.running\s*\{[^}]*animation: spin/,
  "a running turn is drawn by a turning ring");
assert.match(styles, /@keyframes spin\s*\{/, "the spinner has its rotation");
assert.doesNotMatch(styles, /^\.dot\s*\{/m, "the old live dot style is gone");

// A finished turn in the conversation on screen is recorded as seen before the
// sidebar repaints, so watching a turn end never leaves a dot behind.
assert.match(source, /statusOfLive\(snapshot\) === "done"\) rememberSeen\(`id:\$\{snapshot\.sessionId\}`\)/,
  "the open conversation's finished turn is recorded as seen");

// The record is restored from the server before the first sidebar paint, so a
// page load never starts by marking every finished conversation again.
assert.match(source, /loadSeen\(\)\.then\(\(\) => loadOverview\(\)\)/,
  "the record is loaded before the first overview paint");
assert.doesNotMatch(source, /function storedSeen\(/, "the record is no longer read from localStorage");

// The renderer, its status helpers and the seen record run exactly as shipped,
// including the localStorage key the one-time handover still reads.
const renderer = source.slice(
  source.indexOf("function isSelected("),
  source.indexOf("// ------------------------------------------------------------------- select"),
);
assert.match(renderer, /function renderSession\(/, "the sidebar renderer slice is complete");
assert.match(renderer, /function loadSeen\(/, "the seen record is part of the slice");

/**
 * The server side of the record: `/api/seen` over a list that outlives the
 * page, exactly like the file the real server writes. `apiFetch` is replaced by
 * a fake that answers synchronously, so a click's write is visible at once.
 */
function fakeServer(store) {
  return async (path, init = {}) => {
    assert.equal(path, "/api/seen", `unexpected request: ${path}`);
    if ((init.method ?? "GET") === "POST") {
      const { identities, seen } = JSON.parse(init.body);
      const wanted = new Set(identities);
      const kept = store.seen.filter(identity => !wanted.has(identity));
      store.seen = seen === true ? [...kept, ...wanted] : kept;
      return { ok: true, json: async () => ({ ok: true, seen: store.seen }) };
    }
    return { ok: true, json: async () => ({ seen: store.seen }) };
  };
}

/**
 * One page load over a server record. `store` is the server: passing the same
 * object to a second `createUi` is a reload or a restarted process.
 */
function createUi(store = { seen: [] }) {
  const state = { selection: null, snapshot: null, overview: null, seen: {} };
  const context = vm.createContext({
    state,
    tr: t,
    escapeHtml: value => String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    formatTime: () => "just now",
    document: { createElement: () => new Element() },
    selectLive() {},
    selectFile() {},
    setConversationView() {},
    readStorage: () => "",
    writeStorage: () => {},
    modeStorageKey: key => key,
    apiFetch: fakeServer(store),
  });
  vm.runInContext(`${renderer}`, context);
  return { state, store, renderSession: context.renderSession, loadSeen: () => context.loadSeen() };
}

/** A live entry as the overview and the stream report it. */
function live(overrides = {}) {
  return {
    key: "live:1",
    sessionId: "s1",
    cwd: "/project",
    title: "A conversation",
    provider: "DeepSeek",
    model: "deepseek-chat",
    intensity: "High",
    busy: false,
    paused: false,
    queued: null,
    compressing: false,
    approval: null,
    approvalMode: "request",
    tokens: { prompt: 0, completion: 0 },
    ...overrides,
  };
}

const liveRow = (overrides = {}) => ({ id: "s1", live: true, liveKey: "live:1", model: "deepseek-chat", ...overrides });

/** Draw the row and report its mark: `null` when the row carries none. */
function markOf(ui, session) {
  const html = ui.renderSession(session).innerHTML;
  const match = /class="session-state (\w+)" title="([^"]*)"/.exec(html);
  return match ? { status: match[1], label: match[2] } : null;
}

// --- finished conversations ------------------------------------------------
{
  // A saved transcript is done by definition, even while other sessions run.
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live({ busy: true })] };
  const saved = { id: "saved", live: false, liveKey: null, title: "Saved", model: "deepseek-chat" };
  assert.deepEqual(markOf(ui, saved), { status: "done", label: "Done" }, "saved history is done");
}
{
  // A live conversation whose turn ended — still open in a browser or terminal.
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live()] };
  assert.equal(markOf(ui, liveRow()).status, "done", "an idle live conversation is done");
}

// --- a turn in flight ------------------------------------------------------
{
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live({ busy: true })] };
  assert.deepEqual(markOf(ui, liveRow()), { status: "running", label: "Running" }, "a busy turn is running");
}
{
  // Paused or queued work is unfinished, never done.
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live({ paused: true, queued: "next" })] };
  assert.equal(markOf(ui, liveRow()).status, "running", "a paused turn is still running");
}
{
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live({ compressing: true })] };
  assert.equal(markOf(ui, liveRow()).status, "running", "compression keeps the row running");
}
{
  // The open stream is fresher than the last overview poll.
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live()] };
  ui.state.snapshot = live({ busy: true });
  assert.equal(markOf(ui, liveRow()).status, "running", "the stream wins over the poll");
}

// --- waiting for the user --------------------------------------------------
{
  const ui = createUi();
  const approval = { tool: "shell", arguments: { command: "rm -rf build" }, level: "high" };
  ui.state.overview = { groups: [], live: [live({ busy: true, approval })] };
  assert.deepEqual(markOf(ui, liveRow()), { status: "approval", label: "Waiting for approval" },
    "a manual approval turns the row amber");
}
{
  // An automated review is a pending call too, but the user has nothing to
  // answer: the row keeps showing the turn as running.
  const ui = createUi();
  const approval = { tool: "shell", arguments: { command: "rm -rf build" }, level: "high" };
  ui.state.overview = { groups: [], live: [live({ busy: true, approval, approvalMode: "auto" })] };
  assert.equal(markOf(ui, liveRow()).status, "running", "automatic review is not the user's turn");
}
{
  // Approval outranks a plain busy turn on the open stream as well.
  const ui = createUi();
  const approval = { tool: "shell", arguments: { command: "rm -rf build" }, level: "high" };
  ui.state.overview = { groups: [], live: [live()] };
  ui.state.snapshot = live({ busy: true, approval });
  assert.equal(markOf(ui, liveRow()).status, "approval", "the stream reports the waiting call");
}
{
  // Switching to automatic approval must take the amber mark away at once.
  const ui = createUi();
  const approval = { tool: "shell", arguments: { command: "rm -rf build" }, level: "high" };
  ui.state.overview = { groups: [], live: [live()] };
  ui.state.snapshot = live({ busy: true, approval });
  assert.equal(markOf(ui, liveRow()).status, "approval");
  ui.state.snapshot = live({ busy: true, approval, approvalMode: "auto" });
  assert.equal(markOf(ui, liveRow()).status, "running", "automatic approval removes the amber mark");
}

// --- opening a finished conversation ---------------------------------------
{
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live()] };
  const row = ui.renderSession(liveRow());
  assert.equal(markOf(ui, liveRow()).status, "done", "a finished conversation starts with a blue dot");

  row.click();
  assert.equal(markOf(ui, liveRow()), null, "opening the row takes the blue dot away");
  ui.state.selection = { kind: "live", key: "live:1" };
  assert.equal(markOf(ui, liveRow()), null, "the open conversation keeps no dot");
  assert.deepEqual(ui.store.seen, ["id:s1"], "the opened conversation is recorded on the server");
}
{
  // Saved history behaves the same way: the dot goes away once it is opened.
  const ui = createUi();
  const saved = { id: "saved", live: false, liveKey: null, title: "Saved", model: "deepseek-chat" };
  ui.state.overview = { groups: [], live: [] };
  assert.equal(markOf(ui, saved).status, "done");
  ui.state.selection = { kind: "file", id: "saved" };
  ui.renderSession(saved).click();
  assert.equal(markOf(ui, saved), null, "opened history carries no dot");
  assert.deepEqual(ui.store.seen, ["id:saved"], "opened history is recorded on the server");
}
{
  // The record outlives the page, and the process: a fresh page load reading
  // the same server record must not ask again. This is the reload that used to
  // bring every blue dot back.
  const store = { seen: [] };
  const first = createUi(store);
  first.state.overview = { groups: [], live: [live()] };
  first.renderSession(liveRow()).click();

  const reloaded = createUi(store);
  await reloaded.loadSeen();
  reloaded.state.overview = { groups: [], live: [live()] };
  assert.equal(markOf(reloaded, liveRow()), null, "a reload does not bring the dot back");

  // A conversation the record does not mention keeps its dot.
  const other = { id: "s2", live: true, liveKey: "live:2", model: "deepseek-chat" };
  assert.equal(markOf(reloaded, other).status, "done", "an unread conversation still asks");
}
{
  // New activity forgets the record, so the turn that follows gets its own dot.
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live()] };
  ui.renderSession(liveRow()).click();
  assert.equal(markOf(ui, liveRow()), null);

  ui.state.overview = { groups: [], live: [live({ busy: true })] };
  assert.equal(markOf(ui, liveRow()).status, "running", "a running turn is always drawn");
  assert.equal(ui.state.seen["id:s1"], undefined, "new activity clears the record");
  assert.deepEqual(ui.store.seen, [], "the forgetful turn reached the server");

  ui.state.overview = { groups: [], live: [live()] };
  assert.equal(markOf(ui, liveRow()).status, "done", "the next finished turn asks again");
}
{
  // Running and waiting marks are live states: opening the row never hides them.
  const ui = createUi();
  const approval = { tool: "shell", arguments: { command: "rm -rf build" }, level: "high" };
  ui.state.overview = { groups: [], live: [live({ busy: true, approval })] };
  ui.renderSession(liveRow()).click();
  assert.equal(markOf(ui, liveRow()).status, "approval", "opening a waiting conversation keeps the amber mark");
}
{
  // An unreachable record is not an error page: the dots come back and the
  // console still draws. Nothing is thrown.
  const state = { selection: null, snapshot: null, overview: null, seen: {} };
  const context = vm.createContext({
    state,
    tr: t,
    escapeHtml: value => String(value ?? ""),
    formatTime: () => "just now",
    document: { createElement: () => new Element() },
    selectLive() {},
    selectFile() {},
    setConversationView() {},
    readStorage: () => "",
    writeStorage: () => {},
    modeStorageKey: key => key,
    apiFetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  vm.runInContext(`${renderer}`, context);
  await context.loadSeen();
  state.overview = { groups: [], live: [live()] };
  const html = context.renderSession(liveRow()).innerHTML;
  assert.match(html, /session-state done/, "an unreadable record still draws the finished row");
}

// --- labels follow the interface language ----------------------------------
setLanguage("zh");
{
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live()] };
  assert.equal(markOf(ui, liveRow()).label, "已完成");
  ui.state.overview = { groups: [], live: [live({ busy: true })] };
  assert.equal(markOf(ui, liveRow()).label, "运行中");
  const approval = { tool: "shell", arguments: { command: "rm -rf build" }, level: "high" };
  ui.state.overview = { groups: [], live: [live({ busy: true, approval })] };
  assert.equal(markOf(ui, liveRow()).label, "等待审批");
}
setLanguage("en");

// --- the rest of the row is unchanged --------------------------------------
{
  const ui = createUi();
  ui.state.overview = { groups: [], live: [live()] };
  ui.state.selection = { kind: "live", key: "live:1" };
  const item = ui.renderSession(liveRow({ title: "Named" }));
  assert.ok(item.classes.has("selected"), "the open conversation stays selected");
  assert.ok(item.classes.has("live"), "live rows keep their class");
  assert.match(item.innerHTML, /<span class="session-title">Named<\/span>/, "the title is unchanged");
  assert.match(item.innerHTML, /1 message|0 messages/, "the message count is unchanged");
}

console.log("web sidebar status: ok");
