// Ordinary conversation must outlive delegation quotas; explicit task limits remain strict.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-task-budget-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.NEUTRINO_PLAN = "off";
const { TaskRuntime, taskBudgetScope } = await import("../dist/llm/runtime.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { runSubAgent } = await import("../dist/llm/subagent.js");
const { finalTaskReport } = await import("../dist/llm/context.js");
const { executeTool, getSubAgentToolDefinitions } = await import("../dist/llm/tools.js");
const { saveConfig, loadConfig, loadSession } = await import("../dist/config.js");
const { WebSession } = await import("../dist/web/session.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const originalFetch = globalThis.fetch;
const model = { name: "budget-fixture", url: "https://fixture.invalid/v1", api_key: "fixture", supports_streaming: true };
const client = () => new LLMClient(model, "Fixture", "High");
const allowed = async () => ({ approved: true, source: "prompt", reason: "Fixture" });
const call = (name, args, id = "T1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const event = (content, calls = []) => new Response(
  `data: ${JSON.stringify({ choices: [{ delta: { content, tool_calls: calls.map((item, index) => ({ index, ...item })) } }] })}\n\ndata: [DONE]\n\n`,
  { headers: { "Content-Type": "text/event-stream" } },
);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, "fixture timed out"); await delay(10); }
}
const subagent = { system: "Inspect evidence", task: "Inspect the fixture", tools: [], createClient: client,
  approve: allowed, execute: async () => { throw new Error("Unexpected tool"); } };

try {
  assert.equal(taskBudgetScope({}), "delegation");
  assert.equal(taskBudgetScope(loadConfig()), "delegation");
  assert.equal(taskBudgetScope({ task_budget_scope: "task" }), "task");
  assert.throws(() => taskBudgetScope({ task_budget_scope: "typo" }), /task_budget_scope/);

  // Repeated large prompts in the main conversation do not consume the child's quota.
  let requests = 0;
  globalThis.fetch = async () => { requests++; return event("Complete"); };
  const ordinary = new TaskRuntime({ request: "Finish the original work", budgetScope: "delegation",
    limits: { modelRequests: 2, toolCalls: 1, tokens: 10, durationMs: 30 } });
  await ordinary.run(async () => {
    for (let i = 0; i < 3; i++) {
      assert.equal(await client().complete("system", "large repeated history ".repeat(200), { maxOutputTokens: 32 }), "Complete");
      assert.equal(await ordinary.tool("read_file", { path: "fixture" }, async () => "Evidence"), "Evidence");
    }
    await delay(40);
    const child = await runSubAgent({ ...subagent, runtime: ordinary });
    assert.equal(child.status, "blocked");
    assert.equal(child.error.code, "token_budget", "the child clock starts at delegation, not at the root turn");
    assert.equal(requests, 3, "a child over its own quota never reaches the provider");
    assert.equal(await client().complete("system", "Continue locally", { maxOutputTokens: 32 }), "Complete");
  });
  const usage = ordinary.snapshot();
  assert.equal(usage.counts.modelRequests, 4);
  assert.equal(usage.counts.toolCalls, 3);
  assert.ok(usage.counts.tokens > 10);
  assert.deepEqual(usage.delegatedCounts, { modelRequests: 0, toolCalls: 0, tokens: 0 });
  assert.equal(usage.budgetStop.used, 0, "root spending cannot starve a later child");
  assert.equal(ordinary.signal.aborted, false);
  ordinary.finish("completed");
  assert.equal(ordinary.snapshot().state, "completed");
  console.log("ok budgets: repeated root prompts, tool calls and elapsed time do not stop ordinary conversation");

  const tree = new TaskRuntime({ request: "Bound all descendants", budgetScope: "delegation",
    limits: { modelRequests: 3, toolCalls: 1 } });
  await tree.run(async () => {
    await client().complete("system", "Root work", { maxOutputTokens: 32 });
    await tree.child("worker", "First branch", async () => {
      await client().complete("system", "Child work", { maxOutputTokens: 32 });
      await tree.tool("read_file", {}, async () => "Child evidence");
      await tree.child("reviewer", "Nested branch", async () => {
        await client().complete("system", "Nested work", { maxOutputTokens: 32 });
        const blocked = client();
        await blocked.complete("system", "No fresh quota", { maxOutputTokens: 32 });
        assert.equal(blocked.outcome.error.code, "request_budget");
        await assert.rejects(tree.tool("read_file", {}, async () => "Must not run"), /tool-call budget/);
      });
    });
    assert.equal(await client().complete("system", "Finish locally", { maxOutputTokens: 32 }), "Complete");
    await tree.tool("read_file", {}, async () => "Parent still runs");
  });
  assert.equal(tree.snapshot().delegatedCounts.modelRequests, 2);
  assert.equal(tree.snapshot().delegatedCounts.toolCalls, 1);
  assert.equal(tree.snapshot().counts.modelRequests, 4);
  assert.ok(tree.snapshot().delegatedCounts.tokens > 0);
  tree.finish("completed");
  console.log("ok budgets: nested agents share request, token and tool counters while the parent can finish locally");

  // The delegated deadline aborts an actual command, without aborting its parent.
  if (process.platform !== "win32") {
    const marker = path.join(home, "must-not-write");
    const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
    const code = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'bad'),400)`;
    const command = `${quote(process.execPath)} -e ${quote(code)}`;
    const timed = new TaskRuntime({ request: "Keep the main task alive", cwd: home, budgetScope: "delegation", limits: { durationMs: 200 } });
    globalThis.fetch = async () => event("Inspecting", [call("run_command", { command, reason: "Fixture" })]);
    const result = await runSubAgent({ ...subagent, runtime: timed, tools: getSubAgentToolDefinitions(),
      execute: (name, args) => executeTool(name, args, home) });
    assert.equal(result.status, "partial");
    assert.equal(result.error.code, "duration_budget");
    assert.equal(result.aborted, false, "budget exhaustion is not a user cancellation");
    assert.equal(timed.signal.aborted, false);
    assert.equal(timed.evidence[0].status, "cancelled");
    await assert.rejects(timed.child("worker", "Fresh branch", async () => {}), /time budget/);
    await timed.run(() => timed.tool("write_file", {}, async () => "Root continues"));
    await delay(450);
    assert.equal(fs.existsSync(marker), false);
    timed.finish("completed");
  }
  console.log("ok budgets: a shared child deadline cancels real side effects and preserves the parent");

  let reportingRequest;
  globalThis.fetch = async (_url, init) => { reportingRequest = JSON.parse(init.body); return event("Verified all 365 records; remaining work: export the chart."); };
  const strict = new TaskRuntime({ request: "Verify records and export the chart", limits: { modelRequests: 2 }, journalDir: path.join(home, "journal") });
  await strict.run(async () => {
    await client().complete("system", "Initial work", { maxOutputTokens: 32 });
    strict.recordTool("run_command", { command: "verify.py" }, "== source records\n365 records passed the independent mapping check", "completed");
    const stopped = client();
    await stopped.complete("system", "Export the chart", { maxOutputTokens: 32 });
    assert.equal(stopped.outcome.error.code, "request_budget");
    const report = await finalTaskReport(strict, client, undefined, [{ role: "assistant", content: "Cross-check completed; export is the only remaining step." }]);
    assert.match(report, /request_budget; scope=task; used=1; limit=2/);
    assert.match(reportingRequest.messages[1].content, /365 records passed the independent mapping check/);
    assert.match(reportingRequest.messages[1].content, /export is the only remaining step/);
  });
  assert.equal(strict.snapshot().counts.modelRequests, 2);
  assert.match(fs.readFileSync(strict.snapshot().journal, "utf8"), /"type":"budget_stopped"/);
  strict.finish("partial");

  const tiny = new TaskRuntime({ request: "Strict tiny cap", limits: { tokens: 10, agentRuns: 1 } });
  await tiny.run(async () => {
    await tiny.child("worker", "First child", async () => {});
    await assert.rejects(tiny.child("worker", "Over agent quota", async () => {}), /sub-agent budget/);
    assert.equal(tiny.snapshot().budgetStop.code, "agent_budget");
    await client().complete("system", "Too large", { maxOutputTokens: 32 });
    const original = tiny.snapshot().budgetStop;
    assert.equal(original.code, "token_budget", "a later root stop supersedes an earlier child stop");
    const report = await finalTaskReport(tiny, client);
    assert.match(report, /token_budget; scope=task; used=0; limit=10/);
    assert.deepEqual(tiny.snapshot().budgetStop, original, "reporting failure preserves the original stop reason");
  });
  tiny.finish("partial");
  console.log("ok budgets: explicit task limits retain current verification evidence and precise stop diagnostics");

  fs.writeFileSync(path.join(home, "fixture.txt"), "Verified fixture");
  // Run actual LLM accounting through both UI drivers, rather than mocking streamTurn.
  for (const { scope, cap } of [{ scope: "delegation", cap: "none" }, { scope: "task", cap: "token" }, { scope: "task", cap: "tool" }]) {
    saveConfig({ ...loadConfig(), task_budget_scope: scope, task_max_requests: cap === "tool" ? 8 : 2,
      task_max_tools: 1, task_max_tokens: cap === "tool" ? 2_000_000 : 10, task_timeout_ms: scope === "task" ? 5000 : 10 });
    for (const kind of ["web", "terminal"]) {
      let mainRequests = 0;
      globalThis.fetch = async (_url, init) => {
        mainRequests++;
        await delay(25);
        const body = JSON.parse(init.body);
        if (body.messages[0].content.startsWith("The configured task budget")) return event("The first inspection passed; a configured tool limit stopped further work.");
        const count = body.messages.filter(message => message.role === "tool").length;
        return count < 3 ? event("Progress", [call("read_file", { path: "fixture.txt", reason: "Fixture" }, `R${count}`)]) : event("All requested work completed.");
      };
      const owner = kind === "web" ? new WebSession({ id: `budget-${cap}`, provider: "Fixture", model: model.name, intensity: "High", cwd: home, messages: [] }, model) : new ChatScreen();
      if (kind === "terminal") {
        owner.app = { state: { selectedProvider: "Fixture", selectedModelName: model.name, selectedModelUrl: model.url,
          selectedModelApiKey: model.api_key, selectedModelStreaming: true, selectedIntensity: "High", cursorOn: true }, render() {} };
        owner.loadedCwd = home;
        owner.onActivate();
      } else owner.start();
      owner.requestApproval = allowed;
      try {
        owner.liveSend("Finish a multi-step inspection");
        await waitFor(() => !owner.busy && owner.taskRuntime?.snapshot().state !== "running");
        const saved = loadSession(owner.sessionId);
        assert.equal(saved.task_run.budgetScope, scope);
        if (scope === "delegation") {
          assert.equal(saved.task_run.state, "completed");
          assert.equal(mainRequests, 4);
          assert.equal(saved.task_run.counts.toolCalls, 3);
          assert.ok(saved.task_run.counts.tokens > 10);
          assert.equal(saved.messages.at(-1).content, "All requested work completed.");
        } else if (cap === "token") {
          assert.equal(mainRequests, 0);
          assert.equal(saved.task_run.state, "partial");
          assert.match(saved.messages.at(-1).content, /token_budget; scope=task/);
        } else {
          assert.equal(mainRequests, 3, "the tool cap stops execution and allows a single report request");
          assert.equal(saved.task_run.state, "partial");
          assert.equal(saved.task_run.counts.toolCalls, 1);
          assert.match(saved.messages.at(-1).content, /tool_budget; scope=task/);
          assert.match(saved.messages.filter(message => message.role === "tool").at(-1).result, /Not executed/);
        }
      } finally { if (kind === "terminal") owner.onDeactivate(); else owner.dispose(); }
    }
  }
  console.log("ok budgets: Web and terminal drivers complete past default quotas and honor explicit task limits");
  console.log("TASK BUDGET TESTS PASSED");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(home, { recursive: true, force: true });
}
