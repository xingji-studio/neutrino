import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-verification-context-"));
const priorHome = os.homedir, keys = ["NEUTRINO_HOME", "NEUTRINO_PLUGIN_HOME", "NEUTRINO_DIAGNOSTICS_DIR"];
const priorEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
os.homedir = () => root;
process.env.NEUTRINO_HOME = path.join(root, "config");
process.env.NEUTRINO_PLUGIN_HOME = path.join(root, "plugins");
delete process.env.NEUTRINO_DIAGNOSTICS_DIR;
const { ContextVersionTable, expandContextVersions } = await import("../dist/fast/context.js");
const { verificationSourceReads, MAX_PREFETCH_SOURCE_BYTES } = await import("../dist/fast/prefetch.js");
const { FastAgentEngine } = await import("../dist/fast/engine.js");
const { runFastWorker } = await import("../dist/fast/worker.js");
const { fastSettings } = await import("../dist/fast/types.js");
const { TaskRuntime, currentTask } = await import("../dist/llm/runtime.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { executeTool, getToolDefinitions } = await import("../dist/llm/tools.js");
const { DiagnosticRecorder } = await import("../dist/llm/diagnostics.js");
const hash = text => createHash("sha256").update(text).digest("hex");
const makeTask = (task_id, extra = {}) => ({ task_id, task_goal: "Independently inspect source.txt", dependencies: [],
  required_context: ["request", "history"], input_versions: {}, acceptance_criteria: ["Source value is 7"],
  output_contract: "Exact original value and evidence", read_only: true, write_paths: [], exclusive: false,
  priority: 0, estimated_duration: 1, status: "RUNNING", kind: "work", attempts: 1, generation: 0, ...extra });
const model = { name: "fixed-test-model", url: "https://offline.invalid/v1", api_key: "fixture", intensity: ["Max"], supports_streaming: true };
const call = (client, name, args) => { client.toolCalls = [{ id: "call", name, arguments: JSON.stringify(args) }]; };

try {
  // The wire dictionary is lossless and never rewrites evidence, prose, unknown versions or stored records.
  const versions = { request: hash("full original request"), history: hash("full history") };
  const records = Array.from({ length: 12 }, (_, i) => ({ task_id: "t" + i,
    input_versions: { ...versions, source: i, stale: hash("old") },
    result: `  Unabridged finding ${i}: ${versions.request}\n`, assumptions: ["A distinct caveat"], unresolved: i === 2 ? ["Contradiction"] : [],
    evidence: [{ arguments: { input_versions: versions }, result: versions.history }] }));
  const original = structuredClone(records), table = new ContextVersionTable(records, key => versions[key]);
  assert.deepEqual(table.values(), versions);
  const wire = records.map(record => table.compact(record));
  assert.deepEqual(wire.map(record => expandContextVersions(record, table.values())), original);
  assert.deepEqual(records, original);
  assert.ok(Buffer.byteLength(JSON.stringify(wire) + table.instructions()) < Buffer.byteLength(JSON.stringify(records)));
  assert.equal(wire[0].result, records[0].result);
  assert.deepEqual(wire[0].evidence, records[0].evidence);
  assert.equal(wire[0].input_versions.stale, records[0].input_versions.stale);
  assert.deepEqual(new ContextVersionTable(records.slice(0, 2), key => versions[key]).values(), {});
  assert.deepEqual(new ContextVersionTable(records, () => "superseded").values(), {});
  assert.deepEqual(expandContextVersions({ input_versions: { request: { context: "history" } } }, versions),
    { input_versions: { request: { context: "history" } } });

  const cwd = path.join(root, "selector"); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, "source.txt"), "7");
  const source = makeTask("source"), verifier = makeTask("source.verify", { kind: "verification", verifies: "source", dependencies: ["source"], input_versions: { source: 1 } });
  const record = { id: "actual", runId: "runtime-owned", name: "read_file", arguments: { path: "source.txt", reason: "Original source" }, result: "7", status: "completed" };
  const artifact = { task_id: "source", version: 1, input_versions: {}, verification: "pending", created_at: "test",
    source_run_id: "runtime-owned", result: "7", conclusions: [], assumptions: [], unresolved: [], evidence: [record.id], side_effects: false };
  const select = (t = verifier, a = artifact, d = source, es = [record]) => verificationSourceReads(t, a, d, es, cwd);
  assert.equal(select().length, 1);
  assert.equal(select()[0].path, "source.txt");
  for (const a of [{ ...artifact, source_run_id: undefined }, { ...artifact, source_run_id: "claimed" },
    { ...artifact, version: 2 }, { ...artifact, verification: "invalidated" }, { ...artifact, side_effects: true }, { ...artifact, evidence: [] }]) assert.deepEqual(select(verifier, a), []);
  assert.deepEqual(select({ ...verifier, read_only: false }), []);
  assert.deepEqual(select({ ...verifier, verifies: undefined }), []);
  assert.deepEqual(select(verifier, artifact, { ...source, read_only: false }), []);
  for (const e of [{ ...record, status: "denied" }, { ...record, status: "failed" }, { ...record, name: "run_command" },
    { ...record, arguments: { path: "source.txt", unexpected: "slice" } }, { ...record, arguments: { path: "../outside.txt" } }]) assert.deepEqual(select(verifier, artifact, source, [e]), []);
  const duplicate = { ...record, id: "second" };
  assert.equal(select(verifier, { ...artifact, evidence: [record.id, duplicate.id] }, source, [record, duplicate]).length, 1);
  fs.writeFileSync(path.join(cwd, "large.txt"), "x".repeat(MAX_PREFETCH_SOURCE_BYTES + 1));
  assert.deepEqual(select(verifier, artifact, source, [{ ...record, arguments: { path: "large.txt" } }]), []);
  fs.writeFileSync(path.join(root, "outside.txt"), "private");
  fs.symlinkSync(path.join(root, "outside.txt"), path.join(cwd, "escape.txt"));
  assert.deepEqual(select(verifier, artifact, source, [{ ...record, arguments: { path: "escape.txt" } }]), []);
  fs.symlinkSync(root, path.join(cwd, "escape-dir"), "dir");
  assert.deepEqual(select(verifier, artifact, source, [{ ...record, arguments: { path: "escape-dir/outside.txt" } }]), []);
  assert.deepEqual(select(verifier, artifact, source, [{ ...record, arguments: { path: "missing.txt" } }]), []);

  // Actual independent scopes, original tools and explicit verdicts: a changed source must block successors.
  async function engineFixture(changed = false) {
    const directory = path.join(root, changed ? "changed" : "good"); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "source.txt"), "7");
    const request = "Independently inspect the original source, then integrate the verified value. Work only inside this directory.";
    const diagnostics = new DiagnosticRecorder(path.join(directory, "trace.jsonl"), { mode: "fast_dag" });
    const runtime = new TaskRuntime({ request, cwd: directory, diagnostics });
    const requests = [], approvals = [], executed = [];
    let engine;
    const createClient = () => {
      const client = new LLMClient(model, "Fixture", "Max");
      client.streamTurn = async function* (messages, tools, options) {
        assert.equal(this.intensity, "Max"); assert.equal(options.maxOutputTokens, 16384);
        this.toolCalls = []; this.outcome = { status: "completed" }; this.usage = { prompt: 100, completion: 20, total: 120 };
        if (messages[0].content.startsWith("You plan tasks")) {
          yield JSON.stringify({ type: "constraints", goal: request, constraints: ["All original checks"] }) + "\n";
          yield JSON.stringify({ type: "task", task: makeTask("source") }) + "\n";
          yield JSON.stringify({ type: "task", task: makeTask("integrate", { dependencies: ["source"], task_goal: "Integrate the exact source value" }) }) + "\n";
          yield '{"type":"done"}\n'; return;
        }
        if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
          const complete = engine.scheduler.successful;
          call(this, "finish_fast_review", { status: complete ? "completed" : "partial", report: "Actual checks audited", unresolved: complete ? [] : ["Changed original source"],
            evidence_ids: complete ? ["artifact:source@1", "artifact:integrate@1"] : [] }); return;
        }
        const text = messages.find(m => m.role === "user").content;
        const task = JSON.parse(text.match(/Task: (\{[^\n]*\})/)[1]), results = messages.filter(m => m.role === "tool");
        requests.push(task.task_id);
        if (task.task_id === "source") {
          if (!results.length) { call(this, "read_file", { path: "source.txt", reason: "Read the original source" }); return; }
          assert.match(results[0].content, /^7/);
          if (changed) fs.writeFileSync(path.join(directory, "source.txt"), "8");
          call(this, "finish_task", { status: "completed", report: "Original source value: 7", unresolved: [], source_run_id: "forged" }); return;
        }
        if (task.task_id === "source.verify") {
          assert.equal(results.length, 1, "fresh original source read occurs before the first verifier model reply");
          assert.match(messages.find(m => m.role === "assistant").content, /Runtime source prefetch/);
          assert.equal(runtime.evidenceFor(currentTask().runId).length, 1);
          const passed = results[0].content.startsWith("7\n");
          assert.equal(passed, !changed);
          call(this, "finish_task", { status: "completed", report: passed ? "Fresh source matches the claim" : "Fresh source contradicts the claim", verification_passed: passed,
            unresolved: passed ? [] : ["Original value changed"] }); return;
        }
        if (task.task_id === "integrate.verify") {
          const reports = JSON.parse(text.match(/Referenced dependency reports \(captured claims, not independent checks\): ([^\n]+)/)[1]);
          assert.equal(reports.length, 1); assert.equal(reports[0].result, "Original source value: 7");
          const index = JSON.parse(text.match(/Actual dependency evidence: ([^\n]+)/)[1]).artifacts;
          assert.equal(index.find(a => a.task_id === "source").inline_report, true);
          assert.ok(index.some(a => a.task_id === "source.verify"), "full verifier findings remain accessible through the same authorized lineage");
        }
        call(this, "finish_task", { status: "completed", report: "Verified input integrated", unresolved: [], ...(task.kind === "verification" ? { verification_passed: true } : {}) });
      };
      return client;
    };
    engine = new FastAgentEngine({ runtime, signal: runtime.signal, cwd: directory, history: [{ role: "user", content: request }],
      settings: { ...fastSettings({}), retries: 0, replans: 0 }, system: "Unchanged capabilities", subagentSystem: "Independent checks",
      contextWindow: 1000000, maxRounds: 8, createClient,
      approve: async (name, args) => { approvals.push({ name, args, runId: currentTask().runId }); return { approved: true, source: "prompt", reason: "Local fixture" }; },
      execute: async (name, args, signal) => { executed.push(name); return executeTool(name, args, directory, signal); } });
    const result = await runtime.run(() => engine.run()); runtime.finish(result.status); await runtime.drain(); await diagnostics.close();
    const parent = result.snapshot.artifacts.find(a => a.task_id === "source"), verification = result.snapshot.artifacts.find(a => a.task_id === "source.verify");
    assert.ok(parent.source_run_id && parent.source_run_id !== "forged");
    assert.equal(runtime.evidenceFor(parent.source_run_id)[0].result, "7");
    assert.notEqual(verification?.source_run_id, parent.source_run_id);
    assert.equal(approvals.length, 2); assert.equal(executed.length, 2); assert.equal(runtime.snapshot().counts.toolCalls, 2);
    const events = fs.readFileSync(diagnostics.file, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(events.some(e => e.event === "tool_start" || e.event === "tool_started") || events.some(e => e.event === "tool_end"));
    assert.equal(requests.filter(id => id === "source.verify").length, 1, "one model round saved, independent original read retained");
    assert.equal(result.status, changed ? "partial" : "completed");
    if (changed) {
      assert.equal(result.snapshot.tasks.find(t => t.task_id === "integrate").status, "BLOCKED");
      assert.ok(!requests.includes("integrate"));
    }
    if (!changed) {
      const task = engine.scheduler.tasks.get("integrate.verify"), direct = [engine.store.latest("integrate")];
      const original = engine.store.latest("source");
      assert.deepEqual(engine.referencedDependencyReports(task, direct, [{ ...original, version: original.version + 1 }]), [], "superseded claims are never preloaded");
      assert.deepEqual(engine.referencedDependencyReports(task, direct, [{ ...original, result: "x".repeat(12001) }]), [], "large complete claims fall back to exact evidence lookup, without truncation");
      assert.deepEqual(engine.referencedDependencyReports(task, direct, [{ ...original, task_id: "unrelated" }]), [], "claimed references cannot expand the declared lineage");
    }
    return result;
  }
  await engineFixture(); await engineFixture(true);

  // Even an eager read cannot bypass normal approval, cancellation, inherited read-only scope or tool budgets.
  async function guardedRead(kind) {
    const directory = path.join(root, "guard-" + kind); fs.mkdirSync(directory); fs.writeFileSync(path.join(directory, "source.txt"), "7");
    const runtime = new TaskRuntime({ request: "Read source.txt. Work only inside this directory.", cwd: directory, ...(kind === "budget" ? { limits: { toolCalls: 1 } } : {}) });
    if (kind === "budget") await runtime.run(() => runtime.tool("read_file", { path: "source.txt" }, () => executeTool("read_file", { path: "source.txt" }, directory, runtime.signal)));
    const controller = new AbortController(); let executed = 0, approvals = 0, modelCalls = 0;
    if (kind === "cancel-before") controller.abort("Cancel before prefetch");
    const createClient = () => {
      const client = new LLMClient(model, "Fixture", "Max");
      client.streamTurn = async function* () {
        modelCalls++; this.outcome = { status: "completed" }; this.usage = { prompt: 10, completion: 1, total: 11 };
        call(this, "finish_task", { status: "completed", report: "Cannot turn a denial into success", verification_passed: true, unresolved: [] });
      }; return client;
    };
    const run = runtime.run(() => runFastWorker({ runtime, signal: controller.signal, task: "Independent verification", taskId: "test.verify",
      verification: true, readOnly: true, prefetchReads: [{ path: "source.txt", reason: "Fresh source" }], system: "Independent acceptance", tools: getToolDefinitions(),
      maxRounds: 3, contextWindow: 1000000, createClient,
      approve: async () => { approvals++; if (kind === "cancel-during") controller.abort("Cancel at approval");
        return { approved: kind !== "denied", source: "human", reason: "Actual unchanged decision" }; },
      execute: async (name, args, signal) => { executed++; return executeTool(name, args, directory, signal); } }));
    await assert.rejects(run, /blocked|completed:|Cancel|budget|limit/i);
    runtime.finish("failed"); await runtime.drain();
    assert.equal(executed, 0);
    if (kind === "denied") { assert.equal(approvals, 1); assert.equal(runtime.evidence[0].status, "denied"); }
    if (kind.startsWith("cancel")) assert.equal(modelCalls, 0);
  }
  for (const kind of ["denied", "cancel-before", "cancel-during", "budget"]) await guardedRead(kind);
  console.log("PASS lossless context versions; bounded fresh verifier reads; distinct evidence scopes; changed-source gate; complete upstream claims; approval/cancellation/budget invariants");
} finally {
  os.homedir = priorHome;
  for (const key of keys) priorEnv[key] === undefined ? delete process.env[key] : process.env[key] = priorEnv[key];
  fs.rmSync(root, { recursive: true, force: true });
}
