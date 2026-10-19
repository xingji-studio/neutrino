// Exercise the actual browser login handlers without a browser or storage access.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class Element {
  events = new Map();
  children = [];
  value = "";
  textContent = "";
  disabled = false;
  open = false;
  classList = { toggle() {} };
  addEventListener(name, callback) { this.events.set(name, callback); }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  focus() { this.focused = true; }
  select() { this.selected = true; }
  showModal() { this.open = true; this.modal = true; }
  close() { this.open = false; }
  async fire(name) {
    let prevented = false;
    await this.events.get(name)?.({ preventDefault() { prevented = true; } });
    return prevented;
  }
}
const parts = Object.fromEntries(["form", "input", "button", ".form-feedback"].map(name => [name, new Element()]));
const gate = new Element();
gate.querySelector = selector => parts[selector];
const settingsDialog = new Element();
settingsDialog.open = true;
const body = new Element();
let reloads = 0;
let requests = [];
let success = false;
let closedStreams = 0;
const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const access = source.slice(source.indexOf("// Login is remembered"), source.indexOf("const el = {"));
const context = vm.createContext({
  URLSearchParams,
  location: { search: "?t=old-secret&view=history", pathname: "/", hash: "", reload() { reloads++; } },
  history: { replaceState(_state, _title, url) { assert.equal(url, "/?view=history"); } },
  localStorage: { removeItem() { throw new Error("storage blocked"); } },
  document: { body, createElement: () => gate, getElementById: () => settingsDialog },
  closeStream() { closedStreams++; },
  setStatus() {},
  async fetch(url, init) {
    requests.push({ url, ...init });
    return { ok: success, status: success ? 200 : 401, json: async () => ({ error: "Incorrect password." }) };
  },
});
vm.runInContext(access, context);
await assert.rejects(context.apiFetch("/api/overview"), /Password login required/);
assert.equal(gate.modal, true, "login uses the top layer so the app cannot cover it");
assert.equal(settingsDialog.open, false);
assert.equal(closedStreams, 1);
context.showGate();
assert.equal(body.children.length, 1, "polls cannot duplicate or reset password input");
assert.equal(await gate.fire("cancel"), true, "Escape cannot expose the locked app");
parts.input.value = " exact password ";
await parts.form.fire("submit");
assert.equal(parts[".form-feedback"].textContent, "Incorrect password.");
assert.equal(parts.button.disabled, false);
assert.equal(reloads, 0, "wrong password remains on login form");
success = true;
await parts.form.fire("submit");
assert.equal(reloads, 1, "login succeeds even when localStorage is blocked");
assert.equal(requests.at(-1).url, "/api/auth/login");
assert.equal(requests.at(-1).credentials, "same-origin");
assert.deepEqual(JSON.parse(requests.at(-1).body), { password: " exact password " });
assert.ok(!source.includes("withToken("), "SSE credentials never enter the URL");

// URL login must finish before any protected request, including when it is slow.
async function checkUrlLogin(password, outcome) {
  const nodes = Object.fromEntries(["form", "input", "button", ".form-feedback"].map(name => [name, new Element()]));
  const dialog = new Element();
  dialog.querySelector = selector => nodes[selector];
  const page = new Element();
  const calls = [];
  let cleanUrl;
  let release;
  let reloadCount = 0;
  let result = outcome;
  const pending = new Promise(resolve => { release = resolve; });
  const ctx = vm.createContext({
    URLSearchParams,
    location: { search: `?pwd=${encodeURIComponent(password)}&view=history&t=legacy`, pathname: "/", hash: "#conversation", reload() { reloadCount++; } },
    history: { replaceState(_state, _title, url) { cleanUrl = url; } },
    localStorage: { removeItem() {} },
    document: { body: page, createElement: () => dialog, getElementById: () => new Element() },
    closeStream() {}, setStatus() {},
    async fetch(url, init) {
      calls.push({ url, ...init });
      if (url === "/api/auth/login") {
        await pending;
        if (result === "network") throw new Error("Network unavailable.");
        return { ok: result === "ok", json: async () => ({ error: "Incorrect password." }) };
      }
      return { status: 200 };
    },
  });
  vm.runInContext(access, ctx);
  assert.equal(cleanUrl, "/?view=history#conversation", "remove password before sending login while retaining navigation");
  assert.deepEqual(JSON.parse(calls[0].body), { password }, "URL encoding preserves the exact password");
  assert.equal(calls[0].url, "/api/auth/login");
  assert.equal(calls[0].credentials, "same-origin");
  const request = ctx.apiFetch("/api/overview");
  await Promise.resolve();
  assert.equal(calls.length, 1, "protected requests wait for the login response");
  assert.equal(page.children.length, 0, "slow login does not flash the password dialog");
  release();
  if (outcome === "ok") {
    assert.equal((await request).status, 200);
    assert.equal(calls[1].url, "/api/overview");
    assert.equal(calls[1].credentials, "same-origin");
    assert.equal(page.children.length, 0, "correct URL password directly opens the app");
    assert.equal(reloadCount, 0, "automatic login needs no reload");
  } else {
    await assert.rejects(request, /Password login required/);
    assert.equal(calls.length, 1, "failed automatic login cannot reach conversation APIs");
    assert.equal(dialog.modal, true);
    assert.equal(nodes[".form-feedback"].textContent, outcome === "network" ? "Network unavailable." : "Incorrect password.");
    result = "ok";
    nodes.input.value = "corrected-password";
    await nodes.form.fire("submit");
    assert.deepEqual(JSON.parse(calls.at(-1).body), { password: "corrected-password" });
    assert.equal(reloadCount, 1, "manual login still works after failed URL login");
  }
}
await checkUrlLogin("114514", "ok");
await checkUrlLogin(" a+b&密码 ", "ok");
await checkUrlLogin("wrong-password", "wrong");
await checkUrlLogin("", "wrong");
await checkUrlLogin("114514", "network");

// Exercise password confirmation and successful Settings saves.
const elements = new Map();
const getElement = id => {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
};
globalThis.document = { getElementById: getElement, createElement: () => new Element() };
try {
  const { createSettingsUI } = await import("../web/settings.js");
  const config = {
    providers: [], intensities: ["High"], compressThresholds: [{ value: 32000, label: "32K" }],
    selection: { provider: "", model: "", intensity: "High" },
    settings: { context_compress_threshold: 32000, approval_model: "", auto_approve_extreme_risk: false },
  };
  const saves = [];
  createSettingsUI({
    applyModel() {},
    async apiFetch(_route, init) {
      if (init.body) saves.push(JSON.parse(init.body));
      return { ok: true, json: async () => config };
    },
  });
  await getElement("settings-open").fire("click");
  getElement("settings-password").value = "new-password";
  getElement("settings-password-confirm").value = "mismatch";
  await getElement("settings-form").fire("submit");
  assert.equal(saves.length, 0, "confirmation mismatch cannot change the password");
  getElement("settings-password-confirm").value = "new-password";
  await getElement("settings-form").fire("submit");
  assert.equal(saves[0].settings.web_password, "new-password");
  assert.equal(getElement("settings-password").value, "");
  assert.equal(getElement("settings-password-confirm").value, "");
  await getElement("settings-form").fire("submit");
  assert.equal(saves[1].settings.web_password, undefined, "blank fields preserve the existing password");
} finally { delete globalThis.document; }
console.log("WEB PASSWORD UI TESTS PASSED");
