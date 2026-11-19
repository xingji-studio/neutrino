import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const take = name => {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2);
};
let now = 0, nextTimer = 0, rendered = 0;
const timers = new Map(), streams = [];
class Stream {
  listeners = new Map(); closed = false;
  constructor() { streams.push(this); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  emit(name, data = {}) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  close() { this.closed = true; }
}
const state = { selection: { kind: "live", key: "L1" }, snapshot: null, eventSource: null };
const snapshot = (revision, extra = {}) => ({ key: "L1", epoch: "server1", revision, busy: true, paused: false, messages: [], ...extra });
let response = snapshot(2, { busy: false, paused: true });
let request = async path => ({ ok: true, status: 200, json: async () => path.endsWith("/overview")
  ? { live: [{ key: "L1" }], groups: [] } : path.endsWith("/pause") ? { snapshot: response } : response });
const context = vm.createContext({
  state, gateShown: false, console, AbortSignal, EventSource: Stream, Date: { now: () => now },
  el: { header: { classList: { remove() {} } }, sub: {} },
  apiPath: path => path, apiFetch: (...args) => request(...args),
  setStatus: (key, kind) => { state.status = { key, kind }; },
  renderLive: () => { rendered++; }, renderSidebar() {}, renderWorkspaceChrome() {}, renderAgentMode() {},
  statusOfLive: value => value?.busy ? "running" : "done", rememberSeen() {}, announce() {}, liveHasContent: () => false, syncSelection() {},
  setInterval: fn => { const id = ++nextTimer; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
});
vm.runInContext(["applyLiveSnapshot", "refreshLiveSnapshot", "openStream", "closeStream", "loadOverview", "postAction"].map(take).join("\n"), context);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

context.openStream("L1");
const first = streams[0];
first.emit("snapshot", snapshot(1));
assert(state.streamConnected); assert.equal(state.snapshot.busy, true);
first.onerror(); await flush();
assert.equal(state.snapshot.paused, true, "HTTP fallback recovers the conversation after SSE failure");
assert.equal(state.streamConnected, false);
await context.loadOverview({ silent: true });
assert.equal(state.status.kind, "offline", "a successful sidebar poll cannot mask the broken SSE stream");

response = snapshot(3, { paused: true, busy: false });
await context.postAction("L1", "pause");
assert.equal(state.snapshot.revision, 3, "pause applies its returned snapshot immediately");
first.emit("snapshot", snapshot(1));
assert.equal(state.snapshot.revision, 3, "late SSE state cannot undo a pause response");
assert.equal(state.snapshot.paused, true);
now = 20000; first.emit("heartbeat");
now = 40000; for (const fn of [...timers.values()]) fn();
assert.equal(streams.length, 1, "heartbeats keep a quiet conversation connected");
now = 51000; for (const fn of [...timers.values()]) fn(); await flush();
assert.equal(first.closed, true); assert.equal(streams.length, 2, "silent connection is replaced automatically");
assert.equal(timers.size, 1, "reconnect replaces its watchdog");

const before = rendered;
first.emit("snapshot", snapshot(100));
assert.equal(rendered, before, "events from a discarded connection are ignored");
state.selection = { kind: "live", key: "L2" }; context.openStream("L2");
streams[1].emit("snapshot", snapshot(101));
assert.equal(rendered, before, "events from a previous conversation are ignored");
context.closeStream(); assert.equal(timers.size, 0);

// A delayed HTTP response must also respect navigation, including switching
// away and back to the same conversation key.
state.selection = { kind: "live", key: "L1" };
let resolve;
request = async () => new Promise(done => { resolve = done; });
const pending = context.refreshLiveSnapshot("L1");
state.selection = { kind: "live", key: "L1" };
const kept = state.snapshot;
resolve({ ok: true, status: 200, json: async () => snapshot(200) });
await pending;
assert.equal(state.snapshot, kept);
console.log("ok web recovery: pause snapshot, HTTP fallback, heartbeat watchdog, ordering and navigation races");
