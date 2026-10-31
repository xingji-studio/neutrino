// Plan-first turns: a planner agent writes the steps, a worker agent executes
// them one at a time, and the top-right info card shows the plan as a timeline.
//
//   * the planner's answer is read leniently (bare JSON, fenced JSON, an object
//     behind a sentence, a numbered list) and anything unusable falls back to a
//     plain turn instead of failing it,
//   * each step runs on its own, in order, with the whole plan and its own step
//     in the system prompt — a step never starts before the previous one ended,
//   * the card draws pending steps lit, the running step as a highlighted row,
//     finished steps dark, top to bottom, with connectors between the nodes,
//   * a failed step stops the plan; a paused turn stops it without leaving a
//     step looking alive,
//   * the plan and its progress are saved with the session and come back on
//     reload, and
//   * the browser session plans the same way and publishes the plan.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-plan-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;

const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { Buffer: ScreenBuffer } = await import("../dist/terminal/buffer.js");
const { loadSession, saveConfig } = await import("../dist/config.js");
const { defaultState } = await import("../dist/state.js");
const plan = await import("../dist/llm/plan.js");

const { C } = await import("../dist/colors.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out: ${label}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---------------------------------------------------------------------------
// 1. Reading the planner's answer
// ---------------------------------------------------------------------------
{
  const json = JSON.stringify({
    goal: "build the scene",
    steps: [{ title: "Model the case from box.png", detail: "match the reference" }, { title: "Model the monitor" }],
  });
  let parsed = plan.parsePlan(json);
  assert.equal(parsed.steps.length, 2, "bare JSON is a plan");
  assert.equal(parsed.goal, "build the scene");
  assert.equal(parsed.steps[0].detail, "match the reference");
  assert.equal(parsed.steps[0].status, "pending", "a parsed step starts pending");

  parsed = plan.parsePlan("Sure! Here is the plan:\n```json\n" + json + "\n```\nEnjoy.");
  assert.equal(parsed?.steps.length, 2, "fenced JSON behind a sentence is still read");

  parsed = plan.parsePlan('{"steps": ["first action", "second action"]}');
  assert.deepEqual(parsed.steps.map((step) => step.title), ["first action", "second action"], "string steps are accepted");

  parsed = plan.parsePlan("1. Model the case\n2、Model the monitor\n3) Animate the camera");
  assert.equal(parsed?.steps.length, 3, "a numbered list is a usable plan");

  assert.equal(plan.parsePlan("Just one step: model it."), null, "prose without steps is not a plan");
  assert.equal(plan.parsePlan("- only one bullet"), null, "a single step is an answer, not a plan");
  assert.equal(plan.parsePlan("[Error: 401 unauthorized]"), null, "a failed planner answer is not a plan");
  assert.equal(plan.parsePlan('{"steps": []}'), null, "an empty plan is not a plan");

  const many = plan.parsePlan(JSON.stringify({ steps: Array.from({ length: 30 }, (_, i) => `step ${i}`) }));
  assert.equal(many.steps.length, plan.PLAN_MAX_STEPS, "the step count is bounded");

  assert.equal(plan.parsePlan('{"steps": [{"title": "  spaced   out  "}, {"title": "two"}]}').steps[0].title, "spaced out",
    "titles are folded into one line");
}

// ---------------------------------------------------------------------------
// 2. Prompt text built from a plan
// ---------------------------------------------------------------------------
{
  const state = {
    goal: "the scene",
    steps: [
      { title: "Model the case", detail: "use box.png", status: "pending" },
      { title: "Animate the camera", status: "pending" },
    ],
  };
  assert.equal(plan.planSpec(state), "1. Model the case\n   detail: use box.png\n2. Animate the camera");

  const message = plan.planMessage(state);
  assert.ok(message.startsWith("Plan · 2 steps"), `plan message header (got ${message.split("\n")[0]})`);
  assert.ok(message.includes("1. Model the case") && message.includes("2. Animate the camera"), "every step is listed");
  assert.ok(message.includes("1. Model the case — use box.png"), "the detail stays on the step's line");

  const directive = plan.renderStepDirective(
    "step {{index}} of {{total}} — {{step}}\n{{plan}}\n{{detail}}",
    state,
    1,
  );
  assert.ok(directive.includes("step 2 of 2"), "the index is 1-based for the model");
  assert.ok(directive.includes("Model the case"), "the whole plan is repeated");
  assert.ok(directive.includes("Animate the camera"), "including the current step");
  assert.ok(!directive.includes("{{"), "every placeholder is substituted");

  const input = plan.buildPlannerInput({ request: "do it", cwd: "C:/work", transcript: "USER: earlier" });
  assert.ok(input.includes("Working directory: C:/work"));
  assert.ok(input.includes("USER: earlier"));
  assert.ok(input.trimEnd().endsWith("Current request:\ndo it"), "the request comes last");
}

// ---------------------------------------------------------------------------
// 3. The card as a vertical timeline
// ---------------------------------------------------------------------------
{
  const state = {
    goal: "",
    steps: [
      { title: "Model the case", status: "done" },
      { title: "Model the monitor", status: "active" },
      { title: "Animate the camera", status: "pending" },
    ],
  };
  const rows = plan.planCardRows(state, { width: 50, maxRows: 20 });
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["header", "step-done", "connector", "step-active", "connector", "step-pending"],
    "one node per step, in order, joined by a connector",
  );
  assert.equal(rows[0].text, "Plan · 1/3", "the header counts finished steps");
  assert.ok(rows[1].text.startsWith("✓ 1."), "a finished step is ticked");
  assert.ok(rows[3].text.startsWith("● 2."), "the running step is the filled node");
  assert.ok(rows[5].text.startsWith("○ 3."), "a step still to come is an open node");

  state.steps[2].status = "done";
  assert.equal(plan.planCardRows(state, { width: 50, maxRows: 20 })[0].text, "Plan · 2/3", "counts follow the states");
  state.steps[2].status = "failed";
  assert.match(plan.planCardRows(state, { width: 50, maxRows: 20 })[0].text, /· failed/, "a failure shows in the header");
  state.steps[2].status = "pending";
  state.stopped = true;
  assert.match(plan.planCardRows(state, { width: 50, maxRows: 20 })[0].text, /· stopped/, "a stopped plan says so");

  // A long plan is windowed around the running step instead of being cut off at
  // the top: the reader needs to know about the steps on both sides.
  const long = {
    goal: "",
    steps: Array.from({ length: 9 }, (_, i) => ({
      title: `step number ${i + 1}`,
      status: i < 6 ? "done" : i === 6 ? "active" : "pending",
    })),
  };
  const narrow = plan.planCardRows(long, { width: 40, maxRows: 8 });
  assert.ok(narrow.length <= 8, `the card respects its row budget (got ${narrow.length})`);
  assert.ok(narrow.some((row) => row.kind === "step-active"), "the running step is always in the window");
  assert.ok(narrow.some((row) => row.kind === "more"), "steps outside the window are counted, not dropped silently");

  // Width is measured in columns, so a CJK plan cannot overflow the card.
  const cjk = { goal: "", steps: [{ title: "按照 box.png 对机箱进行建模", status: "pending" }, { title: "第二部分", status: "active" }] };
  for (const row of plan.planCardRows(cjk, { width: 24, maxRows: 10 })) {
    assert.ok(plan.planRowsWidth([row]) <= 24, `row fits its width: ${row.text}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Plan bookkeeping
// ---------------------------------------------------------------------------
{
  const saved = { goal: "", steps: [{ title: "a", status: "done" }, { title: "b", status: "active" }] };
  const restored = plan.resumePlan(saved);
  assert.equal(restored.steps[1].status, "pending", "a reloaded plan has no step running");
  assert.equal(restored.stopped, true, "and it says why it is not running");

  const fresh = { goal: "", steps: [{ title: "a", status: "pending" }] };
  assert.equal(plan.advancePlan(fresh, 0, "active"), true);
  assert.equal(fresh.steps[0].status, "active");
  assert.equal(fresh.stopped ?? false, false);
  assert.equal(plan.stopPlan(fresh), true, "stopping moves the running step back to pending");
  assert.equal(fresh.steps[0].status, "pending");
  assert.equal(fresh.stopped, true);
  assert.equal(plan.stopPlan(fresh), false, "stopping twice is a no-op");

  assert.equal(plan.lastRequestText([{ role: "user", content: "old" }, { role: "assistant", content: "x" }, { role: "user", content: "new" }]), "new");
  const transcript = plan.planTranscript([
    { role: "user", content: "first" },
    { role: "tool", name: "read_file", result: "z".repeat(2000) },
    { role: "user", content: "second" },
  ]);
  assert.ok(transcript.includes("USER: first"));
  assert.ok(transcript.includes("TOOL read_file"), "tool output is named");
  assert.ok(transcript.length < 700, `tool output is clipped (got ${transcript.length})`);
  assert.ok(!transcript.includes("second"), "the current request is not duplicated");
}

// ---------------------------------------------------------------------------
// 5. A planned turn in the terminal
// ---------------------------------------------------------------------------

const PLAN_JSON = JSON.stringify({
  goal: "build the scene",
  steps: [
    { title: "Model the case from box.png", detail: "match the size in the reference" },
    { title: "Model the monitor from vision.jpg" },
    { title: "Animate the camera", detail: "push in, orbit, pull back" },
  ],
});

const calls = [];
let scripted = [];
const originalStream = LLMClient.prototype.streamTurn;
LLMClient.prototype.streamTurn = async function* (messages, tools) {
  this.toolCalls = [];
  calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools: (tools ?? []).length });
  const next = scripted.shift() ?? { text: "ok" };
  if (next.gate) await next.gate;
  if (next.throw) throw next.throw;
  yield next.text;
};

const screens = [];

function makeScreen() {
  const screen = new ChatScreen("");
  screen.app = { width: 100, height: 32, state: defaultState(), render() {}, popScreen() {}, showToast() {} };
  screen.onActivate();
  screens.push(screen);
  return screen;
}

function draw(screen, w = 100, h = 32) {
  screen.app.width = w;
  screen.app.height = h;
  const buf = new ScreenBuffer(w, h);
  screen.render(buf);
  return buf;
}

const rows = (buf) => buf.cells.map((row) => row.map((cell) => cell.ch).join("").trimEnd());
const textOf = (buf) => rows(buf).join("\n");
const rowOf = (buf, needle) => rows(buf).findIndex((row) => row.includes(needle));
/** The cell of the first occurrence of `glyph` on the row that contains `needle`. */
function cellOf(buf, needle, glyph) {
  const y = rowOf(buf, needle);
  assert.ok(y >= 0, `row "${needle}" is on screen`);
  const row = buf.cells[y];
  const x = row.findIndex((cell) => cell.ch === glyph);
  assert.ok(x >= 0, `"${glyph}" is on the row with "${needle}"`);
  return row[x].style;
}

try {
  saveConfig({ plan_first: true });

  // 5a. The planner's steps are executed in order, one agent loop each.
  {
    calls.length = 0;
    const screen = makeScreen();
    const gate = deferred();
    scripted = [
      { text: PLAN_JSON },
      { text: "STEP-ONE-REPLY" },
      { text: "STEP-TWO-REPLY", gate: gate.promise },
      { text: "STEP-THREE-REPLY" },
    ];

    screen.liveSend("Build the case, the monitor and a camera animation");
    await waitFor(() => screen.plan?.steps[1]?.status === "active", "the second step to start");

    // The plan so far, straight from the state machine.
    assert.deepEqual(screen.plan.steps.map((step) => step.status), ["done", "active", "pending"]);
    assert.equal(screen.plan.steps[0].detail, "match the size in the reference", "details survive parsing");
    assert.equal(screen.showInfo, true, "the card opens as soon as the plan is written");

    // The plan is an ordinary message in the transcript, ahead of the work.
    const transcript = screen.messages.filter((message) => message.role !== "system");
    assert.equal(transcript[0].role, "user");
    assert.equal(transcript[1].role, "assistant");
    assert.ok(transcript[1].content.includes("Plan · 3 steps"), "the user sees the steps as a message");
    assert.ok(transcript[1].content.includes("Model the monitor from vision.jpg"));

    // The card: nodes top to bottom, three distinct states.
    const buf = draw(screen);
    const text = textOf(buf);
    assert.match(text, /Plan · 1\/3/, "the header counts the finished step");
    const y1 = rowOf(buf, "1. Model the case from box.png");
    const y2 = rowOf(buf, "2. Model the monitor from vision.jpg");
    const y3 = rowOf(buf, "3. Animate the camera");
    assert.ok(y1 >= 0 && y2 >= 0 && y3 >= 0, "every step is on the card");
    assert.ok(y1 < y2 && y2 < y3, "steps read top to bottom in execution order");
    assert.ok(rows(buf)[y1 + 1].includes("│"), "the nodes are joined by a connector");

    // Colours carry the state: done dark, running highlighted, pending lit.
    const done = cellOf(buf, "1. Model the case", "✓");
    assert.deepEqual(done.fg, C.dim, "a finished step is drawn dark");
    const active = cellOf(buf, "2. Model the monitor", "●");
    assert.deepEqual(active.fg, C.accent, "the running step is drawn in the accent colour");
    assert.deepEqual(active.bg, C.highlightBg, "on a highlighted bar");
    const pending = cellOf(buf, "3. Animate the camera", "○");
    assert.deepEqual(pending.fg, C.assistant, "a pending step stays lit");

    // Every step saw the plan and its own place in it, and nothing else ran.
    gate.resolve();
    await waitFor(() => !screen.busy, "the plan to finish");
    assert.deepEqual(screen.plan.steps.map((step) => step.status), ["done", "done", "done"]);
    assert.equal(screen.plan.stopped ?? false, false, "a finished plan is not stopped");

    assert.equal(calls.length, 4, "one planner request plus one request per step");
    assert.equal(calls[0].tools, 0, "the planner gets no tools: it only writes the plan");
    for (let i = 1; i <= 3; i++) {
      assert.ok(calls[i].tools > 0, `step ${i} runs with the tools`);
      assert.ok(calls[i].messages[0].content.includes(`step ${i} of 3`), `step ${i} is told which step it is`);
      assert.ok(calls[i].messages[0].content.includes("Model the monitor from vision.jpg"), `step ${i} sees the plan`);
      assert.ok(calls[i].messages.some((m) => m.content?.includes("Plan · 3 steps")), `step ${i} sees the plan message`);
    }

    // On screen: every node is finished and drawn dark.
    const finished = draw(screen);
    assert.match(textOf(finished), /Plan · 3\/3 · done/);
    for (const title of ["1. Model the case", "2. Model the monitor", "3. Animate the camera"]) {
      assert.deepEqual(cellOf(finished, title, "✓").fg, C.dim, `${title} is dark once finished`);
    }

    // The plan is part of the saved conversation, with its progress.
    const saved = loadSession(screen.sessionId);
    assert.equal(saved.plan.steps.length, 3);
    assert.deepEqual(saved.plan.steps.map((step) => step.status), ["done", "done", "done"]);

    // Reopening the conversation shows the same card without re-running anything.
    const reopened = new ChatScreen("");
    reopened.app = { width: 100, height: 32, state: defaultState(), render() {}, popScreen() {} };
    reopened.loadedMessages = saved.messages;
    reopened.loadedPlan = saved.plan;
    reopened.onActivate();
    screens.push(reopened);
    reopened.showInfo = true;
    const restored = textOf(draw(reopened));
    assert.match(restored, /Plan · 3\/3 · done/, "a saved plan comes back on reload");
    assert.ok(restored.includes("2. Model the monitor from vision.jpg"));

    console.log("ok tui: the planner writes the steps, the worker runs them in order, the card follows");
  }

  // 5b. A planner answer that is not a plan leaves the turn exactly as before.
  {
    calls.length = 0;
    const screen = makeScreen();
    scripted = [{ text: "I would simply answer, but here is a paragraph." }];
    screen.liveSend("say hello");
    await waitFor(() => !screen.busy, "the unplanned turn to finish");
    assert.equal(screen.plan, null, "no plan is invented");
    assert.equal(calls.length, 2, "the planner was asked once, then the worker answered directly");
    const text = textOf(draw(screen));
    assert.ok(!text.includes("Plan · "), "no plan message is added");
    assert.ok(text.includes("ok"), "the worker answered the request itself");
    console.log("ok tui: an unusable plan falls back to a plain turn");
  }

  // 5c. Planning can be turned off, by config and by the environment.
  {
    calls.length = 0;
    saveConfig({ plan_first: false });
    const screen = makeScreen();
    scripted = [{ text: "direct answer" }];
    screen.liveSend("answer directly");
    await waitFor(() => !screen.busy, "the direct turn to finish");
    assert.equal(calls.length, 1, "no planner request when planning is off");
    assert.equal(screen.plan, null);
    assert.ok(textOf(draw(screen)).includes("direct answer"));

    calls.length = 0;
    saveConfig({ plan_first: true });
    process.env.NEUTRINO_PLAN = "off";
    const envOff = makeScreen();
    scripted = [{ text: "direct again" }];
    envOff.liveSend("answer directly");
    await waitFor(() => !envOff.busy, "the env-off turn to finish");
    assert.equal(calls.length, 1, "NEUTRINO_PLAN=off wins over the config");
    delete process.env.NEUTRINO_PLAN;
    saveConfig({ plan_first: true });
    console.log("ok tui: planning is on by default and can be switched off");
  }

  // 5d. Pausing mid-plan leaves no step running.
  {
    calls.length = 0;
    const screen = makeScreen();
    const gate = deferred();
    scripted = [
      { text: PLAN_JSON },
      { text: "ONE" },
      { text: "TWO", gate: gate.promise },
      { text: "THREE" },
    ];
    screen.liveSend("build it");
    await waitFor(() => screen.plan?.steps[1]?.status === "active", "the second step to start");

    // ESC closes the card, the next two presses pause the turn.
    for (let i = 0; i < 3; i++) screen.onKey({ name: "escape", ctrl: false, meta: false, shift: false });
    assert.equal(screen.paused, true, "the turn is paused");
    assert.equal(screen.plan.steps[1].status, "pending", "a paused step is no longer marked as running");
    assert.equal(screen.plan.stopped, true, "and the plan says it stopped");

    screen.showInfo = true;
    const text = textOf(draw(screen));
    assert.match(text, /Plan · 1\/3 · stopped/, "the card explains that the plan is not running");
    assert.ok(!text.includes("●"), "nothing looks active after the pause");

    gate.resolve();
    await sleep(30);
    console.log("ok tui: pausing a plan stops it instead of leaving a step alive");
  }

  // 5e. A step that fails stops the plan; the rest is never started.
  {
    calls.length = 0;
    const screen = makeScreen();
    scripted = [
      { text: PLAN_JSON },
      { text: "", throw: new Error("provider exploded") },
      { text: "SHOULD-NOT-RUN" },
    ];
    screen.liveSend("build it");
    await waitFor(() => !screen.busy, "the failed turn to end");
    assert.deepEqual(screen.plan.steps.map((step) => step.status), ["failed", "pending", "pending"],
      "only the step that ran is marked, the rest stays for a re-plan");
    assert.equal(calls.length, 2, "a failed step stops the plan instead of continuing");
    const text = textOf(draw(screen));
    assert.match(text, /Plan · 0\/3 · failed/);
    assert.ok(!text.includes("SHOULD-NOT-RUN"));
    console.log("ok tui: a failed step stops the plan and leaves the rest pending");
  }

  // 5f. Without a plan the card is still the token card it always was.
  {
    const screen = makeScreen();
    screen.tokens = { prompt: 11, completion: 22 };
    screen.showInfo = true;
    const text = textOf(draw(screen));
    assert.ok(text.includes("Tokens"), "the token card still opens");
    assert.ok(text.includes("Prompt: 11") && text.includes("Total: 33"));
    assert.ok(!text.includes("Plan ·"), "no plan rows without a plan");
    console.log("ok tui: the card still shows token usage when nothing is planned");
  }

  // ---- browser ---------------------------------------------------------

  // 6. The browser session plans the same way and publishes the plan.
  {
    calls.length = 0;
    saveConfig({ plan_first: true });
    const model = { name: "test", url: "", api_key: "test", supports_streaming: true };
    const session = new WebSession(
      { id: "plan-web", provider: "test", model: "test", intensity: "High", cwd: process.cwd(), messages: [] },
      model,
    );
    session.start();
    try {
      scripted = [{ text: PLAN_JSON }, { text: "one" }, { text: "two" }, { text: "three" }];
      session.liveSend("build the scene");
      await waitFor(() => session.liveSnapshot().busy, "the web turn to start");
      await waitFor(() => !session.liveSnapshot().busy, "the web turn to finish");

      const snapshot = session.liveSnapshot();
      assert.equal(snapshot.busy, false);
      assert.ok(snapshot.plan, "the snapshot carries the plan for the browser to draw");
      assert.deepEqual(snapshot.plan.steps.map((step) => step.status), ["done", "done", "done"]);
      assert.ok(snapshot.messages.some((message) => message.content?.includes("Plan · 3 steps")),
        "the plan message is part of the transcript");
      assert.equal(calls.length, 4, "the browser plans once and runs three steps");

      const saved = loadSession("plan-web");
      assert.equal(saved.plan.steps.length, 3, "the browser session saves the plan too");
      console.log("ok web: plans a turn, publishes the plan and saves its progress");
    } finally {
      session.dispose();
    }
  }
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  for (const screen of screens) screen.onDeactivate();
  delete process.env.NEUTRINO_PLAN;
  fs.rmSync(testHome, { recursive: true, force: true });
}

console.log("PLAN TESTS PASSED");
