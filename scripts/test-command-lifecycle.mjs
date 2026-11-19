import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startCommand } from "../dist/llm/command.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-command-"));
process.env.NEUTRINO_HOME = path.join(dir, "home");
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { resumeTaskSnapshot } = await import("../dist/llm/runtime.js");
const { executeTool } = await import("../dist/llm/tools.js");
const quote = value => process.platform === "win32" ? `"${value}"` : `'${value.replace(/'/g, `'"'"'`)}'`;
const script = (name, content) => { const file = path.join(dir, name); fs.writeFileSync(file, content); return file; };
const command = file => `${quote(process.execPath)} ${quote(file)}`;
const waitFor = async predicate => {
  const deadline = Date.now() + 15000;
  while (!predicate()) { assert(Date.now() < deadline, "process fixture did not become ready"); await new Promise(resolve => setTimeout(resolve, 20)); }
};
const bounded = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error("command did not settle within 5s")), 5000); timer.unref();
})]);

const hello = script("hello.cjs", "process.stdout.write('hello');process.exit(7)");
assert.match(await startCommand(command(hello), dir, new AbortController().signal).done, /hello\n\[exit code: 7\]/);
const eof = script("eof.cjs", "process.stdin.resume();process.stdin.on('end',()=>console.log('EOF received'))");
assert.match(await startCommand(command(eof), dir, new AbortController().signal).done, /EOF received/);

// The shell and launcher exit before the worker. It retains their stdio and
// attempts a write after cancellation. This runs on Windows as well as POSIX.
const ready = path.join(dir, "ready"), late = path.join(dir, "late");
const worker = script("worker.cjs", `const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(late)},'unexpected write'),1200);setTimeout(()=>{},10000)`);
const launcher = script("launcher.cjs", `require('child_process').spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:'inherit'}).unref();process.exit(0)`);
const launch = process.platform === "win32" ? `start "" /b ${command(worker)} & echo SHELL_DONE` : command(launcher);
for (const background of [false, true]) {
  fs.rmSync(ready, { force: true }); fs.rmSync(late, { force: true });
  const stop = new AbortController();
  const runtime = new TaskRuntime({ request: "cancel the owned process tree", cwd: dir, signal: stop.signal });
  let result;
  const running = runtime.run(() => runtime.tool("run_command", { command: launch, background }, () => executeTool("run_command", { command: launch, background }, dir)));
  if (background) {
    result = JSON.parse(await running);
    assert.equal(result.running, true);
    const stranger = new TaskRuntime({ request: "cannot control another task", cwd: dir });
    assert.match(await stranger.run(() => executeTool("stop_command", { command_id: result.command_id }, dir)), /unknown command/);
    stranger.finish("completed");
  }
  await waitFor(() => fs.existsSync(ready));
  const pid = Number(fs.readFileSync(ready, "utf8"));
  stop.abort();
  await bounded(runtime.drain());
  if (!background) assert.match(await running, /command cancelled/);
  assert.throws(() => process.kill(pid, 0), "owned descendant must have exited");
  await new Promise(resolve => setTimeout(resolve, 1300));
  assert.equal(fs.existsSync(late), false, "cancelled descendants cannot write later");
  runtime.finish("cancelled");
}

// Normal task completion also stops explicitly managed background work.
fs.rmSync(ready, { force: true });
const runtime = new TaskRuntime({ request: "start and stop a background fixture", cwd: dir });
const background = await runtime.run(() => executeTool("run_command", { command: launch, background: true }, dir));
const handle = JSON.parse(background).command_id;
await waitFor(() => fs.existsSync(ready));
assert.equal(JSON.parse(await runtime.run(() => executeTool("command_status", { command_id: handle }, dir))).running, true);
assert.equal(JSON.parse(await runtime.run(() => executeTool("stop_command", { command_id: handle }, dir))).running, false);
await bounded(runtime.drain()); runtime.finish("completed");

// A task finishing normally must reclaim its background work as well.
fs.rmSync(ready, { force: true });
const completed = new TaskRuntime({ request: "finish with a running background fixture", cwd: dir });
await completed.run(() => executeTool("run_command", { command: launch, background: true }, dir));
await waitFor(() => fs.existsSync(ready));
const ownedPid = Number(fs.readFileSync(ready, "utf8"));
await bounded(completed.drain()); completed.finish("completed");
assert.throws(() => process.kill(ownedPid, 0), "normal completion stops task-owned background processes");

const neverEnds = script("timeout.cjs", "console.log('timeout fixture');setTimeout(()=>{},10000)");
assert.match(await bounded(startCommand(command(neverEnds), dir, new AbortController().signal, { timeoutMs: 1000 }).done), /command timed out/);

// Exercise the real Standard WebSession pause/resume driver with a fixture
// model. No provider requests or user configuration are involved.
const { WebSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
process.env.NEUTRINO_PLAN = "off";
const originalStream = LLMClient.prototype.streamTurn;
let requests = 0;
LLMClient.prototype.streamTurn = async function* () {
  this.toolCalls = requests++ === 0 ? [{ id: "fixture-call", name: "run_command", arguments: JSON.stringify({ command: launch, reason: "isolated pause fixture" }) }] : [];
  this.outcome = { status: "completed" };
  if (!this.toolCalls.length) yield "Fixture continued after pause.";
};
const session = new WebSession({ id: "command-pause-fixture", cwd: dir, messages: [], provider: "Fixture", model: "Fixture", intensity: "High" },
  { name: "Fixture", url: "https://fixture.invalid", api_key: "fixture", supports_streaming: true });
session.autoCompress = async () => {};
session.requestApproval = async () => ({ approved: true, source: "prompt", reason: "isolated fixture" });
try {
  fs.rmSync(ready, { force: true }); fs.rmSync(late, { force: true });
  session.start(); session.liveSend("Run this command.");
  await waitFor(() => fs.existsSync(ready));
  session.livePause();
  await waitFor(() => session.liveMeta().task?.state === "cancelled");
  assert.equal(session.liveMeta().paused, true);
  session.liveResume();
  await waitFor(() => !session.liveMeta().busy && session.liveSnapshot(session.key).messages.some(m => m.content?.includes("Fixture continued")));
  assert.equal(session.liveMeta().paused, false);
  assert.equal(fs.existsSync(late), false);
} finally { session.dispose(); LLMClient.prototype.streamTurn = originalStream; }

// An uncooperative operation is reported as blocked, then recovers when it
// actually stops. It must never be reported cancelled while still executing.
const stuck = new TaskRuntime({ request: "uncooperative operation", cwd: dir });
let release; const pending = stuck.track(new Promise(resolve => { release = resolve; }));
let notifications = 0; stuck.observeState(() => notifications++);
stuck.cancel();
await new Promise(resolve => setTimeout(resolve, 5100));
assert.equal(stuck.snapshot().state, "blocked");
assert(stuck.snapshot().cleanupError); assert(stuck.settling);
assert.equal(resumeTaskSnapshot(stuck.snapshot()).cleanupError, undefined, "a process restart has no live operations to clean up");
release(); await pending; await stuck.drain(); await Promise.resolve();
assert.equal(stuck.snapshot().state, "cancelled"); assert.equal(stuck.snapshot().cleanupError, undefined);
assert(notifications >= 3); stuck.finish("cancelled");
fs.rmSync(dir, { recursive: true, force: true });
console.log(`ok command lifecycle (${process.platform}): EOF, exit status, orphan descendants, background ownership, cancellation and cleanup failure`);
