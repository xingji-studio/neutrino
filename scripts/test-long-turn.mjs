// Long tasks must keep running through the model's progress messages and tool
// calls, while retaining their history and allowing the user to pause them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-long-turn-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.NEUTRINO_PLAN = "off";

const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { loadSession } = await import("../dist/config.js");

const fixture = "long-task fixture contents";
fs.writeFileSync(path.join(home, "fixture.txt"), fixture);
const model = { name: "test", url: "", api_key: "test", supports_streaming: true };
const originalStream = LLMClient.prototype.streamTurn;
const active = new Set();
let sequence = 0;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(predicate, label) {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(5);
  }
}
function create(kind) {
  let agent;
  if (kind === "terminal") {
    agent = new ChatScreen();
    agent.app = { state: {
      selectedProvider: "test", selectedModelName: model.name,
      selectedModelUrl: model.url, selectedModelApiKey: model.api_key,
      selectedModelStreaming: true, selectedIntensity: "High", cursorOn: true,
    }, render() {} };
    agent.loadedCwd = home;
    agent.onActivate();
  } else {
    agent = new WebSession({
      id: `long-turn-${++sequence}`, provider: "test", model: model.name,
      intensity: "High", cwd: home, messages: [],
    }, model);
    agent.start();
  }
  // Force the context threshold so this small fixture exercises the same
  // protection that a long real-world turn needs near its context limit.
  agent.compressThreshold = () => 500;
  active.add(agent);
  return agent;
}
function close(agent) {
  if (agent instanceof ChatScreen) agent.onDeactivate();
  else agent.dispose();
  active.delete(agent);
}
function scriptLongTurn(gate, requests) {
  let rounds = 0;
  LLMClient.prototype.streamTurn = async function* (messages) {
    rounds++;
    const round = rounds;
    requests.push(structuredClone(messages));
    if (round === 25) await gate.promise;
    this.usage = { prompt: 1000, completion: 5, total: 1005 };
    this.reasoningContent = `thinking ${round}`;
    if (round <= 28) {
      this.toolCalls = [{
        id: `call-${round}`, name: "read_file",
        arguments: JSON.stringify({ path: "fixture.txt", reason: "Inspect the task fixture" }),
      }];
      if (round === 1 || round === 24) yield `Progress ${round}`;
    } else {
      this.toolCalls = [];
      yield "The task is complete.";
    }
  };
  return () => rounds;
}

try {
  for (const kind of ["web", "terminal"]) {
    const gate = deferred();
    const requests = [];
    const rounds = scriptLongTurn(gate, requests);
    const agent = create(kind);
    try {
      agent.liveSend("Perform a long task");
      await waitFor(() => rounds() >= 25 || !agent.busy, `${kind}: reach round 25`);
      assert.equal(rounds(), 25, `${kind}: a turn must continue past 24 tool rounds`);
      assert.equal(agent.busy, true, `${kind}: progress does not end the turn`);
      assert.equal(loadSession(agent.sessionId).messages.filter(m => m.role === "tool").length, 24);
      gate.resolve();
      await waitFor(() => !agent.busy, `${kind}: complete the task`);
      assert.equal(rounds(), 29);
      const saved = loadSession(agent.sessionId);
      const tools = saved.messages.filter(m => m.role === "tool");
      assert.equal(tools.length, 28);
      assert.ok(tools.every(m => m.result === fixture), `${kind}: all tool results remain in history`);
      assert.equal(saved.messages.at(-1).content, "The task is complete.");
      assert.ok(saved.messages.some(m => m.content === "Progress 24"));

      const sent = requests.at(-1);
      const results = sent.filter(m => m.role === "tool");
      assert.equal(results.length, 28);
      assert.ok(results.slice(0, -4).every(m => m.content === "[tool output omitted to save context]"));
      assert.ok(results.slice(-4).every(m => m.content === fixture));
      for (const result of results) {
        assert.ok(sent.some(m => m.role === "assistant" && m.tool_calls?.some(c => c.id === result.tool_call_id)),
          `${kind}: every retained tool result still has its originating call`);
      }
    } finally {
      gate.resolve();
      close(agent);
    }
    console.log(`ok ${kind}: long turn reaches the final response and retains its tool history`);

    const pauseGate = deferred();
    const pauseRequests = [];
    const pauseRounds = scriptLongTurn(pauseGate, pauseRequests);
    const paused = create(kind);
    try {
      paused.liveSend("Pause a long task");
      await waitFor(() => pauseRounds() >= 25 || !paused.busy, `${kind}: pause after 24 calls`);
      assert.equal(pauseRounds(), 25, `${kind}: a long turn is still running at the pause point`);
      paused.livePause();
      pauseGate.resolve();
      await delay(50);
      assert.equal(paused.busy, false);
      assert.equal(paused.paused, true);
      assert.equal(pauseRounds(), 25, `${kind}: pause prevents any further requests`);
      const saved = loadSession(paused.sessionId);
      assert.equal(saved.messages.filter(m => m.role === "tool").length, 24);
      assert.ok(!saved.messages.some(m => m.content === "The task is complete."));
    } finally {
      pauseGate.resolve();
      close(paused);
    }
    console.log(`ok ${kind}: a long turn remains interruptible`);
  }
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  for (const agent of active) close(agent);
  fs.rmSync(home, { recursive: true, force: true });
}
