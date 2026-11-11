// The working directory is chosen in the operating system's own folder window:
// a browser cannot read an absolute path from its own picker. These tests cover
// the per-platform dialog commands with a stubbed process, and the HTTP route
// that decides who may ask for a window at all.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-picker-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.NEUTRINO_PLAN = "off";
const { pickFolder } = await import("../dist/web/folderPicker.js");
const { startWebServer, lanAddresses } = await import("../dist/web/server.js");

const project = path.join(testHome, "project one");
fs.mkdirSync(project, { recursive: true });
const missing = path.join(testHome, "gone");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (overrides) => ({ code: 0, stdout: "", stderr: "", missing: false, ...overrides });
/** Records every dialog process the picker started. */
function recorder(results) {
  const calls = [];
  const runner = async (command, args, env, timeoutMs) => {
    calls.push({ command, args, env, timeoutMs });
    const result = results[command] ?? results.default ?? run({ code: 1 });
    return typeof result === "function" ? result(command, args, env) : result;
  };
  return { calls, runner };
}

let server;
let respond = async () => ({ picked: project });
const calls = [];
async function request(route, { body, method, headers = {}, base = null } = {}) {
  const response = await fetch((base ?? server.url) + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

try {
  // --- Windows: the Explorer folder window, one PowerShell child per ask ------
  {
    // The script only exists while the dialog runs, so it is read from inside the
    // stub process instead of afterwards.
    const started = [];
    const runner = async (command, args, env) => {
      const script = args[args.indexOf("-File") + 1];
      started.push({ command, args, env, script, source: fs.readFileSync(script, "utf8") });
      return run({ stdout: `${project}\r\n` });
    };
    const outcome = await pickFolder({ platform: "win32", start: project, title: "Pick", runner });
    assert.deepEqual(outcome, { picked: project });
    assert.equal(started.length, 1);
    assert.equal(started[0].command, "powershell.exe", "Windows PowerShell ships with every supported Windows");
    assert.ok(started[0].args.includes("-STA"), "the folder window needs a single-threaded apartment");
    assert.ok(started[0].args.includes("-NonInteractive"));
    const source = started[0].source;
    assert.match(source, /PickFolders\s*=\s*0x00000020/, "FOS_PICKFOLDERS makes it a folder window");
    assert.match(source, /FolderBrowserDialog/, "the plain dialog stays as a fallback");
    assert.match(source, /NeutrinoFallbackRaise/,
      "the older WinForms window is raised too: a host that refuses the shell interop still gets one in front");
    assert.ok(source.indexOf("[NeutrinoFallbackRaise]::RaiseWhenShown") > 0
      && source.indexOf("[NeutrinoFallbackRaise]::RaiseWhenShown") < source.indexOf("$window.ShowDialog()"),
      "the raiser waits on a thread of its own, so it must start before the blocking dialog is drawn");
    assert.match(source, /d57c7288-d4ad-4768-be02-9d969532d960/i,
      "the shell class answers this iid; asking for IFileDialog itself is refused with E_NOINTERFACE");
    assert.doesNotMatch(source, /42f85136-db7e-439c-89c5-8c9b1d0c9c6f/i,
      "the iid the dialog refuses must never come back");
    assert.match(source, /SetForegroundWindow/,
      "a window drawn by a console-less child is left behind the browser unless it is raised");
    assert.match(source, /FlashWindowEx/, "and a window raised without focus is still noticed");
    assert.match(source, /DialogClass = "#32770"/,
      "only the dialog window is raised: the console this script runs in owns visible windows of its own");
    assert.doesNotMatch(source, /\[DllImport\("user32\.dll"\)\]\s*private static extern uint GetCurrentThreadId/,
      "GetCurrentThreadId is exported by kernel32: importing it from user32 throws at the first pick");
    assert.equal(started[0].env.NEUTRINO_PICKER_START, project, "the window opens where the page is");
    assert.equal(started[0].env.NEUTRINO_PICKER_TITLE, "Pick");
    assert.equal(fs.existsSync(path.dirname(started[0].script)), false, "the temp script is cleaned up");
  }

  {
    // Windows PowerShell removed: `pwsh` draws the same window.
    const { calls: started, runner } = recorder({
      "powershell.exe": run({ missing: true, stderr: "spawn powershell.exe ENOENT" }),
      "pwsh.exe": run({ stdout: project }),
    });
    assert.deepEqual(await pickFolder({ platform: "win32", start: project, runner }), { picked: project });
    assert.deepEqual(started.map(call => call.command), ["powershell.exe", "pwsh.exe"]);
  }

  {
    const { runner } = recorder({ "powershell.exe": run({ code: 0, stdout: "" }) });
    assert.deepEqual(await pickFolder({ platform: "win32", start: project, runner }), { cancelled: true });
  }

  {
    const { runner } = recorder({ "powershell.exe": run({ code: 1, stderr: "Add-Type failed\ncannot load" }) });
    const outcome = await pickFolder({ platform: "win32", start: project, runner });
    assert.deepEqual(outcome, { unavailable: "cannot load" }, "the last error line explains the failure");
  }

  {
    const { runner } = recorder({ "powershell.exe": run({ missing: true }), "pwsh.exe": run({ missing: true }) });
    const outcome = await pickFolder({ platform: "win32", start: project, runner });
    assert.match(outcome.unavailable, /not installed/);
  }

  // --- macOS: AppleScript's own chooser -------------------------------------
  {
    const { calls: started, runner } = recorder({ osascript: run({ stdout: `${project}/\n` }) });
    assert.deepEqual(await pickFolder({ platform: "darwin", start: project, runner }), { picked: project },
      "the trailing separator AppleScript appends is dropped");
    assert.equal(started[0].command, "osascript");
    assert.equal(started[0].args[1], (started[0].args[1] ?? "").trim());
    assert.match(started[0].args[1], /choose folder/);
    assert.equal(started[0].args.at(-1), project, "the start folder is passed as an argument, never into a shell");

    const root = recorder({ osascript: run({ stdout: "/\n" }) });
    assert.deepEqual(await pickFolder({ platform: "darwin", start: project, runner: root.runner }), { picked: "/" },
      "the filesystem root keeps its separator");

    const cancelled = recorder({ osascript: run({ code: 1, stderr: "execution error: User canceled. (-128)" }) });
    assert.deepEqual(await pickFolder({ platform: "darwin", start: project, runner: cancelled.runner }), { cancelled: true });

    const failed = recorder({ osascript: run({ code: 1, stderr: "execution error: Not authorized" }) });
    assert.deepEqual(await pickFolder({ platform: "darwin", start: project, runner: failed.runner }),
      { unavailable: "execution error: Not authorized" });
  }

  // --- Linux: zenity, then kdialog ------------------------------------------
  {
    const display = { DISPLAY: ":0" };
    const zenity = recorder({ zenity: run({ stdout: `${project}\n` }) });
    assert.deepEqual(await pickFolder({ platform: "linux", start: project, env: display, runner: zenity.runner }),
      { picked: project });
    assert.ok(zenity.calls[0].args.includes("--directory"));
    assert.ok(zenity.calls[0].args.includes(`--filename=${project}${path.sep}`));

    const kdialog = recorder({ zenity: run({ missing: true }), kdialog: run({ stdout: project }) });
    assert.deepEqual(await pickFolder({ platform: "linux", start: project, env: display, runner: kdialog.runner }),
      { picked: project });
    assert.deepEqual(kdialog.calls.map(call => call.command), ["zenity", "kdialog"]);

    const cancelled = recorder({ zenity: run({ code: 1 }) });
    assert.deepEqual(await pickFolder({ platform: "linux", start: project, env: display, runner: cancelled.runner }),
      { cancelled: true }, "closing the window is not an error");

    const timedOut = recorder({ zenity: run({ code: 5 }) });
    assert.deepEqual(await pickFolder({ platform: "linux", start: project, env: display, runner: timedOut.runner }),
      { cancelled: true });

    const headless = recorder({});
    const outcome = await pickFolder({ platform: "linux", start: project, env: {}, runner: headless.runner });
    assert.match(outcome.unavailable, /no desktop session/);
    assert.equal(headless.calls.length, 0, "a server without a desktop starts no dialog");

    const bare = recorder({ zenity: run({ missing: true }), kdialog: run({ missing: true }) });
    const nothing = await pickFolder({ platform: "linux", start: project, env: display, runner: bare.runner });
    assert.match(nothing.unavailable, /not installed/);
  }

  // --- inputs --------------------------------------------------------------
  {
    const { calls: started, runner } = recorder({ default: run({ stdout: project }) });
    const bogus = await pickFolder({ platform: "darwin", start: missing, runner });
    assert.equal(bogus.picked, project);
    assert.equal(started[0].args.at(-1), os.homedir(), "a start folder that is gone falls back to home");

    const relative = recorder({ default: run({ stdout: project }) });
    await pickFolder({ platform: "darwin", start: "relative/path", runner: relative.runner });
    assert.equal(relative.calls[0].args.at(-1), os.homedir(), "only an absolute folder is offered as a start");

    const titled = recorder({ default: run({ stdout: project }) });
    await pickFolder({ platform: "darwin", title: "  Select\n  a folder  ", runner: titled.runner });
    assert.equal(titled.calls[0].args[2], "Select a folder", "the window title stays one line");

    const plain = recorder({ default: run({ stdout: project }) });
    await pickFolder({ platform: "darwin", runner: plain.runner });
    assert.equal(plain.calls[0].args[2], "Select a working directory");

    const unsupported = recorder({});
    assert.match((await pickFolder({ platform: "aix", runner: unsupported.runner })).unavailable, /aix/);
    assert.equal(unsupported.calls.length, 0);
  }

  // --- the route: only a browser on this machine may open a window ----------
  server = await startWebServer({
    port: 0,
    auth: false,
    folderPicker: async (picked) => {
      calls.push(picked);
      return respond(picked);
    },
  });

  {
    calls.length = 0;
    const picked = await request("/api/fs/pick", { body: { start: project, title: "Select a working directory" } });
    assert.equal(picked.status, 200);
    assert.deepEqual(picked.data, { path: project });
    assert.deepEqual(calls, [{ start: project, title: "Select a working directory" }]);

    respond = async () => ({ cancelled: true });
    const cancelled = await request("/api/fs/pick", { body: { start: project } });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.data, { path: null }, "closing the window is a normal answer");

    respond = async () => ({ unavailable: "no desktop session is available" });
    const unavailable = await request("/api/fs/pick", { body: {} });
    assert.equal(unavailable.status, 501);
    assert.equal(unavailable.data.code, "native picker unavailable");
    assert.equal(unavailable.data.error, "no desktop session is available");

    respond = async () => ({ picked: project });
    calls.length = 0;
    assert.equal((await request("/api/fs/pick", { method: "GET" })).status, 405);
    const crossSite = await request("/api/fs/pick", { body: {}, headers: { Origin: "https://evil.invalid" } });
    assert.equal(crossSite.status, 403);
    assert.equal((await request("/api/fs/pick", { body: { start: 5 } })).status, 400);
    assert.equal((await request("/api/fs/pick", { body: { title: [] } })).status, 400);
    assert.equal(calls.length, 0, "nothing opens a window before the request is accepted");
  }

  // One window at a time: a second click waits for the one already on the desk.
  {
    calls.length = 0;
    let release;
    respond = () => new Promise((resolve) => { release = () => resolve({ picked: project }); });
    const first = request("/api/fs/pick", { body: { start: project } });
    const second = request("/api/fs/pick", { body: { start: project } });
    await sleep(80);
    assert.equal(calls.length, 1, "the second request shares the open window");
    release();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.data.path, project);
    assert.equal(two.data.path, project);
    respond = async () => ({ picked: project });
  }

  // A browser on another device asks for a window it could never see: the server
  // keeps it on the in-page folder browser instead.
  {
    const address = lanAddresses()[0];
    if (!address) {
      console.log("skip: this host has no LAN address to probe");
    } else {
      const lan = await startWebServer({ port: 0, host: "0.0.0.0", auth: false, folderPicker: async () => ({ picked: project }) });
      try {
        const base = `http://${address}:${lan.port}`;
        const remote = await request("/api/fs/pick", { body: { start: project }, base });
        assert.equal(remote.status, 501, "only the machine beside the desktop may open a window");
        assert.equal(remote.data.code, "native picker unavailable");
        const local = await request("/api/fs/pick", { body: { start: project } });
        assert.equal(local.status, 200, "the same console still serves this machine");
      } finally {
        await lan.close();
      }
    }
  }

  console.log("ok folder picker: system windows per platform and a loopback-only route");
} finally {
  if (server) await server.close();
  fs.rmSync(testHome, { recursive: true, force: true });
}
