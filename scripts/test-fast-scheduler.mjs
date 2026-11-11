import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactStore } from "../dist/fast/artifacts.js";
import { DynamicScheduler, FastTaskError } from "../dist/fast/scheduler.js";
import { ResourcePool } from "../dist/fast/pool.js";
import { fastSettings } from "../dist/fast/types.js";

const settings = { ...fastSettings({}), workerSlots: 4, retries: 0, replans: 0 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const output = (task, extra = {}) => ({ result: task.task_id, conclusions: [], evidence: [], assumptions: [], unresolved: [],
  side_effects: false, verification_passed: task.kind === "verification", ...extra });
const task = (id, dependencies = [], extra = {}) => ({ task_id: id, task_goal: `Task ${id}`, dependencies,
  required_context: ["request", "history"], input_versions: {}, acceptance_criteria: ["Return a correct result"],
  output_contract: "A factual result", priority: 0, estimated_duration: 1, read_only: true, write_paths: [], exclusive: false, ...extra });
function scheduler(execute, extra = {}) {
  const store = new ArtifactStore(); store.context("request", "Keep all global constraints"); store.context("history", "Original history");
  return new DynamicScheduler(store, settings, { cwd: process.cwd(), execute, ...extra });
}

// The first worker starts while planning is still streaming. A successor ignores an unrelated slow branch.
{
  const firstStarted = deferred(), slowStarted = deferred(), releaseSlow = deferred(), childStarted = deferred();
  const events = [];
  const dag = scheduler(async t => {
    events.push(t.task_id);
    if (t.task_id === "a") firstStarted.resolve();
    if (t.task_id === "slow") { slowStarted.resolve(); await releaseSlow.promise; }
    if (t.task_id === "child") childStarted.resolve();
    return output(t);
  });
  const run = dag.run(async s => {
    s.add(task("a"));
    await firstStarted.promise;
    assert.equal(s.tasks.get("a").status, "RUNNING", "planning does not impose a barrier");
    s.add(task("slow")); s.add(task("child", ["a"]));
  });
  await slowStarted.promise; await childStarted.promise;
  assert.ok(events.indexOf("a.verify") < events.indexOf("child"));
  assert.equal(dag.tasks.get("slow").status, "RUNNING");
  releaseSlow.resolve(); await run;
  assert.equal(dag.successful, true);
  assert.equal(dag.store.latest("child").input_versions.a, 1);
  assert.equal(dag.store.latest("child").verification, "verified");
}

// Forward references are allowed; cycles and incomplete contracts never execute.
{
  const dag = scheduler(async t => output(t));
  await dag.run(async s => { s.add(task("later", ["first"])); s.add(task("first")); });
  assert.equal(dag.successful, true);
  const cyclic = scheduler(async t => output(t));
  await assert.rejects(cyclic.run(async s => { s.add(task("a", ["b"])); s.add(task("b", ["a"])); }), /Cyclic/);
  const missing = scheduler(async t => output(t));
  await missing.run(async s => s.add(task("a", ["missing"])));
  assert.equal(missing.tasks.get("a").status, "BLOCKED");
  const invalid = scheduler(async t => output(t));
  assert.throws(() => invalid.add(task("bad", [], { acceptance_criteria: [] })), /Incomplete/);
}

// A failed verifier cannot unlock its successors; independent branches still complete.
{
  let invoked = false;
  const pinned = scheduler(async t => { invoked = true; return output(t); });
  await pinned.run(async s => s.add(task("stale", [], { input_versions: { request: "outdated" } })));
  assert.equal(invoked, false); assert.equal(pinned.tasks.get("stale").status, "BLOCKED");
  assert.match(pinned.tasks.get("stale").error, /version mismatch/);
}

// A failed verifier cannot unlock its successors; independent branches still complete.
{
  const invoked = [];
  const dag = scheduler(async t => { invoked.push(t.task_id); return output(t, { verification_passed: t.task_id !== "a.verify" }); });
  await dag.run(async s => { s.add(task("a")); s.add(task("blocked", ["a"])); s.add(task("independent")); });
  assert.equal(dag.tasks.get("a").status, "FAILED");
  assert.equal(dag.tasks.get("blocked").status, "BLOCKED");
  assert.ok(!invoked.includes("blocked"));
  assert.equal(dag.store.latest("independent").verification, "verified");
}

// Invalidation cancels stale generations and republishes with pinned new versions.
{
  const running = deferred(), release = deferred(); let aCalls = 0;
  const dag = scheduler(async t => {
    if (t.task_id === "b" && t.generation === 0) { running.resolve(); await release.promise; }
    if (t.task_id === "a") aCalls++;
    return output(t, { result: `${t.task_id}:generation=${t.generation}` });
  });
  await dag.run(async s => {
    s.add(task("a")); s.add(task("b", ["a"]));
    await running.promise;
    s.invalidate("a", "Updated source"); release.resolve();
  });
  assert.equal(aCalls, 2);
  assert.equal(dag.store.latest("b").input_versions.a, 2);
  assert.match(dag.store.latest("b").result, /generation=1/);
  assert.equal(dag.store.all().find(a => a.task_id === "a" && a.version === 1).verification, "invalidated");
}

// Failed readers may retry; writes never repeat automatically. Explicit repairs retain original verification.
{
  let tries = 0;
  const retrySettings = { ...settings, retries: 1 };
  const store = new ArtifactStore();
  const dag = new DynamicScheduler(store, retrySettings, { cwd: process.cwd(), execute: async t => {
    if (t.kind === "work" && tries++ === 0) throw new FastTaskError("Transient read failure");
    return output(t);
  } });
  await dag.run(async s => s.add(task("read")));
  assert.equal(tries, 2); assert.equal(dag.retries, 1); assert.equal(dag.successful, true);
  let writes = 0;
  const edit = new DynamicScheduler(new ArtifactStore(), retrySettings, { cwd: process.cwd(), execute: async t => {
    if (t.task_id === "edit") { writes++; throw new FastTaskError("Partial write", true); }
    return output(t);
  } });
  await edit.run(async s => s.add(task("edit", [], { read_only: false, exclusive: true })));
  assert.equal(writes, 1); assert.equal(edit.retries, 0);
  await edit.run(async s => { s.add(task("repair")); s.repair("edit", "repair", "Repair existing changes"); });
  assert.equal(writes, 1, "repair must not replay an edit");
  assert.equal(edit.tasks.get("edit").status, "COMPLETED");
  assert.equal(edit.store.latest("edit").input_versions.repair, 1);
}

// Disjoint edit leases overlap, but a reader or shell lease cannot observe concurrent writes.
{
  let active = [], peak = 0;
  const dag = scheduler(async t => {
    if (t.kind === "work") {
      if (t.read_only || t.exclusive) assert.equal(active.length, 0);
      else assert.ok(active.every(other => !other.read_only && !other.exclusive));
      active.push(t); peak = Math.max(peak, active.length);
      await sleep(15); active = active.filter(other => other !== t);
    }
    return output(t);
  });
  await dag.run(async s => {
    s.add(task("edit_a", [], { read_only: false, write_paths: ["module-a"] }));
    s.add(task("edit_b", [], { read_only: false, write_paths: ["module-b"] }));
    s.add(task("reader")); s.add(task("shell", [], { read_only: false, exclusive: true }));
  });
  assert.equal(peak, 2);
  assert.equal(dag.successful, true);
}

// Cancellation drains actual work; timeout propagates the signal and leaves dependencies blocked.
{
  const started = deferred(), abort = new AbortController(); let drained = false;
  const dag = scheduler(async (t, signal) => {
    started.resolve(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    drained = true; return output(t);
  }, { signal: abort.signal });
  const run = dag.run(async s => s.add(task("slow")));
  await started.promise; abort.abort("Paused"); await run;
  assert.equal(drained, true); assert.equal(dag.store.latest("slow"), undefined);
  const timed = new DynamicScheduler(new ArtifactStore(), { ...settings, taskTimeoutMs: 10 }, {
    cwd: process.cwd(), execute: async (t, signal) => { await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); return output(t); },
  });
  await timed.run(async s => s.add(task("timeout")));
  assert.equal(timed.tasks.get("timeout").status, "FAILED");
  assert.match(timed.tasks.get("timeout").error, /timed out/);
}

// Resource limits apply to actual requests; priority, cancellation and live resizing are deterministic.
{
  const pool = new ResourcePool(1), release = await pool.acquire();
  const abort = new AbortController();
  const cancelled = pool.acquire(abort.signal); abort.abort("Cancelled queued request");
  await assert.rejects(cancelled, /Cancelled/);
  const order = [];
  const low = pool.run(async () => order.push("low"), undefined, 0);
  const high = pool.run(async () => order.push("high"), undefined, 10);
  release(); await Promise.all([low, high]); assert.deepEqual(order, ["high", "low"]);
  pool.resize(2); const a = await pool.acquire(), b = await pool.acquire();
  assert.equal(pool.running, 2); pool.resize(1); a(); assert.equal(pool.running, 1); b();
}

// Durable versions and separate stores never overwrite another run's context/results.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-artifacts-"));
  try {
    const store = new ArtifactStore(dir);
    store.context("request", "full constraints");
    store.put("a", output(task("a")), { request: "v1" }); store.verify("a"); store.invalidate("a");
    store.put("a", output(task("a")), { request: "v2" });
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "artifacts.json"), "utf8"));
    assert.equal(persisted.artifacts.length, 2); assert.equal(persisted.artifacts[0].verification, "invalidated");
    assert.equal(new ArtifactStore().latest("a"), undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    store.put("a", output(task("a")), { request: "v3" });
    assert.equal(fs.existsSync(dir), false, "late callbacks cannot resurrect explicitly deleted task history");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log("PASS fast scheduler: streaming dispatch, real dependencies, verification, versions, repair, leases, resource limits, cancellation and durability");
