// Exercise the mode boundary, live changes, persistence, terminal layout and HTTP.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-approval-mode-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
const { loadConfig, saveConfig, loadSession } = await import("../dist/config.js");
const { defaultState } = await import("../dist/state.js");
const { Buffer } = await import("../dist/terminal/buffer.js");
const { StartScreen } = await import("../dist/screens/start.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { App } = await import("../dist/app.js");
const { WebSession } = await import("../dist/web/session.js");
const { ApprovalGate } = await import("../dist/llm/approval.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { hub } = await import("../dist/web/hub.js");
const { startWebServer } = await import("../dist/web/server.js");
const originalComplete = LLMClient.prototype.complete;
const model = { name: "test-model", url: "https://unused.invalid/v1", api_key: "test", supports_streaming: true };
let reviews = 0;
LLMClient.prototype.complete = async () => {
  reviews++;
  return JSON.stringify({ approve: true, reason: "requested action" });
};
const active = [];
let server;
const row = (buffer, y) => buffer.cells[y].map(cell => cell.ch).join("").trim();
const key = name => ({ name, ctrl: false, meta: false, shift: false });
const stubApp = (width = 80, height = 24) => ({
  width, height, state: defaultState(), render() {}, showToast() {},
});
const request = {
  tool: "run_command",
  args: { command: "npm install test", reason: "install the dependency the user asked for" },
  cwd: process.cwd(),
  prompt: "install the dependency",
  risk: { level: "high", summary: "install dependency", reasons: ["package install"] },
};

try {
  saveConfig({ approval_mode: "request", auto_approve_extreme_risk: true });

  for (const prompt of ["自动审批", "自动批准", "不要自动审批"]) {
    let asked = 0;
    const gate = new ApprovalGate({
      askHuman: async () => { asked++; return false; },
      reviewer: () => { throw new Error("prompt text must not start a reviewer"); },
      extremeAutoApprovalEnabled: () => true,
    });
    assert.equal((await gate.decide({ ...request, prompt })).source, "human");
    assert.equal(asked, 1);
  }

  // The switch enables two reviewers per call; a delete-class call repeats that
  // whole panel three times, one independent round after another.
  let automatic = true;
  const gate = new ApprovalGate({
    askHuman: async () => false,
    autoApprovalEnabled: () => automatic,
    reviewer: () => ({ model, provider: "test", intensity: "High" }),
    extremeAutoApprovalEnabled: () => true,
  });
  reviews = 0;
  assert.equal((await gate.decide(request)).source, "ai");
  assert.equal(reviews, 2);
  const extreme = await gate.decide({ ...request, risk: { ...request.risk, level: "extreme" } });
  assert.equal(extreme.votes.length, 6);
  assert.equal(reviews, 8);

  // A completed review from the old mode cannot bypass a later human request.
  const finishReviews = [];
  LLMClient.prototype.complete = () => new Promise(resolve => { finishReviews.push(resolve); });
  const inFlight = gate.decide(request);
  automatic = false;
  for (const finishReview of finishReviews) finishReview('{"approve":true,"reason":"old mode"}');
  assert.equal((await inFlight).source, "human");
  LLMClient.prototype.complete = async () => '{"approve":true,"reason":"requested action"}';

  // One-row button, a blank line, then the version, across terminal sizes.
  for (const [width, height] of [[80, 24], [120, 40], [40, 18], [24, 12]]) {
    const screen = new StartScreen();
    screen.app = stubApp(width, height);
    const buffer = new Buffer(width, height);
    screen.render(buffer);
    assert.equal(row(buffer, height - 4), "[ Request Approval ]");
    assert.equal(row(buffer, height - 3), "");
    assert.match(row(buffer, height - 2), /^v\d/);
    const layout = screen.layout();
    assert.ok(layout.tabY + 3 <= height - 4, "tabs stay above the button");
  }
  const menu = new StartScreen();
  menu.app = stubApp();
  menu.onMouse({ type: "click", button: 0, x: 40, y: 20 });
  assert.equal(loadConfig().approval_mode, "auto");
  const reopenedMenu = new StartScreen();
  reopenedMenu.app = stubApp();
  const menuBuffer = new Buffer(80, 24);
  reopenedMenu.render(menuBuffer);
  assert.equal(row(menuBuffer, 20), "[ Auto Approval ]");
  reopenedMenu.onKey(key("up")); // input wraps to the mode button
  reopenedMenu.onKey(key("return"));
  assert.equal(loadConfig().approval_mode, "request");

  for (const kind of ["tui", "web"]) {
    saveConfig({ ...loadConfig(), approval_mode: "auto" });
    let agent;
    if (kind === "tui") {
      agent = new ChatScreen();
      agent.app = stubApp();
      agent.loadedMessages = [{ role: "user", content: "saved original" }];
      agent.onActivate();
    } else {
      agent = new WebSession({ id: "mode-web", provider: "test", model: model.name, intensity: "High", cwd: process.cwd(), messages: [{ role: "user", content: "saved original" }] }, model);
      agent.start();
    }
    active.push(agent);
    const liveKey = hub.register(agent);
    assert.equal(hub.snapshot(liveKey).approvalMode, "auto", "new conversations inherit menu mode");
    assert.equal(hub.setApprovalMode(liveKey, "request"), true);
    assert.equal(loadConfig().approval_mode, "auto", "session changes preserve the default");
    const waiting = agent.requestApproval("run_command", {
      command: "npm install test",
      reason: "install the dependency the user asked for",
    });
    assert.equal(hub.snapshot(liveKey).approval.level, "high");
    hub.setApprovalMode(liveKey, "auto");
    assert.equal((await waiting).source, "ai", "switching a pending call reroutes it to review");
    assert.equal(hub.snapshot(liveKey).approval, null);
    assert.equal(loadSession(agent.sessionId).approval_mode, "auto");
    hub.setApprovalMode(liveKey, "request");
    if (kind === "tui") {
      agent.onMouse({ type: "click", button: 0, x: 40, y: 19 });
      assert.equal(agent.liveMeta().approvalMode, "auto");
      agent.onKey({ ...key("a"), ctrl: true });
      assert.equal(agent.liveMeta().approvalMode, "request");
      const buffer = new Buffer(80, 24);
      agent.render(buffer);
      assert.equal(row(buffer, 19), "[ Request Approval ]");
    }
    const saved = loadSession(agent.sessionId);
    assert.equal(saved.approval_mode, "request");
    const restored = new WebSession(saved, model);
    assert.equal(restored.liveMeta().approvalMode, "request", "saved mode wins over menu default");
    restored.dispose();
    const terminal = new App();
    terminal.render = () => {};
    terminal.loadSession(saved);
    active.push(terminal.top);
    assert.equal(terminal.top.liveMeta().approvalMode, "request");
  }

  // Browser switch semantics, successful snapshot update and visible errors.
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const controls = [];
  const state = { selection: { kind: "live", key: "L1" }, snapshot: null };
  const el = { controls: { appendChild(button) { controls.push(button); } }, sub: {} };
  const calls = [];
  let succeeds = true;
  let renders = 0;
  const context = vm.createContext({
    state, el, renderLive() { renders++; },
    document: { createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(_name, handler) { this.click = handler; } }) },
    async apiFetch(url, init) {
      calls.push({ url, mode: JSON.parse(init.body).mode });
      return { ok: succeeds, json: async () => succeeds ? { snapshot: { approvalMode: "auto" } } : { error: "mode rejected" } };
    },
  });
  vm.runInContext(source.slice(source.indexOf("async function changeApprovalMode"), source.indexOf("function renderControls")), context);
  vm.runInContext('renderApprovalModeControl("request", mode => changeApprovalMode("L1", mode))', context);
  const button = controls[0];
  assert.equal(button.attrs.role, "switch");
  assert.equal(button.attrs["aria-checked"], "false");
  await button.click();
  assert.deepEqual(calls[0], { url: "/api/live/L1/approval-mode", mode: "auto" });
  assert.equal(state.snapshot.approvalMode, "auto");
  assert.equal(renders, 1);
  succeeds = false;
  await button.click();
  assert.match(el.sub.textContent, /mode rejected/);
  assert.equal(button.disabled, false);

  // The new endpoint retains authentication, same-origin and enum validation.
  server = await startWebServer({ port: 0 });
  const liveKey = hub.register(active[0]);
  const route = `${server.url}/api/live/${liveKey}/approval-mode`;
  const post = (body, headers = {}) => fetch(route, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ mode: "auto" })).status, 401);
  const login = await fetch(`${server.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "114514" }) });
  const Cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await post({ mode: "auto" }, { Cookie, Origin: "https://other.invalid" })).status, 403);
  for (const body of [{ mode: true }, { mode: "AUTO" }, {}, null]) {
    assert.equal((await post(body, { Cookie })).status, 400);
  }
  assert.equal(hub.snapshot(liveKey).approvalMode, "request");
  const changed = await post({ mode: "auto" }, { Cookie });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).snapshot.approvalMode, "auto");
  assert.equal(loadSession(active[0].sessionId).approval_mode, "auto");
  console.log("APPROVAL MODE TESTS PASSED");
} finally {
  await server?.close();
  for (const agent of active) {
    if (agent instanceof ChatScreen) agent.onDeactivate(); else agent.dispose();
  }
  LLMClient.prototype.complete = originalComplete;
  os.homedir = originalHomedir;
  fs.rmSync(testHome, { recursive: true, force: true });
}
