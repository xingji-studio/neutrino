// Exercise real chat/web loops with a controlled stream, isolated from user
// history and model providers. In particular, never let a test save to HOME.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-persistence-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// Persistence and interruption, not planning, are under test here.
process.env.NEUTRINO_PLAN = "off";

const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { SESSION_DIR, loadSession, listSessionsForCwd, saveSession } = await import("../dist/config.js");
const { CHECKPOINT_MS, flushSessionCheckpoints } = await import("../dist/persistence.js");
const { Buffer: ScreenBuffer } = await import("../dist/terminal/buffer.js");
assert.ok(SESSION_DIR.startsWith(home + path.sep), "history must be isolated");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
async function waitFor(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await sleep(10);
  }
}

const model = { name: "test", url: "", api_key: "do-not-persist", supports_streaming: true };
const active = new Set();
let seq = 0;
function runner(kind) {
  let agent;
  if (kind === "tui") {
    agent = new ChatScreen();
    agent.app = {
      state: {
        selectedProvider: "test", selectedModelName: model.name,
        selectedModelUrl: model.url, selectedModelApiKey: model.api_key,
        selectedModelStreaming: true, selectedIntensity: "High", cursorOn: true,
      },
      render() {},
    };
    agent.onActivate();
  } else {
    agent = new WebSession({
      id: `persistence-web-${++seq}`, provider: "test", model: model.name,
      intensity: "High", cwd: process.cwd(), messages: [],
    }, model);
    agent.start();
  }
  agent.autoCompress = async () => {};
  agent.compressThreshold = () => 0;
  active.add(agent);
  return agent;
}
function close(agent) {
  if (agent instanceof ChatScreen) agent.onDeactivate();
  else agent.dispose();
  active.delete(agent);
}
const originalStream = LLMClient.prototype.streamTurn;
const read = agent => loadSession(agent.sessionId);

try {
  for (const kind of ["tui", "web"]) {
    // A new history entry must exist while the very first reply is in flight.
    const finish = deferred();
    LLMClient.prototype.streamTurn = async function* () {
      yield "partial reply";
      await finish.promise;
      yield " completed";
    };
    const agent = runner(kind);
    agent.liveSend("first prompt");
    assert.ok(agent.sessionId, `${kind}: immediate session id`);
    assert.equal(read(agent).messages[0].content, "first prompt");
    assert.ok(listSessionsForCwd().some(s => s.id === agent.sessionId));
    await waitFor(() => agent.streamingContent === "partial reply", "partial reply");
    await sleep(CHECKPOINT_MS + 80);
    assert.equal(read(agent).messages.at(-1).content, "partial reply", `${kind}: trailing checkpoint`);
    assert.equal(agent.messages.filter(m => m.role === "assistant").length, 0, "checkpoint must not mutate live messages");
    assert.equal(JSON.stringify(read(agent)).includes(model.api_key), false);

    // Flush newer output synchronously, before the timer has a chance to run.
    agent.streamingContent = "latest unsaved reply";
    assert.equal(flushSessionCheckpoints(), true);
    assert.equal(read(agent).messages.at(-1).content, "latest unsaved reply");
    finish.resolve();
    await waitFor(() => !agent.busy, "completed reply");
    assert.deepEqual(read(agent).messages.filter(m => m.role === "assistant").map(m => m.content), ["partial reply completed"], `${kind}: no duplicate partial reply`);

    // Failed writes stay visible, and preserve the previous valid transcript.
    const file = path.join(SESSION_DIR, agent.sessionId + ".json");
    const previous = fs.readFileSync(file, "utf8");
    const rename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error("disk access denied"), { code: "EACCES" }); };
    try {
      agent.messages.push({ role: "user", content: "not yet saved" });
      agent.save();
      assert.match(agent.liveMeta().saveError, /disk access denied/);
      assert.equal(fs.readFileSync(file, "utf8"), previous);
      assert.equal(fs.readdirSync(SESSION_DIR).some(f => f.endsWith(".tmp")), false);
      if (kind === "tui") {
        const buf = new ScreenBuffer(100, 30);
        agent.render(buf);
        assert.match(buf.cells[1].map(c => c.ch).join(""), /History save failed/);
      }
    } finally {
      fs.renameSync = rename;
    }
    agent.save();
    assert.equal(agent.liveMeta().saveError, null);
    assert.equal(read(agent).messages.at(-1).content, "not yet saved");
    close(agent);

    // An old stream must not erase/duplicate a partial reply after pause/resume.
    const oldFinish = deferred();
    const oldStopped = deferred();
    const newFinish = deferred();
    let turns = 0;
    LLMClient.prototype.streamTurn = async function* () {
      if (++turns === 1) {
        try {
          yield "paused partial";
          await oldFinish.promise;
          yield "stale data";
        } finally { oldStopped.resolve(); }
      } else {
        yield "new reply";
        await newFinish.promise;
      }
    };
    const paused = runner(kind);
    paused.liveSend("before pause");
    await waitFor(() => paused.streamingContent === "paused partial", "before pause");
    paused.livePause();
    assert.equal(read(paused).messages.at(-1).content, "paused partial");
    paused.liveSend("after pause");
    paused.liveResume();
    await waitFor(() => paused.streamingContent === "new reply", "new stream");
    oldFinish.resolve();
    await oldStopped.promise;
    assert.equal(paused.streamingContent, "new reply");
    newFinish.resolve();
    await waitFor(() => !paused.busy, "new reply completed");
    assert.deepEqual(read(paused).messages.filter(m => m.role === "assistant").map(m => m.content), ["paused partial", "new reply"]);
    close(paused);

    // Preserve an in-flight tool and its result before the next model finishes.
    const approve = deferred();
    const nextFinish = deferred();
    let requested = false;
    let rounds = 0;
    const toolFile = path.join(home, "tool.txt");
    fs.writeFileSync(toolFile, "saved tool output");
    LLMClient.prototype.streamTurn = async function* () {
      if (++rounds === 1) {
        yield "reading file";
        this.toolCalls = [{ id: "call-1", name: "read_file", arguments: JSON.stringify({ path: toolFile }) }];
      } else {
        yield "after tool";
        await nextFinish.promise;
      }
    };
    const tool = runner(kind);
    tool.requestApproval = async () => {
      requested = true;
      await approve.promise;
      return { approved: true, source: "prompt", reason: "test" };
    };
    tool.liveSend("read the fixture");
    await waitFor(() => requested, "tool awaiting approval");
    assert.equal(read(tool).messages.at(-1).role, "tool");
    approve.resolve();
    await waitFor(() => tool.streamingContent === "after tool", "tool result");
    assert.equal(read(tool).messages.find(m => m.role === "tool").result, "saved tool output");
    nextFinish.resolve();
    await waitFor(() => !tool.busy, "tool turn finished");
    close(tool);
    console.log(`ok ${kind}: immediate history, partial/exit checkpoints, pause races, tools, save failures`);
  }

  // Simulate a disk write that stops halfway through the new JSON.
  const id = saveSession([{ role: "user", content: "original" }], "test", "test", "High");
  const file = path.join(SESSION_DIR, id + ".json");
  const previous = fs.readFileSync(file, "utf8");
  const write = fs.writeFileSync;
  fs.writeFileSync = (target, ...args) => {
    if (typeof target === "number") {
      fs.writeSync(target, "{incomplete");
      throw new Error("disk full");
    }
    return write(target, ...args);
  };
  try {
    assert.throws(() => saveSession([{ role: "user", content: "replacement" }], "test", "test", "High", process.cwd(), id), /disk full/);
    assert.equal(fs.readFileSync(file, "utf8"), previous);
    assert.equal(fs.readdirSync(SESSION_DIR).some(f => f.endsWith(".tmp")), false);
  } finally {
    fs.writeFileSync = write;
  }
  console.log("ok atomic session writes preserve the previous history on a partial write");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  for (const agent of active) close(agent);
  fs.rmSync(home, { recursive: true, force: true });
}
