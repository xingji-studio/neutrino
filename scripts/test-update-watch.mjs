// The background service asks the registry again every 30 minutes, and a
// release it has not seen before is announced to every open window. A fake
// `npm` stands in for the registry; the interval is shortened so a real timer
// and a real event stream can be watched, and the announced shape is compared
// with the settings payload to prove both dialogs read one source.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-watch-home-"));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-update-watch-npm-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { loadVersion } = await import("../dist/config.js");
const { UPDATE_CHECK_INTERVAL_MS, startUpdateWatch, subscribeUpdateAnnouncements } = await import("../dist/updateWatch.js");
const { startWebServer } = await import("../dist/web/server.js");

const current = loadVersion();
const major = Number(current.split(".")[0]);
const [first, second, third] = [major + 1, major + 2, major + 3].map(n => `${n}.0.0`);

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

function useNpm(dir) {
  process.env.PATH = dir;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fn()) return;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let server;
let cookie;
async function request(route, { body, method, headers = {} } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: JSON.parse(text) };
}

/** Every `data:` line of a stream, as JSON in arrival order. */
function events(text) {
  return text.split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice("data: ".length)));
}

const opened = [];
async function openStream(route, { anonymous = false } = {}) {
  const controller = new AbortController();
  const response = await fetch(server.url + route, {
    headers: anonymous || !cookie ? {} : { Cookie: cookie },
    signal: controller.signal,
  });
  if (response.status !== 200) {
    await response.text();
    controller.abort();
    return { status: response.status, text: "", controller };
  }
  const stream = { status: response.status, text: "", controller };
  stream.reading = (async () => {
    const reader = response.body.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        stream.text += new TextDecoder().decode(next.value);
      }
    } catch {
      // Aborted in the cleanup below.
    }
  })();
  opened.push(stream);
  return stream;
}

const announcements = [];
const stopListening = subscribeUpdateAnnouncements(check => announcements.push(check));
let stopWatch = null;

try {
  // The console asks again every half hour; a shorter interval only lets this
  // test watch the same timer.
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 30 * 60 * 1000, "the background check runs every 30 minutes");

  const npmFirst = fakeNpm("first", [`echo ${first}`]);
  const npmSecond = fakeNpm("second", [`echo ${second}`]);
  const npmThird = fakeNpm("third", [`echo ${third}`]);
  const npmBroken = fakeNpm("broken", process.platform === "win32"
    ? ["echo registry down 1>&2", "exit /b 1"]
    : ["echo registry down 1>&2", "exit 1"]);

  // --- the timer announces a release it has not seen before ------------------
  useNpm(npmFirst);
  stopWatch = startUpdateWatch({ intervalMs: 250 });
  await waitFor(() => announcements.length === 1, "the first announced update");
  assert.equal(announcements[0].hasUpdate, true);
  assert.equal(announcements[0].latestVersion, first);
  assert.equal(announcements[0].currentVersion, current);

  // Another four ticks find the same release: a user who already declined it
  // must not be asked again every half hour.
  await delay(1000);
  assert.equal(announcements.length, 1, "a known release is announced once, not on every tick");

  // An unreachable registry is not news either, and it keeps the last answer.
  useNpm(npmBroken);
  await delay(750);
  assert.equal(announcements.length, 1, "a failed check announces nothing");

  // A release published after the failure is announced when it is found.
  useNpm(npmSecond);
  await waitFor(() => announcements.length === 2, "the release found after the failure");
  assert.equal(announcements[1].latestVersion, second);

  // --- the announcement reaches every open window ---------------------------
  server = await startWebServer({ port: 0 });
  // The stream is a console resource like the settings payload, so it sits
  // behind the login cookie.
  assert.equal((await openStream("/api/update/events", { anonymous: true })).status, 401);
  const login = await request("/api/auth/login", { body: { password: "114514" } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];

  // A window that opens after the release was found still learns about it: the
  // current answer goes out first.
  const standard = await openStream("/api/update/events");
  assert.equal(standard.status, 200);
  await waitFor(() => events(standard.text).length === 1, "the current status on connect");
  assert.deepEqual(events(standard.text)[0], {
    has_update: true, current_version: current, latest_version: second, error: "",
  });

  // A release published while the window is open is pushed to it, without a
  // reload and without asking for it.
  useNpm(npmThird);
  await waitFor(() => events(standard.text).some(event => event.latest_version === third), "the pushed announcement");
  const pushed = events(standard.text).find(event => event.latest_version === third);
  assert.deepEqual(pushed, { has_update: true, current_version: current, latest_version: third, error: "" });

  // The Pro workspace reads the same stream: an update belongs to the process,
  // not to a workspace.
  const pro = await openStream("/pro/api/update/events");
  assert.equal(pro.status, 200);
  await waitFor(() => events(pro.text).length === 1, "the Pro workspace's first event");
  assert.equal(events(pro.text)[0].latest_version, third);

  // One source of truth: the event carries exactly what the settings payload
  // the first-open dialog reads reports.
  const settings = (await request("/api/settings")).data.update;
  assert.deepEqual(
    { has_update: events(standard.text).at(-1).has_update, current_version: settings.current_version, latest_version: settings.latest_version },
    settings,
  );
  assert.equal(settings.latest_version, third);

  // Only a GET streams; a mutation on this route is not a route at all.
  assert.equal((await request("/api/update/events", { body: {} })).status, 404);

  // A window is not a reason to keep a closing console alive.
  const closing = Date.now();
  await server.close();
  const closedInMs = Date.now() - closing;
  server = null;
  assert.ok(closedInMs < 2000, `closing the console ends its update streams (took ${closedInMs}ms)`);

  console.log("ok update watch: a 30-minute check announces each new release once to every open window");
} finally {
  stopWatch?.();
  stopListening();
  for (const stream of opened) stream.controller.abort();
  await Promise.allSettled(opened.map(stream => stream.reading));
  await server?.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(testHome, { recursive: true, force: true });
}
