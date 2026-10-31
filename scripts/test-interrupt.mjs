import assert from "node:assert/strict";
import fs from "node:fs";
import { App } from "../dist/app.js";
import { ChatScreen } from "../dist/screens/chat.js";
import { InputReader } from "../dist/terminal/input.js";
import { Buffer as Frame } from "../dist/terminal/buffer.js";
import { Renderer } from "../dist/terminal/renderer.js";
import { TUI_TEARDOWN } from "../dist/terminal/restore.js";

const hint = "press ctrl+shift+c or press ctrl+c 3 times to exit";
const apps = [];
class TestApp extends App {
  // Keep tests independent of the user's config, terminal and session history.
  restoreSelection() {}
  render() {}
  quit() { this.exits = (this.exits ?? 0) + 1; }
}
function fixture(busy = false) {
  const app = new TestApp();
  apps.push(app);
  const chat = new ChatScreen();
  chat.app = app;
  chat.busy = busy;
  chat.save = () => { chat.saves = (chat.saves ?? 0) + 1; };
  app.screens = [chat];
  return { app, chat };
}
function input(handler, chunks) {
  const reader = new InputReader();
  reader.handler = handler;
  for (const chunk of chunks) reader.onData(Buffer.from(chunk));
  reader.stop();
}
const press = (app, ...chunks) => input(ev => app.dispatchEvent(ev), chunks);
const originalNow = Date.now;
let now = 10000;
Date.now = () => now;
try {
  const { app, chat } = fixture(true);
  chat.streamingContent = "partial response";
  chat.turnToken = 7;
  app.state.isThinking = true;
  // Model/settings overlays must not prevent pausing the current chat.
  app.screens.push({ onKey() {} });
  press(app, "\x03");
  assert.equal(app.exits, undefined);
  assert.equal(chat.paused, true);
  assert.equal(chat.busy, false);
  assert.equal(app.state.isThinking, false);
  assert.equal(chat.turnToken, 8);
  assert.equal(chat.streamingContent, null);
  assert.deepEqual(chat.messages, [{ role: "assistant", content: "partial response" }]);
  assert.equal(chat.saves, 1);
  press(app, "\x03");
  assert.equal(app.toast, hint);
  assert.equal(chat.saves, 1, "a second interrupt must not resume or pause again");
  assert.equal(app.exits, undefined);
  const frame = new Frame(80, 12);
  app.drawToast(frame);
  assert.equal(frame.cells[0].map(cell => cell.ch).join("").trim(), hint);
  assert.equal(frame.cells[11].map(cell => cell.ch).join("").trim(), "");
  press(app, "\x03");
  assert.equal(app.exits, 1, "the initial pause counts toward the three presses");

  for (const busy of [true, false]) {
    const { app, chat } = fixture(busy);
    const selection = { anchor: { x: 0, y: 0 }, cursor: { x: 4, y: 0 } };
    app.state.selection = selection;
    app.pressed = true;
    app.pressStart = selection.anchor;
    press(app, "\x03\x1b[99;5u\x1b[27;5;99~");
    app.handleInterrupt();
    assert.equal(app.exits, undefined, "selected Ctrl+C never exits, even after three presses");
    assert.equal(chat.busy, busy, "selected Ctrl+C never pauses the conversation");
    assert.equal(chat.paused, false);
    assert.equal(chat.saves, undefined);
    assert.equal(app.toast, "", "selected Ctrl+C never shows a hint");
    assert.equal(app.state.selection, selection);
    assert.equal(app.pressed, true, "Ctrl+C must not interrupt an ongoing drag");
    assert.equal(app.pressStart, selection.anchor);
    app.state.selection = null;
    press(app, "\x03\x03");
    assert.equal(app.exits, undefined, "ignored presses do not count toward exit");
    press(app, "\x03");
    assert.equal(app.exits, 1);
  }

  const idle = fixture().app;
  press(idle, "\x03\x03");
  assert.equal(idle.exits, undefined);
  now += 1501;
  press(idle, "\x03");
  assert.equal(idle.exits, undefined, "spaced interrupts must not accumulate");
  press(idle, "\x03\x03");
  assert.equal(idle.exits, 1);

  for (const other of ["x", "\x1b[200~pasted\x1b[201~", "\x1b[<0;1;1M", "\x1b[<64;1;1M"]) {
    const { app } = fixture();
    press(app, "\x03\x03", other, "\x03\x03");
    assert.equal(app.exits, undefined, "other input resets the interrupt count");
    press(app, "\x03");
    assert.equal(app.exits, 1);
  }

  for (const chunks of [["\x1b[99;6u"], ["\x1b[27;6;67~"], ["\x1b[", "99;", "6u"]]) {
    const { app } = fixture(true);
    app.state.selection = { anchor: { x: 0, y: 0 }, cursor: { x: 4, y: 0 } };
    press(app, ...chunks);
    assert.equal(app.exits, 1, "Ctrl+Shift+C exits immediately, including split reads");
  }
  const release = fixture().app;
  press(release, "\x1b[99;5:3u\x1b[99;5:3u\x1b[99;5:3u");
  assert.equal(release.exits, undefined);
  assert.equal(release.toast, "", "key releases must not count as interrupts");
  const extended = fixture().app;
  press(extended, "\x1b[99;5u\x1b[27;5;99~\x1b[99:67;5:1u");
  assert.equal(extended.exits, 1, "both keyboard protocols also support ordinary Ctrl+C");

  const events = [];
  input(ev => events.push(ev), ["\x1b[97;5u\x1b[27;2;9~\x1b[13u\x1b[27u\x1b[127u\x1b[65;2u"]);
  assert.deepEqual(events.map(ev => [ev.key.name, ev.key.ctrl, ev.key.shift]), [
    ["a", true, false], ["tab", false, true], ["return", false, false],
    ["escape", false, false], ["backspace", false, false], ["A", false, true],
  ]);
  assert.equal(events[0].key.sequence, "\x1b[97;5u");
  const pasted = fixture().app;
  press(pasted, "\x1b[200~\x03\x03\x03\x1b[201~");
  assert.equal(pasted.exits, undefined, "pasted control characters never exit");

  const approval = fixture(true);
  let decision;
  approval.chat.pendingApproval = {
    tool: "run_command", args: { command: "echo test" },
    risk: { level: "high", reason: "test" },
    resolve(value) { decision = value; },
  };
  press(approval.app, "\x03");
  assert.equal(decision, false, "pausing settles pending approvals");
  assert.equal(approval.chat.pendingApproval, null);

  // Start the real app's signal wiring with only terminal effects stubbed.
  const sigintBefore = new Set(process.listeners("SIGINT"));
  const sigtermBefore = new Set(process.listeners("SIGTERM"));
  const signalApp = new TestApp();
  apps.push(signalApp);
  signalApp.renderer.init = () => {};
  signalApp.input.start = () => {};
  signalApp.pushScreen = () => {};
  try {
    await signalApp.start();
    const { chat } = fixture(true);
    chat.app = signalApp;
    signalApp.screens = [chat];
    signalApp.state.selection = { anchor: { x: 0, y: 0 }, cursor: { x: 4, y: 0 } };
    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGINT");
    assert.equal(chat.busy, true, "SIGINT is ignored while text is selected too");
    assert.equal(signalApp.exits, undefined);
    assert.equal(signalApp.toast, "");
    signalApp.state.selection = null;
    process.emit("SIGINT");
    assert.equal(chat.paused, true);
    assert.equal(signalApp.exits, undefined);
    process.emit("SIGINT");
    assert.equal(signalApp.toast, hint);
    process.emit("SIGINT");
    assert.equal(signalApp.exits, 1, "SIGINT follows the same three-press exit path");
    process.emit("SIGTERM");
    assert.equal(signalApp.exits, 2, "SIGTERM still exits immediately");
  } finally {
    for (const handler of process.listeners("SIGINT")) if (!sigintBefore.has(handler)) process.removeListener("SIGINT", handler);
    for (const handler of process.listeners("SIGTERM")) if (!sigtermBefore.has(handler)) process.removeListener("SIGTERM", handler);
    process.stdout.removeListener("resize", signalApp.resizeHandler);
  }

  // A retry backoff must never hold a paused turn hostage: ESC has to take
  // effect at once, not after the current 3s/5s/… wait expires.
  {
    const savedDelay = process.env.NEUTRINO_RETRY_DELAY_MS;
    const savedFetch = globalThis.fetch;
    process.env.NEUTRINO_RETRY_DELAY_MS = "3000";
    globalThis.fetch = async () => {
      throw new TypeError("terminated");
    };
    try {
      const { chat } = fixture(true);
      chat.model = { name: "test", url: "http://127.0.0.1:1/v1", api_key: "k", supports_streaming: true };
      chat.modelProvider = "OpenAI";
      chat.intensity = "High";
      const token = ++chat.turnToken;
      const started = process.hrtime.bigint();
      const turn = chat.agentLoop([{ role: "user", content: "hi" }], token, {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.match(
        chat.retryNotice,
        /retrying in 3s \(attempt 2\/7\)/,
        "a busy turn says why it is silent",
      );
      chat.togglePause();
      await turn;
      const waited = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(waited < 1500, `pausing must cut the backoff short, waited ${Math.round(waited)}ms`);
      assert.equal(chat.retryNotice, null, "the notice is cleared once the turn ends");
      assert.equal(chat.paused, true);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedDelay === undefined) delete process.env.NEUTRINO_RETRY_DELAY_MS;
      else process.env.NEUTRINO_RETRY_DELAY_MS = savedDelay;
    }
  }

  let output = "";
  const renderer = new Renderer();
  renderer.out = { write(chunk) { output += chunk; } };
  renderer.init();
  assert.ok(output.includes("\x1b[>4;2m\x1b[>1u"));
  const writeSync = fs.writeSync;
  let restored = "";
  try {
    fs.writeSync = (fd, data, offset, length) => {
      assert.equal(fd, 1);
      restored += data.subarray(offset, offset + length).toString();
      return length;
    };
    renderer.dispose();
    assert.equal(restored, TUI_TEARDOWN);
    assert.ok(restored.includes("\x1b[<u\x1b[>4m"), "shutdown restores keyboard modes");
  } finally {
    fs.writeSync = writeSync;
  }
} finally {
  Date.now = originalNow;
  for (const app of apps) {
    for (const timer of [app.toastTimer, app.sizeTimer, app.repaintTimer]) clearTimeout(timer);
  }
}
console.log("INTERRUPT TESTS PASSED");
