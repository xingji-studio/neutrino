// A phone shows one pane at a time: opening a conversation replaces the list.
// The browser's own Back button has to walk the same levels as the back arrow
// in the header — from the open conversation to the list — and Forward has to
// reopen that conversation. Getting this wrong is invisible on a desktop, where
// both panes are shown side by side and no level is ever recorded.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

// The page listens for the browser's Back/Forward and corrects a conversation
// mark that a reload left behind, before the first click can read it.
assert.match(source, /window\.addEventListener\("popstate", followViewHistory\)/,
  "Back and Forward are wired to the panes");
assert.match(source, /^\s*forgetStaleConversationEntry\(\);/m,
  "a reload forgets the conversation it no longer shows");

// The view switch, its history helpers and the popstate handler run exactly as
// shipped, together with the entry mark they read.
const slice = source.slice(
  source.indexOf("const CONVERSATION_ENTRY"),
  source.indexOf("function resetMessagePane("),
);
assert.match(slice, /function setConversationView\(open, \{ record = true \} = \{\}\)/,
  "the view switch accepts a navigation that must not be recorded");
assert.match(slice, /function followViewHistory\(event\)/, "the popstate handler is part of the slice");
assert.match(slice, /function forgetStaleConversationEntry\(\)/, "the reload correction is part of the slice");
assert.match(slice, /function watchPanes\(\)/, "the rotation watcher is part of the slice");

function classListOf(classes) {
  return {
    add: name => classes.add(name),
    remove: name => classes.delete(name),
    contains: name => classes.has(name),
    toggle: (name, value) => {
      const on = value === undefined ? !classes.has(name) : Boolean(value);
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
  };
}

/**
 * One page load with a real history stack: `browserBack`/`browserForward` move
 * an entry and dispatch popstate the way a browser does, `settle` delivers the
 * popstate caused by a `history.back()` the page itself called, and `headerBack`
 * presses the back arrow in the header.
 */
function createPage({ stacked = true, href = "http://127.0.0.1:8765/", layoutEvents = false } = {}) {
  const classes = new Set();
  const layoutHandlers = [];
  const focus = [];
  const rows = { selected: null };
  const entries = [{ state: null }];
  const pendingPopstates = [];
  const backCalls = [];
  const replaced = [];
  let index = 0;
  let narrow = stacked;

  const history = {
    get state() { return entries[index].state; },
    pushState(state) {
      entries.splice(index + 1);
      entries.push({ state });
      index = entries.length - 1;
    },
    replaceState(state) {
      entries[index] = { state };
      replaced.push(state);
    },
    back() {
      backCalls.push(history.state);
      if (index === 0) return; // The entry beneath is another page: it unloads.
      index -= 1;
      pendingPopstates.push(entries[index].state);
    },
  };

  const context = vm.createContext({
    window: {
      matchMedia: () => (layoutEvents
        ? { matches: narrow, addEventListener: (_type, handler) => { layoutHandlers.push(handler); } }
        : { matches: narrow }),
    },
    history,
    location: { href },
    el: {
      app: { classList: classListOf(classes) },
      back: { focus: () => focus.push("back") },
      sessions: { querySelector: () => rows.selected },
      refresh: { focus: () => focus.push("refresh") },
    },
  });
  vm.runInContext(slice, context);

  return {
    setConversationView: context.setConversationView,
    followViewHistory: context.followViewHistory,
    forgetStaleConversationEntry: context.forgetStaleConversationEntry,
    watchPanes: context.watchPanes,
    classes,
    focus,
    rows,
    entries,
    backCalls,
    replaced,
    get stack() { return entries.length; },
    get at() { return index; },
    get state() { return history.state; },
    setStacked(value) { narrow = value; },
    /** Turn the phone: the layout query reports the new width. */
    rotate(matches) {
      narrow = matches;
      for (const handler of layoutHandlers) handler({ matches });
    },
    browserBack() {
      assert.ok(index > 0, "the fixture expects an entry beneath");
      index -= 1;
      context.followViewHistory({ state: entries[index].state });
    },
    browserForward() {
      assert.ok(index < entries.length - 1, "the fixture expects an entry above");
      index += 1;
      context.followViewHistory({ state: entries[index].state });
    },
    settle() {
      for (const state of pendingPopstates.splice(0)) context.followViewHistory({ state });
    },
    headerBack() {
      context.setConversationView(false);
      this.settle();
    },
  };
}

// --- opening a conversation records one level -------------------------------
{
  const page = createPage();
  assert.equal(page.stack, 1, "a fresh page starts on the list");
  page.setConversationView(true);
  assert.ok(page.classes.has("conversation-open"), "the conversation pane opens");
  assert.equal(page.stack, 2, "opening a conversation records exactly one entry");
  assert.equal(page.entries[1].state.neutrinoView, "conversation", "the entry is marked as a conversation");
  assert.deepEqual(page.focus, ["back"], "the header's back arrow takes focus");

  page.setConversationView(true);
  assert.equal(page.stack, 2, "reopening the same pane never stacks a second entry");
}

// --- the browser's Back returns to the list, Forward reopens ----------------
{
  const page = createPage();
  page.setConversationView(true);
  page.focus.length = 0;

  page.browserBack();
  assert.equal(page.classes.has("conversation-open"), false, "Back returns to the conversation list");
  assert.equal(page.stack, 2, "Back keeps the conversation entry for Forward");
  assert.deepEqual(page.focus, ["refresh"], "focus moves into the list");

  page.rows.selected = { focus: () => page.focus.push("row") };
  page.browserForward();
  assert.ok(page.classes.has("conversation-open"), "Forward reopens the conversation that was open");
  assert.equal(page.stack, 2, "Forward does not record a second level");
  assert.deepEqual(page.focus, ["refresh", "back"], "focus returns to the conversation");

  page.browserBack();
  assert.deepEqual(page.focus.slice(-1), ["row"], "the conversation that was open keeps the focus");
}

// --- the header's back arrow consumes its own entry -------------------------
{
  const page = createPage();
  page.setConversationView(true);
  page.headerBack();
  assert.equal(page.classes.has("conversation-open"), false, "the arrow closes the pane");
  assert.equal(page.at, 0, "the browser steps onto the list entry");
  assert.equal(page.backCalls.length, 1, "the arrow consumes exactly one entry");
  assert.equal(page.entries.length, 2, "the entry is kept for Forward");
  assert.equal(page.classes.has("conversation-open"), false, "the popstate it causes changes nothing");

  page.headerBack();
  assert.equal(page.backCalls.length, 1, "a second press has no entry of ours left to consume");
  assert.equal(page.at, 0, "and it never leaves the console");
}

// --- history the page did not write is never used ---------------------------
{
  const page = createPage({ stacked: false });
  page.setConversationView(true);
  assert.equal(page.stack, 1, "a wide screen has no pane to return to");
  assert.ok(page.classes.has("conversation-open"), "the pane still opens");
  assert.deepEqual(page.focus, [], "no focus is taken when both panes are shown");

  // The window narrows with a conversation already open: the list looks like a
  // level the browser never recorded, so the arrow must not walk into the page
  // the reader came from.
  page.setStacked(true);
  page.headerBack();
  assert.equal(page.classes.has("conversation-open"), false, "the arrow still closes the pane");
  assert.deepEqual(page.backCalls, [], "the arrow never walks history it did not write");
  assert.equal(page.at, 0, "the reader stays where they are");
}

// --- rotating into the single-pane layout records the open conversation -----
{
  const page = createPage({ stacked: false, layoutEvents: true });
  page.watchPanes();
  page.setConversationView(true);
  assert.equal(page.stack, 1, "a two-pane layout has no level to return to");

  page.rotate(true);
  assert.equal(page.stack, 2, "the phone takes up one pane at a time, so the open conversation becomes a level");
  assert.equal(page.entries[1].state.neutrinoView, "conversation", "the recorded entry is marked as a conversation");

  page.browserBack();
  assert.equal(page.classes.has("conversation-open"), false, "Back returns to the list after the rotation");
  assert.equal(page.stack, 2, "and Forward can reopen the conversation");
}
{
  const page = createPage({ stacked: false, layoutEvents: true });
  page.watchPanes();
  page.rotate(true);
  assert.equal(page.stack, 1, "rotating with the list on screen records nothing");
}

// --- a reload forgets the conversation it no longer shows -------------------
{
  const page = createPage();
  page.setConversationView(true);
  // A reload rebuilds the page with the pane closed, while the browser stays on
  // the entry that recorded the conversation.
  page.classes.delete("conversation-open");
  page.forgetStaleConversationEntry();
  assert.equal(page.stack, 2, "only the mark goes: the entry itself stays");
  assert.equal(page.entries[1].state, null, "a reloaded page is a plain list");

  page.setConversationView(true);
  assert.equal(page.stack, 3, "the next conversation records a level of its own");
  page.headerBack();
  assert.equal(page.at, 1, "Back lands on the list, not on the reloaded page");
  assert.equal(page.classes.has("conversation-open"), false);
}
{
  const page = createPage();
  page.forgetStaleConversationEntry();
  assert.deepEqual(page.replaced, [], "a page that never opened a conversation is left untouched");
}

// --- an embedder without history keeps a working back arrow ----------------
{
  // The browser tests load this file with a stripped-down global object, which
  // is also what an embedder without the History API looks like.
  const classes = new Set();
  const context = vm.createContext({
    el: {
      app: { classList: classListOf(classes) },
      back: { focus() {} },
      sessions: { querySelector: () => null },
      refresh: { focus() {} },
    },
  });
  vm.runInContext(slice, context);
  context.setConversationView(true);
  assert.ok(classes.has("conversation-open"), "the pane opens without history");
  context.forgetStaleConversationEntry();
  context.followViewHistory({ state: null });
  assert.equal(classes.has("conversation-open"), false, "Back closes the pane without history");
}

console.log("web mobile history: ok");
