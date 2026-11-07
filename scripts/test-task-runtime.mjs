// Regression coverage of the task tree's real side effects, budgets and acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-task-runtime-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.NEUTRINO_PLAN = "off";
process.env.NEUTRINO_NETWORK_ATTEMPTS = "3";
process.env.NEUTRINO_RETRY_DELAY_MS = "1";
const { TaskRuntime, TaskControlError, currentTask, resumeTaskSnapshot } = await import("../dist/llm/runtime.js");
const { runSubAgent, formatSubAgentResult } = await import("../dist/llm/subagent.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { executeTool, getSubAgentToolDefinitions } = await import("../dist/llm/tools.js");
const { ProAgentTeam } = await import("../dist/pro/agents.js");
const { ACTIVE_PRO_ROLES } = await import("../dist/pro/config.js");
const { preparePlan, finishPlanStep, settlePlan, resumePlan } = await import("../dist/llm/plan.js");
const { estimateTokens } = await import("../dist/llm/context.js");
const allowed = async () => ({ approved: true, source: "prompt", reason: "test" });
const model = { name: "fixture-model", url: "https://fixture.invalid/v1", api_key: "fixture", supports_streaming: true };
const call = (name, args, id = "T1") => ({ id, name, arguments: JSON.stringify(args) });
const event = (text = "", calls = []) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content: text, tool_calls: calls.map((tool, index) => ({ index, id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments } })) } }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "Content-Type": "text/event-stream" } },
);
const originalFetch = globalThis.fetch;
const originalStream = LLMClient.prototype.streamTurn;
const client = () => new LLMClient(model, "Fixture", "High");
const base = { system: "Work on the delegated task", task: "Inspect the fixture", tools: getSubAgentToolDefinitions(), createClient: client, approve: allowed, execute: (name, args) => executeTool(name, args, home) };
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "test timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
try {
  // Cancellation reaches a running shell tree and drain waits for its closure.
  if (process.platform !== "win32") {
    const ready = path.join(home, "ready");
    const marker = path.join(home, "must-not-exist");
    const code = `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'),300)`;
    const command = `${quote(process.execPath)} -e ${quote(code)}`;
    const runtime = new TaskRuntime({ request: "Execute a bounded fixture", cwd: home, journalDir: path.join(home, "journal") });
    const running = runtime.run(() => runtime.tool("run_command", { command }, () => executeTool("run_command", { command }, home)));
    await waitFor(() => fs.existsSync(ready));
    runtime.cancel("Paused by user");
    await runtime.drain();
    assert.match(await running, /cancelled/);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(fs.existsSync(marker), false, "the cancelled subprocess cannot write later");
    assert.equal(runtime.evidence[0].status, "cancelled");
    runtime.finish("cancelled");
    assert.equal(runtime.snapshot().state, "cancelled");
    assert.ok(fs.readFileSync(runtime.snapshot().journal, "utf8").includes('"tool_finished"'));
  }
  if (process.platform !== "win32") {
    const command = `${quote(process.execPath)} -e ${quote("process.stdout.write('x'.repeat(30000));process.exit(2)")}`;
    const runtime = new TaskRuntime({ request: "Retain command failures", cwd: home });
    const output = await runtime.run(() => runtime.tool("run_command", { command }, () => executeTool("run_command", { command }, home)));
    assert.ok(output.length <= 20000);
    assert.match(output, /\[exit code: 2\]$/);
    assert.equal(runtime.evidence[0].status, "failed", "large stdout cannot hide the exit status");
    runtime.finish("partial");
  }
  // A root deadline also cancels tools carrying a separate program signal.
  if (process.platform !== "win32") {
    const marker = path.join(home, "deadline-must-not-write");
    const code = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad'),750)`;
    const command = `${quote(process.execPath)} -e ${quote(code)}`;
    const runtime = new TaskRuntime({ request: "Bound execution time", cwd: home, limits: { durationMs: 500 } });
    const program = new AbortController();
    const result = await runtime.run(() => runtime.tool("run_command", { command }, () => executeTool("run_command", { command }, home, program.signal)));
    assert.match(result, /cancelled/);
    assert.equal(program.signal.aborted, false, "the program controller is independent");
    await runtime.drain();
    assert.equal(fs.existsSync(marker), false);
    runtime.finish("cancelled");

    const parent = new TaskRuntime({ request: "A local cancellation must preserve parent ownership", cwd: home });
    let localStop = false;
    const local = await runSubAgent({ ...base, runtime: parent, cancelled: () => localStop,
      execute: async (name, args) => {
        setTimeout(() => { localStop = true; }, 50);
        return executeTool(name, args, home);
      },
      createClient: () => ({ toolCalls: [], async *streamTurn() { this.toolCalls = [call("run_command", { command, reason: "test" })]; } }),
    });
    assert.equal(local.status, "cancelled");
    assert.equal(parent.signal.aborted, false);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(parent.evidence[0].status, "cancelled");
    await parent.run(() => parent.tool("write_file", { path: "parent-continues", content: "ok" }, () => executeTool("write_file", { path: "parent-continues", content: "ok" }, home)));
    assert.equal(fs.readFileSync(path.join(home, "parent-continues"), "utf8"), "ok");
    parent.finish("completed");
  }
  console.log("ok runtime: cancellation stops real process-tree side effects and preserves the journal");

  // A failed provider completion preserves evidence of writes already completed.
  let requests = 0;
  globalThis.fetch = async () => ++requests === 1
    ? event("I will write the fixture.", [call("write_file", { path: "result.txt", content: "written", reason: "test" })])
    : new Response("invalid request", { status: 400 });
  const failed = await runSubAgent(base);
  assert.equal(failed.status, "partial");
  assert.equal(failed.error.code, "model_error");
  assert.equal(failed.evidenceIds.length, 1);
  assert.equal(fs.readFileSync(path.join(home, "result.txt"), "utf8"), "written");
  assert.match(formatSubAgentResult(failed), /write_file.*result.txt/);
  assert.match(formatSubAgentResult(failed), /HTTP 400/);

  requests = 0;
  globalThis.fetch = async () => ++requests === 1
    ? event("I will inspect it.", [call("read_file", { path: "result.txt", reason: "test" })]) : event();
  const empty = await runSubAgent(base);
  assert.equal(empty.status, "partial");
  assert.equal(empty.error.code, "empty_completion");
  assert.equal(requests, 3, "an empty response gets only one retry");
  assert.ok(!empty.report.includes("I will inspect it"), "a stale promise is not reused as a final report");
  assert.equal(empty.evidenceIds.length, 1);

  let stopped = false;
  const cancelled = await runSubAgent({ ...base, cancelled: () => stopped, createClient: () => ({
    toolCalls: [], async *streamTurn() { stopped = true; },
  }) });
  assert.equal(cancelled.status, "cancelled", "a stream closed without yielding still checks cancellation");
  let deniedRound = 0;
  const dishonest = await runSubAgent({ ...base,
    approve: async () => ({ approved: false, source: "human", reason: "Do not edit" }),
    execute: async () => { throw new Error("Denied writes must not execute"); },
    createClient: () => ({ toolCalls: [], async *streamTurn() {
      this.toolCalls = ++deniedRound === 1
        ? [call("write_file", { path: "denied.txt", content: "bad", reason: "test" })]
        : [call("finish_task", { status: "completed", report: "Everything completed", reason: "test" })];
    } }),
  });
  assert.equal(dishonest.status, "blocked", "a completion claim cannot override a recorded denial");
  assert.equal(fs.existsSync(path.join(home, "denied.txt")), false);
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: {
    content: "Partial output", tool_calls: [{ id: "cut", function: { name: "write_file", arguments: JSON.stringify({ path: "truncated.txt", content: "bad", reason: "test" }) } }],
  } }] }), { headers: { "Content-Type": "application/json" } });
  const truncated = await runSubAgent(base);
  assert.equal(truncated.status, "failed");
  assert.equal(truncated.error.code, "output_limit");
  assert.equal(fs.existsSync(path.join(home, "truncated.txt")), false, "a truncated completion never executes tool calls");
  console.log("ok runtime: provider failures, empty completions and silent cancellation retain correct result states");

  // The final report request also fits its capacity; full tool output stays in evidence.
  let compressed = false;
  let finalMessages;
  let round = 0;
  const runtime = new TaskRuntime({ request: "Do not modify protected.txt", cwd: home });
  const wrapped = await runSubAgent({ ...base, runtime, maxRounds: 2, contextWindow: 8000,
    execute: async () => "x".repeat(60000),
    createClient: () => ({
      toolCalls: [], usage: null,
      async summarize() { compressed = true; return "The large fixture was inspected."; },
      async *streamTurn(messages, tools) {
        if (++round === 1) this.toolCalls = [call("read_file", { path: "large.txt", reason: "test" })];
        else { assert.equal(tools.length, 0); finalMessages = structuredClone(messages); yield "Partial report: inspected the fixture."; }
      },
    }),
  });
  assert.equal(wrapped.status, "partial");
  assert.equal(compressed, true);
  assert.ok(estimateTokens(finalMessages) < 8000);
  assert.ok(finalMessages[0].content.includes("Do not modify protected.txt"));
  assert.equal(runtime.evidence[0].result.length, 60000);
  runtime.finish("partial");

  const tooLarge = await runSubAgent({ ...base, task: "x".repeat(10000), contextWindow: 1000 });
  assert.equal(tooLarge.error.code, "context_capacity");
  console.log("ok runtime: wrap-up compression preserves constraints and full evidence; oversized briefs fail before inference");

  let sent;
  globalThis.fetch = async (_url, init) => { sent = JSON.parse(init.body); return event("ok"); };
  await new LLMClient({ ...model, name: "o4-mini" }, "OpenAI", "high", { professional: true }).complete("system", "test", { maxOutputTokens: 32 });
  assert.equal(sent.max_completion_tokens, 32);
  assert.equal("max_tokens" in sent, false);
  await client().complete("system", "test", { maxOutputTokens: 32 });
  assert.equal(sent.max_tokens, 32);
  // Every actual retry, summary, review-style completion and final request shares the ledger.
  requests = 0;
  globalThis.fetch = async () => { requests++; return new Response("busy", { status: 503 }); };
  const budget = new TaskRuntime({ request: "Bound all inference", limits: { modelRequests: 4 } });
  await budget.run(() => client().complete("work", "request", { retry: { attempts: 5, baseDelayMs: 1 } }));
  assert.equal(requests, 3, "one request is reserved for final reporting");
  globalThis.fetch = async () => { requests++; return event("Final partial report"); };
  assert.equal(await budget.run(() => client().complete("report", "summarize evidence", { final: true })), "Final partial report");
  assert.equal(requests, 4);
  assert.equal(budget.snapshot().counts.modelRequests, 4);
  await budget.run(() => client().summarize("reviewed evidence"));
  assert.equal(requests, 4, "summaries cannot bypass exhausted request capacity");
  budget.finish("partial");

  const tiny = new TaskRuntime({ request: "Bound tokens", limits: { tokens: 10 } });
  await tiny.run(() => client().complete("system", "request"));
  assert.equal(requests, 4, "token capacity is reserved before sending a request");
  tiny.finish("partial");
  console.log("ok runtime: retries and auxiliary requests cannot bypass shared request/token budgets");

  const models = Object.fromEntries(ACTIVE_PRO_ROLES.map(role => [role, {
    role, provider: "Fixture", tier: "medium", intensity: "high", context_window: 128000,
    model: { ...model, name: role },
  }]));
  let serial = 0;
  let runs = 0;
  LLMClient.prototype.streamTurn = async function* (messages) {
    this.toolCalls = [];
    if (messages.length === 2) {
      runs++;
      this.toolCalls = Array.from({ length: 3 }, () => call("call_pro_agent", { role: "thinking_model", task: `Unique branch ${++serial}`, reason: "test" }, `B${serial}`));
    } else yield "Branch report";
  };
  const treeBudget = new TaskRuntime({ request: "Bound the whole delegation tree", limits: { agentRuns: 7 } });
  const team = new ProAgentTeam({ models, runtime: treeBudget, maxDepth: 8, cwd: home, cancelled: () => false, approve: allowed, execute: async () => "unused" });
  await team.call("thinking_model", "begin tree");
  assert.equal(runs, 7);
  assert.equal(treeBudget.snapshot().counts.agentRuns, 7);
  treeBudget.finish("partial");

  const scope = new TaskRuntime({ request: "Never edit protected.txt", cwd: home, readOnly: true });
  let nested = false;
  let executions = 0;
  LLMClient.prototype.streamTurn = async function* (messages, tools) {
    this.toolCalls = [];
    assert.ok(messages[0].content.includes("Never edit protected.txt"));
    assert.ok(!tools.some(tool => ["write_file", "run_command"].includes(tool.function.name)));
    if (messages.length === 2 && this.model.name === "backend_output_model") {
      this.toolCalls = [call("call_pro_agent", { role: "thinking_model", task: "Inspect", read_only: false, reason: "test" })];
    } else if (messages.length === 2) {
      nested = true;
      this.toolCalls = [call("write_file", { path: "protected.txt", content: "bad", reason: "test" })];
    } else yield "No changes were allowed.";
  };
  await new ProAgentTeam({ models, runtime: scope, maxDepth: 4, cwd: home, cancelled: () => false, approve: allowed, execute: async () => { executions++; return "bad"; } }).call("backend_output_model", "Inspect only");
  assert.equal(nested, true);
  assert.equal(executions, 0);
  scope.finish("completed");

  const writes = new TaskRuntime({ request: "Modify allowed directory", cwd: home, writePaths: ["allowed"] });
  await writes.run(() => writes.child("worker", "narrow paths", async () => {
    assert.throws(() => writes.assertTool("write_file", { path: "outside.txt" }), /allowed write paths/);
    assert.throws(() => writes.assertTool("run_command", { command: "echo bad" }), /Arbitrary command/);
    writes.assertTool("write_file", { path: "allowed/result.txt" });
    assert.equal(currentTask().policy.writePathGroups.length, 2);
  }, { writePaths: ["."] }));
  writes.finish("completed");
  console.log("ok runtime: branching stays bounded and original constraints/read-only/write scope survive nested delegation");

  // Accepting a step requires explicit, real references; stopping a reply is insufficient.
  const acceptance = new TaskRuntime({ request: "Deliver two steps", cwd: home });
  const plan = preparePlan({ goal: "Deliver", steps: [{ title: "First", status: "active" }, { title: "Second", status: "pending" }] });
  await acceptance.run(async () => {
    assert.match(finishPlanStep(plan, { step_id: "step-2", status: "done", summary: "bad", deliverable: "Second" }, acceptance), /dependencies/);
    assert.match(finishPlanStep(plan, { step_id: "step-1", status: "done", summary: "bad", evidence_ids: ["invented"] }, acceptance), /missing/);
    assert.match(finishPlanStep(plan, { step_id: "step-1", status: "done", summary: "bad", artifact_paths: ["missing.txt"] }, acceptance), /missing artifact/);
    assert.match(finishPlanStep(plan, { step_id: "step-1", status: "done", summary: "First delivered", deliverable: "The actual first report" }, acceptance), /"done"/);
    await acceptance.child("reviewer", "cannot accept own work", async () => {
      assert.match(finishPlanStep(plan, { step_id: "step-2", status: "done", summary: "bad", deliverable: "bad" }, acceptance), /root coordinator/);
    });
  });
  settlePlan(plan);
  assert.deepEqual(plan.steps.map(step => step.status), ["done", "blocked"]);
  assert.deepEqual(resumePlan(structuredClone(plan)).steps.map(step => step.status), ["done", "blocked"]);
  assert.equal(resumeTaskSnapshot({ ...acceptance.snapshot(), state: "running" }).state, "partial");
  acceptance.finish("partial");
  console.log("ok runtime: step acceptance rejects invented evidence, incomplete dependencies and child self-approval");

  // Exercise the actual Pro session with mock providers, without opening a port.
  LLMClient.prototype.streamTurn = originalStream;
  const { seedProPresets } = await import("./pro-presets.mjs");
  const { saveModels, loadSession, deleteSession, saveConfig, loadConfig } = await import("../dist/config.js");
  const { WebSession } = await import("../dist/web/session.js");
  seedProPresets();
  saveModels({ providers: [{ name: "Fixture", models: [model] }] });
  let acceptSteps = false;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { headers: { "Content-Type": "application/json" } });
    if (body.messages[0].content.includes("You are Neutrino Pro's planning specialist")) return event(JSON.stringify({ goal: "Two reports", steps: [{ title: "First report" }, { title: "Second report" }] }));
    const results = body.messages.filter(message => message.role === "tool");
    if (acceptSteps && results.length < 2) return event("", [call("finish_step", { step_id: `step-${results.length + 1}`, status: "done", summary: "Report delivered", deliverable: `Actual report ${results.length + 1}`, reason: "Accept the requested report" }, `S${results.length}`)]);
    return event(acceptSteps ? "Both reports delivered." : "Blocked: missing required credentials. No changes were made.");
  };
  for (const success of [false, true]) {
    acceptSteps = success;
    const id = success ? "accepted-plan" : "blocked-plan";
    const session = new WebSession({ id, provider: "Fixture", model: model.name, intensity: "xhigh", cwd: home, messages: [], pro_preset: "medium" }, model, "pro");
    session.start();
    try {
      session.liveSend("Produce two text reports");
      await waitFor(() => !session.liveMeta().busy && session.liveMeta().task?.state !== "running");
      const snapshot = session.liveSnapshot(session.key);
      assert.deepEqual(snapshot.plan.steps.map(step => step.status), success ? ["done", "done"] : ["blocked", "pending"]);
      const saved = loadSession(id, "pro");
      assert.equal(saved.task_run.state, success ? "completed" : "partial");
      assert.ok(fs.existsSync(saved.task_run.journal));
      assert.equal(snapshot.task.counts.modelRequests, success ? 5 : 3, "preflight, planner and main use the same request ledger");
      session.dispose();
      assert.equal(deleteSession(id, "pro"), true);
      session.taskRuntime.recordTool("read_file", { path: "late" }, "late cleanup", "cancelled");
      assert.equal(fs.existsSync(saved.task_run.journal), false, "late callbacks cannot recreate deleted evidence logs");

    } finally { session.dispose(); }
  }
  saveConfig({ ...loadConfig(), task_timeout_ms: 100 });
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (init.signal.aborted) abort(); else init.signal.addEventListener("abort", abort, { once: true });
  });
  const timed = new WebSession({ id: "timed-task", provider: "Fixture", model: model.name, intensity: "High", cwd: home, messages: [] }, model);
  timed.start();
  timed.liveSend("Stop this task at its deadline");
  await waitFor(() => !timed.liveMeta().busy && timed.liveMeta().task?.state === "cancelled");
  assert.match(timed.liveSnapshot(timed.key).messages.at(-1).content, /Task time budget exceeded/);
  assert.ok(!timed.liveSnapshot(timed.key).messages.at(-1).content.includes("empty completion"));
  timed.dispose();
  const { ChatScreen } = await import("../dist/screens/chat.js");
  for (const kind of ["web", "terminal"]) {
    const owner = kind === "web" ? new WebSession({ id: "approval-deadline", provider: "Fixture", model: model.name, intensity: "High", cwd: home, messages: [] }, model) : new ChatScreen();
    if (kind === "terminal") owner.app = { state: { approval: null }, render() {}, showToast() {} };
    const runtime = new TaskRuntime({ request: "Inspect with manual approval", cwd: home, limits: { durationMs: 100 } });
    const watchdog = setTimeout(() => {}, 1000);
    const decision = await runtime.run(() => owner.requestApproval("read_file", { path: path.join(home, "..", "outside.txt"), reason: "Read requested evidence" }, { prompt: "Inspect with manual approval", priorUserRequests: [], context: "" }));
    clearTimeout(watchdog);
    assert.equal(runtime.signal.aborted, true);
    assert.equal(decision.approved, false);
    assert.equal(owner.pendingApproval, null);
    if (kind === "terminal") assert.equal(owner.app.state.approval, null, "a cancelled approval clears the terminal header too");
    else owner.dispose();
    runtime.finish("cancelled");
  }
  console.log("ok runtime: Pro session persists real step outcomes and budgets preflight/planning/main together");
  console.log("TASK RUNTIME TESTS PASSED");
} finally {
  globalThis.fetch = originalFetch;
  LLMClient.prototype.streamTurn = originalStream;
  fs.rmSync(home, { recursive: true, force: true });
}
