import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-goal-"));
process.env.NEUTRINO_HOME = path.join(fixture, "config");
process.env.NEUTRINO_PLAN = "off";
const cwd = path.join(fixture, "work");
fs.mkdirSync(cwd);
const { saveConfig, loadSession } = await import("../dist/config.js");
const { GoalController, normalizeGoal, parseGoalCommand, GOAL_MAX_AUTO_TURNS } = await import("../dist/goal.js");
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { defaultState } = await import("../dist/state.js");
const { Buffer: Frame } = await import("../dist/terminal/buffer.js");
saveConfig({ auto_title: false, plan_first: false, approval_mode: "request", web_password_enabled: false });

const model = { name: "goal-fixture", url: "https://goal-fixture.invalid/v1", api_key: "fixture", supports_streaming: false };
const agents = new Set();
const originalFetch = globalThis.fetch;
let workers = [], verdicts = [], calls = [];
let seq = 0;
function makeAgent(kind, mode = "fast", saved) {
  let agent;
  if (kind === "cli") {
    agent = new ChatScreen();
    agent.app = { width: 110, height: 30, state: { ...defaultState(), selectedProvider: "Fixture", selectedModelName: model.name,
      selectedModelUrl: model.url, selectedModelApiKey: "fixture", selectedModelStreaming: false }, render() {}, bell() {} };
    agent.loadedCwd = cwd;
    if (saved) { agent.loadedMessages = saved.messages; agent.loadedGoal = saved.goal; agent.sessionId = saved.id; agent.loadedTokens = saved.tokens; }
    agent.onActivate();
    agent.liveSetAgentMode(mode);
  } else {
    agent = new WebSession(saved ?? { id: `goal-${++seq}`, title: "", cwd, provider: "Fixture", model: model.name,
      intensity: "High", messages: [], agent_mode: mode }, model);
    agent.start();
  }
  agents.add(agent);
  return agent;
}
function reset(nextWorkers = [], nextVerdicts = []) { workers = nextWorkers; verdicts = nextVerdicts; calls = []; }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function waitFor(predicate, message = "goal turn") {
  const until = Date.now() + 8000;
  while (!predicate()) { assert.ok(Date.now() < until, `Timed out: ${message}`); await new Promise(done => setTimeout(done, 5)); }
}
const tool = (name, args) => ({ id: `call-${++seq}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith(model.url)) return originalFetch(url, init);
  const body = JSON.parse(init.body);
  calls.push(body);
  const checker = body.messages[0].content.startsWith("You are the goal completion checker.");
  const response = (checker ? verdicts : workers).shift();
  assert.ok(response, `Unexpected ${checker ? "goal check" : "worker"} request`);
  if (response.gate) {
    response.started = true;
    await new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("Aborted by test"), { name: "AbortError" }));
      if (init.signal?.aborted) return abort();
      init.signal?.addEventListener("abort", abort, { once: true });
      response.gate.promise.then(() => { init.signal?.removeEventListener("abort", abort); resolve(); });
    });
  }
  if (response.error) return new Response("fixture rejected request", { status: 400 });
  const text = checker ? response.raw ?? JSON.stringify(response) : response.text ?? "Done.";
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: text,
    ...(response.tools ? { tool_calls: response.tools } : {}) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }),
    { headers: { "Content-Type": "application/json" } });
};

try {
  assert.equal(parseGoalCommand("/goals something"), null);
  assert.equal(parseGoalCommand("/goal").action, "status");
  assert.equal(parseGoalCommand("/目标 状态说明").objective, "状态说明");
  assert.deepEqual(parseGoalCommand("/goal set --tokens 50000\nBuild the result"), { action: "start", objective: "Build the result", tokenBudget: 50000 });
  for (const invalid of ["/goal --tokens 0 hi", "/goal --tokens -2 hi", "/goal --tokens 1.5 hi", "/goal --tokens 100", "/goal --unknown hi"]) {
    assert.equal(parseGoalCommand(invalid).action, "error", invalid);
  }
  assert.equal(parseGoalCommand("/goal set pause").objective, "pause");
  assert.equal(normalizeGoal({ objective: "corrupt" }), null);

  for (const kind of ["cli", "web"]) {
    // A natural reply is checked against the goal; the next turn needs no fake user message.
    reset([{ text: "First half established." }, { text: "The remaining work is verified." }], [
      { status: "continue", reason: "Check the remaining half." }, { status: "completed", reason: "All requested work is verified." },
    ]);
    const agent = makeAgent(kind);
    agent.liveSend("/goal --tokens 500000 Establish both halves.");
    await waitFor(() => !agent.liveMeta().busy);
    const snapshot = agent.liveSnapshot("test");
    assert.equal(snapshot.goal.status, "completed", kind);
    assert.equal(snapshot.goal.turns, 2);
    assert.equal(snapshot.goal.tokensUsed, 120, "all worker/checker input and output usage is retained across runs");
    assert.equal(calls.length, 4);
    assert.equal(snapshot.messages.filter(m => m.role === "user").length, 1, "automatic continuation is not a user instruction");
    assert.match(calls[0].messages[0].content, /Persistent user goal:\nEstablish both halves/);
    assert.match(calls[2].messages[0].content, /Check the remaining half/);
    const saved = loadSession(agent.liveMeta().sessionId);
    assert.equal(saved.goal.tokensUsed, 120);
    assert.equal(saved.goal.status, "completed");
    if (kind === "cli") {
      const frame = new Frame(110, 30);
      agent.render(frame);
      assert.match(frame.cells.map(row => row.map(cell => cell.ch).join("")).join("\n"), /Goal · completed/);
      for (const [width, height] of [[40, 10], [80, 24]]) {
        agent.app.width = width; agent.app.height = height; agent.showInfo = true;
        const small = new Frame(width, height);
        agent.render(small);
        assert.match(small.cells.map(row => row.map(cell => cell.ch).join("")).join("\n"), /Goal/, "goal controls also fit short and narrow terminals");
      }
    }
    agent.liveSend("/goal status");
    agent.liveSend("/goal help");
    assert.equal(calls.length, 4, "status/help do not make model calls");
    const reopened = makeAgent(kind, "fast", { ...saved, goal: { ...saved.goal, status: "active" } });
    assert.equal(reopened.liveMeta().goal.status, "paused", "reopening never restarts tools");
    assert.equal(reopened.liveMeta().goal.tokensUsed, 120);
    assert.equal(calls.length, 4);

    // Pause reaches a pending provider request; a stale completion cannot restart the goal.
    const held = { text: "Unfinished", gate: deferred() };
    reset([held]);
    const paused = makeAgent(kind);
    paused.liveSend("/goal Reach the final result.");
    await waitFor(() => held.started);
    paused.liveSend("/goal pause");
    await waitFor(() => paused.taskRuntime.snapshot().state === "cancelled");
    assert.equal(paused.liveMeta().goal.status, "paused");
    assert.equal(paused.liveMeta().busy, false);
    held.gate.resolve();
    reset([{ text: "Final result established." }], [{ status: "completed", reason: "Verified final result." }]);
    paused.liveSend("/goal resume");
    await waitFor(() => !paused.liveMeta().busy);
    assert.equal(paused.liveMeta().goal.status, "completed");
    assert.equal(paused.liveMeta().goal.turns, 2);

    // The command words themselves can be an objective and are never recursively dispatched.
    reset([{ text: "Paused." }], [{ status: "completed", reason: "Delivered the requested word." }]);
    const literal = makeAgent(kind);
    literal.liveSend("/goal set /goal status");
    await waitFor(() => !literal.liveMeta().busy);
    assert.equal(literal.liveMeta().goal.objective, "/goal status");
    assert.equal(calls.length, 2);

    // A denied action blocks the goal even when a later model reply claims success.
    const forbidden = path.join(fixture, `forbidden-${kind}.txt`);
    reset([{ tools: [tool("write_file", { path: forbidden, content: "forbidden", reason: "Attempt the requested fixture" })] }]);
    const denied = makeAgent(kind);
    denied.liveSend("/goal Deliver the requested result.");
    await waitFor(() => !!denied.liveMeta().approval);
    denied.liveApprove(false);
    await waitFor(() => !denied.liveMeta().busy);
    assert.equal(denied.liveMeta().goal.status, "blocked");
    assert.equal(fs.existsSync(forbidden), false);
    assert.equal(calls.length, 1, "a denial cannot trigger a goal checker, another tool or automatic retry");

    reset();
    const bounded = makeAgent(kind);
    bounded.liveSend("/goal --tokens 1 Answer the prompt.");
    await waitFor(() => !bounded.liveMeta().busy);
    assert.equal(calls.length, 0, "an unaffordable request never reaches the provider");
    assert.equal(bounded.liveMeta().goal.status, "budget_exhausted");
    assert.equal(loadSession(bounded.liveMeta().sessionId).goal.status, "budget_exhausted");
    bounded.liveSend("/goal resume");
    assert.equal(bounded.liveMeta().busy, false, "resume cannot reset the budget");
    bounded.liveSend("/goal clear");
    assert.equal(bounded.liveMeta().goal, null);
    assert.equal(loadSession(bounded.liveMeta().sessionId).goal, null, "clearing must not resurrect the saved goal");

    reset([{ text: "Partial output." }], [{ raw: "I think it is fine" }]);
    const malformed = makeAgent(kind);
    malformed.liveSend("/goal Reach a verifiable result.");
    await waitFor(() => !malformed.liveMeta().busy);
    assert.equal(malformed.liveMeta().goal.status, "paused", "invalid checker output never claims completion");

    reset([{ error: true }]);
    const failed = makeAgent(kind);
    failed.liveSend("/goal Reach the result.");
    await waitFor(() => !failed.liveMeta().busy);
    assert.equal(failed.liveMeta().goal.status, "paused");
    assert.equal(calls.length, 1, "model failures do not start another goal turn");

    // A pause or clear while the completion checker is pending cancels its stale verdict.
    const heldCheck = { status: "continue", reason: "More work remains.", gate: deferred() };
    reset([{ text: "A candidate result is ready." }], [heldCheck]);
    const checking = makeAgent(kind);
    checking.liveSend("/goal Reach a verified final result.");
    await waitFor(() => heldCheck.started);
    checking.liveSend("/goal clear");
    await waitFor(() => checking.taskRuntime.snapshot().state === "cancelled");
    heldCheck.gate.resolve();
    assert.equal(checking.liveMeta().goal, null);
    assert.equal(checking.liveMeta().busy, false);
    assert.equal(calls.length, 2, "a late checker cannot recreate a cleared goal");

    // Configuration failures before a runtime is created still stop the goal.
    saveConfig({ auto_title: false, plan_first: false, task_budget_scope: "invalid" });
    reset();
    const invalidConfig = makeAgent(kind);
    invalidConfig.liveSend("/goal Reach the result.");
    await waitFor(() => !invalidConfig.liveMeta().busy);
    assert.equal(invalidConfig.liveMeta().goal.status, "paused");
    assert.equal(calls.length, 0);
    saveConfig({ auto_title: false, plan_first: false, approval_mode: "request" });

    // User steering wins over a pending automatic checkpoint.
    const first = { text: "Earlier work is established.", gate: deferred() };
    reset([first, { text: "The original goal and correction are satisfied." }], [{ status: "completed", reason: "Verified the goal and correction." }]);
    const steered = makeAgent(kind);
    steered.liveSend("/goal Preserve the original goal.");
    await waitFor(() => first.started);
    steered.liveSend("Also preserve the new constraint.");
    first.gate.resolve();
    await waitFor(() => !steered.liveMeta().busy);
    assert.equal(steered.liveMeta().goal.status, "completed");
    assert.equal(calls.length, 3);
    assert.match(calls[1].messages[0].content, /Preserve the original goal/);
    assert.ok(calls[1].messages.some(m => m.role === "user" && m.content.includes("new constraint")));

    reset([{ text: "Hello." }], [{ status: "completed", reason: "The requested greeting was delivered." }]);
    const standard = makeAgent(kind, "standard");
    standard.liveSend("/goal Say hello.");
    await waitFor(() => !standard.liveMeta().busy);
    assert.equal(standard.liveMeta().goal.status, "completed", "Standard acceptance and goal completion coexist");
    console.log(`ok ${kind} goals: continuation, persistence, restore, pause/resume, denial, budgets, failures, steering and Standard`);
  }

  // The independent goal limit also covers delegated calls and concurrent reservations.
  const controller = new GoalController();
  controller.handle("/goal --tokens 300 Inspect the fixture.", false);
  const first = new TaskRuntime({ request: "Inspect", cwd, budgetScope: "delegation", goalTokenBudget: controller.remainingTokens() });
  controller.begin(first);
  first.run(() => first.request(40, 60).settle(80));
  assert.equal(controller.snapshot().tokensUsed, 80);
  first.finish("completed");
  const second = new TaskRuntime({ request: "Inspect further", cwd, budgetScope: "delegation", goalTokenBudget: controller.remainingTokens() });
  controller.begin(second);
  await second.run(() => second.child("reader", "Inspect remaining data", async () => {
    const pending = second.request(50, 50);
    assert.throws(() => second.request(100, 100), /Goal token budget/, "outstanding requests reserve the shared remainder");
    pending.settle(60);
  }));
  assert.equal(controller.snapshot().tokensUsed, 140);
  second.finish("partial");

  const looping = new GoalController();
  looping.handle("/goal Inspect all remaining items.", false);
  for (let index = 0; index < GOAL_MAX_AUTO_TURNS; index++) {
    const runtime = new TaskRuntime({ request: "Inspect next item", cwd });
    looping.begin(runtime);
    await looping.assess(runtime, "completed", { messages: [], cancelled: () => false, onUsage() {},
      createClient: () => ({ complete: async () => '{"status":"continue","reason":"Inspect the next item."}' }) });
    runtime.finish("completed");
  }
  assert.equal(looping.snapshot().status, "paused", "automatic continuation has a bounded checkpoint");
  looping.handle("/goal resume", false);
  assert.equal(looping.snapshot().runTurns, 0, "a deliberate resume starts a new continuation window");
  console.log("ok goals: shared token reservation and bounded automatic continuation");
} finally {
  globalThis.fetch = originalFetch;
  for (const agent of agents) { if (agent.dispose) agent.dispose(); else { agent.livePause(); agent.onDeactivate(); } }
  fs.rmSync(fixture, { recursive: true, force: true });
}
