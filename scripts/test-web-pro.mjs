// Pro mode is a second, isolated workspace served from /pro. These tests drive
// it over real HTTP: page routing, transcript isolation, live-session
// isolation, and the settings that are (and are not) shared with the regular
// workspace.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-web-pro-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.NEUTRINO_PLAN = "off";

const {
  CONFIG_FILE, PRO_CONFIG_FILE, PRO_SESSION_DIR, SESSION_DIR, contextCompressionThreshold,
  loadConfig, loadModels, saveModels, saveSession,
} = await import("../dist/config.js");
const { PRO_CUSTOM_MODEL_FILE } = await import("../dist/pro/config.js");
const { seedProPresets } = await import("./pro-presets.mjs");
// Nothing ships with the package: this home writes the presets the page offers.
seedProPresets(["cheap", "medium", "best"]);
// The presets this user keeps for themselves: they are not part of the graded set.
seedProPresets(["custom", "mine"], PRO_CUSTOM_MODEL_FILE);
const { startWebServer } = await import("../dist/web/server.js");
const { proModeUrl } = await import("../dist/browser.js");
const { PRO_MODE_LABEL, WEB_MODE_LABEL, proModeButton, webModeButton } = await import("../dist/ui.js");

// --- CLI entry point -------------------------------------------------------
assert.equal(PRO_MODE_LABEL, "启用Pro模式");
assert.equal(proModeUrl("http://127.0.0.1:8765/"), "http://127.0.0.1:8765/pro");
assert.equal(proModeUrl("http://127.0.0.1:8765"), "http://127.0.0.1:8765/pro");
assert.equal(proModeUrl("http://127.0.0.1:8765/pro/"), "http://127.0.0.1:8765/pro",
  "a /pro URL is not doubled");
const button = proModeButton(80, 24);
assert.ok(button, "the Pro button fits a standard terminal");
assert.deepEqual(
  { x: button.x, y: button.y, h: button.h, w: button.w },
  { x: 1, y: 1, h: 3, w: 15 },
  "the box sits one blank column from the edge, directly below the status bar",
);
assert.equal(proModeButton(80, 20), null, "short terminals keep their original layout");
assert.equal(proModeButton(16, 24), null, "the box is hidden when it cannot fit horizontally");

// The Web entry point is glued to the Pro box, on the same rows.
assert.equal(WEB_MODE_LABEL, "打开Web端");
const webButton = webModeButton(80, 24);
assert.ok(webButton, "the Web button fits a standard terminal");
assert.deepEqual(
  { x: webButton.x, y: webButton.y, h: webButton.h, w: webButton.w },
  { x: button.x + button.w, y: button.y, h: button.h, w: 13 },
  "the Web box starts where the Pro box ends, so the two are flush",
);
assert.equal(webModeButton(80, 20), null, "short terminals hide the Web box with the Pro box");
assert.equal(webModeButton(31, 24), null, "the Web box is hidden when the row cannot fit");
assert.ok(proModeButton(31, 24), "the Pro box stays on a terminal the Web box does not fit in");

assert.ok(CONFIG_FILE.startsWith(testHome + path.sep));
assert.ok(PRO_CONFIG_FILE.startsWith(path.join(testHome, ".neutrino", "pro")));
assert.ok(PRO_SESSION_DIR.startsWith(path.join(testHome, ".neutrino", "pro")));

const provider = "ProTest";
const modelName = "shared-model";
saveModels({
  providers: [{
    name: provider,
    models: [{
      name: modelName,
      url: "https://pro.invalid/v1",
      api_key: "pro-secret-key",
      supports_streaming: true,
      context_window: 100_000,
    }],
  }],
});

let server;
async function request(route, { body, method, headers = {} } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* HTML or empty */ }
  return { status: response.status, headers: response.headers, text, data, response };
}
const sessionIds = (overview) =>
  (overview?.groups ?? []).flatMap((group) => group.sessions.map((session) => session.id));

try {
  server = await startWebServer({ port: 0, auth: false });

  // --- page and asset routing ----------------------------------------------
  {
    const page = await request("/pro");
    assert.equal(page.status, 200, "the Pro page is served");
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.text, /<title>Neutrino<\/title>/, "the same SPA shell is used");
    const redirect = await fetch(`${server.url}/pro/`, { redirect: "manual" });
    assert.equal(redirect.status, 308, "a trailing slash redirects");
    assert.equal(redirect.headers.get("location"), "/pro");
    const gif = await request("/neutrino-pro.gif");
    assert.equal(gif.status, 200, "the switch animation is public");
    assert.match(gif.headers.get("content-type") ?? "", /image\/gif/);
    const logo = await request("/neutrino.png");
    assert.equal(logo.status, 200, "the Pro workspace logo is public");
    assert.match(logo.headers.get("content-type") ?? "", /image\/png/);
    assert.ok(fs.existsSync(new URL("../web/neutrino.png", import.meta.url)), "the logo asset exists where requested");
    assert.equal((await request("/pro/app.js")).status, 404, "only the page and API live under /pro");
  }

  // --- conversations are isolated ------------------------------------------
  const cwd = process.cwd();
  const standardCreated = await request("/api/conversations", {
    body: { cwd, selection: { provider, model: modelName, intensity: "High" } },
  });
  assert.equal(standardCreated.status, 200);
  const standardKey = standardCreated.data.key;
  const proCreated = await request("/pro/api/conversations", {
    body: { cwd, selection: { provider, model: modelName, intensity: "High" } },
  });
  assert.equal(proCreated.status, 200);
  const proKey = proCreated.data.key;
  assert.notEqual(standardKey, proKey);

  const standardOverview = await request("/api/overview");
  const proOverview = await request("/pro/api/overview");
  assert.deepEqual(standardOverview.data.live.map((entry) => entry.key), [standardKey]);
  assert.deepEqual(proOverview.data.live.map((entry) => entry.key), [proKey]);

  // A Pro tab cannot reach the regular workspace's live key, and vice versa.
  assert.equal((await request(`/pro/api/live/${standardKey}`)).status, 404, "pro cannot see standard live");
  assert.equal((await request(`/api/live/${proKey}`)).status, 404, "standard cannot see pro live");
  assert.equal((await request(`/pro/api/live/${standardKey}/stream`)).status, 404);
  assert.equal((await request(`/api/live/${proKey}/stream`)).status, 404);
  assert.equal((await request(`/pro/api/live/${standardKey}/message`, { body: { text: "hi" } })).status, 404);
  assert.equal((await request(`/pro/api/live/${standardKey}/close`, { method: "POST" })).status, 404);

  // Saved transcripts are filed per workspace.
  saveSession([{ role: "user", content: "standard only" }], modelName, provider, "High", cwd, "standard-only");
  saveSession([{ role: "user", content: "pro only" }], modelName, provider, "High", cwd, "pro-only", undefined, null, undefined, null, "pro");
  assert.ok(fs.existsSync(path.join(SESSION_DIR, "standard-only.json")));
  assert.ok(fs.existsSync(path.join(PRO_SESSION_DIR, "pro-only.json")));
  assert.ok(!fs.existsSync(path.join(PRO_SESSION_DIR, "standard-only.json")));
  assert.ok(!fs.existsSync(path.join(SESSION_DIR, "pro-only.json")));

  assert.equal((await request("/api/session/standard-only")).status, 200);
  assert.equal((await request("/pro/api/session/standard-only")).status, 404, "pro cannot read standard history");
  assert.equal((await request("/pro/api/session/pro-only")).status, 200);
  assert.equal((await request("/api/session/pro-only")).status, 404, "standard cannot read pro history");
  assert.equal((await request(`/pro/api/session/standard-only/continue`, { method: "POST" })).status, 404);
  assert.equal((await request(`/api/session/pro-only/continue`, { method: "POST" })).status, 404);

  const standardOverviewWithFiles = await request("/api/overview");
  const proOverviewWithFiles = await request("/pro/api/overview");
  const standardIds = sessionIds(standardOverviewWithFiles.data);
  const proIds = sessionIds(proOverviewWithFiles.data);
  assert.ok(standardIds.includes("standard-only"));
  assert.ok(!standardIds.includes("pro-only"), "pro history is hidden from the standard sidebar");
  assert.ok(proIds.includes("pro-only"));
  assert.ok(!proIds.includes("standard-only"), "standard history is hidden from the pro sidebar");
  assert.deepEqual((await request("/api/sessions")).data.sessions.map((s) => s.id), ["standard-only"]);
  assert.deepEqual((await request("/pro/api/sessions")).data.sessions.map((s) => s.id), ["pro-only"]);
  assert.equal((await request("/api/session/pro-only/delete", { method: "POST" })).status, 404);
  assert.equal((await request("/pro/api/session/standard-only/delete", { method: "POST" })).status, 404);

  // --- settings are isolated, except credentials and approval policy -------
  const before = (await request("/api/settings")).data;
  const proBefore = (await request("/pro/api/settings")).data;
  assert.equal(before.selection.provider, provider);
  assert.equal(proBefore.selection.provider, provider);
  assert.ok(!proBefore.providers.some((p) => p.models.some((m) => m.name === "pro-secret")));
  assert.deepEqual(proBefore.pro.presets.map((preset) => preset.name), ["custom", "mine", "cheap", "medium", "best"],
    "the slider starts with the user's own presets instead of ending on them");

  // A standard context-capacity edit must not move Pro's compression threshold;
  // Pro starts from its own documented default until it saves its own value.
  await request("/api/settings", {
    body: { settings: { model_context_window: 64_000 } },
  });
  assert.equal(loadModels().providers[0].models[0].context_window, 64_000);
  assert.equal((await request("/pro/api/settings")).data.settings.model_context_window, 1_000_000,
    "the pro capacity does not inherit the standard edit");

  const proUpdate = await request("/pro/api/settings", {
    body: {
      selection: { provider, model: modelName, intensity: "Ultra" },
      settings: {
        language: "zh",
        plan_first: false,
        approval_model: modelName,
        sound_alerts: false,
        model_context_window: 123_456,
        approval_mode: "auto",
        auto_approve_extreme_risk: true,
        web_password: "pro password 密码",
      },
    },
  });
  assert.equal(proUpdate.status, 200, "pro settings save");
  assert.equal(proUpdate.data.selection.intensity, "Ultra");
  assert.equal(proUpdate.data.settings.language, "zh");
  assert.equal(proUpdate.data.settings.plan_first, false);
  assert.equal(proUpdate.data.settings.approval_model, modelName);
  assert.equal(proUpdate.data.settings.sound_alerts, false);
  assert.equal(proUpdate.data.settings.model_context_window, 123_456);

  const standardAfter = (await request("/api/settings")).data;
  const proAfter = (await request("/pro/api/settings")).data;
  assert.equal(proAfter.settings.model_context_window, 123_456);
  assert.equal(proAfter.settings.language, "zh");
  // Isolated: defaults/models/plan/language/reviewer/context/sound.
  assert.equal(standardAfter.selection.intensity, "High", "pro model selection is not shared");
  assert.equal(standardAfter.settings.language, "en", "pro language is not shared");
  assert.equal(standardAfter.settings.plan_first, true, "pro plan setting is not shared");
  assert.equal(standardAfter.settings.approval_model, "", "pro reviewer model is not shared");
  assert.equal(standardAfter.settings.sound_alerts, true, "pro sound preference is not shared");
  assert.equal(standardAfter.settings.model_context_window, 64_000, "the standard capacity is untouched by pro");
  // Shared: password and the approval policy.
  assert.equal(standardAfter.settings.approval_mode, "auto");
  assert.equal(standardAfter.settings.auto_approve_extreme_risk, true);
  assert.match(loadConfig().web_password_hash, /^scrypt:/);
  const standardConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  const proConfig = JSON.parse(fs.readFileSync(PRO_CONFIG_FILE, "utf-8"));
  assert.equal(standardConfig.web_password_hash, loadConfig("pro").web_password_hash, "password hash is shared");
  assert.equal(proConfig.web_password_hash, undefined, "the password hash is never copied into the pro config");
  assert.equal(proConfig.approval_mode, undefined, "the shared approval mode stays out of the pro config");
  assert.equal(standardConfig.approval_mode, "auto");

  // Standard edits write the shared model catalog; Pro keeps its own override.
  assert.equal(loadModels().providers[0].models[0].context_window, 64_000);
  assert.equal((await request("/pro/api/settings")).data.settings.model_context_window, 123_456,
    "a standard context edit does not overwrite the pro override");
  const sharedModel = loadModels().providers[0].models[0];
  assert.equal(contextCompressionThreshold(provider, sharedModel, "standard"), 51_200);
  assert.equal(contextCompressionThreshold(provider, sharedModel, "pro"), 98_764);

  // --- workspace recents are per workspace --------------------------------
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-pro-folder-"));
  try {
    const recorded = await request("/api/workspaces", { body: { path: extra } });
    assert.equal(recorded.status, 200);
    const proWorkspaces = (await request("/pro/api/workspaces")).data.workspaces.map((entry) => entry.path);
    assert.ok(!proWorkspaces.some((entry) => path.resolve(entry) === path.resolve(extra)),
      "a standard-only recent folder is not listed in pro");
    const standardWorkspaces = (await request("/api/workspaces")).data.workspaces.map((entry) => entry.path);
    assert.ok(standardWorkspaces.some((entry) => path.resolve(entry) === path.resolve(extra)));
  } finally {
    fs.rmSync(extra, { recursive: true, force: true });
  }

  // --- static HTML carries the Pro workspace affordances ------------------
  {
    const html = (await request("/pro")).text;
    assert.match(html, /id="brand-logo"/, "the brand badge is a control");
    assert.match(html, /pro-tip/, "the dismissible Pro hint exists");
    // The corner reminder is page chrome, so both workspaces must be served it
    // along with the stylesheet that places it.
    assert.match(html, /id="update-badge"/, "the Pro workspace is served the update reminder");
    assert.match((await request("/")).text, /id="update-badge"/,
      "the regular console is served the same reminder");
    // The mobile override repeats the selector, so match the rule that really
    // pins it to the corner instead of any occurrence of the class name.
    assert.match((await request("/style.css")).text, /\.update-badge \{[^}]*position: fixed/,
      "the stylesheet that pins the reminder to the corner is served too");
    assert.match(html, /id="pro-exit"/, "the way back to the regular workspace exists");
    const index = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
    assert.match(index, /data-i18n="Click the badge to switch to Pro mode"/);
    assert.match(index, /data-i18n="Exit Pro mode"/);
    assert.equal(index.includes('data-i18n="Exit Pro mode">Exit Pro mode</span>'), true);
    assert.match(index, /id="brand-name">Neutrino</, "the regular brand name stays Neutrino");
    const browserSource = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
    assert.match(browserSource, /el\.brandName\.textContent = "Neutrino Pro"/,
      "the Pro brand renames itself to Neutrino Pro");
  }

  // --- the client routes API calls to the active workspace ----------------
  {
    const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
    const start = source.indexOf("// Login is remembered");
    const end = source.indexOf("const el = {");
    assert.ok(start >= 0 && end > start, "the browser access layer is findable");
    const access = source.slice(start, end);
    const sandbox = (pathname) => {
      const requests = [];
      const context = vm.createContext({
        URLSearchParams,
        location: { search: "", pathname, hash: "" },
        history: { replaceState() {} },
        localStorage: { removeItem() {} },
        document: { body: null, getElementById: () => ({ close() {} }), createElement: () => ({}) },
        closeStream() {},
        setStatus() {},
        async fetch(url) {
          requests.push(url);
          return { ok: true, status: 200, json: async () => ({}) };
        },
      });
      vm.runInContext(access, context);
      return { context, requests };
    };
    const pro = sandbox("/pro");
    await pro.context.apiFetch("/api/overview");
    await pro.context.apiFetch("/api/conversations");
    assert.deepEqual(pro.requests, ["/pro/api/overview", "/pro/api/conversations"],
      "pro requests use the isolated prefix");
    await pro.context.loginWithPassword("pw");
    assert.equal(pro.requests.at(-1), "/api/auth/login", "login stays shared and unprefixed");
    const standard = sandbox("/");
    await standard.context.apiFetch("/api/overview");
    assert.deepEqual(standard.requests, ["/api/overview"], "the regular page keeps its API");
  }

  // --- bfcache restores never revive the switch curtain --------------------
  {
    const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
    const start = source.indexOf("function removeProCurtains");
    const end = source.indexOf("/** Consume a just-recorded switch");
    assert.ok(start >= 0 && end > start, "the bfcache cleanup is findable");
    const handlers = {};
    const classes = [];
    let recordsCleared = 0;
    const curtain = { removed: false, remove() { this.removed = true; } };
    const context = vm.createContext({
      PRO_TRANSITION_KEY: "neutrino.pro.transition",
      proTransitionStarted: true,
      el: { modePicker: null },
      document: {
        querySelectorAll(selector) {
          assert.equal(selector, ".pro-curtain");
          return [curtain];
        },
        documentElement: { classList: { remove: (name) => classes.push(name) } },
      },
      window: { addEventListener: (name, handler) => { handlers[name] = handler; } },
      sessionStorage: {
        removeItem(key) {
          assert.equal(key, "neutrino.pro.transition");
          recordsCleared += 1;
        },
      },
    });
    vm.runInContext(`${source.slice(start, end)}\nwatchProNavigation();`, context);
    assert.equal(typeof handlers.pagehide, "function", "pagehide is observed");
    assert.equal(typeof handlers.pageshow, "function", "pageshow is observed");

    handlers.pagehide({ persisted: true });
    assert.equal(curtain.removed, true, "a page entering bfcache drops its curtain");
    assert.ok(classes.includes("pro-transitioning"), "the pre-paint cover is dropped too");
    assert.equal(recordsCleared, 0, "pagehide keeps the record for the loading /pro page");
    assert.equal(context.proTransitionStarted, false, "an interrupted switch can be started again");

    handlers.pageshow({ persisted: false });
    assert.equal(recordsCleared, 0, "a normal initial pageshow is ignored");
    curtain.removed = false;
    classes.length = 0;
    handlers.pageshow({ persisted: true });
    assert.equal(recordsCleared, 1, "a bfcache restore clears the stale record");
    assert.equal(curtain.removed, true, "a restored page drops its stale curtain");
    assert.ok(classes.includes("pro-transitioning"), "a restored page drops the pre-paint cover");
  }

  await server.close();

  // --- the login gate and password are shared with the regular console ----
  server = await startWebServer({ port: 0 });
  const base = server.url;
  // Drain every response before closing the server. An unread HTML body can
  // otherwise keep Node 18's HTTP connection alive as the page grows.
  const consumed = async (pending) => {
    const response = await pending;
    await response.arrayBuffer();
    return response;
  };
  const loginRoute = (password) => consumed(fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  }));
  const withCookie = (route, cookie) => consumed(fetch(base + route, { headers: { Cookie: cookie } }));
  assert.equal((await consumed(fetch(`${base}/pro`))).status, 200, "the pro page stays public like /");
  assert.equal((await consumed(fetch(`${base}/pro/api/overview`))).status, 401, "the pro API needs the shared login");
  const signedIn = await loginRoute("pro password 密码");
  assert.equal(signedIn.status, 200, "the password saved from pro settings signs in");
  const cookie = signedIn.headers.get("set-cookie").split(";")[0];
  assert.equal((await withCookie("/pro/api/overview", cookie)).status, 200);
  assert.equal((await withCookie("/api/overview", cookie)).status, 200, "one cookie opens both workspaces");

  // Changing the password in the Pro workspace changes it for the standard one.
  const changed = await consumed(fetch(`${base}/pro/api/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ settings: { web_password: "shared password 密码" } }),
  }));
  assert.equal(changed.status, 200);
  assert.equal((await withCookie("/api/overview", cookie)).status, 401, "the old cookie is signed out");
  const replacement = changed.headers.get("set-cookie").split(";")[0];
  assert.equal((await withCookie("/api/overview", replacement)).status, 200);
  assert.equal((await loginRoute("pro password 密码")).status, 401);
  assert.equal((await loginRoute("shared password 密码")).status, 200);

  await server.close();
  server = null;
  console.log("ok web pro: page routing, transcript/live/settings isolation, shared credentials/policy and clean Back/Forward restores");
} finally {
  if (server) await server.close();
  fs.rmSync(testHome, { recursive: true, force: true });
}
