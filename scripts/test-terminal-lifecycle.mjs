// Check the actual exit/signal handlers without terminating the test process or
// changing its terminal. The subprocess integration cases live in resilience.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-lifecycle-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { Renderer } = await import("../dist/terminal/renderer.js");
const restore = await import("../dist/terminal/restore.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { App } = await import("../dist/app.js");
const { SessionCheckpoint } = await import("../dist/persistence.js");
const { loadSession, NEUTRINO_DIR } = await import("../dist/config.js");
assert.equal(NEUTRINO_DIR, path.join(testHome, ".neutrino"));

const write = fs.writeSync;
const stdoutWrite = process.stdout.write;
const on = process.on;
const exit = process.exit;
const stdin = process.stdin;
const inputDescriptors = Object.fromEntries(["isTTY", "isRaw", "setRawMode"].map(key => [key, Object.getOwnPropertyDescriptor(stdin, key)]));
let stdout = "";
let stderr = "";
let queued = "";
let failWrite = false;
let partialWrites = false;
let rawRestores = 0;
fs.writeSync = (fd, data, offset, length, ...rest) => {
  if (fd !== 1 && fd !== 2) return write(fd, data, offset, length, ...rest);
  if (failWrite && fd === 1) { failWrite = false; throw new Error("write failed"); }
  const bytes = Buffer.isBuffer(data) ? data.subarray(offset, offset + (partialWrites ? Math.min(length, 5) : length)) : Buffer.from(data);
  if (fd === 1) stdout += bytes.toString();
  else stderr += bytes.toString();
  return bytes.length;
};
process.stdout.write = chunk => { queued += chunk; return false; };
Object.defineProperties(stdin, {
  isTTY: { value: true, configurable: true },
  isRaw: { value: true, writable: true, configurable: true },
  setRawMode: { value(raw) { this.isRaw = raw; if (!raw) rawRestores++; }, configurable: true },
});
const count = (text, needle) => text.split(needle).length - 1;
const results = [];
try {
  const renderer = new Renderer();
  renderer.out = { write: chunk => { queued += chunk; return false; } };
  renderer.init();
  partialWrites = true;
  renderer.dispose();
  renderer.dispose();
  assert.equal(stdout, restore.TUI_TEARDOWN, "all teardown bytes must be written synchronously, even across short writes");
  assert.equal(count(queued, "\x1b[?1003l"), 0, "teardown must not join the pending frame queue");
  assert.equal(stdin.isRaw, false);
  assert.equal(rawRestores, 1);
  assert.equal(restore.restoreTerminalSync(), false, "successful dispose disarms the exit guard");
  results.push("ok synchronous dispose flushes every teardown byte and restores raw mode once");

  stdout = "";
  partialWrites = false;
  restore.markTuiActive();
  stdin.isRaw = true;
  failWrite = true;
  assert.equal(restore.restoreTerminalSync(), false);
  assert.equal(stdin.isRaw, false, "output failure must still restore input");
  assert.equal(restore.restoreTerminalSync(), true, "output failure must leave the exit retry armed");
  assert.equal(stdout, restore.TUI_TEARDOWN);
  results.push("ok failed output still restores input and permits a synchronous retry");

  stdout = "";
  const app = new App();
  app.renderer.out = { write: chunk => { queued += chunk; return false; } };
  app.renderer.init();
  app.input.stop = () => {
    assert.equal(stdout, restore.TUI_TEARDOWN, "mouse reporting must be disabled before input stops");
    throw new Error("input already closed");
  };
  let appExit;
  process.exit = code => { appExit = code; };
  app.quit(7);
  assert.equal(appExit, 7, "a failed render must retain its nonzero exit status");
  assert.equal(stdout, restore.TUI_TEARDOWN);
  process.exit = exit;
  results.push("ok App.quit restores the terminal before stopping input and preserves the exit status");

  for (const kind of ["exit", "uncaughtException", "unhandledRejection", "SIGHUP", "SIGBREAK", "save-failure", "exit-save-failure"]) {
    stdout = "";
    stderr = "";
    stdin.isRaw = true;
    const handlers = new Map();
    const guard = await import(`../dist/terminal/restore.js?lifecycle=${kind}`);
    process.on = function (name, handler) { handlers.set(name, handler); return this; };
    let exitCode;
    process.exit = code => { exitCode = code; handlers.get("exit")(code); };
    guard.installCrashGuard();
    process.on = on;
    guard.markTuiActive();

    const screen = new ChatScreen();
    screen.app = { state: { selectedProvider: "test", selectedModelName: "test", selectedModelUrl: "", selectedModelApiKey: "", selectedModelStreaming: true, selectedIntensity: "High" }, render() {} };
    screen.onActivate();
    screen.messages.push({ role: "user", content: "first prompt" });
    screen.streamingContent = "reply before the first checkpoint";
    let failed;
    if (kind === "save-failure" || kind === "exit-save-failure") {
      failed = new SessionCheckpoint(() => false);
      failed.register();
      if (kind === "exit-save-failure") process.exit(0);
      else handlers.get("uncaughtException")(new Error("fatal with unwritable history"));
      assert.match(stderr, /could not be saved/);
    } else if (kind === "exit") {
      process.exit(0);
    } else if (kind === "uncaughtException" || kind === "unhandledRejection") {
      handlers.get(kind)(new Error("injected fatal error"));
      assert.match(stderr, /injected fatal error/);
      assert.equal(exitCode, 1);
    } else {
      handlers.get(kind)();
      assert.equal(exitCode, kind === "SIGHUP" ? 129 : 149);
    }
    const saved = loadSession(screen.sessionId);
    assert.deepEqual(saved.messages.map(m => m.content), ["first prompt", "reply before the first checkpoint"]);
    assert.equal(stdout, guard.TUI_TEARDOWN, `${kind}: restore exactly once`);
    assert.equal(stdin.isRaw, false);
    failed?.dispose();
    screen.onDeactivate();
    results.push(`ok ${kind}: synchronous terminal restoration and unfinished history checkpoint`);
  }
} finally {
  fs.writeSync = write;
  process.stdout.write = stdoutWrite;
  process.on = on;
  process.exit = exit;
  for (const [key, descriptor] of Object.entries(inputDescriptors)) {
    if (descriptor) Object.defineProperty(stdin, key, descriptor);
    else delete stdin[key];
  }
  fs.rmSync(testHome, { recursive: true, force: true });
}
fs.writeSync(1, results.join("\n") + "\n");
