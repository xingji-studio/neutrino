import assert from "node:assert/strict";
import fs from "node:fs";
import { createProUI } from "../web/pro.js";
import { createSettingsUI } from "../web/settings.js";
import { setLanguage } from "../web/i18n.js";

class Element {
  value = ""; textContent = ""; disabled = false; checked = false; open = false;
  children = []; attributes = {}; events = new Map(); classes = new Set(); modalCount = 0;
  classList = {
    toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
    add: name => this.classes.add(name), remove: name => this.classes.delete(name),
  };
  addEventListener(name, callback) { this.events.set(name, callback); }
  setAttribute(name, value) { this.attributes[name] = value; }
  appendChild(node) { this.children.push(node); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  showModal() { this.open = true; this.modalCount++; }
  close() { this.open = false; }
  contains(node) { return node === this || this.children.includes(node); }
  async fire(name) { await this.events.get(name)?.({ preventDefault() {}, stopPropagation() {} }); }
}

const previousDocument = globalThis.document;
const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
const node = id => { assert.ok(nodes.has(id), `missing control ${id}`); return nodes.get(id); };
globalThis.document = { getElementById: node, createElement: () => new Element(), addEventListener() {} };
const roleNames = ["main_model", "thinking_model", "front_output_model", "backend_output_model", "confirm_model", "genimage_model", "plan_model", "modeling_model"];
const presets = ["cheap", "medium", "best"].map((name, index) => ({
  name, chinese_name: ["节约", "平衡", "最佳"][index],
  "model-setting": roleNames.map(type => ({ type, provider: "shared", model: type === "genimage_model" ? "null" : `${name}-${type}`, intensity: "high", context_window: 1000000 })),
}));
let catalog = {
  providers: [], selection: { provider: "", model: "", intensity: "High" }, intensities: ["High"],
  settings: { language: "en", approval_mode: "request", sound_alerts: true, web_console: true },
  pro: { presets, preset: "medium", max_recursion_depth: 10 },
};

try {
  const changed = [];
  let fail = false;
  const ui = createProUI({ changePreset: async value => { changed.push(value); if (fail) throw new Error("preset rejected"); } });
  ui.load(catalog);
  ui.show(null, "new:project");
  assert.equal(ui.preset(), "medium");
  assert.equal(node("pro-preset-models").children.length, 8, "all eight roles are visible");
  assert.equal(node("pro-preset-models").children[5].children[1].textContent, "Reserved");

  node("pro-preset-range").value = "0";
  await node("pro-preset-range").fire("input");
  assert.equal(ui.preset(), "cheap");
  assert.equal(changed.length, 0, "dragging previews without issuing requests for every input event");
  await node("pro-preset-range").fire("change");
  await ui.flush();
  assert.deepEqual(changed, ["cheap"]);

  ui.show({ busy: true, pro: { preset: "cheap", checking: true } }, "live:L1");
  assert.equal(node("pro-preset-range").disabled, true);
  await node("pro-preset-ticks").children[2].fire("click");
  await ui.flush();
  assert.deepEqual(changed, ["cheap"], "a running turn cannot change models");

  const fallback = {
    preset: "cheap", checking: false, checkId: "check-1", models: [],
    fallbacks: [{ role: "thinking_model", requested: { model: "unavailable", tier: "cheap" }, replacement: { model: "available", tier: "lower" }, reason: "HTTP 404" }],
  };
  ui.show({ busy: false, pro: fallback }, "live:L1");
  assert.equal(node("pro-fallback-dialog").open, true);
  assert.equal(node("pro-fallback-rows").children[0].children[1].textContent, "unavailable → available");
  await node("pro-fallback-close").fire("click");
  ui.show({ busy: false, pro: fallback }, "live:L1");
  assert.equal(node("pro-fallback-dialog").open, false, "SSE repaints do not reopen an acknowledged popup");
  assert.equal(node("pro-fallback-dialog").modalCount, 1);

  fail = true;
  node("pro-preset-range").value = "2";
  await node("pro-preset-range").fire("input");
  await node("pro-preset-range").fire("change");
  await assert.rejects(ui.flush(), /preset rejected/);
  assert.equal(ui.preset(), "cheap", "a rejected selection rolls back to the committed preset");
  assert.equal(node("pro-preset-feedback").textContent, "preset rejected");

  ui.show({ busy: false, pro: { ...fallback, checkId: "check-2", fallbacks: [{ ...fallback.fallbacks[0], replacement: null }], error: "No usable reasoning model" } }, "live:L1");
  assert.match(node("pro-fallback-rows").children[0].children[1].textContent, /No available model/);
  assert.equal(node("pro-fallback-error").textContent, "No usable reasoning model");
  assert.equal(node("pro-fallback-dialog").modalCount, 2);
  setLanguage("zh"); ui.refresh();
  assert.match(node("pro-preset-label").textContent, /节约/);

  const saves = [];
  const settings = createSettingsUI({
    proMode: true, applyModel() {},
    async apiFetch(_url, init) {
      if (init.method === "POST") {
        const body = JSON.parse(init.body); saves.push(body);
        catalog = { ...catalog, pro: { ...catalog.pro, preset: body.settings.pro_preset, max_recursion_depth: body.settings.pro_max_recursion_depth } };
      }
      return { ok: true, json: async () => catalog };
    },
  });
  await settings.load();
  settings.showConversation({ busy: false }, "live:L1");
  assert.ok(node("model-picker").classes.has("hidden"), "Pro does not offer a misleading single model selector");
  await node("settings-open").fire("click");
  assert.equal(node("settings-context").disabled, true);
  assert.equal(node("settings-pro-depth").value, "10");
  node("settings-pro-preset").value = "best";
  node("settings-pro-depth").value = "12";
  await node("settings-form").fire("submit");
  assert.equal(saves[0].settings.pro_preset, "best");
  assert.equal(saves[0].settings.pro_max_recursion_depth, 12);
  for (const key of ["default_intensity", "approval_model", "plan_first", "model_context_window"]) assert.ok(!(key in saves[0].settings));
  assert.ok(!("selection" in saves[0]));
  console.log("ok Pro UI: role presets, slider commit, busy guard, rejection rollback, fallback notices, localization and orchestration settings");
} finally {
  setLanguage("en");
  if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
}
