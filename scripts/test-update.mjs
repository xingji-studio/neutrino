// The update check must announce a newer release and stay silent otherwise.
// A fake `npm` on PATH stands in for the registry, so no network is involved;
// the version comparison is exercised directly.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-npm-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const updateModule = new URL("../dist/update.js", import.meta.url).href;

const { compareVersions, isNewerVersion, updateStatus, checkForUpdate } = await import("../dist/update.js");
const { loadVersion } = await import("../dist/config.js");
const { getWebSettings } = await import("../dist/web/settings.js");
const { seedProPresets } = await import("./pro-presets.mjs");

const current = loadVersion();
const major = Number(current.split(".")[0]);
const newer = `${major + 1}.0.0`;

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
const noisy = fakeNpm("noisy", ["echo npm warn skipped-optional-dependency", `echo ${newer}`]);
const empty = fakeNpm("empty", []);
const broken = fakeNpm("broken", process.platform === "win32"
  ? ["echo registry down 1>&2", "exit /b 1"]
  : ["echo registry down 1>&2", "exit 1"]);
const garbage = fakeNpm("garbage", ["echo not-a-version"]);

/** Run one check in a fresh process: the module caches within a process only. */
function runCheck(pathDir, only = false) {
  const code = `
const mod = await import(${JSON.stringify(updateModule)});
const before = mod.updateStatus();
const result = await mod.checkForUpdate();
const after = mod.updateStatus();
process.env.PATH = ${JSON.stringify(empty)};
const again = await mod.checkForUpdate();
process.stdout.write(JSON.stringify({ before, result, after, again }));
`;
  const env = { ...process.env, PATH: [pathDir, only ? "" : process.env.PATH].filter(Boolean).join(path.delimiter) };
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" }));
}

try {
  // Semantic-version order, including the pre-release rules npm follows.
  assert.equal(compareVersions(current, current), 0);
  assert.equal(compareVersions("0.4.2", "0.4.1"), 1);
  assert.equal(compareVersions("0.4.1", "0.4.2"), -1);
  assert.equal(compareVersions("0.5.0", "0.4.9"), 1);
  assert.equal(compareVersions("v1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.equal(compareVersions("0.4.1-beta.1", "0.4.1"), -1);
  assert.equal(compareVersions("0.4.1", "0.4.1-beta.1"), 1);
  assert.equal(compareVersions("0.4.1-beta.2", "0.4.1-beta.1"), 1);
  assert.equal(compareVersions("0.4.1-beta", "0.4.1-beta.1"), -1);
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("", current), 0, "an unparsable version never claims an update");
  assert.equal(isNewerVersion("not-a-version", current), false);
  assert.equal(isNewerVersion("", current), false);
  assert.equal(isNewerVersion(newer, current), true);
  assert.equal(isNewerVersion(current, current), false);
  assert.equal(isNewerVersion(current, newer), false);

  // Before any lookup the status reports the running version and no update.
  const idle = updateStatus();
  assert.equal(idle.currentVersion, current);
  assert.equal(idle.latestVersion, "");
  assert.equal(idle.hasUpdate, false);

  // A newer published version is announced, and only then.
  const ahead = runCheck(okNewer);
  assert.deepEqual(ahead.before, { currentVersion: current, latestVersion: "", hasUpdate: false });
  assert.equal(ahead.result.latestVersion, newer);
  assert.equal(ahead.result.currentVersion, current);
  assert.equal(ahead.result.hasUpdate, true);
  assert.equal(ahead.result.error, undefined);
  assert.equal(ahead.after.hasUpdate, true, "the answer is remembered for the rest of the process");
  assert.equal(ahead.again.hasUpdate, true);
  assert.equal(ahead.again.error, undefined, "a known answer is not queried again");

  // The published version being the running one is not an update.
  const level = runCheck(okSame);
  assert.equal(level.result.latestVersion, current);
  assert.equal(level.result.hasUpdate, false);
  assert.equal(level.after.hasUpdate, false);

  // npm warnings before the version must not be mistaken for it.
  const talkative = runCheck(noisy);
  assert.equal(talkative.result.latestVersion, newer);
  assert.equal(talkative.result.hasUpdate, true);

  // Unusable answers leave the running version in place instead of throwing.
  for (const [label, dir] of [["a failing npm", broken], ["an empty answer", empty], ["a malformed answer", garbage]]) {
    const failed = runCheck(dir);
    assert.equal(failed.result.hasUpdate, false, `${label} is not an update`);
    assert.equal(failed.result.latestVersion, "", `${label} leaves no published version`);
    assert.equal(failed.result.currentVersion, current, `${label} still reports the running version`);
    assert.equal(typeof failed.result.error, "string", `${label} reports why it failed`);
  }

  // …and so does not being able to run npm at all.
  const missing = runCheck(path.join(root, "no-npm-here"), true);
  assert.equal(missing.result.hasUpdate, false);
  assert.match(missing.result.error, /could not run npm|failed with code/i);

  // Both web pages read the same state from the settings payload.
  seedProPresets();
  const idlePayload = getWebSettings();
  assert.deepEqual(idlePayload.update, { current_version: current, latest_version: "", has_update: false });
  assert.deepEqual(getWebSettings("pro").update, idlePayload.update, "the Pro workspace reports the same state");

  process.env.PATH = [okNewer, process.env.PATH].join(path.delimiter);
  const found = await checkForUpdate();
  assert.equal(found.hasUpdate, true);
  const payload = getWebSettings();
  assert.equal(payload.update.current_version, current);
  assert.equal(payload.update.latest_version, newer);
  assert.equal(payload.update.has_update, true);
  // The published answer never leaks into the saved configuration.
  const saved = fs.readFileSync(path.join(testHome, ".neutrino", "config.json"), "utf8");
  assert.equal(/update|latest_version|has_update/.test(saved), false);

  process.stdout.write("Update check tests passed.\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(testHome, { recursive: true, force: true });
}
