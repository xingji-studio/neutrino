// Full transcript retention, collapsed-history clicks, repeated compaction and
// resuming saved sessions, for both terminal and browser conversation runners.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-history-fold-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { Buffer: ScreenBuffer } = await import("../dist/terminal/buffer.js");
const { loadSession, saveConfig, saveModels, listSessionsForCwd } = await import("../dist/config.js");
const { updateWebSettings } = await import("../dist/web/settings.js");
const { normalizeContext } = await import("../dist/compact.js");
const { defaultState } = await import("../dist/state.js");
const { App } = await import("../dist/app.js");

saveConfig({});
const original = [
  { role: "user", content: "FIRST ORIGINAL PROMPT" },
  { role: "assistant", content: "FIRST ORIGINAL ANSWER" },
  { role: "tool", name: "read_file", arguments: { path: "fixture.txt" }, result: "TOOL START " + "x".repeat(9000) + " TOOL END" },
  ...Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? "user" : "assistant", content: `recent ${i}` })),
];
const model = { name: "test", url: "", api_key: "", supports_streaming: true };
const active = new Set();
function app() {
  return { width: 100, height: 40, state: defaultState(), render() {} };
}
function make(kind, source) {
  let runner;
  if (kind === "tui") {
    runner = new ChatScreen();
    runner.app = app();
    runner.loadedMessages = source?.messages ?? structuredClone(original);
    runner.sessionId = source?.id ?? null;
    runner.loadedContext = source?.context ?? null;
    runner.onActivate();
  } else {
    runner = new WebSession(source ?? {
      id: "fold-web", provider: "test", model: "test", intensity: "High",
      cwd: process.cwd(), messages: structuredClone(original),
    }, model);
    runner.start();
  }
  active.add(runner);
  return runner;
}
function close(runner) {
  if (runner instanceof ChatScreen) runner.onDeactivate();
  else runner.dispose();
  active.delete(runner);
}
const originalSummarize = LLMClient.prototype.summarize;
let transcripts = [];
LLMClient.prototype.summarize = async transcript => { transcripts.push(transcript); return `summary ${transcripts.length}`; };
const render = screen => {
  screen.followBottom = false;
  screen.scrollTop = 0;
  const buffer = new ScreenBuffer(100, 40);
  screen.render(buffer);
  return buffer.cells.map(row => row.map(cell => cell.ch).join("")).join("\n");
};

try {
  // Both runners use the exact provider/model, reload capacity changes in live
  // chats, and trigger precisely at 80%, preserving history through compression.
  const capacityModel = { ...model, name: "shared" };
  saveModels({ providers: [
    { name: "capacity-a", models: [{ ...capacityModel, context_window: 128000 }] },
    { name: "capacity-b", models: [{ ...capacityModel, context_window: 256000 }] },
  ] });
  for (const kind of ["tui", "web"]) {
    const runner = make(kind);
    if (kind === "tui") runner.summarizeTranscript = LLMClient.prototype.summarize;
    runner.model = capacityModel;
    if (kind === "tui") runner.modelProvider = "capacity-a";
    else runner.provider = "capacity-a";
    assert.equal(runner.compressThreshold(), 102400, `${kind}: 80% of 128K`);
    if (kind === "tui") runner.modelProvider = "capacity-b";
    else runner.provider = "capacity-b";
    assert.equal(runner.compressThreshold(), 204800, `${kind}: same model name uses the new provider's capacity`);
    updateWebSettings({ selection: { provider: "capacity-b", model: "shared", intensity: "High" }, settings: { model_context_window: 64000 } });
    assert.equal(runner.compressThreshold(), 51200, `${kind}: existing runner picks up a Settings change`);
    runner.lastPromptTokens = 51199;
    await runner.autoCompress(0);
    assert.equal(runner.context, null, `${kind}: does not compress below 80%`);
    runner.lastPromptTokens = 51200;
    await runner.autoCompress(0);
    assert.equal(runner.context.end, 4, `${kind}: compresses at exactly 80%`);
    assert.deepEqual(loadSession(runner.sessionId).messages, original);
    close(runner);
    updateWebSettings({ settings: { model_context_window: 256000 } });
  }
  saveConfig({});
  console.log("ok tui and web: model/provider capacity, live settings and exact 80% boundary");

  for (const kind of ["tui", "web"]) {
    transcripts = [];
    LLMClient.prototype.summarize = async transcript => { transcripts.push(transcript); return `summary ${transcripts.length}`; };
    const runner = make(kind);
    if (kind === "tui") runner.summarizeTranscript = LLMClient.prototype.summarize;
    runner.lastPromptTokens = 800000;
    await runner.autoCompress(0);
    const saved = loadSession(runner.sessionId);
    assert.deepEqual(saved.messages, original, `${kind}: every original message/tool result survives`);
    assert.equal(saved.context.end, 4);
    assert.equal(saved.messages[2].result.length, original[2].result.length, "large results are not truncated in history");
    assert.equal(saved.title, original[0].content, "compression must not replace the conversation title");
    assert.ok(transcripts[0].includes("FIRST ORIGINAL PROMPT"));
    assert.ok(!transcripts[0].includes("TOOL END"), "only summary input is clipped");
    assert.ok(runner.buildApiMessages().some(m => m.content.includes("summary 1")));
    assert.ok(!runner.buildApiMessages().some(m => m.content === original[0].content));
    const snapshot = runner.liveSnapshot("test");
    assert.deepEqual(snapshot.messages, original, "live clients receive complete originals");
    assert.deepEqual(snapshot.context, saved.context);

    if (kind === "tui") {
      let text = render(runner);
      assert.match(text, /▸ Earlier conversation \(4 messages\)/);
      assert.ok(!text.includes(original[0].content), "earlier messages start folded");
      runner.onMouse({ type: "click", button: 0, x: 3, y: [...runner.contextRows][0] });
      text = render(runner);
      assert.match(text, /▾ Earlier conversation/);
      assert.ok(text.includes(original[0].content), "click reveals the original user message");
      assert.ok(text.includes(original[1].content), "click reveals the original answer");
      const toolRow = [...runner.toolRows.entries()][0][0];
      runner.onMouse({ type: "click", button: 0, x: 3, y: toolRow });
      const fullText = runner.buildLines(96).flatMap(line => line.spans.map(span => span.text)).join("\n");
      assert.ok(fullText.includes("TOOL END"), "nested tool details can still reveal the complete result");
      render(runner);
      runner.onMouse({ type: "click", button: 0, x: 3, y: [...runner.contextRows][0] });
      assert.ok(!render(runner).includes(original[0].content), "a second click folds the old conversation");
    }

    // A later compaction summarizes the previous context plus new messages;
    // it never removes the first originals or overwrites their tool results.
    const newer = Array.from({ length: 4 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `new ${i}` }));
    runner.messages.push(...newer);
    runner.lastPromptTokens = 800000;
    await runner.autoCompress(0);
    assert.ok(transcripts[1].includes("summary 1"));
    assert.ok(!transcripts[1].includes(original[0].content));
    const repeated = loadSession(runner.sessionId);
    assert.deepEqual(repeated.messages, [...original, ...newer]);
    assert.equal(repeated.context.end, 8);
    assert.ok(listSessionsForCwd().some(s => s.id === repeated.id && s.message_count === 12));
    close(runner);

    const resumed = make(kind, repeated);
    assert.deepEqual(resumed.context, repeated.context);
    assert.ok(resumed.buildApiMessages().some(m => m.content.includes("summary 2")));
    if (kind === "tui") {
      assert.ok(!render(resumed).includes(original[0].content), "reopened history starts folded again");
      resumed.onMouse({ type: "click", button: 0, x: 3, y: [...resumed.contextRows][0] });
      assert.ok(render(resumed).includes(original[0].content), "reopened history expands to original text");
      resumed.onKey({ name: "l", ctrl: true, meta: false, shift: false, char: "", sequence: "" });
      resumed.startTurn = () => {};
      resumed.liveSend("a fresh conversation");
      assert.notEqual(resumed.sessionId, repeated.id, "clear starts a new session instead of overwriting old originals");
      assert.deepEqual(loadSession(repeated.id).messages, repeated.messages);
      assert.equal(loadSession(resumed.sessionId).context, undefined);
    }
    close(resumed);

    // A message arriving during summarization must not be lost or assigned to
    // the wrong folded range. Failed summaries must retain the originals too.
    const race = make(kind);
    race.lastPromptTokens = 800000;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const delayed = async () => { await pending; return "stale snapshot summary"; };
    if (kind === "tui") race.summarizeTranscript = delayed;
    else LLMClient.prototype.summarize = delayed;
    const compressing = race.autoCompress(0);
    const queued = { role: "user", content: "queued during compression" };
    race.messages.push(queued);
    release();
    await compressing;
    assert.equal(race.context, null, "a changed transcript must not receive a stale compression boundary");
    const failed = async () => { throw new Error("summary unavailable"); };
    if (kind === "tui") race.summarizeTranscript = failed;
    else LLMClient.prototype.summarize = failed;
    await race.autoCompress(0);
    assert.deepEqual(loadSession(race.sessionId).messages, [...original, queued]);
    assert.match(race.context.summary, /preserved in history/);
    close(race);
    console.log(`ok ${kind}: full originals, repeated compression, save/reload and compact model input`);
  }

  // App.loadSession must transfer the summary metadata into the chat screen.
  const source = { ...loadSession("fold-web"), context: { end: 4, summary: "persisted summary" } };
  const host = app();
  host.pushScreen = screen => { screen.app = host; screen.onActivate(); host.loaded = screen; };
  App.prototype.loadSession.call(host, source);
  active.add(host.loaded);
  assert.deepEqual(host.loaded.context, source.context);
  close(host.loaded);

  assert.equal(normalizeContext({ end: 999, summary: "bad" }, 8), null);
  assert.equal(normalizeContext({ end: -1, summary: "bad" }, 8), null);
  assert.equal(normalizeContext({ end: 1.5, summary: "bad" }, 8), null);
  assert.equal(normalizeContext({ end: 4, summary: "" }, 8), null);
  console.log("ok restored metadata and invalid boundaries cannot hide original messages");
} finally {
  LLMClient.prototype.summarize = originalSummarize;
  for (const runner of active) close(runner);
  fs.rmSync(testHome, { recursive: true, force: true });
}
