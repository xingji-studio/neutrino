/**
 * Resilience tests: a crash of any kind must leave the terminal usable, and a
 * dropped browser connection must not take the server down.
 *
 * The terminal checks run in child processes with piped stdio, which is the only
 * way to observe what a dying process actually flushes to fd 1.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { hub } from "../dist/web/hub.js";
import { startWebServer } from "../dist/web/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const restoreModule = pathToFileURL(path.join(root, "dist", "terminal", "restore.js")).href;

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const MOUSE_OFF = "\x1b[?1003l";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const count = (haystack, needle) => haystack.split(needle).length - 1;

function runChild(body, { env = {}, timeout = 8000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-resilience-"));
  const file = path.join(dir, "child.mjs");
  fs.writeFileSync(file, body.replaceAll("__RESTORE__", JSON.stringify(restoreModule)), "utf8");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
console.log("TERMINAL RESTORE");
{
  // The teardown has to disable mouse reporting *before* leaving the alternate
  // screen, otherwise the last writes land on the user's shell prompt.
  const { stdout } = await runChild(`
    import { TUI_TEARDOWN as T } from __RESTORE__;
    const modes = ["1000l", "1002l", "1003l", "1006l", "1015l"];
    process.stdout.write(JSON.stringify({
      mouse: T.includes("?1003l"),
      allModes: modes.every((m) => T.includes(m)),
      cursor: T.includes("?25h"),
      mouseIdx: T.indexOf("1003l"),
      altIdx: T.indexOf("1049l"),
    }));
  `);
  const t = JSON.parse(stdout);
  check("teardown disables mouse tracking", t.mouse);
  check("teardown disables every mouse mode", t.allModes);
  check("teardown re-enables the cursor", t.cursor);
  check("mouse is restored before leaving the alt screen", t.mouseIdx > 0 && t.mouseIdx < t.altIdx, `mouse=${t.mouseIdx} alt=${t.altIdx}`);
}

{
  const { code, stdout } = await runChild(`
    import { markTuiActive, restoreTerminalSync } from __RESTORE__;
    markTuiActive();
    const first = restoreTerminalSync();
    const second = restoreTerminalSync();
    process.stdout.write("RESULT " + first + " " + second + "\\n");
  `);
  check("restoreTerminalSync reports one restore", stdout.includes("RESULT true false"), stdout.trim());
  check(
    "teardown is written exactly once",
    count(stdout, ALT_SCREEN_OFF) === 1,
    `count=${count(stdout, ALT_SCREEN_OFF)}`,
  );
  check("a double restore still exits cleanly", code === 0, `code=${code}`);
}

{
  // A guard that was never armed must not scribble on the shell (the
  // `neutrino web` mode never claims the terminal).
  const { stdout } = await runChild(`
    import { restoreTerminalSync } from __RESTORE__;
    restoreTerminalSync();
    process.stdout.write("DONE\\n");
  `);
  check("unarmed guard writes no escapes", count(stdout, ALT_SCREEN_OFF) === 0, stdout.slice(0, 40));
}

// ---------------------------------------------------------------------------
console.log("CRASH CONTAINMENT");
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-home-"));
  const { code, stdout, stderr } = await runChild(
    `
    import { installCrashGuard, markTuiActive } from __RESTORE__;
    markTuiActive();
    installCrashGuard();
    setTimeout(() => {}, 500);
    Promise.reject(new Error("boom-rejection"));
  `,
    { env: { USERPROFILE: home, HOME: home } },
  );

  check(
    "unhandled rejection restores the terminal",
    count(stdout, MOUSE_OFF) === 1 && count(stdout, ALT_SCREEN_OFF) === 1,
    JSON.stringify(stdout.slice(0, 60)),
  );
  check("unhandled rejection is reported", stderr.includes("boom-rejection"), stderr.trim().split("\n")[0]);
  check("unhandled rejection exits non-zero", code === 1, `code=${code}`);
  const log = path.join(home, ".neutrino", "crash.log");
  const logged = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  check("rejection is written to the crash log", logged.includes("boom-rejection"), logged.slice(0, 80));
  fs.rmSync(home, { recursive: true, force: true });
}

{
  // The classic: a throw from a timer callback, far away from any try/catch.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-home-"));
  const { code, stdout, stderr } = await runChild(
    `
    import { installCrashGuard, markTuiActive } from __RESTORE__;
    markTuiActive();
    installCrashGuard();
    setTimeout(() => { throw new Error("boom-timer"); }, 10);
  `,
    { env: { USERPROFILE: home, HOME: home } },
  );
  check("timer throw restores the terminal", count(stdout, MOUSE_OFF) === 1, JSON.stringify(stdout.slice(0, 60)));
  check("timer throw is reported", stderr.includes("boom-timer"), stderr.trim().split("\n")[0]);
  check("timer throw exits non-zero", code === 1, `code=${code}`);
  fs.rmSync(home, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("WEB STREAM RESILIENCE");
{
  const meta = {
    sessionId: "resilience-test",
    title: "resilience",
    provider: "test",
    model: "test-model",
    intensity: "medium",
    busy: false,
    paused: false,
    queued: null,
    compressing: false,
    tokens: { prompt: 0, completion: 0 },
    approval: null,
  };
  const agent = {
    liveCwd: () => root,
    liveMeta: () => meta,
    liveSnapshot: (key) => ({ ...meta, key, cwd: root, messages: [], streamingContent: null }),
    livePause: () => {},
    liveResume: () => {},
    liveSend: () => {},
    liveApprove: () => true,
  };
  const key = hub.register(agent);
  const server = await startWebServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;

  const get = (p) =>
    new Promise((resolve, reject) => {
      const req = http.get(`${base}${p}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", reject);
      });
      req.on("error", reject);
    });

  // Open the SSE stream, then yank the socket out from under the server while
  // it is still a registered subscriber, and force it to write.
  const opened = await new Promise((resolve) => {
    const req = http.get(`${base}/api/live/${key}/stream`, (res) => {
      res.once("data", () => {
        res.destroy();
        req.destroy();
        resolve(true);
      });
      res.on("error", () => {});
    });
    req.on("error", () => resolve(false));
    setTimeout(() => resolve(false), 3000);
  });
  check("subscribed to the live stream", opened);

  // Writes aimed at a connection that no longer exists are the crash being
  // guarded against: an unhandled 'error' event on the response.
  for (let i = 0; i < 50; i++) hub.notify(key);
  await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 10; i++) hub.notify(key);
  await new Promise((r) => setTimeout(r, 150));

  const health = await get("/api/health");
  check("server survives an abrupt client disconnect", health.status === 200, `status=${health.status}`);

  // A malformed request line must not kill the server either.
  await new Promise((resolve) => {
    const sock = net.connect(server.port, "127.0.0.1", () => sock.end("GARBAGE\r\n\r\n"));
    sock.on("error", () => resolve());
    sock.on("close", resolve);
    setTimeout(resolve, 1000);
  });
  const health2 = await get("/api/health");
  check("server survives a malformed request", health2.status === 200, `status=${health2.status}`);

  hub.unregister(key);
  await server.close();
}

// ---------------------------------------------------------------------------
console.log(failures === 0 ? "\nRESILIENCE TESTS PASSED" : `\nRESILIENCE TESTS FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
