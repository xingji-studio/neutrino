// Per-model thinking-intensity limits: the catalogue declares what a model
// accepts, and every surface (API validation, saved sessions, terminal and Web
// UI) must stay inside that list.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-intensity-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const {
  INTENSITY_LEVELS,
  intensityForModel,
  loadConfig,
  loadModels,
  loadSession,
  modelIntensities,
  resolveModelSelection,
  saveConfig,
  saveModels,
  saveSession,
} = await import("../dist/config.js");
const { getWebSettings, updateWebSettings } = await import("../dist/web/settings.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { WebSession, resumeSession } = await import("../dist/web/session.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { ModelSelectScreen } = await import("../dist/screens/modelSelect.js");
const { SettingsScreen } = await import("../dist/screens/settings.js");
const { App } = await import("../dist/app.js");
const { defaultState } = await import("../dist/state.js");
const { hub } = await import("../dist/web/hub.js");
const { createSettingsUI } = await import("../web/settings.js");

const limited = {
  name: "low-high-max", url: "https://limited.invalid/v1", api_key: "secret-limited",
  supports_streaming: true, intensity: ["low", "high", "max"],
};
const reordered = {
  name: "reordered", url: "https://limited.invalid/v1", api_key: "secret-limited",
  supports_streaming: true, intensity: ["MAX", "medium", "low", "medium", "bogus"],
};
const unknownOnly = {
  name: "unknown-only", url: "https://limited.invalid/v1", api_key: "secret-limited",
  supports_streaming: true, intensity: ["bogus"],
};
const open = {
  name: "all", url: "https://open.invalid/v1", api_key: "secret-open", supports_streaming: true,
};
const models = [
  { name: "Limited", models: [limited, reordered, unknownOnly] },
  { name: "Open", models: [open] },
];

const live = new Set();
function close(agent) {
  if (agent instanceof ChatScreen) agent.onDeactivate(); else agent.dispose();
  live.delete(agent);
}

try {
  saveModels({ providers: models });

  // -- catalogue ---------------------------------------------------------
  assert.deepEqual(modelIntensities(limited), ["Low", "High", "Max"], "lowercase names normalise to canonical labels");
  assert.deepEqual(modelIntensities(reordered), ["Low", "Medium", "Max"], "order is canonical, duplicates and typos are ignored");
  assert.deepEqual(modelIntensities(unknownOnly), INTENSITY_LEVELS, "an unusable list falls back to every level");
  assert.deepEqual(modelIntensities(open), INTENSITY_LEVELS, "an absent list keeps the historical behaviour");
  assert.deepEqual(modelIntensities(null), INTENSITY_LEVELS);
  assert.equal(intensityForModel(limited, "Ultra"), "High", "unsupported preference falls back to High");
  assert.equal(intensityForModel(limited, "Ultra", "Max"), "Max", "the configured fallback wins when supported");
  assert.equal(intensityForModel(limited, "low"), "Low", "a supported preference is canonicalised, not replaced");
  assert.equal(intensityForModel(unknownOnly, "Ultra"), "Ultra", "a typo-only list allows every level");

  assert.equal(resolveModelSelection({ provider: "Limited", model: "low-high-max", intensity: "low" }).intensity, "Low");
  assert.throws(
    () => resolveModelSelection({ provider: "Limited", model: "low-high-max", intensity: "Medium" }),
    /does not support that thinking intensity/,
  );
  assert.throws(
    () => resolveModelSelection({ provider: "Limited", model: "low-high-max", intensity: "ultra" }),
    /does not support that thinking intensity/,
  );
  assert.throws(
    () => resolveModelSelection({ provider: "Limited", model: "low-high-max", intensity: "extreme" }),
    /invalid thinking intensity/,
  );
  assert.equal(resolveModelSelection({ provider: "Open", model: "all", intensity: "Ultra" }).intensity, "Ultra");

  // -- Web settings catalogue and validation ----------------------------
  saveConfig({ selected_provider: "Limited", selected_model: "low-high-max", selected_intensity: "Ultra", default_intensity: "Ultra" });
  const catalog = getWebSettings();
  assert.deepEqual(catalog.providers[0].models[0].intensities, ["Low", "High", "Max"]);
  assert.deepEqual(catalog.providers[1].models[0].intensities, INTENSITY_LEVELS);
  assert.deepEqual(catalog.intensities, INTENSITY_LEVELS, "the raw catalogue is still advertised for older clients");
  assert.equal(catalog.selection.intensity, "High", "a stale saved level is replaced by a supported one");
  assert.equal(catalog.settings.default_intensity, "High");

  const before = loadConfig();
  assert.throws(() => updateWebSettings({ settings: { default_intensity: "Ultra" } }), /does not support/);
  assert.throws(() => updateWebSettings({ selection: { provider: "Limited", model: "low-high-max", intensity: "Medium" } }), /does not support/);
  assert.deepEqual(loadConfig(), before, "a rejected level leaves the saved settings untouched");

  updateWebSettings({ selection: { provider: "Limited", model: "low-high-max", intensity: "max" } });
  assert.equal(loadConfig().selected_intensity, "Max", "a lowercase supported level is stored canonically");
  updateWebSettings({ settings: { default_intensity: "low" } });
  assert.equal(loadConfig().default_intensity, "Low");
  updateWebSettings({ selection: { provider: "Open", model: "all", intensity: "Ultra" } });
  assert.equal(getWebSettings().selection.intensity, "Ultra");

  // -- restored state and the actual request ----------------------------
  const client = new LLMClient(limited, "Limited", "Ultra");
  assert.equal(client.intensity, "High", "the request never carries a level the model rejects");
  assert.equal(client.temperature, 0.7);
  const maxClient = new LLMClient(limited, "Limited", "max");
  assert.equal(maxClient.intensity, "Max");
  assert.equal(maxClient.temperature, 1.0);

  saveSession([{ role: "user", content: "saved before the limit existed" }], "low-high-max", "Limited", "Ultra", process.cwd(), "limited-session");
  const resumed = resumeSession(loadSession("limited-session"));
  assert.equal(resumed.ok, true);
  live.add(resumed.session);
  assert.equal(resumed.session.liveMeta().intensity, "High", "a saved session is clamped on resume");
  close(resumed.session);
  const resumedExplicit = resumeSession(loadSession("limited-session"), { provider: "Limited", model: "low-high-max", intensity: "Max" });
  assert.equal(resumedExplicit.ok, true);
  live.add(resumedExplicit.session);
  assert.equal(resumedExplicit.session.liveMeta().intensity, "Max");
  close(resumedExplicit.session);

  const tuiState = {
    ...defaultState(),
    selectedProvider: "Limited",
    selectedModelName: "low-high-max",
    selectedModelUrl: limited.url,
    selectedModelApiKey: limited.api_key,
    selectedIntensity: "Ultra",
  };
  const tui = new ChatScreen();
  tui.app = { state: tuiState, render() {} };
  tui.loadedProvider = "Limited";
  tui.loadedModel = "low-high-max";
  tui.loadedIntensity = "Ultra";
  tui.onActivate();
  live.add(tui);
  assert.equal(tui.intensity, "High", "the terminal chat clamps a resumed transcript");
  assert.equal(tuiState.selectedIntensity, "High", "and the header follows the level actually in use");
  close(tui);

  saveConfig({ selected_provider: "Limited", selected_model: "low-high-max", selected_intensity: "Ultra" });
  const app = new App();
  assert.equal(app.state.selectedIntensity, "High", "startup restores a level the selected model accepts");

  // -- terminal selectors ----------------------------------------------
  let chosen = null;
  const screenHost = {
    state: { ...defaultState(), selectedProvider: "Limited", selectedModelName: "low-high-max", selectedIntensity: "High" },
    width: 80,
    height: 24,
    render() {},
    popScreen() {},
    setModelConfig(provider, model, intensity) { chosen = { provider, model, intensity }; },
  };
  const select = new ModelSelectScreen();
  select.app = screenHost;
  select.onActivate();
  select.confirm();
  select.confirm();
  assert.equal(select.level, 2);
  assert.deepEqual(select.currentList(), ["Low", "High", "Max"], "the terminal only lists supported levels");
  select.selectedIntensityIdx = 2;
  select.confirm();
  assert.equal(chosen.intensity, "Max");

  const settingsScreen = new SettingsScreen();
  settingsScreen.app = screenHost;
  settingsScreen.onActivate();
  assert.deepEqual(settingsScreen.intensityLevels, ["Low", "High", "Max"]);
  assert.equal(settingsScreen.rowTexts()[0].value, "High");
  settingsScreen.cycle("intensity", 1);
  assert.equal(settingsScreen.intensityLevels[settingsScreen.intensityIdx], "Max");

  // -- browser controls -------------------------------------------------
  class Element {
    value = ""; children = []; checked = false; disabled = false; open = false; events = new Map(); textContent = "";
    classes = new Set();
    classList = {
      toggle: name => { if (name) this.classes.add(name); },
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
  const previousDocument = globalThis.document;
  globalThis.document = {
    getElementById: id => { assert.ok(nodes.has(id), `missing control ${id}`); return nodes.get(id); },
    createElement: () => new Element(),
  };
  try {
    updateWebSettings({ selection: { provider: "Limited", model: "low-high-max", intensity: "High" } });
    const ui = createSettingsUI({
      async apiFetch() { return { ok: true, json: async () => getWebSettings() }; },
      async applyModel() {},
    });
    await ui.load();
    ui.showConversation({ provider: "Limited", model: "low-high-max", intensity: "High", busy: false }, "live:L1");
    const values = select => select.children.map(child => child.value);
    const ticks = () => nodes.get("model-intensity-ticks").children.map(child => child.textContent);
    assert.deepEqual(ticks(), ["Low", "High", "Max"]);
    assert.equal(nodes.get("model-intensity").value, "1", "the slider starts at the selected intensity");
    nodes.get("model-name").value = "reordered";
    await nodes.get("model-name").fire("change");
    await ui.flush();
    assert.deepEqual(ticks(), ["Low", "Medium", "Max"], "changing the model narrows the slider");
    assert.equal(nodes.get("model-intensity").value, "0", "an unsupported intensity falls back to a supported one");
    await nodes.get("settings-open").fire("click");
    assert.deepEqual(values(nodes.get("default-intensity")), ["Low", "High", "Max"]);
    nodes.get("default-provider").value = "Open";
    await nodes.get("default-provider").fire("change");
    assert.deepEqual(values(nodes.get("default-intensity")), INTENSITY_LEVELS);
  } finally {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }

  // Remove no-longer-relevant live registrations before the cleanup check.
  for (const agent of live) close(agent);
  assert.ok(hub.list().length === 0, "every test session unregisters from the live hub");
  assert.deepEqual(loadModels().providers[0].models[0].intensity, ["low", "high", "max"], "reading the catalogue never rewrites it");
  console.log("ok per-model intensity: catalogue, API validation, restored sessions, requests, terminal and browser controls");
} finally {
  for (const agent of live) {
    try { close(agent); } catch { /* already disposed */ }
  }
  fs.rmSync(testHome, { recursive: true, force: true });
}
