// The Web console and the Pro workspace must offer the update on load, install
// it only after the user confirms, and fall back to the manual command when npm
// fails. The page is evaluated with a DOM stand-in and a stubbed server, so the
// assertions are made on the dialog the browser actually builds. The release
// reaches the page over the console's announcement stream, so the stand-in
// EventSource sends it exactly the way the server does.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/**
 * The console only needs a settings controller that can load the payload; the
 * settings dialog itself is not what this test is about, and the page's own
 * picker markup is being reworked separately.
 */
const settingsOptions = [];
function createSettingsUI(options) {
  settingsOptions.push(options);
  const { apiFetch } = options;
  return {
    async load() {
      const response = await apiFetch("/api/settings", { cache: "no-store" });
      return response.json();
    },
    showConversation() {},
    clear() {},
    soundAlerts: () => true,
    refreshTexts() {},
    catalog: () => null,
    defaultSelection: () => undefined,
    selectionForFile: () => undefined,
  };
}

const MANUAL = "npm install -g @xingjisoft/neutrino";
const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8")
  .replace(/^import .*;\r?\n/gm, "");
const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");

class Element {
  value = ""; children = []; checked = false; disabled = false; open = false; textContent = "";
  classes = new Set();
  events = new Map();
  classList = {
    toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
    add: name => this.classes.add(name), remove: name => this.classes.delete(name),
    contains: name => this.classes.has(name),
  };
  set innerHTML(_value) { this.replaceChildren(); }
  replaceChildren() { this.children = []; }
  appendChild(child) { this.children.push(child); }
  setAttribute(name, value) { (this.attributes ??= {})[name] = value; }
  // The login gate is built at run time, so the stand-in needs the lookups it
  // performs on its own markup.
  querySelector(selector) {
    this.queries ??= new Map();
    if (!this.queries.has(selector)) this.queries.set(selector, new Element());
    return this.queries.get(selector);
  }
  addEventListener(name, fn) { this.events.set(name, fn); }
  async fire(name, event = { preventDefault() {} }) { await this.events.get(name)?.(event); }
  showModal() { this.open = true; }
  // A real dialog fires "close" when it is closed, however that happened.
  close() { this.open = false; void this.events.get("close")?.({}); }
}

const CURRENT = "0.4.1";
const LATEST = "9.9.9";

/**
 * Load the console the way a browser does: one DOM built from index.html, one
 * settings payload, and a stubbed server. `pathname` decides the workspace.
 */
function boot(pathname, {
  update = { current_version: CURRENT, latest_version: LATEST, has_update: true },
  backgroundPrompt = false,
  // Whether the console knows about `update` when the tab connects. Silent
  // streams stand in for a page whose payload and stream disagree.
  announce = true,
} = {}) {
  // One stand-in per control in the real markup, keeping the classes the page
  // ships with: "hidden" in the HTML has to mean hidden here too, or a control
  // that starts out of sight looks visible to every assertion.
  const nodes = new Map();
  for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const element = new Element();
    const declared = /\bclass="([^"]*)"/.exec(match[0]);
    if (declared) for (const name of declared[1].split(/\s+/).filter(Boolean)) element.classes.add(name);
    nodes.set(match[1], element);
  }
  const node = id => {
    assert.ok(nodes.has(id), `missing control ${id}`);
    return nodes.get(id);
  };
  const requests = [];
  let updateReply = { status: 200, body: { ok: true, version: LATEST, error: "", command: MANUAL } };
  const payload = () => ({
    update,
    providers: [],
    intensities: ["Low", "Medium", "High"],
    selection: { provider: "", model: "", intensity: "High" },
    settings: {
      default_intensity: "High", model_context_window: 1_000_000, approval_model: "",
      auto_approve_extreme_risk: false, sound_alerts: true, language: "en", plan_first: true,
      approval_mode: "request", web_console: true, web_lan: false, background: false,
      background_prompt: backgroundPrompt,
    },
  });
  const rootClasses = { add() {}, remove() {}, toggle() {} };
  const document = {
    getElementById: node,
    createElement: () => new Element(),
    querySelectorAll: () => [],
    documentElement: { classList: rootClasses },
    body: { classList: rootClasses, appendChild() {} },
  };
  // The real endpoint sends the state it knows the moment a tab connects and
  // again whenever the 30-minute check finds a new release; both arrive here.
  const streams = [];
  class StubEventSource {
    listeners = new Map();
    closed = false;
    constructor(url) {
      this.url = url;
      streams.push(this);
      if (announce) setTimeout(() => { if (!this.closed) void this.fire("update", update); }, 0);
    }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    close() { this.closed = true; }
    async fire(name, data) { await this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  }
  const context = vm.createContext({
    createSettingsUI,
    document,
    localStorage: { getItem: () => "", setItem() {}, removeItem() {} },
    location: { search: "", pathname },
    window: { addEventListener() {} },
    URLSearchParams,
    setInterval: () => 1,
    console: { error() {} },
    EventSource: StubEventSource,
    async fetch(url, init = {}) {
      requests.push({ url, init });
      const respond = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
      if (url === `${pathname === "/pro" ? "/pro/api" : "/api"}/settings`) return respond(payload());
      if (url === "/api/overview") return respond({ groups: [], live: [] });
      if (url === "/api/update" || url === "/pro/api/update") return respond(updateReply.body, updateReply.status);
      throw new Error(`unexpected browser request: ${url}`);
    },
  });
  // The document is read through the global at run time; the console captures it
  // while it loads, so it must be in place first.
  settingsOptions.length = 0;
  globalThis.document = document;
  vm.runInContext(
    `${source}\nglobalThis.appTest = { applyUpdateStatus, runUpdate, preferences, el, showGate };`,
    context,
  );
  return {
    node,
    requests,
    streams,
    appTest: context.appTest,
    settingsOptions: () => settingsOptions.at(-1),
    failWith(error) {
      updateReply = { status: 500, body: { ok: false, version: LATEST, error, command: MANUAL } };
    },
  };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

try {
  // --- the regular console -------------------------------------------------
  const consolePage = boot("/");
  const node = consolePage.node;
  // The console asks on load, not when the user goes looking for it.
  await waitFor(() => node("update-dialog").open, "the update dialog to open on load");
  assert.equal(node("update-versions").textContent, `Running ${CURRENT} · published ${LATEST}`);
  assert.equal(node("update-now").classes.has("hidden"), false, "the confirm button is offered");
  assert.equal(node("update-later").classes.has("hidden"), false);
  assert.equal(node("update-command-block").classes.has("hidden"), true,
    "the manual command stays out of the way until something fails");
  assert.equal(consolePage.requests.filter(request => request.url === "/api/update").length, 0,
    "nothing installs before the user confirms");

  await node("update-now").fire("click");
  await waitFor(() => node("update-feedback").textContent.includes("Updated to"), "the install result");
  assert.equal(node("update-feedback").textContent, `Updated to ${LATEST}. Restart Neutrino to use it.`);
  assert.equal(node("update-feedback").classes.has("error"), false);
  assert.equal(consolePage.requests.filter(request => request.url === "/api/update").length, 1);
  assert.equal(consolePage.requests.find(request => request.url === "/api/update").init.method, "POST");
  assert.equal(node("update-now").classes.has("hidden"), true, "a finished update offers no second attempt");
  assert.equal(node("update-later").classes.has("hidden"), true);
  assert.equal(node("update-command-block").classes.has("hidden"), true);

  // npm failing is reported in the dialog, together with the command that
  // finishes the job by hand.
  consolePage.failWith(`npm install -g @xingjisoft/neutrino failed with code 1: EACCES permission denied`);
  node("update-now").classes.delete("hidden");
  node("update-later").classes.delete("hidden");
  await consolePage.appTest.runUpdate();
  assert.match(node("update-feedback").textContent, /^Update failed: npm install -g @xingjisoft\/neutrino failed with code 1/);
  assert.equal(node("update-feedback").classes.has("error"), true);
  assert.equal(node("update-command-block").classes.has("hidden"), false, "the manual fallback is shown");
  assert.equal(node("update-command").textContent, MANUAL);
  assert.equal(node("update-now").disabled, false, "the user can try again");

  // Dismissing is always possible: the notice is an offer, never a gate.
  await node("update-later").fire("click");
  assert.equal(node("update-dialog").open, false);

  // --- the Pro workspace ---------------------------------------------------
  const proPage = boot("/pro");
  await waitFor(() => proPage.node("update-dialog").open, "the Pro workspace to offer the update");
  assert.equal(proPage.streams[0]?.url, "/pro/api/update/events",
    "the Pro workspace listens to the same stream under its own API prefix");
  assert.equal(proPage.node("update-versions").textContent, `Running ${CURRENT} · published ${LATEST}`);
  assert.equal(proPage.node("update-badge").classes.has("hidden"), false,
    "the Pro workspace draws the same corner badge");
  await proPage.node("update-now").fire("click");
  await waitFor(() => proPage.node("update-feedback").textContent.includes("Updated to"), "the Pro install result");
  const proUpdate = proPage.requests.find(request => request.url === "/pro/api/update");
  assert.ok(proUpdate, "the Pro workspace updates through its own API prefix");
  assert.equal(proUpdate.init.method, "POST");

  // An up-to-date console says nothing at all, even when the answer is handed
  // to the prompt directly.
  const upToDate = { current_version: CURRENT, latest_version: CURRENT, has_update: false };
  const quiet = boot("/", { update: upToDate });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(quiet.node("update-dialog").open, false, "no update means no dialog on load");
  quiet.appTest.applyUpdateStatus(upToDate);
  assert.equal(quiet.node("update-dialog").open, false, "no update means no dialog when asked");
  assert.ok(!quiet.requests.some(request => request.url === "/api/update"));
  assert.equal(quiet.node("update-badge").classes.has("hidden"), true,
    "no update means no corner badge");

  // A check started from Settings reaches the same dialog: the page offers the
  // release it reports and installs it only after the user confirms.
  for (const pathname of ["/", "/pro"]) {
    const page = boot(pathname, { update: { current_version: CURRENT, latest_version: CURRENT, has_update: false } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(page.node("update-dialog").open, false, "an up-to-date console shows nothing on load");
    const settings = page.settingsOptions();
    assert.equal(typeof settings?.onUpdateFound, "function", "the settings dialog can hand a release to the page");
    const found = { current_version: CURRENT, latest_version: LATEST, has_update: true };
    assert.equal(settings.onUpdateFound(found), true, "the offer is shown");
    assert.equal(page.node("update-dialog").open, true);
    assert.equal(page.node("update-versions").textContent, `Running ${CURRENT} · published ${LATEST}`);
    assert.equal(page.node("update-now").classes.has("hidden"), false, "the confirm button is offered");
    assert.equal(page.requests.filter(request => request.url.endsWith("/api/update")).length, 0,
      "nothing installs before the user confirms");
    await page.node("update-now").fire("click");
    await waitFor(() => page.node("update-feedback").textContent.includes("Updated to"), "the settings-started install");
    const install = page.requests.find(request => request.url.endsWith("/api/update"));
    assert.equal(install.init.method, "POST");
    assert.equal(page.node("update-feedback").textContent, `Updated to ${LATEST}. Restart Neutrino to use it.`);
  }

  // --- the corner badge ----------------------------------------------------
  // The badge is the reminder that outlives the notice: it appears as soon as
  // the page knows about a release, survives "Later", and reopens the same
  // notice when the user clicks it.
  const badged = boot("/");
  await waitFor(() => badged.node("update-dialog").open, "the notice on load");
  assert.equal(badged.node("update-badge").classes.has("hidden"), false,
    "a known release lights the corner badge");
  assert.equal(badged.node("update-badge").title, "A new version is available",
    "the badge carries the words screen readers announce");
  await badged.node("update-later").fire("click");
  assert.equal(badged.node("update-dialog").open, false, "\"Later\" closes the notice");
  assert.equal(badged.node("update-badge").classes.has("hidden"), false,
    "the badge stays after the notice is dismissed");
  await badged.node("update-badge").fire("click");
  assert.equal(badged.node("update-dialog").open, true, "the badge reopens the notice");
  assert.equal(badged.node("update-versions").textContent, `Running ${CURRENT} · published ${LATEST}`,
    "the reopened notice names the release the badge stood for");
  assert.equal(badged.requests.filter(request => request.url === "/api/update").length, 0,
    "opening the notice installs nothing");
  await badged.node("update-now").fire("click");
  await waitFor(() => badged.node("update-feedback").textContent.includes("Updated to"), "the badge-started install");
  assert.equal(badged.node("update-badge").classes.has("hidden"), true,
    "an installed release clears the badge");

  // A check started in Settings lights the same badge in both workspaces, and
  // dismissing that notice leaves the reminder behind.
  for (const pathname of ["/", "/pro"]) {
    const page = boot(pathname, { update: { current_version: CURRENT, latest_version: CURRENT, has_update: false } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(page.node("update-badge").classes.has("hidden"), true,
      `${pathname} shows no badge while up to date`);
    page.settingsOptions().onUpdateFound({ current_version: CURRENT, latest_version: LATEST, has_update: true });
    assert.equal(page.node("update-badge").classes.has("hidden"), false,
      `${pathname} lights the badge when a check finds a release`);
    assert.equal(page.node("update-dialog").open, true, `${pathname} also shows the notice`);
    await page.node("update-later").fire("click");
    assert.equal(page.node("update-badge").classes.has("hidden"), false,
      `${pathname} keeps the badge after the notice is dismissed`);
    await page.node("update-badge").fire("click");
    assert.equal(page.node("update-dialog").open, true, `${pathname} reopens the notice from the badge`);
    assert.equal(page.requests.filter(request => request.url.endsWith("/api/update")).length, 0,
      `${pathname} installs nothing until the user confirms`);
  }

  // --- one announcement stream ---------------------------------------------
  // The console is the only source: the notice no longer reads the release out
  // of the settings payload, so a window that stays open learns about a new
  // version the same way one that has just loaded does.
  const silent = boot("/", { announce: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(silent.streams.length, 1, "the console subscribes to one announcement stream");
  assert.equal(silent.streams[0].url, "/api/update/events");
  assert.equal(silent.node("update-dialog").open, false,
    "a settings payload that still reports a release opens nothing on its own");
  assert.equal(silent.node("update-badge").classes.has("hidden"), true, "and lights no badge");

  // What a tab receives from the stream is the notice it shows on load.
  await silent.streams[0].fire("update", { current_version: CURRENT, latest_version: LATEST, has_update: true });
  assert.equal(silent.node("update-dialog").open, true, "the announcement opens the notice");
  assert.equal(silent.node("update-versions").textContent, `Running ${CURRENT} · published ${LATEST}`,
    "with the words the notice has always used");
  assert.equal(silent.node("update-badge").classes.has("hidden"), false, "and lights the corner badge");

  // A release the 30-minute check announces later reaches the same notice and
  // the same badge: the reminder is never left naming an older version.
  const LATER = "10.0.0";
  await silent.node("update-later").fire("click");
  assert.equal(silent.node("update-dialog").open, false, "\"Later\" closes the notice");
  await silent.streams[0].fire("update", { current_version: CURRENT, latest_version: LATER, has_update: true });
  assert.equal(silent.node("update-dialog").open, false,
    "a release announced later does not reopen a notice the user dismissed");
  assert.equal(silent.node("update-badge").classes.has("hidden"), false,
    "but the corner badge keeps the reminder");
  await silent.node("update-badge").fire("click");
  assert.equal(silent.node("update-dialog").open, true, "the badge reopens the notice");
  assert.equal(silent.node("update-versions").textContent, `Running ${CURRENT} · published ${LATER}`,
    "naming the release the console announced last");

  // A console that reports no release at all drops the reminder.
  await silent.streams[0].fire("update", { current_version: CURRENT, latest_version: CURRENT, has_update: false });
  assert.equal(silent.node("update-badge").classes.has("hidden"), true,
    "an announcement with no release clears the badge");

  // The background invitation is modal too: a release that lands while it is up
  // waits for it to close instead of stacking a second dialog on top of it.
  const invited = boot("/", { announce: false, backgroundPrompt: true });
  await waitFor(() => invited.node("background-dialog").open, "the background invitation");
  await invited.streams[0].fire("update", { current_version: CURRENT, latest_version: LATEST, has_update: true });
  assert.equal(invited.node("update-dialog").open, false,
    "the notice waits while the background invitation is up");
  assert.equal(invited.node("update-badge").classes.has("hidden"), false, "the reminder is still lit");
  invited.node("background-dialog").close();
  assert.equal(invited.node("background-dialog").open, false);
  assert.equal(invited.node("update-dialog").open, true,
    "closing the invitation offers the release it was holding back");

  // The login gate closes the invitation on its way in, so an offer held back
  // for that invitation must not end up covering the gate.
  const locked = boot("/", { announce: false, backgroundPrompt: true });
  await waitFor(() => locked.node("background-dialog").open, "the background invitation");
  await locked.streams[0].fire("update", { current_version: CURRENT, latest_version: LATEST, has_update: true });
  assert.equal(locked.node("update-dialog").open, false, "the notice still waits for the invitation");
  locked.appTest.showGate();
  assert.equal(locked.node("background-dialog").open, false, "the gate closes the invitation");
  assert.equal(locked.node("update-dialog").open, false, "and the notice never covers the gate");

  console.log("ok update dialog: announced over the console's stream or from Settings in both workspaces, the corner badge reminds until installed, installs on confirm, manual fallback on failure");
} finally {
  delete globalThis.document;
}
