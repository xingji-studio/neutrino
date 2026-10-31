import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-web-settings-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.NEUTRINO_PLAN = "off";
const { saveModels, saveConfig, loadConfig, loadSession, resolveModelSelection } = await import("../dist/config.js");
const { getWebSettings, updateWebSettings } = await import("../dist/web/settings.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession, resolveModel, resumeSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { App } = await import("../dist/app.js");
const { defaultState } = await import("../dist/state.js");
const { hub } = await import("../dist/web/hub.js");
const { createSettingsUI } = await import("../web/settings.js");
const { turnAnswerIndex, turnFolds, turnPreview, turnRanges } = await import("../web/turns.js");

const models = [
  { name: "Provider A", models: [{ name: "same", url: "https://a.invalid/v1", api_key: "secret-a", supports_streaming: true }] },
  { name: "Provider B", models: [
    { name: "same", url: "https://b.invalid/v1", api_key: "secret-b", supports_streaming: true },
    { name: "b-only", url: "https://b.invalid/v1", api_key: "secret-b-only", supports_streaming: false },
    { name: "no-key", url: "https://b.invalid/v1", api_key: "", supports_streaming: true },
  ] },
];
const a = { provider: "Provider A", model: "same", intensity: "High" };
const b = { provider: "Provider B", model: "same", intensity: "Ultra" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, "timed out waiting for turn"); await sleep(10); }
}
const originalStream = LLMClient.prototype.streamTurn;
const previousDocument = globalThis.document;
const active = new Set();
function close(agent) {
  if (agent instanceof ChatScreen) agent.onDeactivate(); else agent.dispose();
  active.delete(agent);
}
function runner(kind) {
  let agent;
  if (kind === "tui") {
    agent = new ChatScreen();
    agent.app = { state: { ...defaultState(), selectedProvider: a.provider, selectedModelName: a.model, selectedModelUrl: models[0].models[0].url, selectedModelApiKey: "secret-a" }, render() {} };
    agent.loadedMessages = [{ role: "user", content: "preserved history" }];
    agent.onActivate();
  } else {
    agent = new WebSession({ id: "settings-web", provider: a.provider, model: a.model, intensity: a.intensity, cwd: process.cwd(), messages: [{ role: "user", content: "preserved history" }] }, models[0].models[0]);
    agent.start();
  }
  active.add(agent);
  agent.autoCompress = async () => {};
  agent.compressThreshold = () => 0;
  return agent;
}

try {
  saveModels({ providers: models });
  saveConfig({ unrelated: "keep", approval_model: "", auto_approve_extreme_risk: false });
  updateWebSettings({ selection: a });
  const exposed = JSON.stringify(getWebSettings());
  for (const secret of ["secret-a", "secret-b", "selected_model_api_key", "https://a.invalid"]) assert.ok(!exposed.includes(secret));
  assert.equal(getWebSettings().providers[1].models[2].configured, false);
  updateWebSettings({ selection: b, settings: { model_context_window: 16000, approval_model: "b-only", auto_approve_extreme_risk: true } });
  assert.equal(loadConfig().selected_model_url, "https://b.invalid/v1");
  assert.equal(loadConfig().selected_model_api_key, "secret-b");
  assert.equal(loadConfig().default_intensity, "Ultra");
  assert.equal(loadConfig().unrelated, "keep");
  assert.equal(getWebSettings().settings.model_context_window, 16000);
  assert.equal(getWebSettings().providers[0].models[0].context_window, 1_000_000, "same name in another provider keeps its own capacity");
  const before = loadConfig();
  const beforeSettings = getWebSettings();
  for (const patch of [
    { api_key: "injection" }, { settings: { selected_model_api_key: "injection" } },
    { settings: { default_intensity: "invalid" } }, { settings: { model_context_window: -1 } },
    { settings: { model_context_window: "32000" } }, { settings: { model_context_window: 0 } }, { settings: { model_context_window: 1.5 } }, { settings: { model_context_window: Number.MAX_SAFE_INTEGER + 1 } }, { settings: { auto_approve_extreme_risk: "true" } },
    { settings: { approval_model: "missing" } }, { selection: { ...a, model: "b-only" } },
    { settings: { default_intensity: "Low", unknown: true } },
  ]) { assert.throws(() => updateWebSettings(patch)); assert.deepEqual(loadConfig(), before); assert.deepEqual(getWebSettings(), beforeSettings); }
  assert.throws(() => resolveModelSelection({ ...b, model: "no-key" }), /API key/);
  assert.equal(resolveModel("same", "missing provider").ok, false, "do not fall back to another provider with the same model name");
  console.log("ok settings catalog, key redaction, strict provider matching, validation and persistence");

  for (const kind of ["tui", "web"]) {
    updateWebSettings({ selection: a });
    const agent = runner(kind);
    const key = hub.register(agent);
    const resolved = resolveModelSelection(b);
    agent.busy = true;
    assert.equal(hub.configure(key, resolved).ok, false, "a running turn cannot switch providers");
    assert.equal(agent.liveMeta().provider, a.provider);
    agent.busy = false;
    assert.equal(hub.configure(key, resolved).ok, true);
    assert.equal(agent.liveMeta().provider, b.provider);
    assert.equal(loadSession(agent.sessionId).intensity, b.intensity);
    assert.equal(loadConfig().selected_provider, a.provider, "current-session changes do not overwrite defaults");
    assert.ok(loadSession(agent.sessionId).messages.some(m => m.content === "preserved history"));
    if (kind === "tui") assert.equal(agent.app.state.selectedModelApiKey, "secret-b");
    const requests = [];
    LLMClient.prototype.streamTurn = async function* () {
      requests.push({ provider: this.provider, model: this.model, intensity: this.intensity, temperature: this.temperature });
      yield "configured reply";
    };
    agent.liveSend("probe the next request");
    await waitFor(() => !agent.busy && requests.length === 1);
    assert.equal(requests[0].provider, b.provider);
    assert.equal(requests[0].model.api_key, "secret-b");
    assert.equal(requests[0].model.url, "https://b.invalid/v1");
    assert.equal(requests[0].intensity, "Ultra");
    assert.equal(requests[0].temperature, 1.5);

    let finish;
    const stalled = new Promise(resolve => { finish = resolve; });
    let stopped;
    const done = new Promise(resolve => { stopped = resolve; });
    LLMClient.prototype.streamTurn = async function* () {
      try { yield "partial old response"; await stalled; yield "late data"; }
      finally { stopped(); }
    };
    agent.liveSend("pause before switching");
    await waitFor(() => agent.streamingContent === "partial old response");
    agent.livePause();
    assert.equal(hub.configure(key, resolveModelSelection({ ...a, intensity: "Low" })).ok, true);
    finish();
    await done;
    assert.equal(agent.liveMeta().intensity, "Low");
    assert.equal(agent.liveMeta().provider, a.provider);
    const saved = loadSession(agent.sessionId);
    close(agent);
    const resumed = resumeSession(saved);
    assert.equal(resumed.ok, true);
    active.add(resumed.session);
    assert.equal(resumed.session.liveMeta().provider, a.provider);
    assert.equal(resumed.session.liveMeta().intensity, "Low");
    close(resumed.session);
    console.log(`ok ${kind}: busy guard, actual next request, pause/switch, history and resume`);
  }

  const terminal = new App();
  terminal.pushScreen = () => {};
  updateWebSettings({ selection: b });
  terminal.startNewChat("use web defaults");
  assert.equal(terminal.state.selectedProvider, b.provider);
  assert.equal(terminal.state.selectedIntensity, b.intensity);

  // Test the actual browser controller with a DOM stand-in and real settings
  // validation. Rendering functions never receive credentials.
  class Element {
    value = ""; children = []; checked = false; disabled = false; open = false; events = new Map(); textContent = "";
    classes = new Set();
    classList = {
      toggle: (name, on) => { if (on) this.classes.add(name); else this.classes.delete(name); },
      add: name => this.classes.add(name), remove: name => this.classes.delete(name),
    };
    set innerHTML(_value) { this.replaceChildren(); }
    replaceChildren() { this.children = []; }
    appendChild(child) { this.children.push(child); }
    setAttribute(name, value) { (this.attributes ??= {})[name] = value; }
    addEventListener(name, fn) { this.events.set(name, fn); }
    async fire(name) { await this.events.get(name)?.({ preventDefault() {} }); }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const nodes = new Map();
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(match[1], new Element());
  globalThis.document = { getElementById: id => { assert.ok(nodes.has(id), `missing control ${id}`); return nodes.get(id); }, createElement: () => new Element() };
  const applied = [];
  let ui;
  let failApply = false;
  ui = createSettingsUI({
    async apiFetch(_url, init) {
      try {
        if (init.method === "POST") updateWebSettings(JSON.parse(init.body));
        return { ok: true, json: async () => getWebSettings() };
      } catch (error) { return { ok: false, status: 400, json: async () => ({ error: error.message }) }; }
    },
    async applyModel(selection) {
      if (failApply) throw new Error("pause the current turn before changing models");
      applied.push(selection);
      ui.showConversation({ ...selection, busy: false }, "live:L1");
    },
  });
  const node = id => nodes.get(id);
  await ui.load();
  ui.showConversation({ ...a, busy: false }, "live:L1");
  node("model-provider").value = b.provider;
  await node("model-provider").fire("change");
  node("model-name").value = "b-only";
  await node("model-name").fire("change");
  node("model-intensity").value = "Low";
  await node("model-intensity").fire("change");
  ui.showConversation({ ...a, busy: false }, "live:L1");
  assert.equal(node("model-name").value, "b-only", "SSE refresh must preserve the user's draft");
  await node("model-picker").fire("submit");
  assert.deepEqual(applied[0], { provider: b.provider, model: "b-only", intensity: "Low" });
  ui.showConversation({ ...b, busy: true }, "live:L1");
  assert.equal(node("model-apply").disabled, true);
  await node("model-picker").fire("submit");
  assert.equal(applied.length, 1);
  ui.showConversation({ ...b, busy: false, paused: true }, "live:L1");
  failApply = true;
  await node("model-picker").fire("submit");
  assert.match(node("model-feedback").textContent, /pause/);
  assert.equal(node("model-apply").disabled, false);
  await node("settings-open").fire("click");
  assert.equal(node("settings-dialog").open, true);
  node("default-provider").value = a.provider;
  await node("default-provider").fire("change");
  assert.equal(node("settings-context").value, "1000000");
  node("default-provider").value = b.provider;
  await node("default-provider").fire("change");
  assert.equal(node("settings-context").value, "16000", "provider change reloads that model's capacity");
  node("default-model").value = "b-only";
  await node("default-model").fire("change");
  assert.equal(node("settings-context").value, "1000000", "model change reloads default capacity");
  node("default-provider").value = a.provider;
  await node("default-provider").fire("change");
  node("default-intensity").value = "Medium";
  node("settings-context").value = "64000";
  await node("settings-context").fire("input");
  assert.match(node("settings-compress-note").textContent, /51,200/);
  node("settings-reviewer").value = "b-only";
  node("settings-extreme").checked = false;
  await node("settings-form").fire("submit");
  assert.equal(loadConfig().selected_provider, a.provider);
  assert.equal(loadConfig().default_intensity, "Medium");
  assert.equal(getWebSettings().settings.model_context_window, 64000);
  assert.equal(loadConfig().auto_approve_extreme_risk, false);
  assert.match(node("settings-feedback").textContent, /saved/);
  await node("settings-cancel").fire("click");
  assert.equal(node("settings-dialog").open, false);
  console.log("ok browser controls: dependent selectors, streaming drafts, apply errors, settings dialog and saved defaults");

  // Load the entire browser entry point as well: the picker must actually call
  // the live-model endpoint and a disappearing session must clear both forms.
  const browserErrors = [];
  const browserRequests = [];
  let snapshot = { ...a, key: "browser-live", messages: [], busy: false, tokens: { prompt: 0, completion: 0 } };
  const browser = vm.createContext({
    createSettingsUI, turnAnswerIndex, turnFolds, turnPreview, turnRanges, document: globalThis.document,
    localStorage: { removeItem() {} }, location: { search: "" },
    window: { addEventListener() {} }, URLSearchParams, setInterval() {},
    console: { error: error => browserErrors.push(error) },
    EventSource: class { addEventListener() {} close() {} },
    async fetch(url, init = {}) {
      browserRequests.push({ url, init });
      let data;
      if (url === "/api/settings") data = getWebSettings();
      else if (url === "/api/overview") data = { groups: [], live: [] };
      else if (url === "/api/live/browser-live/model") {
        snapshot = { ...snapshot, ...JSON.parse(init.body) };
        data = { ok: true, snapshot };
      } else throw new Error(`unexpected browser request: ${url}`);
      return { ok: true, status: 200, json: async () => data };
    },
  });
  // Strip every module import: the test injects the same bindings into the vm
  // context above (settings.js and turns.js are real ES modules).
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "");
  vm.runInContext(source + "\nglobalThis.appTest = { state, preferences, loadOverview, selectLive, renderLive, syncSelection };", browser);
  const appTest = browser.appTest;
  await appTest.preferences.load();
  await appTest.loadOverview();
  await appTest.selectLive("browser-live");
  appTest.state.snapshot = snapshot;
  appTest.renderLive();
  node("model-provider").value = b.provider;
  await node("model-provider").fire("change");
  node("model-intensity").value = "Max";
  await node("model-intensity").fire("change");
  await node("model-picker").fire("submit");
  assert.equal(appTest.state.snapshot.provider, b.provider);
  assert.equal(appTest.state.snapshot.intensity, "Max");
  assert.equal(node("model-provider").value, b.provider);
  assert.equal(browserRequests.filter(request => request.url.endsWith("/model")).length, 1);
  appTest.syncSelection();
  assert.equal(appTest.state.selection, null);
  assert.ok(node("model-picker").classes.has("hidden"));
  assert.ok(node("composer").classes.has("hidden"));
  assert.deepEqual(browserErrors, []);
  console.log("ok browser entry point: live model requests, response rendering and ended-session cleanup");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  for (const agent of active) close(agent);
  fs.rmSync(testHome, { recursive: true, force: true });
}
