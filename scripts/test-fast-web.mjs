import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-web-"));
const priorEnvironment = { NEUTRINO_HOME: process.env.NEUTRINO_HOME, NEUTRINO_PLUGIN_HOME: process.env.NEUTRINO_PLUGIN_HOME };
process.env.NEUTRINO_HOME = path.join(fixture, ".neutrino"); process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
const originalHomedir = os.homedir; os.homedir = () => fixture;
const config = await import("../dist/config.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { createWebSession, resumeSession } = await import("../dist/web/session.js");
const { hub } = await import("../dist/web/hub.js");
const { startWebServer } = await import("../dist/web/server.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { defaultState } = await import("../dist/state.js");
const model = { name: "unchanged-model", url: "https://fixture.invalid/v1", api_key: "fixture", intensity: ["High"] };
const selection = { provider: "Fixture", model: model.name, intensity: "High" };
config.saveModels({ providers: [{ name: "Fixture", models: [model] }] });
config.saveConfig({ selected_provider: "Fixture", selected_model: model.name, plan_first: false, fast_replans: 0 });
const originalStream = LLMClient.prototype.streamTurn;
let releaseWorker, blocked = false;
const calls = [];
const task = { task_id: "inspect", task_goal: "Inspect fixture", dependencies: [], required_context: [], input_versions: {},
  acceptance_criteria: ["Correct with evidence"], output_contract: "A factual answer", priority: 0, estimated_duration: 1,
  read_only: true, write_paths: [], exclusive: false };
const line = value => JSON.stringify(value) + "\n";
LLMClient.prototype.streamTurn = async function* (messages) {
  calls.push(structuredClone(messages)); this.toolCalls = []; this.outcome = { status: "completed" };
  this.usage = { prompt: 10, completion: 2, total: 12 };
  if (messages[0].content.includes("You plan tasks")) {
    yield line({ type: "constraints", goal: "Inspect fixture", constraints: [] }) + line({ type: "task", task }) + line({ type: "done" });
  } else if (messages.some(m => m.content?.includes("Task: {"))) {
    if (blocked && !messages.at(-1).content.includes('"kind":"verification"')) await new Promise(resolve => { releaseWorker = resolve; });
    yield JSON.stringify({ result: "inspected", verification_passed: true, unresolved: [] });
  } else {
    if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
      this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "Verified final answer", unresolved: [], evidence_ids: ["artifact:inspect@1", "artifact:inspect.verify@1"] }) }];
    }
    yield "Verified final answer";
  }
};
const waitFor = async predicate => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Web mode test timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
};
let server, screen;
const sessions = [];
try {
  server = await startWebServer({ port: 0, auth: false });
  const request = async (route, body) => {
    const response = await fetch(server.url + route, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const created = await request("/api/conversations", { cwd: fixture, selection, agent_mode: "fast_dag" });
  assert.equal(created.status, 200); const key = created.body.key; sessions.push(key);
  assert.equal(created.body.snapshot.agentMode, "fast_dag");
  assert.equal((await request(`/api/live/${key}/message`, { text: "Inspect the fixture", agent_mode: "bogus" })).status, 400);
  assert.equal((await request(`/api/live/${key}`)).body.messages.length, 0, "invalid modes append no message");

  blocked = true;
  assert.equal((await request(`/api/live/${key}/message`, { text: "Inspect fixture", agent_mode: "fast_dag" })).status, 200);
  await waitFor(() => releaseWorker);
  const changing = await request(`/api/live/${key}/agent-mode`, { mode: "standard" });
  assert.equal(changing.body.snapshot.activeAgentMode, "fast_dag", "selection cannot mutate a running turn");
  assert.equal(changing.body.snapshot.agentMode, "standard");
  await request(`/api/live/${key}/message`, { text: "Then answer normally", agent_mode: "standard" });
  await request(`/api/live/${key}/agent-mode`, { mode: "fast" });
  blocked = false; releaseWorker();
  await waitFor(() => !hub.snapshot(key).busy);
  assert.equal(hub.snapshot(key).agentMode, "fast");
  assert.equal(hub.snapshot(key).fast.actual_mode, "fast_dag");
  assert.equal(hub.snapshot(key).task.execution_mode, "standard", "the task record stores actual execution, independent of the next selected mode");
  assert.ok(!calls.at(-1)[0].content.includes("Fast mode:"), "queued message keeps its submitted Standard strategy");
  const saved = config.loadSession(hub.snapshot(key).sessionId);
  assert.equal(saved.fast_run.phase, "completed"); assert.equal(saved.fast_run.metrics.total.prompt, 40);
  const restored = resumeSession(saved); assert.equal(restored.ok, true);
  assert.equal(restored.session.liveSnapshot("restored").fast.run_id, saved.fast_run.run_id); restored.session.dispose();
  const interrupted = resumeSession({ ...saved, fast_run: { ...saved.fast_run, phase: "executing" } });
  assert.equal(interrupted.session.liveSnapshot("restored").fast.phase, "failed"); interrupted.session.dispose();

  const old = createWebSession(fixture, { provider: "Fixture", model, intensity: "High" }); old.start(); sessions.push(old.key);
  const before = calls.length;
  await request(`/api/live/${old.key}/message`, { text: "Explain the phrase 极速模式, without changing mode" });
  await waitFor(() => !old.liveMeta().busy);
  assert.equal(calls.length - before, 1); assert.equal(old.liveMeta().agentMode, "standard");
  assert.equal(old.liveSnapshot("legacy").fast, undefined);

  config.saveConfig({ ...config.loadConfig(), fast_mode_enabled: false });
  assert.equal((await request("/api/overview")).body.fast_mode_enabled, false);
  const disabled = await request(`/api/live/${key}/message`, { text: "must not send", agent_mode: "fast_dag" });
  assert.equal(disabled.status, 409); assert.match(disabled.body.error, /disabled/);
  assert.equal(hub.snapshot(key).agentMode, "fast", "disabled mode does not silently switch engines");
  assert.ok(!hub.snapshot(key).messages.some(m => m.content === "must not send"));
  config.saveConfig({ ...config.loadConfig(), fast_mode_enabled: true });

  // The browser can select Fast Mode for an existing terminal conversation too.
  screen = new ChatScreen("");
  screen.app = { width: 100, height: 32, state: defaultState(), render() {}, popScreen() {}, showToast() {}, bell() {} };
  screen.loadedCwd = fixture; screen.loadedModel = model.name; screen.loadedProvider = "Fixture"; screen.loadedIntensity = "High";
  screen.onActivate();
  assert.equal(hub.sendConfigured(screen.liveKey, "Inspect fixture", "fast_dag").ok, true);
  await waitFor(() => !screen.liveMeta().busy);
  assert.equal(screen.liveSnapshot("terminal").fast.phase, "completed");
  assert.equal(config.loadSession(screen.sessionId).fast_run.actual_mode, "fast_dag");

  // Exercise the actual browser mode control and next-message payload in a minimal DOM.
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('data-agent-mode="fast_dag"')); assert.ok(!html.includes('class="fast-mode-icon"'));
  for (const mode of ["standard", "ptc", "fast", "pro"]) assert.ok(html.includes(`data-agent-mode="${mode}"`));
  const buttons = ["standard", "ptc", "fast", "fast_dag", "pro"].map(mode => ({ dataset: { agentMode: mode }, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }));
  const picker = { classList: { toggle() {} }, querySelectorAll: () => buttons, open: true };
  const sent = [];
  const context = { state: { selection: { kind: "live", key: "web" }, snapshot: { agentMode: "standard" } },
    el: { modePicker: picker, modeLabel: { removeAttribute() {} }, modeFeedback: { classList: { toggle() {} } },
      input: { value: "Inspect fixture" }, sub: {} },
    PRO_MODE: false, tr: text => text, readStorage: () => "standard", writeStorage() {},
    preferences: { async flush() {} }, autosize() {},
    apiFetch: async (route, options) => { const body = JSON.parse(options.body); sent.push({ route, body });
      return { ok: true, json: async () => ({ snapshot: { agentMode: body.mode } }) }; },
    postAction: async (...args) => { sent.push(args); return true; },
  };
  vm.createContext(context);
  context.renderLive = () => vm.runInContext("renderAgentMode()", context);
  const modeCode = source.slice(source.indexOf("const AGENT_MODE_LABELS"), source.indexOf("async function switchWorkspaceMode"));
  vm.runInContext(modeCode, context);
  await vm.runInContext('chooseAgentMode("fast_dag")', context);
  assert.equal(context.state.snapshot.agentMode, "fast_dag");
  assert.equal(buttons.find(b => b.dataset.agentMode === "fast_dag").attrs["aria-checked"], "true");
  const sendCode = source.slice(source.indexOf("async function sendMessage()"), source.indexOf("function autosize()"));
  vm.runInContext(sendCode, context); await vm.runInContext("sendMessage()", context);
  assert.equal(sent.at(-1)[2].agent_mode, "fast_dag");
  assert.equal(sent.at(-1)[2].text, "Inspect fixture");
  console.log("PASS fast web: real HTTP routing, selected and active modes, queued mode isolation, legacy fallback, flag, persistence, restart, TUI execution and browser card/payload");
} finally {
  releaseWorker?.(); screen?.onDeactivate();
  for (const key of sessions) hub.entries.get(key)?.agent.dispose();
  if (server) await server.close();
  LLMClient.prototype.streamTurn = originalStream; os.homedir = originalHomedir;
  fs.rmSync(fixture, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
