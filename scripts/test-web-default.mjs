// The web console is part of a normal launch: on by default, configurable in
// terminal Settings, and visible in the header while it runs.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-web-default-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { Buffer } = await import("../dist/terminal/buffer.js");
const { DEFAULT_CONFIG, loadConfig, saveConfig } = await import("../dist/config.js");
const { App } = await import("../dist/app.js");
const { defaultState } = await import("../dist/state.js");
const { drawHeader } = await import("../dist/header.js");
const { SettingsScreen } = await import("../dist/screens/settings.js");

const key = (name) => ({ name, char: "", ctrl: false, meta: false, shift: false, sequence: "" });
const flat = (buf) => buf.cells.map((row) => row.map((cell) => cell.ch).join("")).join("\n");

try {
  assert.equal(DEFAULT_CONFIG.web_console, true, "the shipped default mounts the console");
  assert.equal(loadConfig().web_console, true, "a fresh config starts with the console enabled");

  // Mount, reach, and unmount the real server without a terminal.
  const app = new App();
  app.render = () => {};
  const toasts = [];
  app.showToast = (text) => toasts.push(text);
  app.configureWeb(0, "127.0.0.1", false);
  const on = await app.setWebConsole(true);
  assert.deepEqual(on, { ok: true });
  assert.match(app.state.webUrl, /^http:\/\/127\.0\.0\.1:\d+$/, "the running server has a URL");
  const health = await fetch(`${app.state.webUrl}/api/health`);
  assert.equal(health.status, 200, "the mounted server answers");
  const off = await app.setWebConsole(false);
  assert.deepEqual(off, { ok: true });
  assert.equal(app.state.webUrl, null, "stopping clears the header address");
  assert.ok(toasts.some((text) => /Web console:/.test(text)), "starting reports the address");
  assert.ok(toasts.includes("Web console stopped"));

  // A failed bind is reported, not thrown. Keep a socket on the port so the
  // real listen path hits EADDRINUSE.
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const blockedPort = blocker.address().port;
  const blockedApp = new App();
  blockedApp.render = () => {};
  const blockedToasts = [];
  blockedApp.showToast = (text) => blockedToasts.push(text);
  blockedApp.configureWeb(blockedPort, "127.0.0.1", false);
  const blocked = await blockedApp.setWebConsole(true);
  assert.equal(blocked.ok, false, "a busy port does not throw");
  assert.match(blocked.error, /EADDRINUSE|address already in use/);
  assert.equal(blockedApp.state.webUrl, null, "a failed start leaves no address");
  assert.ok(blockedToasts.some((text) => /Web console failed/.test(text)));
  await new Promise((resolve) => blocker.close(resolve));

  // The header advertises the URL while it is mounted.
  const header = new Buffer(80, 1);
  drawHeader(header, { ...defaultState(), webUrl: "http://127.0.0.1:8765" });
  assert.match(flat(header), /web 127\.0\.0\.1:8765/);
  const noWeb = new Buffer(80, 1);
  drawHeader(noWeb, defaultState());
  assert.doesNotMatch(flat(noWeb), /web 127\.0\.0\.1/);

  // Settings reflects the running state and toggles both the server and the
  // saved preference.
  const calls = [];
  const fake = {
    state: { ...defaultState(), webUrl: "http://127.0.0.1:8765" },
    width: 80,
    height: 24,
    render() {},
    popScreen() {},
    async setWebConsole(enabled) { calls.push(enabled); return { ok: true }; },
  };
  const screen = new SettingsScreen("settings");
  screen.app = fake;
  screen.onActivate();
  for (let i = 0; i < 5; i++) screen.onKey(key("down"));
  const before = new Buffer(80, 24);
  screen.render(before);
  assert.match(flat(before), /Web console/);
  assert.match(flat(before), /On · http:\/\/127\.0\.0\.1:8765/);
  screen.onKey(key("left"));
  assert.deepEqual(calls, [false], "turning it off stops the server");
  assert.equal(loadConfig().web_console, false, "the choice is saved");
  screen.onKey(key("right"));
  assert.deepEqual(calls, [false, true], "turning it on mounts the server again");
  assert.equal(loadConfig().web_console, true);

  // Running the console through an explicit flag must not silently rewrite a
  // saved "off" preference when the user edits some other setting.
  saveConfig({ ...loadConfig(), web_console: false });
  const untouched = new SettingsScreen("settings");
  untouched.app = fake;
  untouched.onActivate();
  untouched.onKey(key("right"));
  assert.equal(loadConfig().web_console, false, "unrelated settings keep the saved web preference");
  for (let i = 0; i < 5; i++) untouched.onKey(key("down"));
  untouched.onKey(key("left"));
  assert.equal(loadConfig().web_console, false, "explicitly turning it off saves off");

  console.log("WEB DEFAULT TESTS PASSED");
} finally {
  fs.rmSync(testHome, { recursive: true, force: true });
}
