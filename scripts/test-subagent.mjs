// Sub-agents: a delegated task runs in its own agent loop and only its report
// comes back.
//
//   * `delegate` is offered to a parent agent and removed from a sub-agent's
//     toolset, so delegation is one level deep, never a tree,
//   * the child works in its own transcript: its system prompt is the sub-agent
//     prompt, its task stands alone, and nothing it says enters the parent's
//     context except the final report,
//   * its tool calls go through the parent's approval gate — a risky read still
//     parks the turn until the user answers,
//   * a paused parent aborts the child and says so in the tool result,
//   * a denied call is reported to the child, not retried, and the child's round
//     limit bounds the cost,
//   * the terminal and the browser sessions run the same sub-agent.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-subagent-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
// These cases are about delegation, not planning.
process.env.NEUTRINO_PLAN = "off";

const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { loadSession, loadSubAgentPrompt, saveConfig } = await import("../dist/config.js");
const { defaultState } = await import("../dist/state.js");
const { Buffer: ScreenBuffer } = await import("../dist/terminal/buffer.js");
const { DELEGATE_TOOL, getSubAgentToolDefinitions, getToolDefinitions } = await import("../dist/llm/tools.js");
const subagent = await import("../dist/llm/subagent.js");

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

const FIXTURE = path.join(testHome, "fixture.txt");
fs.writeFileSync(FIXTURE, "hello from the fixture\n", "utf8");
// Outside the session's working directory, so reading it must be approved.
const OUTSIDE = path.join(os.tmpdir(), `neutrino-outside-${process.pid}.txt`);
fs.writeFileSync(OUTSIDE, "outside content that needs approval\n", "utf8");

const APPROVED = { approved: true, source: "prompt", reason: "routine call" };
const DENIED = { approved: false, source: "prompt", reason: "the user said no" };

/** A sub-agent client that replays one script, one round per call. */
function scriptedClient(script, requests) {
  return {
    toolCalls: [],
    usage: null,
    async *streamTurn(messages, tools) {
      requests.push({ messages: structuredClone(messages), tools: (tools ?? []).map((t) => t.function.name) });
      const next = script.shift() ?? { text: "" };
      this.toolCalls = (next.calls ?? []).map((call) => ({ ...call }));
      this.usage = next.usage ?? null;
      yield next.text ?? "";
    },
  };
}

// ---------------------------------------------------------------------------
// 1. The tool catalog: delegation is for the parent only
// ---------------------------------------------------------------------------
{
  const parent = getToolDefinitions().map((tool) => tool.function.name);
  const child = getSubAgentToolDefinitions().map((tool) => tool.function.name);
  assert.ok(parent.includes(DELEGATE_TOOL), "a parent agent can delegate");
  assert.ok(!child.includes(DELEGATE_TOOL), "a sub-agent cannot delegate again");
  assert.deepEqual(
    [...child].sort(),
    ["list_files", "read_file", "run_command", "write_file"],
    "a sub-agent keeps every other tool",
  );
  const definition = getToolDefinitions().find((tool) => tool.function.name === DELEGATE_TOOL).function;
  assert.deepEqual([...definition.parameters.required].sort(), ["reason", "task"], "task and reason are required");
  assert.match(definition.description, /report/i, "the description says what comes back");
  assert.match(definition.description, /cannot see this conversation/i, "and that the task must stand alone");
}

// ---------------------------------------------------------------------------
// 2. The sub-agent loop on its own
// ---------------------------------------------------------------------------
{
  const requests = [];
  const progress = [];
  const scripts = [[
    { text: "Let me read the fixture.", calls: [{ id: "c1", name: "read_file", arguments: '{"path":"fixture.txt","reason":"read it"}' }] },
    { text: "FINAL REPORT: the fixture says hello." },
  ]];
  const result = await subagent.runSubAgent({
    createClient: () => scriptedClient(scripts[0], requests),
    system: "SUB-AGENT SYSTEM",
    task: "Task:\nread the fixture",
    tools: getSubAgentToolDefinitions(),
    approve: async () => APPROVED,
    execute: async (name, args) => `RESULT of ${name} ${JSON.stringify(args)}`,
    onProgress: (label) => progress.push(label),
  });
  assert.equal(result.aborted, false);
  assert.equal(result.exhausted, false);
  assert.equal(result.calls, 1);
  assert.equal(result.report, "FINAL REPORT: the fixture says hello.");
  assert.deepEqual(progress, ["thinking", "read_file", "thinking"], "the parent can see the child's phase");
  assert.equal(requests[0].messages[0].content, "SUB-AGENT SYSTEM", "the child gets its own system prompt");
  assert.equal(requests[0].messages[1].content, "Task:\nread the fixture");
  assert.equal(requests[1].messages.at(-1).role, "tool", "the tool result travels in the child's own transcript");
  assert.match(requests[1].messages.at(-1).content, /RESULT of read_file/);

  // A denied call is reported to the child, which is told not to retry it.
  const deniedRequests = [];
  const deniedScript = [[
    { calls: [{ id: "c1", name: "run_command", arguments: '{"command":"npm install x","reason":"install"}' }] },
    { text: "REPORT: blocked." },
  ]];
  const denied = await subagent.runSubAgent({
    createClient: () => scriptedClient(deniedScript[0], deniedRequests),
    system: "S",
    task: "T",
    tools: getSubAgentToolDefinitions(),
    approve: async () => DENIED,
    execute: async () => {
      throw new Error("a denied call must not run");
    },
  });
  assert.match(deniedRequests[1].messages.at(-1).content, /Not executed: approval denied/);
  assert.match(deniedRequests[1].messages.at(-1).content, /Do not retry this call unchanged/);
  assert.equal(denied.report, "REPORT: blocked.");

  // The round limit bounds a child that keeps asking for tools.
  const looping = [];
  const loopScript = Array.from({ length: 4 }, (_, i) => ({
    text: `round ${i + 1}, still looking`,
    calls: [{ id: `c${i}`, name: "list_files", arguments: '{"reason":"look"}' }],
  }));
  const limited = await subagent.runSubAgent({
    createClient: () => scriptedClient(loopScript, looping),
    system: "S",
    task: "T",
    tools: getSubAgentToolDefinitions(),
    approve: async () => APPROVED,
    execute: async () => "listing",
    maxRounds: 3,
  });
  assert.equal(limited.exhausted, true, "the child stops at the round limit");
  assert.equal(limited.rounds, 3);
  assert.match(subagent.formatSubAgentResult(limited), /treat this report as partial/);

  // A paused parent aborts the child mid-round.
  const abortRequests = [];
  const abortScript = [[{ text: "partial" }]];
  const aborted = await subagent.runSubAgent({
    createClient: () => scriptedClient(abortScript[0], abortRequests),
    system: "S",
    task: "T",
    tools: getSubAgentToolDefinitions(),
    approve: async () => APPROVED,
    execute: async () => "",
    cancelled: () => true,
  });
  assert.equal(aborted.aborted, true);
  assert.match(subagent.formatSubAgentResult(aborted), /stopped/i, "the parent is told the child did not report");

  // The report is clipped: the parent gets evidence, not a transcript.
  const huge = { report: "x".repeat(subagent.SUBAGENT_MAX_REPORT + 10), aborted: false, exhausted: false, rounds: 1, calls: 0 };
  assert.ok(subagent.formatSubAgentResult(huge).length < subagent.SUBAGENT_MAX_REPORT + 100);
  assert.match(subagent.formatSubAgentResult(huge), /report truncated/);

  const task = subagent.buildSubAgentTask({ task: "do the thing", context: "the user wants it small", cwd: "C:/work" });
  assert.ok(task.includes("Working directory: C:/work"));
  assert.ok(task.includes("Task:\ndo the thing"));
  assert.ok(task.includes("the user wants it small"));
  console.log("ok sub-agent: catalog, isolation, denial, round limit, abort and report shaping");
}

// ---------------------------------------------------------------------------
// 3. A delegated call in the terminal session
// ---------------------------------------------------------------------------

const calls = [];
let scripted = [];
const originalStream = LLMClient.prototype.streamTurn;
LLMClient.prototype.streamTurn = async function* (messages, tools) {
  this.toolCalls = [];
  calls.push({
    messages: JSON.parse(JSON.stringify(messages)),
    tools: (tools ?? []).map((tool) => tool.function.name),
  });
  const next = scripted.shift() ?? { text: "ok" };
  if (next.gate) await next.gate;
  this.toolCalls = (next.calls ?? []).map((call) => ({ ...call }));
  yield next.text ?? "";
};

const screens = [];

function makeScreen() {
  const screen = new ChatScreen("");
  screen.app = { width: 100, height: 32, state: defaultState(), render() {}, popScreen() {}, showToast() {} };
  screen.loadedCwd = testHome;
  screen.onActivate();
  screens.push(screen);
  return screen;
}

function delegateCall(task, extra = {}) {
  return {
    id: "d1",
    name: DELEGATE_TOOL,
    arguments: JSON.stringify({ task, reason: "survey the fixture before answering", ...extra }),
  };
}

try {
  saveConfig({ plan_first: false });

  // 3a. The child's work stays out of the parent's context; only the report returns.
  {
    calls.length = 0;
    const screen = makeScreen();
    scripted = [
      { text: "I will look that up with a sub-agent.", calls: [delegateCall("Read fixture.txt and say what it contains.")] },
      { text: "Let me read it.", calls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: FIXTURE, reason: "read the fixture" }) }] },
      { text: "SUB-AGENT REPORT: fixture.txt says 'hello from the fixture'." },
      { text: "PARENT ANSWER: the fixture says hello." },
    ];

    screen.liveSend("What does the fixture say? Use a sub-agent.");
    await waitFor(() => !screen.busy, "the delegated turn to finish");

    assert.equal(calls.length, 4, "parent round, two child rounds, parent answer");
    assert.ok(calls[0].tools.includes(DELEGATE_TOOL), "the parent is offered the delegate tool");

    // The child's conversation.
    const childFirst = calls[1];
    assert.equal(childFirst.messages[0].content, loadSubAgentPrompt(), "the child gets the sub-agent prompt");
    assert.match(childFirst.messages[1].content, /Read fixture\.txt/);
    assert.ok(childFirst.messages[1].content.includes(`Working directory: ${testHome}`), "the child knows where it works");
    assert.deepEqual(childFirst.tools.sort(), ["list_files", "read_file", "run_command", "write_file"], "the child cannot delegate");
    assert.match(calls[2].messages.at(-1).content, /hello from the fixture/, "the child saw its own tool result");

    // The parent's next round sees the report and not the child's transcript.
    const afterDelegate = calls[3].messages.map((message) => message.content ?? "").join("\n");
    assert.match(afterDelegate, /SUB-AGENT REPORT: fixture\.txt says 'hello from the fixture'/);
    assert.ok(!afterDelegate.includes("Let me read it."), "the child's intermediate text never reaches the parent");

    // The transcript records the call and its report.
    const toolMessage = screen.messages.find((message) => message.role === "tool" && message.name === DELEGATE_TOOL);
    assert.ok(toolMessage, "the delegate call is in the transcript");
    assert.match(toolMessage.result, /SUB-AGENT REPORT/);
    assert.equal(screen.subagent, null, "no sub-agent is left running");
    assert.ok(loadSession(screen.sessionId).messages.some((message) => message.result?.includes("SUB-AGENT REPORT")));
    console.log("ok tui: the sub-agent works in its own context and only the report comes back");
  }

  // 3b. A sub-agent's risky call still asks the user.
  {
    calls.length = 0;
    const screen = makeScreen();
    scripted = [
      { calls: [delegateCall("Read the outside file and report it.")] },
      { text: "Reading it.", calls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: OUTSIDE, reason: "read the file the task names" }) }] },
      { text: "SUB-AGENT REPORT: outside content that needs approval." },
      { text: "PARENT ANSWER: done." },
    ];
    screen.liveSend("Read the outside file through a sub-agent.");
    await waitFor(() => screen.pendingApproval !== null, "the sub-agent's call to need approval");
    assert.equal(screen.pendingApproval.tool, "read_file", "the user is asked about the child's call");
    assert.equal(screen.subagent, "read_file", "the status line says what the child is doing");

    // The screen explains the silence while the child works.
    screen.app.width = 100;
    screen.app.height = 32;
    const buffer = new ScreenBuffer(100, 32);
    screen.render(buffer);
    const screenRows = buffer.cells.map((row) => row.map((cell) => cell.ch).join(""));
    assert.match(screenRows[1], /Sub-agent — read_file/, "the status row names the child's phase");
    assert.ok(screenRows.some((row) => row.includes("delegate")), "the delegated call has its own tool block");
    assert.ok(
      screenRows.some((row) => row.includes("Read the outside file and report it")),
      "the block shows the task the child was given",
    );
    assert.ok(
      screenRows.some((row) => row.includes("read_file")),
      "and the live phase marker while it runs",
    );

    screen.liveApprove(true);
    await waitFor(() => !screen.busy, "the approved delegated turn to finish");
    assert.match(calls[2].messages.at(-1).content, /outside content that needs approval/, "the approved call ran");
    assert.equal(screen.pendingApproval, null);
    console.log("ok tui: a sub-agent's risky call goes through the parent's approval gate");
  }

  // 3c. Pausing the turn aborts the child and says so.
  {
    calls.length = 0;
    const screen = makeScreen();
    const gate = deferred();
    scripted = [
      { calls: [delegateCall("Take a long time.")] },
      { text: "Working on it.", gate: gate.promise },
    ];
    screen.liveSend("Delegate something slow.");
    await waitFor(() => screen.busy && screen.subagent !== null, "the child to start");
    screen.livePause();
    gate.resolve();
    await waitFor(
      () => screen.messages.some((message) => message.role === "tool" && /Sub-agent stopped/.test(message.result ?? "")),
      "the child to report that it was stopped",
    );
    assert.equal(screen.busy, false);
    assert.equal(screen.paused, true);
    assert.equal(screen.subagent, null, "the child is gone with the paused turn");
    console.log("ok tui: pausing the parent aborts the sub-agent");
  }

  // ---- browser ---------------------------------------------------------

  // 4. The browser session runs the same sub-agent.
  {
    calls.length = 0;
    const model = { name: "test", url: "", api_key: "test", supports_streaming: true };
    const session = new WebSession(
      { id: "subagent-web", provider: "test", model: "test", intensity: "High", cwd: testHome, messages: [] },
      model,
    );
    session.start();
    try {
      scripted = [
        { calls: [delegateCall("Read fixture.txt.")] },
        { text: "Reading.", calls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: FIXTURE, reason: "read it" }) }] },
        { text: "WEB SUB-AGENT REPORT: hello from the fixture" },
        { text: "PARENT ANSWER: done." },
      ];
      session.liveSend("Check the fixture with a sub-agent.");
      await waitFor(() => session.liveSnapshot().busy, "the web turn to start");
      await waitFor(() => !session.liveSnapshot().busy, "the web turn to finish");

      const snapshot = session.liveSnapshot();
      assert.equal(snapshot.subagent, null);
      const toolMessage = snapshot.messages.find((message) => message.role === "tool" && message.name === DELEGATE_TOOL);
      assert.ok(toolMessage, "the browser sees the delegated call");
      assert.match(toolMessage.result, /WEB SUB-AGENT REPORT/);
      assert.equal(calls[1].messages[0].content, loadSubAgentPrompt(), "the browser's child uses the same prompt");
      assert.deepEqual(calls[1].tools.sort(), ["list_files", "read_file", "run_command", "write_file"]);
      assert.ok(loadSession("subagent-web").messages.some((message) => message.result?.includes("WEB SUB-AGENT REPORT")));
      console.log("ok web: the browser session delegates with the same sub-agent");
    } finally {
      session.dispose();
    }
  }
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  for (const screen of screens) screen.onDeactivate();
  delete process.env.NEUTRINO_PLAN;
  fs.rmSync(OUTSIDE, { force: true });
  fs.rmSync(testHome, { recursive: true, force: true });
}

console.log("SUB-AGENT TESTS PASSED");
