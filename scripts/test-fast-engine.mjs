import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-engine-"));
const priorEnvironment = { NEUTRINO_HOME: process.env.NEUTRINO_HOME, NEUTRINO_PLUGIN_HOME: process.env.NEUTRINO_PLUGIN_HOME };
process.env.NEUTRINO_HOME = path.join(fixture, ".neutrino"); process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
const originalHomedir = os.homedir; os.homedir = () => fixture;
const { FastAgentEngine } = await import("../dist/fast/engine.js");
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { executeTool } = await import("../dist/llm/tools.js");
const { fastSettings } = await import("../dist/fast/types.js");
const model = { name: "same-capable-model", url: "https://fixture.invalid/v1", api_key: "fixture", intensity: ["High"], supports_streaming: true };
const task = (id, dependencies = []) => ({ task_id: id, task_goal: `Inspect ${id}`, dependencies, required_context: ["request", "history"],
  input_versions: {}, acceptance_criteria: ["Accurate with evidence"], output_contract: "A correct result", priority: 0,
  estimated_duration: 1, read_only: true, write_paths: [], exclusive: false });
const line = value => JSON.stringify(value) + "\n";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const header = { type: "constraints", goal: "Inspect all three dimensions", constraints: ["Keep model, reasoning depth and evidence"] };

function harness(custom = {}) {
  const calls = [], snapshots = [], uses = [];
  let active = 0, peak = 0, planning = true, overlapped = false;
  const runtime = new TaskRuntime({ request: "Inspect a, b and c. Keep every constraint.", cwd: fixture, budgetScope: "delegation" });
  const createClient = () => {
    const client = new LLMClient(model, "Fixture", "High");
    client.streamTurn = async function* (messages, tools, opts) {
      assert.equal(this.model.name, model.name); assert.equal(this.intensity, "High");
      active++; peak = Math.max(peak, active);
      calls.push({ messages: structuredClone(messages), tools, model: this.model.name, intensity: this.intensity });
      this.toolCalls = []; this.outcome = { status: "completed" }; this.usage = { prompt: 100, completion: 20, total: 120 };
      try {
        if (custom.stream) { yield* custom.stream.call(this, messages, tools, opts); return; }
        if (messages[0].content.includes("You plan tasks")) {
          yield line(header) + line({ type: "task", task: task("a") });
          await sleep(20);
          yield line({ type: "task", task: task("b") }) + line({ type: "task", task: task("c", ["a"]) }) + line({ type: "done" });
          planning = false;
        } else if (messages.at(-1).content.includes("Perform the mandatory global review")) {
          this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed",
            report: "All three dimensions checked against original evidence.", unresolved: [], evidence_ids: ["artifact:a@1", "artifact:b@1", "artifact:c@1"] }) }];
          yield "Global review completed";
        } else {
          if (planning) overlapped = true;
          const parsed = JSON.parse(messages.findLast(m => m.role === "user").content.match(/Task: (\{[^\n]*\})/)[1]);
          assert.ok(messages[0].content.includes("Keep model, reasoning depth and evidence"));
          assert.ok(messages[0].content.includes("Keep every constraint"));
          await sleep(10);
          yield JSON.stringify({ result: parsed.task_id, conclusions: ["Checked"], evidence: ["fixture:source"],
            assumptions: [], unresolved: [], verification_passed: parsed.kind === "verification" });
        }
      } finally { active--; }
    };
    return client;
  };
  const engine = new FastAgentEngine({ runtime, signal: runtime.signal, settings: { ...fastSettings({}), replans: 0, retries: 0, modelSlots: 2 },
    cwd: fixture, history: [{ role: "user", content: runtime.originalRequest }], system: "Original full agent capabilities", subagentSystem: "Original sub-agent prompt",
    contextWindow: 128_000, maxRounds: 16, createClient, directory: path.join(fixture, "runs"),
    approve: async () => ({ approved: true, source: "prompt", reason: "routine fixture" }),
    execute: async () => "fixture result", onUsage: usage => uses.push(usage), onSnapshot: state => snapshots.push(state),
    ...custom.options,
  });
  return { engine, calls, snapshots, uses, runtime, createClient, peak: () => peak, overlapped: () => overlapped };
}
try {
  const test = harness();
  const result = await test.runtime.run(() => test.engine.run()); test.runtime.finish(result.status);
  assert.equal(result.status, "completed");
  assert.equal(result.snapshot.actual_mode, "fast_dag");
  assert.equal(test.overlapped(), true, "workers run while planner is streaming");
  assert.ok(test.peak() <= 2, "model inference pool covers planner, workers and verifiers");
  assert.equal(test.calls.length, 8, "one planner, three workers, three verifiers, one final review");
  assert.equal(result.snapshot.metrics.total.prompt, 800); assert.equal(result.snapshot.metrics.total.completion, 160);
  assert.equal(result.snapshot.metrics.verification.requests, 3); assert.equal(result.snapshot.metrics.integration.requests, 1);
  assert.equal(test.uses.length, 8);
  assert.ok(test.snapshots.some(s => s.phase === "verifying")); assert.ok(test.snapshots.some(s => s.phase === "reviewing"));
  const persisted = JSON.parse(fs.readFileSync(path.join(fixture, "runs", result.snapshot.run_id, "artifacts.json"), "utf8"));
  assert.equal(persisted.artifacts.filter(a => a.verification === "verified").length, 6);

  const malformed = harness({ stream: async function* () { yield line({ type: "task", task: task("unsafe") }); } });
  const bad = await malformed.runtime.run(() => malformed.engine.run()); malformed.runtime.finish(bad.status);
  assert.equal(bad.status, "failed"); assert.match(bad.snapshot.error, /global constraints/);
  assert.equal(malformed.calls.length, 1, "malformed planner never falls back silently");

  // Billing/auth failures must remain visible, without treating the legacy error text as JSON or replanning against an unusable model.
  const unavailable = harness({ options: { settings: { ...fastSettings({}), replans: 2, retries: 0 } }, stream: async function* () {
    this.usage = null; this.outcome = { status: "failed", error: { code: "model_error", message: "HTTP 402 - Insufficient Balance" } };
    yield "\n[Error: HTTP 402 - Insufficient Balance]";
  } });
  const unavailableResult = await unavailable.runtime.run(() => unavailable.engine.run()); unavailable.runtime.finish(unavailableResult.status);
  assert.equal(unavailableResult.status, "failed"); assert.match(unavailableResult.snapshot.error, /HTTP 402.*Insufficient Balance/);
  assert.equal(unavailable.calls.length, 1); assert.equal(unavailableResult.snapshot.metrics.replans, 0);

  const exhausted = harness({ options: { settings: { ...fastSettings({}), replans: 2, retries: 0 } }, stream: async function* (messages) {
    if (messages[0].content.includes("You plan tasks")) yield line(header) + line({ type: "task", task: task("kept") }) + line({ type: "task", task: task("unpaid", ["kept"]) }) + line({ type: "done" });
    else {
      const definition = JSON.parse(messages.find(m => m.role === "user").content.match(/Task: (\{[^\n]*\})/)[1]);
      if (definition.task_id === "unpaid") {
        this.usage = null; this.outcome = { status: "failed", error: { code: "model_error", message: "HTTP 402 - Insufficient Balance" } };
        yield "\n[Error: HTTP 402 - Insufficient Balance]";
      } else yield JSON.stringify({ result: "Already verified", verification_passed: true, unresolved: [] });
    }
  } });
  const exhaustedResult = await exhausted.runtime.run(() => exhausted.engine.run()); exhausted.runtime.finish(exhaustedResult.status);
  assert.equal(exhaustedResult.status, "partial"); assert.match(exhaustedResult.snapshot.error, /HTTP 402/);
  assert.equal(exhaustedResult.snapshot.artifacts.find(artifact => artifact.task_id === "kept").verification, "verified");
  assert.equal(exhausted.calls.length, 4, "no extra model requests after a permanent account failure");
  assert.equal(exhaustedResult.snapshot.metrics.replans, 0);

  // The final coordinator keeps working past the normal child round limit.
  let reviewRounds = 0;
  const deep = harness({ options: { maxRounds: 2 }, stream: async function* (messages) {
    if (messages[0].content.includes("You plan tasks")) yield line(header) + line({ type: "task", task: task("only") }) + line({ type: "done" });
    else if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
      reviewRounds++;
      if (reviewRounds <= 3) {
        this.toolCalls = [{ id: `read-${reviewRounds}`, name: "read_file", arguments: JSON.stringify({ path: "fixture.txt", reason: "Check original evidence" }) }];
        yield "Reviewing another necessary source";
      } else {
        this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "All necessary sources verified.", unresolved: [], evidence_ids: ["artifact:only@1"] }) }];
        yield "All necessary sources verified.";
      }
    } else yield JSON.stringify({ result: "only", verification_passed: true, unresolved: [] });
  } });
  const reviewed = await deep.runtime.run(() => deep.engine.run()); deep.runtime.finish(reviewed.status);
  assert.equal(reviewed.status, "completed"); assert.equal(reviewRounds, 4);
  assert.match(reviewed.report, /All necessary sources/);

  // A planning failure triggers bounded replanning against preserved state, without changing engines.
  let plans = 0;
  const recovered = harness({ options: { settings: { ...fastSettings({}), replans: 1, retries: 0, modelSlots: 2 } },
    stream: async function* (messages) {
      if (messages[0].content.includes("You plan tasks")) {
        if (++plans === 1) { yield "{ malformed plan\n"; return; }
        yield line(header) + line({ type: "task", task: task("recovered") }) + line({ type: "done" });
      } else if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
        this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "Recovered with evidence", unresolved: [], evidence_ids: ["artifact:recovered@1"] }) }];
        yield "Reviewed";
      } else yield JSON.stringify({ result: "Recovered", verification_passed: true, unresolved: [] });
    } });
  const recovery = await recovered.runtime.run(() => recovered.engine.run()); recovered.runtime.finish(recovery.status);
  assert.equal(recovery.status, "completed"); assert.equal(plans, 2); assert.equal(recovery.snapshot.metrics.replans, 1);

  // Observing an expected failing test does not permanently prevent acceptance after correction and an independent passing test.
  let executed = 0;
  const correction = harness({ options: { execute: async () => ++executed === 1 ? "[exit code: 1] Expected failing test" : "PASS actual fixture check" },
    stream: async function* (messages) {
      if (messages[0].content.includes("You plan tasks")) {
        yield line(header) + line({ type: "task", task: { ...task("corrected"), read_only: false, exclusive: true } }) + line({ type: "done" });
      } else if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
        this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "Corrected and independently tested", unresolved: [], evidence_ids: ["artifact:corrected@1"] }) }];
        yield "Reviewed";
      } else {
        const definition = JSON.parse(messages.find(m => m.role === "user").content.match(/Task: (\{[^\n]*\})/)[1]);
        const toolResults = messages.filter(m => m.role === "tool").length;
        if (toolResults < (definition.kind === "work" ? 2 : 1)) {
          this.toolCalls = [{ id: `check-${toolResults}`, name: "run_command", arguments: JSON.stringify({ command: "node test.mjs", reason: "Observe failure or verify correction" }) }];
          yield "Checking the fixture";
        } else yield JSON.stringify({ result: "Tests pass", verification_passed: true, unresolved: [] });
      }
    } });
  const corrected = await correction.runtime.run(() => correction.engine.run()); correction.runtime.finish(corrected.status);
  assert.equal(corrected.status, "completed"); assert.equal(executed, 3, "the independent verifier must execute its own passing check");
  assert.ok(correction.runtime.evidence.some(e => e.status === "failed"), "the initial failing evidence is preserved");

  const forged = harness({ stream: async function* (messages) {
    if (messages[0].content.includes("You plan tasks")) yield line(header) + line({ type: "task", task: task("only") }) + line({ type: "done" });
    else if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
      this.toolCalls = [{ id: "fake", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "Claimed done", unresolved: [], evidence_ids: ["artifact:only@999"] }) }];
      yield "Claimed done";
    } else yield JSON.stringify({ result: "only", verification_passed: true, unresolved: [] });
  } });
  const rejected = await forged.runtime.run(() => forged.engine.run()); forged.runtime.finish(rejected.status);
  assert.equal(rejected.status, "partial"); assert.match(rejected.snapshot.error, /acceptance evidence/);
  assert.equal(rejected.snapshot.review.filter(row => !row.accepted).length, 3);

  // A missing verification field is corrected in the same transcript, without replaying a writer or replanning.
  let writes = 0, verificationReplies = 0;
  const format = harness({ options: { execute: async () => { writes++; return "Created fixture output"; } }, stream: async function* (messages) {
    if (messages[0].content.includes("You plan tasks")) yield line(header) + line({ type: "task", task: { ...task("formatted"), read_only: false, exclusive: true } }) + line({ type: "done" });
    else if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
      this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "Verified output", unresolved: [], evidence_ids: ["artifact:formatted@1"] }) }];
      yield "Reviewed";
    } else {
      const definition = JSON.parse(messages.find(m => m.role === "user").content.match(/Task: (\{[^\n]*\})/)[1]);
      if (definition.kind === "work" && !messages.some(m => m.role === "tool")) {
        this.toolCalls = [{ id: "write", name: "write_file", arguments: JSON.stringify({ path: "fixture.txt", content: "valid", reason: "Create the fixture output" }) }];
        yield "Writing";
      } else if (definition.kind === "verification") {
        if (++verificationReplies === 1) yield JSON.stringify({ result: "Verified all actual checks; formal verdict accidentally omitted", unresolved: [] });
        else {
          assert.ok(messages.some(m => m.content?.includes("missing required machine-readable fields")));
          this.toolCalls = [{ id: "verify", name: "finish_task", arguments: JSON.stringify({ status: "completed", report: "Verified all checks", conclusions: [], evidence: [], assumptions: [], unresolved: verificationReplies === 2 ? ["Other DAG tasks and future integration remain outside my scope"] : [], verification_passed: true }) }];
          yield "Formatted verdict";
        }
      } else yield JSON.stringify({ result: "Created output", unresolved: [] });
    }
  } });
  const formatted = await format.runtime.run(() => format.engine.run()); format.runtime.finish(formatted.status);
  assert.equal(formatted.status, "completed"); assert.equal(writes, 1); assert.equal(verificationReplies, 3);
  assert.equal(formatted.snapshot.metrics.replans, 0); assert.equal(format.runtime.snapshot().counts.agentRuns, 2);
  assert.equal(formatted.snapshot.integrated.formatted, 1);

  // Approval reviewers share the same inference pool and usage ledger, including overlapping worker inference.
  const approvals = harness({ options: { approve: async (name, args, signal, wrapReviewer) => {
    assert.equal(typeof wrapReviewer, "function");
    const request = async () => {
      const client = wrapReviewer(approvals.createClient());
      for await (const ignored of client.streamTurn([{ role: "user", content: "APPROVAL_FIXTURE" }], [], { signal })) {}
    };
    await Promise.all([request(), request()]);
    return { approved: true, source: "prompt", reason: "Controlled fixture approval" };
  } }, stream: async function* (messages) {
    if (messages[0].content.includes("You plan tasks")) yield line(header) + line({ type: "task", task: task("a") }) + line({ type: "task", task: task("b") }) + line({ type: "done" });
    else if (messages[0].content === "APPROVAL_FIXTURE") { await sleep(20); yield '{"approve":true}'; }
    else if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
      this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "Approved and verified", unresolved: [], evidence_ids: ["artifact:a@1", "artifact:b@1"] }) }];
      yield "Reviewed";
    } else {
      const definition = JSON.parse(messages.find(m => m.role === "user").content.match(/Task: (\{[^\n]*\})/)[1]);
      if (definition.kind === "work" && !messages.some(m => m.role === "tool")) {
        await sleep(definition.task_id === "b" ? 50 : 1);
        this.toolCalls = [{ id: "read", name: "read_file", arguments: JSON.stringify({ path: "../controlled-fixture.txt", reason: "Exercise reviewed read boundary without real filesystem access" }) }];
        yield "Reading";
      } else yield JSON.stringify({ result: definition.task_id, verification_passed: true, unresolved: [] });
    }
  } });
  const approved = await approvals.runtime.run(() => approvals.engine.run()); approvals.runtime.finish(approved.status);
  assert.equal(approved.status, "completed"); assert.ok(approvals.peak() <= 2, "reviewers cannot exceed the inference limit");
  assert.equal(approved.snapshot.metrics.verification.requests, 6, "four policy reviews and two local verifications are accounted");

  let commandStarted;
  const started = new Promise(resolve => { commandStarted = resolve; });
  const lateMarker = path.join(fixture, "must-not-appear.txt"), commandFile = path.join(fixture, "cancel-command.cjs");
  fs.writeFileSync(commandFile, `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(lateMarker)}, 'late'), 500)`);
  const shellArg = value => process.platform === "win32" ? '"' + value.replaceAll('"', '""') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
  const cancellation = harness({ options: { execute: (name, args, signal) => {
    const execution = executeTool(name, args, fixture, signal); commandStarted(); return execution;
  } }, stream: async function* (messages) {
    if (messages[0].content.includes("You plan tasks")) yield line(header) + line({ type: "task", task: { ...task("cancel"), read_only: false, exclusive: true } }) + line({ type: "done" });
    else {
      this.toolCalls = [{ id: "command", name: "run_command", arguments: JSON.stringify({ command: `${shellArg(process.execPath)} ${shellArg(commandFile)}`, reason: "Exercise cancellation of a controlled fixture command" }) }];
      yield "Running fixture command";
    }
  } });
  const cancelling = cancellation.runtime.run(() => cancellation.engine.run());
  await started; cancellation.runtime.cancel("Cancelled by test");
  assert.equal(cancellation.runtime.settling, true);
  await cancellation.runtime.drain();
  const cancelled = await cancelling; cancellation.runtime.finish(cancelled.status);
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.snapshot.phase, "cancelled");
  await sleep(600); assert.equal(fs.existsSync(lateMarker), false, "cancellation drains the real command before a late write");

  const special = harness({ stream: async function* (messages) {
    if (messages[0].content.includes("You plan tasks")) yield line(header) + line({ type: "task", task: task("constructor") }) +
      line({ type: "task", task: task("__proto__") }) + line({ type: "task", task: task("after", ["__proto__"]) }) + line({ type: "done" });
    else if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
      this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "All special identifiers verified", unresolved: [], evidence_ids: ["artifact:constructor@1", "artifact:__proto__@1", "artifact:after@1"] }) }];
      yield "Reviewed";
    } else yield JSON.stringify({ result: "Checked", verification_passed: true, unresolved: [] });
  } });
  const specialResult = await special.runtime.run(() => special.engine.run()); special.runtime.finish(specialResult.status);
  assert.equal(specialResult.status, "completed");
  assert.equal(specialResult.snapshot.metrics.workers.constructor.requests, 1);
  assert.equal(specialResult.snapshot.metrics.workers.__proto__.requests, 1);
  assert.equal(specialResult.snapshot.artifacts.find(a => a.task_id === "after").input_versions.__proto__, 1);
  assert.equal(Object.hasOwn(Object.prototype, "prompt"), false, "task identifiers cannot pollute another mode's state");
  console.log("PASS fast engine: unchanged model/intensity, streaming planning, bounded inference, independent verification, token accounting, durable evidence and unrestricted final review");
} finally {
  os.homedir = originalHomedir; fs.rmSync(fixture, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
