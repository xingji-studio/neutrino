// The update notice has to reach both interfaces: the terminal prompt, and the
// dialog the Web console and the Pro workspace read from the settings payload.
// A fake `npm` on PATH decides what each step reports, so no network is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-ui-home-"));
const npmRoot = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-ui-npm-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { Buffer } = await import("../dist/terminal/buffer.js");
const { defaultState } = await import("../dist/state.js");
const { UpdatePromptScreen } = await import("../dist/screens/updatePrompt.js");
const {
  MANUAL_UPDATE_COMMAND, UPDATE_PACKAGE, checkForUpdate, updateStatus,
} = await import("../dist/update.js");
const { loadVersion } = await import("../dist/config.js");
const { App } = await import("../dist/app.js");
const { Screen } = await import("../dist/terminal/screen.js");
const { StartScreen } = await import("../dist/screens/start.js");
const { startWebServer } = await import("../dist/web/server.js");
const { seedProPresets } = await import("./pro-presets.mjs");

const current = loadVersion();
const newer = `${Number(current.split(".")[0]) + 1}.0.0`;
const literal = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A stand-in npm that prints `lines` and exits with `code`. */
function fakeNpm(name, lines, code = 0) {
  const dir = path.join(npmRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "npm.cmd"), ["@echo off", ...lines, `exit /b ${code}`].join("\r\n") + "\r\n");
  } else {
    const file = path.join(dir, "npm");
    fs.writeFileSync(file, ["#!/bin/sh", ...lines, `exit ${code}`].join("\n") + "\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

const viewNewer = fakeNpm("view-newer", [`echo ${newer}`]);
const installOk = fakeNpm("install-ok", ["echo added 1 package in 3s"]);
const installFail = fakeNpm("install-fail", ["echo EACCES permission denied 1>&2"], 1);
// Records every invocation, so a refused request can prove npm never ran.
const marker = path.join(npmRoot, "ran.txt");
const installRecording = fakeNpm("install-recording", [`echo ran>>"${marker}"`, "echo added 1 package"]);

/** Make one stand-in the npm every later call runs. */
function useNpm(dir) {
  const rest = (process.env.PATH || "")
    .split(path.delimiter)
    .filter((entry) => entry && !entry.startsWith(npmRoot));
  process.env.PATH = [dir, ...rest].join(path.delimiter);
}

const text = (buf) => buf.cells.map((row) => row.map((cell) => cell.ch).join("")).join("\n");

/** A stand-in App good enough for a screen: it re-renders into a buffer. */
function harness(width, height) {
  let screen;
  const app = {
    state: defaultState(),
    width,
    height,
    popped: 0,
    render() {
      const buf = new Buffer(app.width, app.height);
      screen.render(buf);
    },
    popScreen() { app.popped += 1; },
  };
  const draw = () => {
    const buf = new Buffer(app.width, app.height);
    screen.render(buf);
    return text(buf);
  };
  return { app, attach(value) { screen = value; screen.app = app; }, draw };
}

async function waitForText(draw, needle, label) {
  const deadline = Date.now() + 20_000;
  while (!draw().includes(needle)) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const ENTER = { name: "return", ctrl: false, meta: false, shift: false };
const ESCAPE = { name: "escape", ctrl: false, meta: false, shift: false };

let server;
let cookie;
async function request(route, { method = "POST", headers = {} } = {}) {
  const response = await fetch(server.url + route, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  const body = await response.text();
  return { status: response.status, data: JSON.parse(body) };
}

try {
  seedProPresets();

  // --- the terminal prompt -------------------------------------------------
  useNpm(viewNewer);
  const checked = await checkForUpdate();
  assert.equal(checked.hasUpdate, true, "the stand-in registry publishes a newer release");
  assert.equal(checked.latestVersion, newer);

  const prompt = harness(80, 24);
  const screen = new UpdatePromptScreen(checked);
  prompt.attach(screen);
  const opening = prompt.draw();
  assert.match(opening, /Update available/);
  assert.match(opening, new RegExp(`Running ${literal(current)}`));
  assert.match(opening, new RegExp(`Published ${literal(newer)}`));
  assert.match(opening, /Update now/, "the confirm button is offered");
  assert.match(opening, /Later/, "the notice can be postponed");
  assert.match(opening, /Enter confirm/, "the keys are spelled out");

  // Enter starts npm; the screen says so while it waits, and offers no way to
  // close it half-installed.
  useNpm(installOk);
  screen.onKey(ENTER);
  const installing = prompt.draw();
  assert.match(installing, /Updating Neutrino/);
  assert.match(installing, /Installing Neutrino .* with npm/, "the wait says what is running");
  screen.onKey(ESCAPE);
  assert.equal(prompt.app.popped, 0, "the prompt cannot be dismissed mid-install");

  await waitForText(prompt.draw, "Update installed", "the installed result");
  const installed = prompt.draw();
  assert.match(installed, new RegExp(`Neutrino ${literal(newer)} was installed`));
  assert.match(installed, /Restart Neutrino/, "the user is told the running code is unchanged");
  assert.match(installed, /Close/);
  assert.ok(!installed.includes(MANUAL_UPDATE_COMMAND), "a success needs no manual command");

  screen.onKey(ESCAPE);
  assert.equal(prompt.app.popped, 1, "Escape closes a finished notice");

  // --- the same prompt when npm fails -------------------------------------
  useNpm(installFail);
  const failure = harness(80, 24);
  const failing = new UpdatePromptScreen(updateStatus());
  failure.attach(failing);
  failure.draw();
  failing.onKey(ENTER);
  await waitForText(failure.draw, "Update failed", "the failed result");
  const failed = failure.draw();
  assert.match(failed, /The automatic update failed/);
  assert.match(failed, new RegExp(literal(MANUAL_UPDATE_COMMAND)), "the manual command is shown in the prompt");
  assert.match(failed, /EACCES permission/, "npm's own reason is shown");

  // A narrow terminal still carries the title, the command and a button.
  const narrow = harness(40, 14);
  narrow.attach(new UpdatePromptScreen(updateStatus()));
  const narrowText = narrow.draw();
  assert.match(narrowText, /Update available/);
  assert.match(narrowText, /Later/);

  // --- where the terminal shows the notice --------------------------------
  // Rendering is stubbed out: this is about which screen ends up on top.
  class Quiet extends Screen {
    onKey() {}
    render() {}
  }
  const terminal = () => {
    const app = new App();
    app.render = () => {};
    return app;
  };
  const status = { currentVersion: current, latestVersion: newer, hasUpdate: true };

  const launched = terminal();
  launched.pushScreen(new StartScreen());
  launched.promptUpdate(status);
  assert.ok(launched.top instanceof UpdatePromptScreen, "a launch offers the update over the start screen");
  launched.promptUpdate(status);
  assert.equal(launched.screens.length, 2, "the notice is never stacked twice");

  // The registry answer can arrive before the start screen exists; it must not
  // be lost, and it must not be shown twice.
  const early = terminal();
  early.promptUpdate(status);
  assert.equal(early.screens.length, 0, "nothing to draw yet");
  early.pushScreen(new StartScreen());
  assert.ok(early.top instanceof UpdatePromptScreen, "the held offer appears with the start screen");
  assert.equal(early.screens.length, 2);

  // Once the user is talking to the agent, the notice is dropped instead of
  // interrupting the conversation.
  const busy = terminal();
  busy.pushScreen(new Quiet());
  busy.promptUpdate(status);
  assert.ok(busy.top instanceof Quiet, "an open conversation is never interrupted");

  // --- the Web console and the Pro workspace -------------------------------
  server = await startWebServer({ port: 0 });
  const anonymous = await fetch(server.url + "/api/update", { method: "POST" });
  assert.equal(anonymous.status, 401, "the update route needs the login cookie");

  const login = await fetch(server.url + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "114514" }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];

  assert.equal((await request("/api/update", { headers: { Origin: "http://evil.example" } })).status, 403);

  const settings = await fetch(server.url + "/api/settings", { headers: { Cookie: cookie } });
  const settingsBody = await settings.json();
  assert.deepEqual(settingsBody.update, {
    current_version: current, latest_version: newer, has_update: true,
  }, "the console payload announces the release");

  // npm reports success: the answer carries the version and the manual command.
  useNpm(installOk);
  const ok = await request("/api/update");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { ok: true, version: newer, error: "", command: MANUAL_UPDATE_COMMAND });

  // npm reports failure: everything the dialog needs to say why, and what to
  // run by hand instead, comes back with a non-2xx status.
  useNpm(installFail);
  const bad = await request("/api/update");
  assert.equal(bad.status, 500);
  assert.equal(bad.data.ok, false);
  assert.match(bad.data.error, /npm install -g @xingjisoft\/neutrino failed with code 1: EACCES permission denied/);
  assert.equal(bad.data.command, `npm install -g ${UPDATE_PACKAGE}`);

  // The Pro workspace answers the same way, from its own API prefix.
  useNpm(installOk);
  const fromPro = await request("/pro/api/update");
  assert.equal(fromPro.status, 200);
  assert.equal(fromPro.data.ok, true);

  // A console that never heard of a newer release cannot be talked into running
  // npm by a crafted request. Checked in a fresh process, because this one has
  // already cached the registry answer.
  const fresh = execFileSync(process.execPath, ["--input-type=module", "-e", `
const { startWebServer } = await import(${JSON.stringify(new URL("../dist/web/server.js", import.meta.url).href)});
const server = await startWebServer({ port: 0 });
try {
  const login = await fetch(server.url + "/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "114514" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(server.url + "/api/update", { method: "POST", headers: { Cookie: cookie } });
  process.stdout.write(JSON.stringify({ status: response.status, body: await response.json() }));
} finally {
  await server.close();
}
`], {
    env: { ...process.env, PATH: [installRecording, process.env.PATH].join(path.delimiter) },
    encoding: "utf8",
  });
  const refusal = JSON.parse(fresh);
  assert.equal(refusal.status, 409, "no announced release means no update");
  assert.match(refusal.body.error, /No newer version is published/);
  assert.equal(fs.existsSync(marker), false, "npm is never run without an announced release");

  process.stdout.write("Update prompt and interface tests passed.\n");
} finally {
  if (server) await server.close();
  fs.rmSync(npmRoot, { recursive: true, force: true });
  fs.rmSync(testHome, { recursive: true, force: true });
}
