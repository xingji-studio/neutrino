// Read-only product diagnosis. Uses disposable local fixtures and the real
// compiled drivers/browser functions; no provider, command, or live service calls.
// Run after `npm run build`; --assert-healthy turns the observations into regressions.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-silent-stop-"));
process.env.NEUTRINO_HOME = path.join(fixture, "home");
process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
process.env.HOME = fixture;
process.env.USERPROFILE = fixture;
process.env.NEUTRINO_PLAN = "off";
const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("External access disabled in diagnosis"); };

const findings = [];
let screen;
let bridges;
let runtime;
try {
  const { ChatScreen } = await import("../dist/screens/chat.js");
  const { defaultState } = await import("../dist/state.js");
  const { hub } = await import("../dist/web/hub.js");
  const { TerminalBridges } = await import("../dist/web/terminalBridge.js");
  const { TaskRuntime, resumeTaskSnapshot } = await import("../dist/llm/runtime.js");
  const { StandardTask } = await import("../dist/llm/standard.js");
  const { captureApprovalContext } = await import("../dist/llm/approval.js");
  const { turnFolds, turnAnswerIndex } = await import("../web/turns.js");
  const { loadSession, listSessions } = await import("../dist/config.js");
  const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  const take = name => {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert(start >= 0, `Browser function ${name} must exist`);
    const end = source.indexOf("\n}", start);
    assert(end > start, `Browser function ${name} must be complete`);
    return source.slice(start, end + 2);
  };

  screen = new ChatScreen();
  screen.app = { state: defaultState(), render() {}, bell() {} };
  screen.onActivate();
  const terminalKey = screen.liveKey;
  assert(hub.has(terminalKey));
  screen.messages.push({ role: "user", content: "Build a local fixture service" });
  screen.busy = true;
  screen.onDeactivate();
  const registeredAfterDetach = hub.has(terminalKey);
  screen.onActivate();
  findings.push({
    id: "terminal-view-lifetime",
    reproduced: screen.busy && !registeredAfterDetach && !hub.has(screen.liveKey),
    observed: { busy: screen.busy, registeredAfterDetach, registeredAfterReactivate: hub.has(screen.liveKey) },
    invariant: "A running executor remains discoverable independently of its terminal view",
  });
  screen.busy = false;
  screen.checkpoint.dispose();

  const mirrored = {
    key: "terminal:fixture", cwd: fixture, sessionId: "bridge-fixture", title: "fixture",
    provider: "Fixture", model: "fixture", intensity: "High", busy: true,
    paused: false, queued: null, compressing: false, tokens: { prompt: 0, completion: 0 },
    messages: [], streamingContent: null,
  };
  let disconnected = false;
  globalThis.fetch = async () => {
    if (disconnected) throw new Error("Injected bridge disconnect");
    return { ok: true, json: async () => [{ mode: "standard", snapshot: mirrored }] };
  };
  bridges = new TerminalBridges();
  clearInterval(bridges.timer); // Drive the real poll deterministically, without wall-clock delays.
  bridges.add(123456, { url: "http://fixture.invalid", token: "fixture-only" });
  await new Promise(resolve => setImmediate(resolve));
  const firstKey = hub.list().find(entry => entry.sessionId === "bridge-fixture")?.key;
  assert(firstKey, "Initial mirror must register");
  disconnected = true;
  for (let i = 0; i < 3; i++) await bridges.poll(123456);
  assert(hub.has(firstKey), "The fixture must survive the first three failures");
  await bridges.poll(123456);
  const existsAfterFourFailures = hub.has(firstKey);
  if (process.argv.includes("--assert-healthy")) assert.equal(hub.snapshot(firstKey)?.connection, "disconnected");
  disconnected = false;
  await bridges.poll(123456);
  const recoveredKey = hub.list().find(entry => entry.sessionId === "bridge-fixture")?.key;
  assert(recoveredKey, "The fixture must recover after connectivity returns");
  findings.push({
    id: "bridge-disconnect-deletes-identity",
    reproduced: !existsAfterFourFailures && firstKey !== recoveredKey,
    observed: { existsAfterFourFailures, firstKey, recoveredKey, executorStillBusy: mirrored.busy },
    invariant: "Transport failure cannot destroy execution identity or imply task completion",
  });
  bridges.close();
  bridges = undefined;
  globalThis.fetch = async () => { networkAttempts++; throw new Error("External access disabled in diagnosis"); };

  let renderOptions;
  const browser = vm.createContext({
    state: { snapshot: null, overview: { live: [] } },
    el: { title: {}, sub: {} },
    tr: value => value, firstUserMessage: () => "fixture", preferences: { showConversation() {} },
    proUI: null, renderMessageList: (_messages, _streaming, options) => { renderOptions = options; },
    renderFileControls() {}, maybeOpenPlan() {}, renderPlanCard() {},
  });
  vm.runInContext(["statusOfLive", "sessionStatus", "renderFile"].map(take).join("\n"), browser);
  runtime = new TaskRuntime({ request: "Build the original service", cwd: fixture });
  const interrupted = resumeTaskSnapshot(runtime.snapshot());
  const messages = [{ role: "user", content: "Build the original service" }];
  for (let i = 0; i < 4; i++) messages.push({ role: "assistant", content: `Progress ${i}` });
  messages.push({ role: "assistant", content: "Now writing the remaining modules" });
  messages.push({ role: "tool", name: "write_file", arguments: { path: "cache.js" }, result: "" });
  browser.renderFile({ id: "saved-fixture", messages, task_run: interrupted });
  const savedStatus = browser.sessionStatus({ id: "saved-fixture", liveKey: null, task_state: interrupted.state });
  const livePartialStatus = browser.statusOfLive({ busy: false, task: interrupted });
  findings.push({
    id: "unfinished-history-displayed-as-done",
    reproduced: savedStatus === "done" && livePartialStatus === "done" && !renderOptions.active && turnFolds(messages),
    observed: {
      persistedTaskState: interrupted.state, savedStatus, livePartialStatus,
      activeLastTurn: renderOptions.active, lastTurnFolds: turnFolds(messages),
      visibleReply: messages[turnAnswerIndex(messages)].content,
      finalToolHasResult: Boolean(messages.at(-1).result),
    },
    invariant: "An interrupted task stays visibly incomplete and retains its unfinished tool context",
  });
  runtime.finish("partial");
  runtime = undefined;

  // Execute the real terminal runTurn and its TaskRuntime construction. Replace
  // only model work with an observer; no request, tool or approval is executed.
  const original = "Build a local service, implement caching, and verify all endpoints";
  const continued = [{ role: "user", content: original }, { role: "user", content: "开始？" }];
  const approval = captureApprovalContext(continued);
  let acceptance;
  screen.runTaskTurn = async function () {
    const standard = new StandardTask(this.taskRuntime);
    acceptance = {
      request: this.taskRuntime.originalRequest,
      requirements: standard.state.requirements.map(item => item.text),
      earlierRequests: [...this.taskRuntime.priorUserRequests],
    };
    this.taskOutcome = "partial";
  };
  screen.messages = continued.slice(0, 1);
  await screen.runTurn(screen.turnToken, screen.messages.slice(), captureApprovalContext(screen.messages));
  screen.messages = continued;
  await screen.runTurn(screen.turnToken, continued, approval);
  assert(acceptance, "The real terminal driver must construct the task");
  const saved = loadSession(screen.sessionId);
  assert(saved?.task_run, "The isolated task checkpoint must be persisted");
  const summary = listSessions().find(item => item.id === screen.sessionId);
  assert(summary, "The isolated session must appear in the real history index");
  findings.push({
    id: "continuation-replaces-acceptance-objective",
    reproduced: acceptance.request === "开始？" && acceptance.requirements.join("\n") === "开始？",
    observed: { ...acceptance, historyIndexIncludesTaskState: "task_run" in summary || "task_state" in summary },
    invariant: "Continue preserves the unfinished task specification separately from the current approval message",
  });
  assert.equal(networkAttempts, 0, "Diagnosis must not contact a provider or a live service");
  console.log(JSON.stringify({
    kind: process.argv.includes("--assert-healthy") ? "regression validation" : "current diagnosis", externalRequests: networkAttempts,
    findings, reproduced: findings.filter(f => f.reproduced).length, checks: findings.length,
  }, null, 2));
  if (process.argv.includes("--assert-healthy")) assert.deepEqual(findings.filter(f => f.reproduced).map(f => f.id), [], "Silent-stop defects must not recur");
} finally {
  globalThis.fetch = previousFetch;
  bridges?.close();
  runtime?.finish("partial");
  if (screen) {
    screen.busy = false;
    screen.onDeactivate();
    screen.checkpoint.dispose();
  }
  // Only the verified temporary fixture is removed; never real session data.
  fs.rmSync(fixture, { recursive: true, force: true });
}
