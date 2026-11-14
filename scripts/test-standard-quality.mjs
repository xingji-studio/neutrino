// Real local files/commands, scripted provider transport: no external model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-standard-quality-"));
process.env.NEUTRINO_HOME = path.join(fixture, "home");
process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
process.env.NEUTRINO_PLAN = "off";
const oldHome = os.homedir, oldFetch = globalThis.fetch;
const measurements = { external_model_requests: 0, transport: "scripted fixture", driver_results: [] };
os.homedir = () => fixture;
const { editFile, fileHash, readFileRange } = await import("../dist/llm/editing.js");
const { StandardTask, requirementInventory } = await import("../dist/llm/standard.js");
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { executeTool } = await import("../dist/llm/tools.js");
const { assessToolCall } = await import("../dist/llm/risk.js");
const { prepareContext, inputTokenBound } = await import("../dist/llm/context.js");
const { createWebSession } = await import("../dist/web/session.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { defaultState } = await import("../dist/state.js");
const config = await import("../dist/config.js");
const model = { name: "deepseek-flash", url: "https://fixture.invalid/v1", api_key: "fixture-only", context_window: 1_000_000 };
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate) {
  const stop = Date.now() + 15_000;
  while (!predicate()) { assert.ok(Date.now() < stop, "Standard integration timed out"); await delay(5); }
}
function response(content = "", calls = [], finish = "stop") {
  const output = finish === "length" ? 16384 : 80;
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content,
    tool_calls: calls.map((c, index) => ({ index, id: `c-${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: output, total_tokens: 100 + output } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } });
}
const tool = (name, args) => ({ name, args: { ...args, reason: "Verify the requested local fixture" } });

try {
  const file = path.join(fixture, "edit.txt");
  fs.writeFileSync(file, "alpha\r\nunique beta\r\nomega\r\n");
  const hash = fileHash(fs.readFileSync(file));
  assert.match(readFileRange(file, { start_line: 2, end_line: 2 }), /2: unique beta/);
  assert.match(readFileRange(file, { start_line: 2, end_line: 2 }), new RegExp(hash));
  assert.throws(() => readFileRange(file, { start_line: 0 }), /positive/);
  assert.throws(() => readFileRange(file, { start_line: 3, end_line: 2 }), /positive/);
  assert.throws(() => editFile(file, { expected_sha256: hash, old_text: "missing", new_text: "x" }), /not found/);
  assert.equal(fileHash(fs.readFileSync(file)), hash);
  editFile(file, { expected_sha256: hash, old_text: "unique beta", new_text: "changed" });
  assert.equal(fs.readFileSync(file, "utf8"), "alpha\r\nchanged\r\nomega\r\n");
  editFile(file, { expected_sha256: fileHash(fs.readFileSync(file)), old_text: "alpha\nchanged", new_text: "alpha\nupdated" });
  assert.equal(fs.readFileSync(file, "utf8"), "alpha\r\nupdated\r\nomega\r\n");
  assert.throws(() => editFile(file, { expected_sha256: hash, old_text: "alpha", new_text: "bad" }), /version changed/);
  fs.writeFileSync(file, "same same");
  assert.throws(() => editFile(file, { expected_sha256: fileHash("same same"), old_text: "same", new_text: "bad" }), /more than once/);
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => editFile(file, { expected_sha256: fileHash("same same"), old_text: "same same", new_text: "bad" }, aborted.signal), /cancelled/);
  assert.equal(fs.readFileSync(file, "utf8"), "same same");
  assert.equal(fs.readdirSync(fixture).filter(x => x.startsWith(".neutrino-edit-")).length, 0);
  const secret = path.join(fixture, ".env"); fs.writeFileSync(secret, "synthetic-test-secret");
  assert.equal(assessToolCall("edit_file", { path: secret }, fixture).level, "high");
  if (process.platform !== "win32") {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-edit-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "target"), "safe");
      fs.symlinkSync(path.join(outside, "target"), path.join(fixture, "link"));
      assert.equal(assessToolCall("edit_file", { path: "link" }, fixture).level, "high");
      const confined = new TaskRuntime({ cwd: fixture, request: "Work only inside the current workspace." });
      await confined.run(async () => {
        const result = await executeTool("edit_file", { path: "link", expected_sha256: fileHash("safe"), old_text: "safe", new_text: "bad" }, fixture);
        assert.match(result, /Error/);
      });
      assert.equal(fs.readFileSync(path.join(outside, "target"), "utf8"), "safe");
      confined.finish("partial");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  }
  console.log("PASS precise edits: actual ranges, exact versions, ambiguity, CRLF, cancellation, sensitive/symlink boundaries");

  // Check freshness against actual filesystem changes, including changes made while reviewing.
  const work = path.join(fixture, "proof"); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, "program.mjs"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(work, "verify.mjs"), "import assert from 'node:assert/strict'; import {answer} from './program.mjs'; assert.equal(answer,42); console.log('independent answer check passed');");
  const request = "Preserve the public answer.\n\nVerify the actual program using the independent check.";
  const runtime = new TaskRuntime({ request, cwd: work, limits: { tokens: 2_000_000, modelRequests: 100 } });
  const contract = new StandardTask(runtime);
  assert.deepEqual(contract.state.requirements.map(r => r.text), requirementInventory(request).map(r => r.text));
  let reviews = 0;
  let mutateDuringReview = false;
  const review = { createClient: () => ({ outcome: { status: "completed" }, usage: { prompt: 20, completion: 5, total: 25 },
    async complete(system, body) {
      reviews++; const data = JSON.parse(body);
      assert.equal(data.original_request, request);
      assert.match(body, /independent answer check passed/);
      assert.ok(data.checks.every(c => c.evidence_ids.length));
      if (mutateDuringReview) fs.appendFileSync(path.join(work, "program.mjs"), "// changed during review\n");
      return JSON.stringify({ accepted: true, unresolved: [], reason: "Actual independent checks cover the request" });
    } }), capacity: 1_000_000 };
  const run = async (name, args) => runtime.tool(name, args, () => executeTool(name, args, work));
  const argsFor = (evidenceId) => ({ status: "completed", report: "Public answer verified", artifact_paths: ["program.mjs"], unresolved: [],
    checks: contract.state.requirements.map(r => ({ requirement_id: r.id, detail: "Actual program check", evidence_ids: [evidenceId] })) });
  await runtime.run(async () => {
    await run("read_file", { path: "program.mjs", start_line: 1, end_line: 2 });
    await run("run_command", { command: "node verify.mjs" });
    const first = runtime.evidence.at(-1).id;
    fs.appendFileSync(path.join(work, "program.mjs"), "// new source version\n");
    const stale = await contract.finish(argsFor(first), review);
    assert.equal(stale.completed, false); assert.equal(reviews, 0, "stale evidence rejected before spending a review request");
    await run("run_command", { command: "node verify.mjs" });
    const fresh = runtime.evidence.at(-1).id;
    mutateDuringReview = true;
    const changed = await contract.finish(argsFor(fresh), review);
    assert.equal(changed.completed, false); assert.match(changed.feedback, /changed during review/);
    mutateDuringReview = false;
    await run("run_command", { command: "node verify.mjs" });
    const accepted = await contract.finish(argsFor(runtime.evidence.at(-1).id), review);
    assert.equal(accepted.completed, true);
    assert.equal(contract.acceptedArtifactsCurrent(), true);
  });
  runtime.finish("completed");
  assert.equal(runtime.snapshot().standard.status, "completed");
  console.log("PASS completion proof: real checks, stale source rejection, concurrent mutation, current evidence accepted");

  // A passing happy-path test does not establish a confidentiality requirement.
  const privacyDir = path.join(fixture, "privacy"); fs.mkdirSync(privacyDir);
  const privateMarker = `PRIVATE_${fileHash(String(Date.now())).slice(0, 12)}`;
  const leaky = `export const output = {label:'public', debug:'${privateMarker}'};\n`;
  fs.writeFileSync(path.join(privacyDir, "output.mjs"), leaky);
  fs.writeFileSync(path.join(privacyDir, "verify.mjs"), "import assert from 'node:assert/strict'; import {output} from './output.mjs'; assert.equal(output.label,'public'); console.log('public behavior passed');");
  const privacyRuntime = new TaskRuntime({ request: "Preserve public behavior.\n\nPrevent private content from entering released artifacts.", cwd: privacyDir });
  const privacyContract = new StandardTask(privacyRuntime);
  const privacyOptions = { capacity: 1_000_000, createClient: () => ({ outcome: { status: "completed" },
    async complete(_system, input) {
      const evidence = JSON.parse(input).evidence;
      assert.ok(evidence.some(e => e.result.includes("public behavior passed")));
      const read = evidence.find(e => e.name === "read_file");
      const accepted = Boolean(read && !read.result.includes(privateMarker));
      return JSON.stringify({ accepted, unresolved: accepted ? [] : ["Passing public behavior does not prove private-content safety; read and inspect the actual artifact"], reason: accepted ? "Both requirements covered" : "Confidentiality proof missing or failing" });
    } }) };
  await privacyRuntime.run(async () => {
    await privacyRuntime.tool("read_file", { path: "output.mjs" }, () => executeTool("read_file", { path: "output.mjs" }, privacyDir));
    await privacyRuntime.tool("run_command", { command: "node verify.mjs" }, () => executeTool("run_command", { command: "node verify.mjs" }, privacyDir));
    const entries = privacyRuntime.evidence.slice();
    const finish = () => ({ status: "completed", report: "All requirements satisfied", unresolved: [], artifact_paths: ["output.mjs"],
      checks: privacyContract.state.requirements.map(r => ({ requirement_id: r.id, detail: "Public behavior and content inspection", evidence_ids: entries.map(e => e.id) })) });
    const refused = await privacyContract.finish(finish(), privacyOptions);
    assert.equal(refused.completed, false);
    assert.match(refused.feedback, /Confidentiality|private-content/);
    assert.equal(privacyRuntime.snapshot().standard.requirements.some(r => r.verified), false);
    await privacyRuntime.tool("edit_file", { path: "output.mjs", expected_sha256: fileHash(leaky), old_text: `, debug:'${privateMarker}'`, new_text: "" },
      () => executeTool("edit_file", { path: "output.mjs", expected_sha256: fileHash(leaky), old_text: `, debug:'${privateMarker}'`, new_text: "" }, privacyDir));
    await privacyRuntime.tool("read_file", { path: "output.mjs" }, () => executeTool("read_file", { path: "output.mjs" }, privacyDir));
    await privacyRuntime.tool("run_command", { command: "node verify.mjs" }, () => executeTool("run_command", { command: "node verify.mjs" }, privacyDir));
    entries.splice(0, entries.length, ...privacyRuntime.evidence.slice(-2));
    assert.equal((await privacyContract.finish(finish(), privacyOptions)).completed, true);
    assert.ok(privacyRuntime.snapshot().standard.requirements.every(r => r.verified && r.evidence_ids.length));
  });
  privacyRuntime.finish("completed");
  console.log("PASS semantic completion: actual public behavior passes while private-content leak rejects completion; repair and fresh evidence accepted");

  const bad = new TaskRuntime({ request, cwd: work }); const badContract = new StandardTask(bad);
  bad.recordTool("run_command", { command: "test denied" }, "Denied by approval", "denied");
  const invalid = { status: "completed", report: "Unsupported", unresolved: [], artifact_paths: [], checks: badContract.state.requirements.map(r => ({ requirement_id: r.id, detail: "claim", evidence_ids: [bad.evidence[0].id] })) };
  const rejected = await bad.run(() => badContract.finish(invalid, { ...review, createClient() { throw new Error("Denied evidence must not reach a reviewer"); } }));
  assert.equal(rejected.completed, false); assert.match(rejected.feedback, /unsuccessful/);
  assert.ok(badContract.naturalCompletion()); assert.ok(badContract.naturalCompletion()); assert.ok(badContract.naturalCompletion());
  assert.equal(badContract.naturalCompletionExhausted, true);
  bad.finish("partial");

  // A normal return from an outer driver must not manufacture completion.
  const unaccepted = new TaskRuntime({ request: "Implement the requested change.", cwd: work });
  new StandardTask(unaccepted);
  unaccepted.finish("completed");
  assert.equal(unaccepted.snapshot().state, "partial");
  assert.equal(unaccepted.snapshot().standard.status, "partial");
  assert.match(unaccepted.snapshot().standard.unresolved.join(" "), /before completion acceptance/);

  const cancellation = new TaskRuntime({ request: "Verify the requested text." });
  const cancelledContract = new StandardTask(cancellation);
  const cancelled = await cancellation.run(() => cancelledContract.finish({ status: "completed", report: "Candidate", checks: [{ requirement_id: "r1", detail: "text", evidence_ids: [] }], artifact_paths: [], unresolved: [] }, {
    capacity: 1_000_000, createClient: () => ({ outcome: { status: "completed" }, async complete() {
      cancellation.cancel("User cancelled during independent review");
      return JSON.stringify({ accepted: true, unresolved: [], reason: "Late assessment must not win cancellation" });
    } }),
  }));
  assert.equal(cancelled.completed, false); cancellation.finish("partial");
  assert.equal(cancellation.snapshot().state, "cancelled");
  assert.equal(cancellation.snapshot().standard.status, "partial");
  let blockedDispatches = 0;
  globalThis.fetch = async () => { blockedDispatches++; throw new Error("Review must not bypass the shared budget"); };
  const capped = new TaskRuntime({ request: "Verify the requested text.", limits: { tokens: 10 } });
  const cappedContract = new StandardTask(capped);
  await capped.run(async () => {
    const result = await cappedContract.finish({ status: "completed", report: "Candidate", checks: [{ requirement_id: "r1", detail: "text", evidence_ids: [] }], artifact_paths: [], unresolved: [] },
      { capacity: 1_000_000, createClient: () => new LLMClient(model, "DeepSeek", "Max") });
    assert.equal(result.completed, false);
  });
  assert.equal(blockedDispatches, 0); assert.equal(capped.snapshot().budgetStop.code, "token_budget"); capped.finish("partial");
  assert.equal(capped.snapshot().standard.status, "partial");
  assert.ok(capped.snapshot().standard.requirements.every(r => !r.verified));
  const scoped = new TaskRuntime({ request: "Respect child write scopes", cwd: work });
  await scoped.run(async () => {
    await scoped.child("reader", "Read-only inspection", async () => {
      const output = await executeTool("edit_file", { path: "program.mjs", expected_sha256: fileHash(fs.readFileSync(path.join(work, "program.mjs"))), old_text: "answer = 42", new_text: "answer = 0" }, work);
      assert.match(output, /read-only/);
    }, { readOnly: true });
    await scoped.child("writer", "Restricted writer", async () => {
      const output = await executeTool("edit_file", { path: "program.mjs", expected_sha256: fileHash(fs.readFileSync(path.join(work, "program.mjs"))), old_text: "answer = 42", new_text: "answer = 0" }, work);
      assert.match(output, /allowed write paths/);
    }, { writePaths: ["allowed"] });
  });
  const scopedContract = new StandardTask(scoped);
  await scoped.run(() => scoped.child("reviewer", "Cannot accept parent", async () => {
    const result = await scopedContract.finish({ status: "partial", report: "Child cannot end its parent" }, { capacity: 1_000_000, createClient() { throw new Error("No child completion reviewer"); } });
    assert.equal(result.settled, false); assert.match(result.feedback, /root task/);
    assert.equal(scopedContract.state.completionAttempts, 0);
  }));
  scoped.finish("completed");
  console.log("PASS invariants: missing/denied evidence, bounded unsupported claims, outer completion guard, cancellation, actual review budget preflight, read-only and child write scopes");

  // Compact below the model's context limit due to remaining task budget, retaining protocol groups.
  const messages = [{ role: "system", content: "ORIGINAL IMMUTABLE POLICY" }, { role: "user", content: request }];
  for (let i = 0; i < 12; i++) messages.push({ role: "assistant", tool_calls: [{ id: `t${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }], reasoning_content: "thinking" },
    { role: "tool", tool_call_id: `t${i}`, content: `${i === 11 ? 'LATEST FAILED CHECK' : 'old evidence'} ${'x'.repeat(6000)}` });
  const before = inputTokenBound(messages);
  await prepareContext({ messages, tools: [], capacity: 1_000_000, remainingBudget: 100_000, evidenceBrief: contract.evidenceBrief(),
    createClient() { throw new Error("Budget-pressure compaction must not call another model"); } });
  assert.ok(inputTokenBound(messages) < before / 2);
  measurements.context_input_bound = { before_bytes: before, after_bytes: inputTokenBound(messages), model_context_capacity: 1_000_000, remaining_task_budget: 100_000 };
  assert.ok(messages.some(m => m.content === request)); assert.equal(messages[0].content, "ORIGINAL IMMUTABLE POLICY");
  assert.ok(messages.some(m => m.content?.includes("LATEST FAILED CHECK")));
  assert.ok(messages.some(m => m.reasoning_content === "thinking" && m.tool_calls[0].id === "t11"));
  assert.match(contract.readEvidence({ evidence_id: runtime.evidence[1].id }), /independent answer check passed/);
  console.log("PASS budget-aware context: zero extra model calls, immutable brief, complete tool groups, failed checks and retrievable evidence");

  config.saveModels({ providers: [{ name: "DeepSeek", models: [model] }] });
  config.saveConfig({ ...config.loadConfig(), selected_provider: "DeepSeek", selected_model: model.name, selected_intensity: "Max",
    plan_first: false, task_budget_scope: "task", task_max_tokens: 2_000_000, task_max_requests: 100, task_max_tools: 100 });
  for (const kind of ["web", "terminal"]) {
    const dir = path.join(fixture, kind); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "program.mjs"), "export const answer = 0;\n");
    fs.writeFileSync(path.join(dir, "verify.mjs"), "import assert from 'node:assert/strict'; import {answer} from './program.mjs'; assert.equal(answer,42); console.log('two required checks passed');");
    let stage = 0, reviewCalls = 0;
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /fixture\.invalid/);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-only");
      const body = JSON.parse(init.body);
      assert.equal(body.model, "deepseek-flash"); assert.equal(body.reasoning_effort, "max");
      assert.equal(body.thinking.type, "enabled"); assert.equal(body.max_tokens, 16384);
      if (body.messages[0].content.includes("independent completion reviewer for Standard")) {
        reviewCalls++; const data = JSON.parse(body.messages[1].content);
        assert.match(JSON.stringify(data.evidence), /two required checks passed/);
        return response(JSON.stringify({ accepted: true, unresolved: [], reason: "Both actual requirements verified" }));
      }
      switch (stage++) {
        case 0: return response("Inspect", [tool("read_file", { path: "program.mjs", start_line: 1, end_line: 3 })]);
        case 1: return response("", [tool("write_file", { path: "must-not-exist", content: "truncated side effect" })], "length");
        case 2:
          assert.equal(fs.existsSync(path.join(dir, "must-not-exist")), false);
          assert.ok(body.messages.some(m => m.content?.includes("none of its tool calls executed")));
          return response("Small edit", [tool("edit_file", { path: "program.mjs", expected_sha256: fileHash(fs.readFileSync(path.join(dir, "program.mjs"))), old_text: "answer = 0", new_text: "answer = 42" })]);
        case 3: return response("Verify", [tool("run_command", { command: "node verify.mjs" })]);
        case 4: {
          const record = [...body.messages].reverse().find(m => m.role === "tool" && m.content.includes("two required checks passed"));
          const id = /Task evidence: ([^;]+);/.exec(record.content)[1];
          return response("", [tool("finish_standard_task", { status: "completed", report: "Implemented and verified", unresolved: [], artifact_paths: ["program.mjs"],
            checks: requirementInventory(request).map(r => ({ requirement_id: r.id, detail: "Local oracle passed", evidence_ids: [id] })) })]);
        }
        default: throw new Error(`Unexpected actor call ${stage} in ${kind}`);
      }
    };
    let session;
    if (kind === "web") {
      session = createWebSession(dir, { provider: "DeepSeek", model, intensity: "Max" }); session.start();
    } else {
      session = new ChatScreen(""); session.app = { width: 100, height: 30, state: { ...defaultState(), selectedProvider: "DeepSeek", selectedModelName: model.name, selectedModelUrl: model.url, selectedModelApiKey: model.api_key, selectedModelStreaming: true, selectedIntensity: "Max" }, render() {}, popScreen() {}, showToast() {}, bell() {} };
      session.loadedCwd = dir; session.loadedModel = model.name; session.loadedProvider = "DeepSeek"; session.loadedIntensity = "Max"; session.onActivate();
    }
    try {
      session.liveSend(request); await until(() => !session.liveMeta().busy);
      const task = session.liveMeta().task;
      assert.equal(task.state, "completed", JSON.stringify(session.messages.at(-1)));
      assert.equal(task.standard.status, "completed"); assert.equal(task.standard.outputRecoveries, 1);
      assert.equal(task.counts.modelRequests, 6); assert.equal(reviewCalls, 1);
      measurements.driver_results.push({ driver: kind, state: task.state, fixture_model_requests: task.counts.modelRequests, independent_reviews: reviewCalls, output_recoveries: task.standard.outputRecoveries, model: "deepseek-flash", api_effort: "max", output_ceiling: 16384, truncated_side_effect: false });
      assert.equal(fs.existsSync(path.join(dir, "must-not-exist")), false);
      assert.match(fs.readFileSync(path.join(dir, "program.mjs"), "utf8"), /answer = 42/);
    } finally { kind === "web" ? session.dispose() : session.onDeactivate(); }
    console.log(`PASS ${kind} Standard: actual read/edit/test, truncated call suppressed, recovery, independent finish, unchanged model/Max/16384`);
  }
  if (process.env.NEUTRINO_STANDARD_RESULTS) {
    fs.writeFileSync(process.env.NEUTRINO_STANDARD_RESULTS, JSON.stringify({ ...measurements,
      passed: true, note: "Fixture usage validates accounting and control flow; these are not real model quality or speed measurements." }, null, 2) + "\n");
  }
  console.log("STANDARD QUALITY REGRESSION PASSED; external model requests=0");
} finally {
  globalThis.fetch = oldFetch; os.homedir = oldHome;
  fs.rmSync(fixture, { recursive: true, force: true });
}
