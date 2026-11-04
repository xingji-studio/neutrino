// Background residency: the shared setting, the one-time console invitation,
// the tray/manager lifecycle and the terminal Settings row.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-background-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
// The test starts the real detached service; never put an icon in the tray.
process.env.NEUTRINO_NO_TRAY = "1";

const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import("../dist/config.js");
const { getWebSettings, updateWebSettings } = await import("../dist/web/settings.js");
const { startWebServer } = await import("../dist/web/server.js");
const {
  BACKGROUND_LOG_FILE, readBackgroundStatus, runningBackground, startBackgroundService, stopBackgroundService,
} = await import("../dist/background.js");
const { SettingsScreen } = await import("../dist/screens/settings.js");
const { defaultState } = await import("../dist/state.js");
const { setLanguage, t } = await import("../web/i18n.js");

let serviceStarted = false;
let server = null;

async function request(base, route, { method, body, headers = {} } = {}) {
  const response = await fetch(base + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: JSON.parse(text) };
}

try {
  // ---- shared, off-by-default configuration --------------------------------
  assert.equal(DEFAULT_CONFIG.background, false, "background residency is off by default");
  assert.equal(loadConfig().background, false, "a fresh config starts with it off");
  assert.equal(getWebSettings().settings.background, false);
  assert.equal(getWebSettings("pro").settings.background, false, "Pro reads the shared value");

  updateWebSettings({ settings: { background: true } });
  assert.equal(loadConfig().background, true, "the browser setting is saved");
  assert.equal(getWebSettings("pro").settings.background, true, "the regular and Pro workspaces share it");
  assert.throws(() => updateWebSettings({ settings: { background: "true" } }), /background residency must be a boolean/);
  assert.equal(loadConfig().background, true, "a rejected value leaves the saved setting alone");
  updateWebSettings({ settings: { background: false } });

  // Saving from the Pro workspace writes the shared key back to the main file.
  saveConfig({ ...loadConfig("pro"), background: true }, "pro");
  assert.equal(loadConfig().background, true, "a Pro save writes the shared background key");
  saveConfig({ ...loadConfig(), background: false });

  // ---- the one-time invitation offered by a terminal-run console -----------
  server = await startWebServer({ port: 0, auth: false, backgroundPrompt: true });
  let payload = await request(server.url, "/api/settings");
  assert.equal(payload.status, 200);
  assert.equal(payload.data.settings.background, false);
  assert.equal(payload.data.settings.background_prompt, true, "the first browser is offered background residency");
  assert.equal(payload.data.settings.background_running, false, "nothing is running in the background yet");

  const dismissed = await request(server.url, "/api/background/dismiss", { method: "POST" });
  assert.equal(dismissed.status, 200);
  payload = await request(server.url, "/api/settings");
  assert.equal(payload.data.settings.background_prompt, false, "dismissing consumes the invitation for this run");

  const enabled = await request(server.url, "/api/settings", { body: { settings: { background: true } } });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.settings.background, true);
  assert.equal(enabled.data.settings.background_prompt, false, "enabling answers the invitation");
  const pro = await request(server.url, "/pro/api/settings");
  assert.equal(pro.data.settings.background, true, "Pro reports the same process-wide setting");
  const proOff = await request(server.url, "/pro/api/settings", { body: { settings: { background: false } } });
  assert.equal(proOff.status, 200);
  assert.equal(loadConfig().background, false, "saving from Pro updates the shared config");
  assert.equal(getWebSettings().settings.background, false, "the regular workspace sees the Pro change");
  await server.close();
  server = null;

  // A new CLI run resets the invitation (the setting is off again).
  saveConfig({ ...loadConfig(), background: false });
  server = await startWebServer({ port: 0, auth: false, backgroundPrompt: true });
  payload = await request(server.url, "/api/settings");
  assert.equal(payload.data.settings.background_prompt, true, "each CLI run offers it once");
  // A standalone `neutrino web` run passes backgroundPrompt: false.
  await server.close();
  server = await startWebServer({ port: 0, auth: false });
  payload = await request(server.url, "/api/settings");
  assert.equal(payload.data.settings.background_prompt, false, "a headless server does not nag");
  await server.close();
  server = null;

  // ---- management endpoints of the detached service -----------------------
  let stopRequested = false;
  const token = "0123456789abcdef0123456789abcdef";
  server = await startWebServer({
    port: 0,
    auth: false,
    backgroundService: { token, onStop: () => { stopRequested = true; } },
  });
  assert.equal((await request(server.url, "/api/background/ping")).status, 401, "the token is required");
  assert.equal((await request(server.url, "/api/background/ping", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  const ping = await request(server.url, "/api/background/ping", { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(ping.status, 200);
  assert.equal(ping.data.pid, process.pid);
  const stop = await request(server.url, "/api/background/stop", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  assert.equal(stop.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopRequested, true, "the token endpoint asks the service to shut down");
  await server.close();
  server = null;

  // A terminal-run console has no management token at all.
  server = await startWebServer({ port: 0, auth: false });
  assert.equal((await request(server.url, "/api/background/ping", { headers: { Authorization: `Bearer ${token}` } })).status, 404);
  await server.close();
  server = null;

  // ---- real detached lifecycle --------------------------------------------
  const started = await startBackgroundService({ port: 0, host: "127.0.0.1", auth: false, tray: false });
  assert.equal(started.ok, true, started.ok ? "" : started.error);
  if (!started.ok) throw new Error(started.error);
  serviceStarted = true;
  assert.equal(started.started, true);
  assert.equal(started.status.auth_required, false, "the saved status remembers whether a password is needed");
  assert.ok(readBackgroundStatus(), "the child records its pid and address");
  assert.equal(runningBackground()?.pid, started.status.pid);
  assert.match(started.status.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const livePing = await request(started.status.url, "/api/background/ping", {
    headers: { Authorization: `Bearer ${started.status.token}` },
  });
  assert.equal(livePing.status, 200, "the detached service answers its management endpoint");
  const health = await fetch(`${started.status.url}/api/settings`);
  assert.equal(health.status, 200, "password login can be disabled for a local service");
  const reused = await startBackgroundService({ port: 0, host: "127.0.0.1", auth: false, tray: false });
  assert.equal(reused.ok, true);
  if (reused.ok) {
    assert.equal(reused.started, false, "starting twice reuses the running service");
    assert.equal(reused.status.pid, started.status.pid);
  }
  const stopped = await stopBackgroundService();
  assert.deepEqual(stopped, { ok: true, stopped: true });
  serviceStarted = false;
  assert.equal(runningBackground(), null, "the status file disappears with the process");
  assert.equal(readBackgroundStatus(), null);

  // ---- terminal Settings row ----------------------------------------------
  saveConfig({ ...loadConfig(), background: false });
  const app = {
    state: defaultState(),
    width: 80,
    height: 24,
    render() {},
    popScreen() {},
    async setWebConsole() { return { ok: true }; },
  };
  const screen = new SettingsScreen("settings");
  screen.app = app;
  screen.onActivate();
  const row = () => screen.rowTexts().find((entry) => entry.label === "Background residency");
  assert.equal(row().value, "Off");
  screen.cycle("background", 1);
  assert.equal(loadConfig().background, true, "the terminal switch persists the shared setting");
  assert.equal(row().value, "On (next CLI launch)");
  screen.cycle("background", -1);
  assert.equal(loadConfig().background, false);

  // ---- browser surface ----------------------------------------------------
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  for (const id of ["settings-background", "background-dialog", "background-enable", "background-cancel", "background-feedback"]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing browser control ${id}`);
  }
  assert.ok(html.indexOf('id="background-dialog"') > html.indexOf('id="settings-dialog"'), "the invitation is its own dialog");
  const css = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.background-mark\s*\{/, "the invitation uses the orbit badge");
  // The normal console's top-left vector badge, not the Pro wordmark.
  assert.match(html, /id="background-dialog"[\s\S]*?<ellipse cx="12" cy="12"/, "the invitation carries the orbit mark");

  setLanguage("zh");
  assert.equal(t("Enable background residency to avoid accidentally interrupting tasks"), "建议开启后台常驻，避免误触中断任务");
  assert.equal(t("Enable"), "开启");
  assert.equal(t("Cancel"), "取消");
  assert.equal(t("Background residency"), "后台常驻");
  setLanguage("en");

  const icon = fs.readFileSync(new URL("../assets/neutrino.ico", import.meta.url));
  assert.deepEqual([...icon.subarray(0, 4)], [0, 0, 1, 0], "the tray icon is a real ICO file");
  assert.ok(fs.existsSync(BACKGROUND_LOG_FILE), "the service writes a diagnostic log");
  console.log("BACKGROUND TESTS PASSED");
} finally {
  if (serviceStarted) await stopBackgroundService().catch(() => {});
  if (server) await server.close().catch(() => {});
  fs.rmSync(testHome, { recursive: true, force: true });
}
