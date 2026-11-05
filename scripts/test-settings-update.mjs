// The Settings dialog must be able to ask npm on demand: a button that runs a
// fresh check through the console's own API, reports the outcome in the form,
// and hands an available release to the page so it can offer the update. The
// real settings controller runs against a DOM stand-in and a scripted server.
import assert from "node:assert/strict";
import fs from "node:fs";

const CURRENT = "0.4.1";
const LATEST = "9.9.9";

class Element {
  value = ""; children = []; checked = false; disabled = false; open = false; events = new Map(); textContent = "";
  classes = new Set();
  classList = {
    toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
    add: name => this.classes.add(name), remove: name => this.classes.delete(name),
    contains: name => this.classes.has(name),
  };
  set innerHTML(_value) { this.replaceChildren(); }
  replaceChildren() { this.children = []; }
  appendChild(child) { this.children.push(child); }
  setAttribute(name, value) { (this.attributes ??= {})[name] = value; }
  addEventListener(name, fn) { this.events.set(name, fn); }
  contains(node) { return node === this || this.children.includes(node); }
  async fire(name, event = {}) { await this.events.get(name)?.({ preventDefault() {}, stopPropagation() {}, ...event }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const nodes = new Map();
for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element());

// A button inside the settings form must not submit it.
const buttonMarkup = html.match(/<button id="settings-check-update"[^>]*>/)?.[0] ?? "";
assert.match(buttonMarkup, /type="button"/, "the check button must not submit the settings form");
assert.match(html, /<h3 data-i18n="Updates">/, "the check lives in the settings dialog");

globalThis.document = {
  getElementById: id => {
    assert.ok(nodes.has(id), `missing control ${id}`);
    return nodes.get(id);
  },
  createElement: () => new Element(),
  addEventListener() {},
};
const previousDocument = globalThis.document;

const settingsPayload = () => ({
  providers: [{ name: "Provider A", models: [{ name: "model-a", configured: true, intensities: ["High"], context_window: 1_000_000 }] }],
  intensities: ["High"],
  selection: { provider: "Provider A", model: "model-a", intensity: "High" },
  settings: {
    default_intensity: "High", model_context_window: 1_000_000, approval_model: "", auto_approve_extreme_risk: false,
    sound_alerts: true, language: "en", plan_first: true, approval_mode: "request", web_console: true, web_lan: false,
    background: false, background_running: false,
  },
  update: { current_version: CURRENT, latest_version: CURRENT, has_update: false },
});

const { createSettingsUI } = await import("../web/settings.js");

const requests = [];
const offered = [];
let checkReply = null;
let holdCheck = null;
let failure = null;

const ui = createSettingsUI({
  async apiFetch(url, init = {}) {
    requests.push({ url, method: init.method ?? "GET" });
    if (url === "/api/settings" && (init.method ?? "GET") === "GET") {
      return { ok: true, status: 200, json: async () => settingsPayload() };
    }
    if (url === "/api/update/check") {
      if (holdCheck) await holdCheck;
      if (failure) throw failure;
      return { ok: true, status: 200, json: async () => checkReply };
    }
    throw new Error(`unexpected browser request: ${url}`);
  },
  onUpdateFound: update => offered.push(update),
});
const node = id => nodes.get(id);
const checks = () => requests.filter(request => request.url === "/api/update/check");

try {
  // The dialog loads its payload the way the page opens it.
  await node("settings-open").fire("click");
  assert.equal(node("settings-dialog").open, true);
  assert.equal(checks().length, 0, "opening Settings must not check npm on its own");
  assert.equal(node("settings-update-feedback").textContent, "");

  // --- a new release: report it and hand it to the console ----------------
  let release;
  holdCheck = new Promise(resolve => { release = resolve; });
  checkReply = { has_update: true, current_version: CURRENT, latest_version: LATEST, error: "" };
  const first = node("settings-check-update").fire("click");
  assert.equal(node("settings-update-feedback").textContent, "Checking for updates…");
  assert.equal(node("settings-check-update").disabled, true, "the button reports that a check is running");
  // A second click while npm is running must not start another check. It is
  // not awaited: a handler that did start a second request would still be
  // pending on the held reply, and the count below proves the difference.
  void node("settings-check-update").fire("click");
  assert.equal(checks().length, 1, "a running check ignores repeat clicks");
  holdCheck = null;
  release();
  await first;
  assert.equal(checks()[0].method, "POST", "the check asks the server, which owns the npm lookup");
  assert.equal(node("settings-update-feedback").textContent, `Version ${LATEST} is available. This install runs ${CURRENT}.`);
  assert.equal(node("settings-update-feedback").classes.has("error"), false);
  assert.equal(node("settings-check-update").disabled, false, "the button is usable again");
  assert.deepEqual(offered, [{ has_update: true, current_version: CURRENT, latest_version: LATEST, error: "" }],
    "the console receives the release so it can ask whether to install");

  // --- already current ----------------------------------------------------
  checkReply = { has_update: false, current_version: CURRENT, latest_version: CURRENT, error: "" };
  await node("settings-check-update").fire("click");
  assert.equal(node("settings-update-feedback").textContent, `Neutrino ${CURRENT} is up to date.`);
  assert.equal(node("settings-update-feedback").classes.has("error"), false);
  assert.equal(offered.length, 1, "no offer without a new release");

  // --- npm could not be reached: the server still answers, with a reason --
  checkReply = { has_update: false, current_version: CURRENT, latest_version: LATEST, error: "npm view timed out" };
  await node("settings-check-update").fire("click");
  assert.equal(node("settings-update-feedback").textContent, "Update check failed: npm view timed out");
  assert.equal(node("settings-update-feedback").classes.has("error"), true);
  assert.equal(node("settings-check-update").disabled, false);
  assert.equal(offered.length, 1, "a failed check must not offer an update");

  // --- the request itself failed -----------------------------------------
  failure = new Error("network down");
  await node("settings-check-update").fire("click");
  assert.equal(node("settings-update-feedback").textContent, "Update check failed: network down");
  assert.equal(node("settings-update-feedback").classes.has("error"), true);
  assert.equal(node("settings-check-update").disabled, false);

  // --- reopening Settings does not show a stale result ------------------
  failure = null;
  await node("settings-close").fire("click");
  assert.equal(node("settings-dialog").open, false);
  await node("settings-open").fire("click");
  assert.equal(node("settings-update-feedback").textContent, "", "the previous visit's result is cleared");

  console.log("ok settings update check: the button asks npm, reports the result, and offers a new release");
} finally {
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
}
