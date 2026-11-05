// The Web console and the Pro workspace must offer the update on load, install
// it only after the user confirms, and fall back to the manual command when npm
// fails. The page is evaluated with a DOM stand-in and a stubbed server, so the
// assertions are made on the dialog the browser actually builds.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

/**
 * The console only needs a settings controller that can load the payload; the
 * settings dialog itself is not what this test is about, and the page's own
 * picker markup is being reworked separately.
 */
function createSettingsUI({ apiFetch }) {
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
  addEventListener(name, fn) { this.events.set(name, fn); }
  async fire(name, event = { preventDefault() {} }) { await this.events.get(name)?.(event); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

const CURRENT = "0.4.1";
const LATEST = "9.9.9";

/**
 * Load the console the way a browser does: one DOM built from index.html, one
 * settings payload, and a stubbed server. `pathname` decides the workspace.
 */
function boot(pathname, { update = { current_version: CURRENT, latest_version: LATEST, has_update: true } } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element());
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
      background_prompt: false,
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
  const context = vm.createContext({
    createSettingsUI,
    document,
    localStorage: { getItem: () => "", setItem() {}, removeItem() {} },
    location: { search: "", pathname },
    window: { addEventListener() {} },
    URLSearchParams,
    setInterval: () => 1,
    console: { error() {} },
    EventSource: class { addEventListener() {} close() {} },
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
  globalThis.document = document;
  vm.runInContext(
    `${source}\nglobalThis.appTest = { maybePromptUpdate, runUpdate, preferences, el };`,
    context,
  );
  return {
    node,
    requests,
    appTest: context.appTest,
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
  assert.equal(proPage.node("update-versions").textContent, `Running ${CURRENT} · published ${LATEST}`);
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
  quiet.appTest.maybePromptUpdate({ update: upToDate });
  assert.equal(quiet.node("update-dialog").open, false, "no update means no dialog when asked");
  assert.ok(!quiet.requests.some(request => request.url === "/api/update"));

  console.log("ok update dialog: offered on load in both workspaces, installs on confirm, manual fallback on failure");
} finally {
  delete globalThis.document;
}
