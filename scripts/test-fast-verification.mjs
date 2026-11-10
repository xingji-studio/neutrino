import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { parseHTML } from "linkedom";
import { analyzeTimeline } from "./fast-timeline-analysis.mjs";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-verification-"));
const original = { home: os.homedir, environment: Object.fromEntries(
  ["NEUTRINO_HOME", "NEUTRINO_PLUGIN_HOME", "NEUTRINO_DIAGNOSTICS_DIR"].map(key => [key, process.env[key]])) };
process.env.NEUTRINO_HOME = path.join(fixture, "home");
process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
delete process.env.NEUTRINO_DIAGNOSTICS_DIR;
os.homedir = () => fixture;
const { ArtifactStore } = await import("../dist/fast/artifacts.js");
const { DynamicScheduler, FastTaskError } = await import("../dist/fast/scheduler.js");
const { FastAgentEngine } = await import("../dist/fast/engine.js");
const { fastSettings } = await import("../dist/fast/types.js");
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { DiagnosticRecorder } = await import("../dist/llm/diagnostics.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { executeTool } = await import("../dist/llm/tools.js");
const settings = { ...fastSettings({}), retries: 0, replans: 0 };
const task = (id, dependencies = [], extra = {}) => ({ task_id: id, task_goal: `Task ${id}`, dependencies,
  required_context: ["request", "history"], input_versions: {}, acceptance_criteria: ["Return a correct result"],
  output_contract: "A factual result", priority: 0, estimated_duration: 1, read_only: true, write_paths: [], exclusive: false, ...extra });
const output = (t, extra = {}) => ({ result: t.task_id, conclusions: [], evidence: [], assumptions: [], unresolved: [],
  side_effects: false, verification_passed: t.kind === "verification", ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function scheduler(execute, extra = {}, limits = settings) {
  const store = new ArtifactStore(); store.context("request", "Keep every requirement"); store.context("history", "Original history");
  return new DynamicScheduler(store, limits, { cwd: fixture, execute, ...extra });
}

// Actual local tools and commands, with scripted model replies. No provider calls or timing claims.
async function runEngine(name, { merged = false, explicit = false, broken = false, omitCheckReference = false } = {}) {
  const cwd = path.join(fixture, name); fs.mkdirSync(cwd);
  const criteria = ["Export both functions", "Addition handles negative inputs", "Multiplication handles zero"];
  fs.writeFileSync(path.join(cwd, "check.mjs"), `import assert from "node:assert/strict";
import { add, multiply } from "./module.mjs";
const checks = {
  shape() { assert.equal(typeof add, "function"); assert.equal(typeof multiply, "function"); },
  add() { assert.equal(add(-2, 5), 3); assert.equal(add(0, 0), 0); },
  multiply() { assert.equal(multiply(7, 0), 0); assert.equal(multiply(-3, 2), -6); }
};
for (const check of process.argv.slice(2)) { checks[check](); console.log("PASS " + check); }
`);
  const build = task("implement_modules", [], { read_only: false, exclusive: true,
    acceptance_criteria: merged ? criteria : criteria.slice(0, 1), output_contract: "Save working add and multiply exports" });
  const check = task("verify_modules", [build.task_id], { kind: explicit ? "verification" : "work",
    read_only: false, exclusive: true, acceptance_criteria: criteria.slice(1), output_contract: "Independently check arithmetic edge cases" });
  const plan = merged ? [build] : [build, check];
  const diagnostics = new DiagnosticRecorder(path.join(cwd, "trace.jsonl"), { mode: "fast_dag" });
  const runtime = new TaskRuntime({ request: "Implement arithmetic functions and independently check every requirement.", cwd, diagnostics });
  const calls = [], executed = [], requirements = new Map(), suppliedCoverage = new Map();
  const model = { name: "unchanged-fixture-model", url: "https://offline.invalid/v1", api_key: "fixture", intensity: ["High"], supports_streaming: true };
  const createClient = () => {
    const client = new LLMClient(model, "Fixture", "High");
    client.streamTurn = async function* (messages, tools, options) {
      assert.equal(this.model.name, model.name); assert.equal(this.intensity, "High");
      assert.ok(options.maxOutputTokens > 0);
      this.toolCalls = []; this.outcome = { status: "completed" }; this.usage = { prompt: 10, completion: 5, total: 15 };
      if (messages[0].content.startsWith("You plan tasks")) {
        calls.push("planner");
        assert.match(messages[0].content, /Merge overlapping single-task validation/);
        yield JSON.stringify({ type: "constraints", goal: runtime.originalRequest, constraints: ["Preserve independent checks"] }) + "\n";
        for (const definition of plan) yield JSON.stringify({ type: "task", task: definition }) + "\n";
        yield '{"type":"done"}\n'; return;
      }
      if (messages.some(m => m.content?.includes("Perform the mandatory global review"))) {
        calls.push("global_review");
        const ids = plan.filter(t => !omitCheckReference || t.task_id !== check.task_id).map(t => `artifact:${t.task_id}@1`);
        this.toolCalls = [{ id: "final", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed",
          report: "All independent checks passed", unresolved: [], evidence_ids: ids }) }];
        return;
      }
      const definition = JSON.parse(messages.find(m => m.role === "user").content.match(/Task: (\{[^\n]*\})/)[1]);
      const coverage = JSON.parse(messages.find(m => m.role === "user").content.match(/Verified dependency acceptance coverage: ([^\n]+)/)[1]);
      suppliedCoverage.set(definition.task_id, coverage);
      for (const check of coverage) for (const id of check.verifier.evidence) {
        assert.ok(runtime.evidence.some(e => e.id === id), "independent coverage carries actual evidence");
        assert.ok(messages.find(m => m.role === "user").content.includes(id));
      }
      calls.push(definition.task_id); requirements.set(definition.task_id, definition.acceptance_criteria);
      const results = messages.filter(m => m.role === "tool");
      const call = (name, args) => { this.toolCalls = [{ id: `${definition.task_id}-${results.length}`, name, arguments: JSON.stringify(args) }]; };
      if (definition.task_id === build.task_id) {
        if (!results.length) {
          call("write_file", { path: "module.mjs", content: `export const add = (a, b) => ${broken ? "a - b" : "a + b"};\nexport const multiply = (a, b) => a * b;\n`, reason: "Implement functions" }); return;
        }
        if (results.length === 1) { call("run_command", { command: "node check.mjs shape", reason: "Development self-check" }); return; }
      } else if (!results.length) {
        const names = definition.acceptance_criteria.map(c => ({ [criteria[0]]: "shape", [criteria[1]]: "add", [criteria[2]]: "multiply" })[c]);
        assert.ok(names.every(Boolean), "every acceptance criterion must have an actual check");
        call("run_command", { command: "node check.mjs " + names.join(" "), reason: "Independent acceptance checks" }); return;
      }
      const expected = definition.task_id === build.task_id ? ["shape"] : definition.acceptance_criteria.map(c =>
        ({ [criteria[0]]: "shape", [criteria[1]]: "add", [criteria[2]]: "multiply" })[c]);
      const passed = results.every(m => !/\[Error:|\[exit code:|AssertionError/.test(m.content)) &&
        expected.every(check => results.at(-1)?.content.includes(`PASS ${check}`));
      yield JSON.stringify({ result: passed ? "Checks passed" : "Required arithmetic check failed",
        verification_passed: passed, unresolved: passed ? [] : ["Addition handles negative inputs"] });
    };
    return client;
  };
  const engine = new FastAgentEngine({ runtime, signal: runtime.signal, settings, cwd, history: [{ role: "user", content: runtime.originalRequest }],
    system: "Keep original model capabilities", subagentSystem: "Independently check original evidence", contextWindow: 128_000,
    maxRounds: 8, createClient, directory: path.join(cwd, "runs"), approve: async () => ({ approved: true, source: "prompt", reason: "Local fixture" }),
    execute: async (name, args, signal) => { executed.push({ name, args }); return executeTool(name, args, cwd, signal); } });
  const result = await runtime.run(() => engine.run()); runtime.finish(result.status); await runtime.drain();
  const trace = analyzeTimeline(fs.readFileSync(diagnostics.file, "utf8").trim().split("\n").map(line => JSON.parse(line)));
  assert.equal(trace.valid_for_attribution, true, trace.issues.join(","));
  return { result, calls, executed, requirements, suppliedCoverage, runtime, trace, criteria };
}

try {
  // Explicit checks depend on fully verified versions, execute once and unlock downstream work directly.
  {
    const calls = [], verified = [];
    const dag = scheduler(async t => {
      calls.push(t.task_id);
      if (t.task_id === "integration") for (const id of ["a", "b"]) assert.equal(dag.store.latest(id).verification, "verified");
      return output(t);
    }, { onVerified: t => verified.push(t.task_id) });
    await dag.run(async s => {
      s.add(task("a")); s.add(task("b"));
      s.add(task("integration", ["a", "b"], { kind: "verification", acceptance_criteria: ["Cross-module contract", "Original source evidence"] }));
      s.add(task("publish", ["integration"]));
    });
    assert.equal(dag.successful, true); assert.equal(dag.plannedTaskCount, 4);
    assert.equal(calls.filter(id => id === "integration").length, 1); assert.equal(dag.tasks.has("integration.verify"), false);
    assert.ok(calls.indexOf("a.verify") < calls.indexOf("integration")); assert.ok(calls.indexOf("b.verify") < calls.indexOf("integration"));
    assert.ok(calls.indexOf("integration") < calls.indexOf("publish"));
    assert.equal(dag.store.latest("integration").input_versions.a, 1); assert.equal(dag.store.latest("publish").input_versions.integration, 1);
    assert.deepEqual(verified.sort(), ["a", "b", "integration", "publish"]);
    const named = scheduler(async t => output(t)); named.add(task("verify_sounding_implementation"));
    assert.equal(named.tasks.has("verify_sounding_implementation.verify"), true, "names cannot waive independent verification");
  }

  // Check roles cannot be used to bypass dependencies, lease rules, limits or runtime-controlled fields.
  {
    const dag = scheduler(async t => output(t), {}, { ...settings, maxTasks: 2 });
    dag.add(task("source")); dag.add(task("check", ["source"], { kind: "verification" }));
    assert.equal(dag.tasks.size, 3); assert.throws(() => dag.add(task("extra")), /count limit/);
    const invalid = scheduler(async t => output(t));
    for (const definition of [task("standalone", [], { kind: "verification" }), task("unknown", [], { kind: "skip" }),
      task("scoped", ["source"], { kind: "verification", read_only: false, write_paths: ["subtree"] }),
      task("spoofed", ["source"], { kind: "verification", verifies: "source" })]) assert.throws(() => invalid.add(definition), /Incomplete|runtime/);
    const cyclic = scheduler(async t => output(t));
    await assert.rejects(cyclic.run(async s => { s.add(task("check", ["work"], { kind: "verification" })); s.add(task("work", ["check"])); }), /Cyclic/);
  }

  // Missing/negative/contradictory verdicts, stale versions and failed source checks never unlock successors.
  for (const verdict of [{ verification_passed: false }, { verification_passed: undefined }, { unresolved: ["Unmet integration criterion"] }]) {
    const calls = [], dag = scheduler(async t => { calls.push(t.task_id); return output(t, t.task_id === "check" ? verdict : {}); });
    await dag.run(async s => { s.add(task("source")); s.add(task("check", ["source"], { kind: "verification" })); s.add(task("after", ["check"])); });
    assert.equal(dag.tasks.get("check").status, "FAILED"); assert.equal(dag.tasks.get("after").status, "BLOCKED");
    assert.equal(dag.store.latest("source").verification, "verified"); assert.ok(!calls.includes("after"));
  }
  {
    const calls = [], dag = scheduler(async t => { calls.push(t.task_id); return output(t); });
    await dag.run(async s => { s.add(task("source")); s.add(task("stale", ["source"], { kind: "verification", input_versions: { source: 9 } })); });
    assert.ok(!calls.includes("stale")); assert.match(dag.tasks.get("stale").error, /version mismatch/);
    const failed = scheduler(async t => output(t, { verification_passed: t.task_id !== "source.verify" }));
    await failed.run(async s => { s.add(task("source")); s.add(task("check", ["source"], { kind: "verification" })); });
    assert.equal(failed.tasks.get("check").attempts, 0);
  }

  // A check in flight is invalidated with its source; stale success cannot be published.
  {
    const started = deferred(), release = deferred(), calls = [];
    const dag = scheduler(async t => {
      calls.push(`${t.task_id}@${t.generation}`);
      if (t.task_id === "check" && t.generation === 0) { started.resolve(); await release.promise; }
      return output(t);
    });
    await dag.run(async s => {
      s.add(task("source")); s.add(task("check", ["source"], { kind: "verification" })); s.add(task("after", ["check"]));
      await started.promise; s.invalidate("source", "Source changed"); release.resolve();
    });
    assert.equal(dag.successful, true); assert.equal(dag.store.latest("check").input_versions.source, 2);
    assert.equal(dag.store.all().filter(a => a.task_id === "check").length, 1); assert.ok(calls.includes("check@1"));
  }

  // A shell check requires explicit recovery after side effects, and repair never replaces its own independent verdict.
  {
    let checks = 0;
    const dag = scheduler(async t => {
      if (t.task_id === "check" && ++checks === 1) throw new FastTaskError("Test produced partial state", true);
      return output(t);
    });
    await dag.run(async s => { s.add(task("source")); s.add(task("check", ["source"], { kind: "verification", read_only: false, exclusive: true, required_context: ["request", "history", "source"] })); });
    assert.equal(checks, 1);
    dag.invalidate("check", "Repair partial test state"); assert.equal(dag.tasks.get("check").needs_repair, true);
    await dag.run(async s => { s.add(task("fix")); s.repair("check", "fix", "Repair first, then independently check original criteria"); });
    assert.equal(checks, 2); assert.equal(dag.successful, true); assert.equal(dag.tasks.has("check.verify"), false);
    assert.deepEqual(dag.tasks.get("check").dependencies, ["source", "fix"]);
    assert.equal(dag.store.latest("check").input_versions.source, 1); assert.equal(dag.store.latest("check").input_versions.fix, 1);
  }
  {
    const started = deferred(), abort = new AbortController(); let drained = false;
    const dag = scheduler(async (t, signal) => {
      if (t.task_id === "check") { started.resolve(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); drained = true; }
      return output(t);
    }, { signal: abort.signal });
    const run = dag.run(async s => { s.add(task("source")); s.add(task("check", ["source"], { kind: "verification" })); });
    await started.promise; abort.abort("Cancel independent check"); await run;
    assert.equal(drained, true); assert.equal(dag.store.latest("check"), undefined); assert.equal(dag.successful, false);
  }

  const legacy = await runEngine("legacy");
  const merged = await runEngine("merged", { merged: true });
  const explicit = await runEngine("explicit", { explicit: true });
  for (const run of [legacy, merged, explicit]) {
    assert.equal(run.result.status, "completed"); assert.equal(run.result.snapshot.review.at(-1).accepted, true);
    assert.equal(run.result.snapshot.metrics.total.requests, run.calls.length);
    assert.equal(run.executed.filter(e => e.name === "write_file").length, 1);
    const independent = run.runtime.evidence.filter(e => e.name === "run_command" && /shape add multiply|add multiply/.test(e.arguments.command));
    assert.ok(independent.length > 0); assert.ok(independent.every(e => e.status === "completed"));
    assert.ok(independent.every(e => e.result.includes("PASS add") && e.result.includes("PASS multiply")));
    assert.ok(independent.every(e => e.runId !== run.runtime.evidence.find(e => e.name === "write_file").runId), "acceptance checks use an independent agent scope");
  }
  assert.deepEqual(merged.requirements.get("implement_modules.verify"), merged.criteria, "merged verifier retains every original criterion");
  assert.equal(merged.result.snapshot.tasks.length, 2); assert.ok(!merged.calls.includes("verify_modules"));
  assert.equal(legacy.calls.length - merged.calls.length, 4, "remove validation work and its nested verifier while preserving independent checks");
  assert.equal(legacy.calls.length - explicit.calls.length, 2, "an additional independent check has no second verifier");
  assert.ok(explicit.result.snapshot.integrated.verify_modules);
  assert.ok(explicit.trace.observed_task_admission_chain.includes("verify_modules"));
  assert.ok(explicit.trace.observed_task_admission_chain.includes("implement_modules.verify"));
  assert.deepEqual(explicit.requirements.get("verify_modules"), legacy.requirements.get("verify_modules.verify"));
  assert.deepEqual(merged.suppliedCoverage.get("implement_modules.verify"), [], "development self-checks cannot count as independent acceptance evidence");
  const coverage = explicit.suppliedCoverage.get("verify_modules");
  assert.equal(coverage.length, 1); assert.deepEqual(coverage[0].acceptance_criteria, [merged.criteria[0]]);
  assert.equal(coverage[0].artifact_version, 1); assert.equal(coverage[0].verifier.task_id, "implement_modules.verify");
  assert.equal(coverage[0].verifier.input_versions.implement_modules, 1);
  // The actual progress card includes planned checks and does not double-count automatic verifiers.
  {
    const { document } = parseHTML('<html><body><div id="plan"></div></body></html>');
    const source = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
    const context = vm.createContext({ document, el: { planCard: document.getElementById("plan") }, state: { planOpen: true },
      tr: (text, args = {}) => text.replace(/\{(\w+)\}/g, (_, key) => args[key]),
      snapshot: { activeAgentMode: "fast_dag", fast: explicit.result.snapshot } });
    const start = source.indexOf("function fastPhaseLabel(");
    vm.runInContext(source.slice(start, source.indexOf("// ------------------------------------------------------------------- actions", start)), context);
    vm.runInContext("renderPlanCard(snapshot)", context);
    const rows = [...document.querySelectorAll(".fast-progress li")].map(row => row.textContent);
    assert.equal(rows.length, 2); assert.ok(rows.some(row => row.includes("Task verify_modules")));
    assert.match(document.querySelector(".fast-progress p").textContent, /0 running · 2\/2 verified/);
  }
  const broken = await runEngine("broken", { merged: true, broken: true });
  assert.notEqual(broken.result.status, "completed"); assert.equal(broken.result.snapshot.tasks.find(t => t.task_id === "implement_modules").status, "FAILED");
  assert.ok(broken.runtime.evidence.some(e => e.name === "run_command" && /AssertionError/.test(e.result)), "the retained independent check catches a real implementation error");
  const omitted = await runEngine("omitted-reference", { explicit: true, omitCheckReference: true });
  assert.notEqual(omitted.result.status, "completed"); assert.ok(omitted.result.snapshot.review.every(row => !row.accepted));
  console.log(`PASS fast verification: local criteria merged, additional independent checks execute once, failures/versioning/repair/cancel remain gated; scripted rounds ${legacy.calls.length} -> ${merged.calls.length}, explicit check ${explicit.calls.length}; real local checks, no provider calls`);
} finally {
  os.homedir = original.home; fs.rmSync(fixture, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original.environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
