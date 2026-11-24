import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskController, TaskStore } from "../dist/tasks/controller.js";

if (process.argv[2] === "--owner") {
  const owner = new TaskController(process.argv[3], "child-attempt", "Build the complete original task");
  if (process.argv[4]) owner.event("tool_started", { id: "in-flight", name: process.argv[4], arguments: { path: "fixture" } });
  process.send({ ready: true });
  setInterval(() => {}, 60000);
} else {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-control-"));
  process.env.NEUTRINO_HOME = path.join(fixture, "home");
  const children = new Set();
  async function startOwner(directory, tool) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--owner", directory, ...(tool ? [tool] : [])],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    children.add(child);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Owner startup timed out")), 10000);
      child.once("message", () => { clearTimeout(timeout); resolve(); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Owner exited before ready")); });
      child.once("error", reject);
    });
    return child;
  }
  async function kill(child) {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL"); await exited; children.delete(child);
  }
  try {
    const directory = path.join(fixture, "lease");
    const child = await startOwner(directory);
    assert.throws(() => new TaskController(directory, "duplicate", "continue"), { code: "task_owned" });
    await kill(child);
    const resumed = new TaskController(directory, "next-attempt", "继续");
    assert.equal(resumed.spec.objective, "Build the complete original task");
    const taskId = resumed.spec.taskId;
    resumed.finish("partial");
    const retry = new TaskController(directory, "retry", "开始？");
    assert.equal(retry.spec.taskId, taskId);
    retry.finish("completed");
    const next = new TaskController(directory, "new", "Create a different task");
    assert.notEqual(next.spec.taskId, taskId); next.finish("completed");
    console.log("ok single writer, forced worker death, original objective and stable task identity");

    const unsafeDir = path.join(fixture, "unknown");
    await kill(await startOwner(unsafeDir, "run_command"));
    assert.throws(() => new TaskController(unsafeDir, "unsafe-retry", "继续"), { code: "tool_outcome_unknown" });
    const unsafe = new TaskStore(unsafeDir);
    assert.equal(unsafe.record.state, "blocked");
    assert.equal(unsafe.unknownTools()[0].id, "in-flight");
    console.log("ok unknown command side effects block recovery instead of replaying");

    const readDir = path.join(fixture, "read");
    await kill(await startOwner(readDir, "read_file"));
    const read = new TaskController(readDir, "safe-retry", "继续");
    assert.equal(read.store.pendingTools().length, 0);
    read.event("tool_started", { id: "read2", name: "read_file", arguments: {} });
    assert.throws(() => read.event("finished", { state: "completed" }), { code: "pending_tools" });
    read.event("tool_finished", { id: "read2", name: "read_file", arguments: {}, result: "content", status: "completed" });
    read.finish("completed");
    console.log("ok read-only recovery reconciles interruption and pending reads prevent completion");

    fs.appendFileSync(path.join(readDir, "events.jsonl"), '{"torn":');
    const torn = new TaskController(readDir, "after-torn", "New task");
    torn.finish("completed");
    assert.equal(new TaskStore(readDir).record.attemptId, "after-torn");
    const corruptFile = path.join(readDir, "events.jsonl");
    const text = fs.readFileSync(corruptFile, "utf8");
    fs.writeFileSync(corruptFile, text.replace('"version":1', '"version":2'));
    assert.throws(() => new TaskController(readDir, "corrupt", "continue"), { code: "task_store_corrupt" });
    console.log("ok torn tail recovery and checksum failure prevent fabricated task success");

    const { TaskRuntime } = await import("../dist/llm/runtime.js");
    const runtime = new TaskRuntime({ request: "Write a fixture", journalDir: path.join(fixture, "persistence") });
    const fsync = fs.fsyncSync;
    let executed = false;
    fs.fsyncSync = () => { throw new Error("injected disk failure"); };
    try {
      await runtime.run(() => runtime.tool("write_file", { path: "fixture" }, async () => { executed = true; return "wrote"; }));
      assert.equal(executed, false);
      assert.throws(() => runtime.check(), /could not be persisted/);
    } finally { fs.fsyncSync = fsync; runtime.finish("blocked"); }
    assert.equal(runtime.snapshot().state, "blocked");
    console.log("ok state persistence failure stops side effects before execution");
    const { WebSession } = await import("../dist/web/session.js");
    const { sessionDir } = await import("../dist/config.js");
    const session = new WebSession({ id: "blocked-startup", provider: "Fixture", model: "fixture", intensity: "High", cwd: fixture, messages: [] },
      { name: "fixture", url: "http://127.0.0.1:1/v1", api_key: "fixture" });
    session.start();
    const lockDir = path.join(sessionDir("standard"), "tasks", "blocked-startup", "controller");
    fs.mkdirSync(lockDir, { recursive: true }); fs.writeFileSync(path.join(lockDir, "owner.lock"), "unverifiable owner");
    session.liveSend("A new task whose ownership cannot be established");
    for (let n = 0; session.liveMeta().busy && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(session.liveMeta().busy, false);
    assert.equal(session.liveMeta().task.state, "blocked");
    assert.match(session.liveMeta().task.stopReason, /owner record cannot be verified/);
    session.dispose();
    console.log("ok executor startup refusal is visibly blocked instead of inheriting a completed or idle state");
  } finally {
    for (const child of children) await kill(child);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
