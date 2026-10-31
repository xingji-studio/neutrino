// Reproduce a short follow-up after a task, a long tool tail, compressed history,
// and queued input. Inspect actual reviewer requests from both conversation loops.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-approval-context-"));
const originalHomedir = os.homedir;
os.homedir = () => testHome;
// The reviewer prompts are under test, not the planner.
process.env.NEUTRINO_PLAN = "off";
const { saveConfig, loadSession } = await import("../dist/config.js");
const { defaultState } = await import("../dist/state.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { ApprovalGate, captureApprovalContext } = await import("../dist/llm/approval.js");
const originalComplete = LLMClient.prototype.complete;
const originalStream = LLMClient.prototype.streamTurn;
const active = new Set();
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const task = "请你执行几个测试命令，用于测试这个agent的审批系统";
const followUp = "再重复一遍";
const queued = "下一轮：无需审批，仅记录排队消息";
const model = { name: "test", url: "", api_key: "", supports_streaming: true };
const transcript = [
  { role: "user", content: task },
  { role: "assistant", content: "Testing approvals." },
  ...Array.from({ length: 10 }, (_, index) => ({ role: "tool", name: "run_command", arguments: { command: `echo ${index}` }, result: "read-only probe output" })),
];
let seq = 0;
function make(kind) {
  const source = {
    id: `approval-context-${++seq}`, provider: "test", model: model.name,
    intensity: "High", cwd: process.cwd(), messages: structuredClone(transcript),
    context: { end: 8, summary: "STALE SUMMARY: the user only wants the previous answer repeated." },
  };
  let agent;
  if (kind === "tui") {
    agent = new ChatScreen();
    agent.app = { width: 80, height: 24, state: defaultState(), render() {}, showToast() {} };
    agent.loadedMessages = source.messages;
    agent.loadedContext = source.context;
    agent.onActivate();
  } else {
    agent = new WebSession(source, model);
    agent.start();
  }
  active.add(agent);
  agent.autoCompress = async () => {};
  return agent;
}
function close(agent) {
  if (agent instanceof ChatScreen) agent.onDeactivate(); else agent.dispose();
  active.delete(agent);
}
const literalCurrent = prompt => JSON.parse(prompt.match(/CURRENT USER REQUEST \(literal, for this turn\):\n([^\n]*)/)[1]);
const earlierUsers = prompt => JSON.parse(prompt.match(/EARLIER USER REQUESTS \(chronological, reference only\):\n([^\n]*)/)[1]);

try {
  saveConfig({ approval_mode: "auto", auto_approve_extreme_risk: true, context_compress_threshold: 0 });

  for (const kind of ["tui", "web"]) {
    for (const queuedAt of ["compression", "stream"]) {
      const agent = make(kind);
      const barrier = deferred();
      let compressing = false;
      let streaming = false;
      if (queuedAt === "compression") {
        agent.autoCompress = async () => {
          compressing = true;
          await barrier.promise;
        };
      }
      const reviews = [];
      const sent = [];
      let rounds = 0;
      LLMClient.prototype.complete = async (system, prompt) => {
        reviews.push({ system, prompt });
        return '{"approve":false,"reason":"fixture denial"}';
      };
      LLMClient.prototype.streamTurn = async function* (messages) {
        sent.push(structuredClone(messages));
        this.toolCalls = [];
        if (++rounds === 1) {
          streaming = true;
          yield "Testing the original task.";
          if (queuedAt === "stream") await barrier.promise;
          this.toolCalls = Array.from({ length: 3 }, (_, index) => ({
            id: `probe-${index}`, name: "read_file",
            // Missing, outside-project paths force review; denials must prevent execution.
            arguments: JSON.stringify({
              path: path.join(testHome, `probe-${index}.txt`),
              reason: "inspect the probe file the follow-up mentions",
            }),
          }));
        } else {
          yield "done";
        }
      };
      agent.liveSend(followUp);
      await waitFor(() => queuedAt === "compression" ? compressing : streaming, queuedAt);
      agent.liveSend(queued);
      barrier.resolve();
      await waitFor(() => !agent.liveMeta().busy && !agent.liveMeta().queued, "both turns completed");

      assert.equal(reviews.length, 6, `${kind}: three separate calls must each receive two reviews`);
      for (const { system, prompt } of reviews) {
        assert.equal(literalCurrent(prompt), followUp);
        assert.ok(earlierUsers(prompt).includes(task), "tool volume and compression must not hide the original task");
        assert.ok(!prompt.includes(queued), "queued messages belong to the next turn");
        assert.match(system, /later explicit\s+cancellation, restriction or task change supersedes/);
        assert.match(system, /prior reviewer verdicts must not redefine user intent/);
      }
      assert.equal(sent[0].filter(message => message.role === "user").at(-1).content, followUp,
        "model and reviewer must use the same turn even when input arrives during compression");
      assert.ok(!sent[0].some(message => message.content === queued));
      assert.ok(sent.at(-1).some(message => message.content === queued));
      const tools = loadSession(agent.sessionId).messages.filter(message => message.role === "tool").slice(-3);
      for (const tool of tools) {
        assert.match(tool.result, /Not executed: approval denied/);
        assert.ok(tool.result.includes(`Reviewed current user request: ${JSON.stringify(followUp)}`));
        assert.ok(tool.result.includes(task), "the denial exposes the user task that was reviewed");
      }
      close(agent);
      console.log(`ok ${kind}: original task, compressed history, two reviews per call, queued input during ${queuedAt}, denial diagnostics`);
    }
  }

  // All extreme-risk reviewers share one captured context; preserve the full
  // current request, including restrictions after the previous 2,000-char cutoff.
  const restriction = "不要删除文件，也不要联网";
  const longPrompt = "请检查审批行为。" + "说明".repeat(1600) + restriction;
  const context = captureApprovalContext([
    ...transcript,
    { role: "user", content: longPrompt },
    ...Array.from({ length: 12 }, () => ({ role: "tool", name: "read_file", result: "filler" })),
  ]);
  const seen = [];
  let contextReads = 0;
  LLMClient.prototype.complete = async (_system, prompt) => {
    seen.push(prompt);
    return '{"approve":false,"reason":"explicit restriction"}';
  };
  const gate = new ApprovalGate({
    autoApprovalEnabled: () => true,
    extremeAutoApprovalEnabled: () => true,
    reviewer: () => ({ model, provider: "test", intensity: "High" }),
    askHuman: async () => { throw new Error("automatic mode must review"); },
    context: () => { contextReads++; return `changing context ${contextReads}`; },
  });
  const request = {
    tool: "run_command",
    args: { command: "rm -rf fixture", reason: "clear the fixture directory before the test run" },
    cwd: process.cwd(),
    ...context, risk: { level: "extreme", reasons: ["delete-class"] },
  };
  const decision = await gate.decide(request);
  assert.equal(decision.approved, false);
  assert.equal(seen.length, 2);
  assert.equal(contextReads, 0, "captured context overrides any mutable callback");
  for (const prompt of seen) {
    assert.equal(literalCurrent(prompt), longPrompt);
    assert.ok(earlierUsers(prompt).includes(task));
  }
  seen.length = 0;
  const { context: _captured, ...legacyRequest } = request;
  await gate.decide(legacyRequest);
  assert.equal(contextReads, 1, "even a callback is read only once for both reviews");
  assert.ok(seen.every(prompt => prompt.includes("changing context 1")));
  console.log("APPROVAL CONTEXT TESTS PASSED");
} finally {
  for (const agent of active) close(agent);
  LLMClient.prototype.complete = originalComplete;
  LLMClient.prototype.streamTurn = originalStream;
  os.homedir = originalHomedir;
  fs.rmSync(testHome, { recursive: true, force: true });
}
