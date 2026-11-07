// The settings page's "Check for updates" button asks the registry on demand
// through the console API, in both workspaces, and reports what it found. A
// fake `npm` on PATH stands in for the registry, so no network is involved.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-check-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-check-npm-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { loadVersion } = await import("../dist/config.js");
const { checkForUpdate } = await import("../dist/update.js");
const { startWebServer } = await import("../dist/web/server.js");
const { PRO_MODELS_URL } = await import("../dist/pro/config.js");
const { seedProPresets } = await import("./pro-presets.mjs");
seedProPresets();

// Both workspaces must be testable without fetching the official Pro presets.
const originalFetch = globalThis.fetch;
let presetDownloads = 0;
globalThis.fetch = (input, init) => {
  if (String(input) === PRO_MODELS_URL) {
    presetDownloads++;
    return Promise.reject(new Error("The update-check fixture is offline"));
  }
  return originalFetch(input, init);
};

const current = loadVersion();
const newer = `${Number(current.split(".")[0]) + 1}.0.0`;

/** Write a stand-in npm that prints `lines` (and optionally fails). */
function fakeNpm(name, lines) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(dir, "npm.cmd"), ["@echo off", ...lines].join("\r\n") + "\r\n");
  } else {
    const file = path.join(dir, "npm");
    fs.writeFileSync(file, ["#!/bin/sh", ...lines].join("\n") + "\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

const okNewer = fakeNpm("newer", [`echo ${newer}`]);
const okSame = fakeNpm("same", [`echo ${current}`]);
const broken = fakeNpm("broken", process.platform === "win32"
  ? ["echo registry down 1>&2", "exit /b 1"]
  : ["echo registry down 1>&2", "exit 1"]);

/** Only the chosen stand-in is on PATH: the server's npm cannot reach a registry. */
function useNpm(dir) {
  process.env.PATH = dir;
}

let server;
let cookie;
async function request(route, { body, method, headers = {}, anonymous = false } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(!anonymous && cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: JSON.parse(text) };
}

try {
  useNpm(okNewer);
  server = await startWebServer({ port: 0 });
  // The check runs npm on this machine, so it is a mutation like the install.
  assert.equal((await request("/api/update/check", { body: {}, anonymous: true })).status, 401);
  const login = await request("/api/auth/login", { body: { password: "114514" } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];

  // Nothing has asked the registry since this process started.
  assert.deepEqual((await request("/api/settings")).data.update,
    { current_version: current, latest_version: "", has_update: false });

  // The button's route asks now and answers with the version it found.
  const checked = await request("/api/update/check", { body: {} });
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.data, { has_update: true, current_version: current, latest_version: newer, error: "" });

  // The answer is shared with the rest of the console: the settings payload the
  // dialog renders, and the Pro workspace, tell the same story.
  const found = { current_version: current, latest_version: newer, has_update: true };
  assert.deepEqual((await request("/api/settings")).data.update, found);
  const proChecked = await request("/pro/api/update/check", { body: {} });
  assert.equal(proChecked.status, 200, JSON.stringify(proChecked.data));
  assert.deepEqual(proChecked.data, checked.data, "the Pro workspace checks through its own API prefix");
  const proSettings = await request("/pro/api/settings");
  assert.equal(proSettings.status, 200, JSON.stringify(proSettings.data));
  assert.deepEqual(proSettings.data.update, found);

  // A second check must not be served from the start-up answer: the registry now
  // reports the running version, so there is nothing to install any more.
  useNpm(okSame);
  const again = await request("/api/update/check", { body: {} });
  assert.deepEqual(again.data, { has_update: false, current_version: current, latest_version: current, error: "" });
  assert.equal((await request("/api/settings")).data.update.has_update, false);
  assert.equal((await request("/api/update", { body: {} })).status, 409, "an outdated answer cannot install anything");

  // npm failing is reported next to the button rather than as a broken response,
  // and the last good answer stays in place.
  useNpm(broken);
  const failed = await request("/api/update/check", { body: {} });
  assert.equal(failed.status, 200);
  assert.equal(failed.data.has_update, false);
  assert.equal(failed.data.current_version, current);
  assert.equal(failed.data.latest_version, current, "a failed check keeps the last published version");
  assert.match(failed.data.error, /npm view .* failed/);

  // The module behind the route lets the terminal screen and the background
  // timer ask again after an answer is already remembered.
  useNpm(okNewer);
  const refreshed = await checkForUpdate({ refresh: true });
  assert.equal(refreshed.hasUpdate, true, "refresh queries the registry after a remembered answer");
  assert.equal(refreshed.error, undefined);

  // Guards: only a same-origin POST may run npm.
  assert.equal((await request("/api/update/check")).status, 405);
  assert.equal((await request("/api/update/check", { body: {}, headers: { Origin: "http://evil.example" } })).status, 403);

  assert.equal(presetDownloads, 0, "update checks and settings use local Pro presets without network downloads");
  console.log("ok update check: both workspaces ask the registry on demand and report the result");
} finally {
  globalThis.fetch = originalFetch;
  await server?.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(testHome, { recursive: true, force: true });
}
