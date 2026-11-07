import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate config without touching the user's home or changing HOME.
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-agent-modes-"));
const originalHomedir = os.homedir;
os.homedir = () => fixture;
const config = await import("../dist/config.js");
const { executeCodeProgram, ProgramToolDenied, getCodeToolDefinition } = await import("../dist/llm/codemode.js");
const { LocalCodeExecutor } = await import("../dist/llm/codeExecutor.js");
const { executeTool } = await import("../dist/llm/tools.js");
const { createWebSession, resumeSession } = await import("../dist/web/session.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { defaultState } = await import("../dist/state.js");
const { hub } = await import("../dist/web/hub.js");
const { startWebServer } = await import("../dist/web/server.js");
const { seedProPresets } = await import("./pro-presets.mjs");
const cwd = path.join(fixture, "project");
fs.mkdirSync(cwd);
fs.writeFileSync(path.join(cwd, "input.txt"), "RAW_INTERMEDIATE\n".repeat(2000));
const model = { name: "fixture-model", url: "https://fixture.invalid/v1", api_key: "fixture-key", supports_streaming: true };
const selection = { provider: "Fixture", model, intensity: "High" };
config.saveModels({ providers: [{ name: "Fixture", models: [model] }] });
config.saveConfig({ plan_first: true, default_provider: "Fixture", default_model: model.name });
seedProPresets();

let script = [];
const requests = [];
const originalStream = LLMClient.prototype.streamTurn;
LLMClient.prototype.streamTurn = async function* (messages, tools) {
  requests.push({ messages: structuredClone(messages), tools: (tools ?? []).map(t => t.function.name) });
  const next = script.shift() ?? { text: "Finished" };
  if (next.wait) await next.wait;
  this.toolCalls = next.calls ?? [];
  this.usage = { prompt: 100, completion: 20 };
  yield next.text ?? "";
};
const sessions = [];
const screens = [];
let server;
const program = code => ({ plan: ["Read input", "Write the filtered result"], reason: "Read and summarize the fixture", code });
const call = args => ({ id: "program-1", name: "execute_ts", arguments: JSON.stringify(args) });
const waitFor = async predicate => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for agent mode test");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
function session(mode) {
  const value = createWebSession(cwd, selection, "request", "standard", undefined, mode);
  value.start(); sessions.push(value); return value;
}
function options(overrides = {}) {
  let plan;
  return {
    call: (name, args) => executeTool(name, args, cwd),
    onPlan: value => { plan = value; },
    onStep: (index, status) => { plan.steps[index].status = status; },
    ...overrides,
  };
}

try {
  assert.equal(config.normalizeAgentMode(undefined), "standard");
  assert.match(getCodeToolDefinition().function.description, /codemode/);
  assert.match(getCodeToolDefinition().function.description, /read_file/);

  // Real TypeScript, SDK-generated API types, dependent calls and local filtering.
  const code = `async () => {
    const input: string = await codemode.read_file({path: "input.txt", reason: "Read the fixture"});
    await codemode.complete_step({index: 0});
    await codemode.set_step({index: 1});
    const lines: number = input.trim().split("\\n").length;
    await codemode.write_file({path: "output.txt", content: String(lines), reason: "Save the count"});
    await codemode.complete_step({index: 1});
    return {lines};
  }`;
  const result = JSON.parse(await executeCodeProgram(program(code), options()));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.result, { lines: 2000 });
  assert.equal(fs.readFileSync(path.join(cwd, "output.txt"), "utf8"), "2000");
  assert.deepEqual(result.completed.map(c => c.tool), ["read_file", "write_file"]);
  assert.ok(!JSON.stringify(result).includes("RAW_INTERMEDIATE"), "raw intermediate data stays out of the model result");

  // Neither Node globals nor direct network APIs exist in the guest.
  const isolated = await new LocalCodeExecutor().execute('async () => [typeof process, typeof require, typeof fetch]', {});
  assert.deepEqual(isolated.result, ["undefined", "undefined", "undefined"]);
  const runaway = await new LocalCodeExecutor(undefined, { cpuMs: 30 }).execute('async () => { while (true) {} }', {});
  assert.match(runaway.error, /interrupt|CPU/i);
  const memory = await new LocalCodeExecutor(undefined, { memoryBytes: 2 * 1024 * 1024 }).execute('async () => new Array(5000000).fill("x")', {});
  assert.ok(memory.error, "oversized allocation is stopped inside the guest");

  // Denial is final even if the program catches it or has queued more work.
  const invoked = [];
  const denied = JSON.parse(await executeCodeProgram(program(`async () => {
    try { await codemode.write_file({path: "blocked.txt", content: "x", reason: "Attempt the denied write"}); } catch {}
    await codemode.write_file({path: "workaround.txt", content: "x", reason: "Attempt another write"});
  }`), options({ call: async name => { invoked.push(name); throw new ProgramToolDenied("Approval denied by user"); } })));
  assert.equal(denied.ok, false);
  assert.match(denied.error, /Approval denied/);
  assert.equal(invoked.length, 1);
  assert.ok(!fs.existsSync(path.join(cwd, "workaround.txt")));

  const unawaited = JSON.parse(await executeCodeProgram(program(`async () => {
    codemode.write_file({path: "unawaited.txt", content: "recorded", reason: "Exercise completion bookkeeping"});
    return "premature";
  }`), options({ call: async (name, args) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return executeTool(name, args, cwd);
  } })));
  assert.equal(unawaited.ok, false);
  assert.match(unawaited.error, /unawaited/);
  assert.equal(unawaited.completed.length, 1, "any completed write is recorded before the error returns");

  const cancel = new AbortController();
  const execution = new LocalCodeExecutor(cancel.signal).execute('async () => await codemode.wait({})', { wait: async () => new Promise(() => {}) });
  setTimeout(() => cancel.abort("Cancelled by test"), 100);
  assert.match((await execution).error, /Cancelled/);

  // Cancelling a command also stops descendants from writing after the turn.
  const commandAbort = new AbortController();
  const marker = path.join(cwd, "late-command.txt");
  const commandFile = path.join(cwd, "cancel-child.cjs");
  fs.writeFileSync(commandFile, `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 350)`);
  const shellArg = value => process.platform === "win32"
    ? '"' + value.replaceAll('"', '""') + '"' : "'" + value.replaceAll("'", "'\\''") + "'";
  const command = `${shellArg(process.execPath)} ${shellArg(commandFile)}`;
  const running = executeTool("run_command", { command }, cwd, commandAbort.signal);
  setTimeout(() => commandAbort.abort(), 70);
  assert.match(await running, /cancelled/);
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.ok(!fs.existsSync(marker));
  console.log("ok PTC: TypeScript composition, compact results, isolation, budgets, denial and cancellation");

  requests.length = 0;
  script = [{ text: "Quick answer" }];
  const fast = session("fast");
  fast.liveSend("First inspect the project, then explain its structure and finally verify the answer.");
  await waitFor(() => !fast.liveMeta().busy);
  assert.equal(requests.length, 1, "fast mode skips the separate planner even for a multi-step request");
  assert.match(requests[0].messages[0].content, /Fast mode/);
  assert.ok(!requests[0].tools.includes("execute_ts"));
  const saved = config.loadSession(fast.liveMeta().sessionId);
  assert.equal(saved.agent_mode, "fast");
  const restored = resumeSession(saved);
  assert.equal(restored.session.liveMeta().agentMode, "fast");
  restored.session.dispose();

  requests.length = 0;
  script = [{ text: "I will read and count the input.", calls: [call(program(code))] }, { text: "Saved 2000." }];
  const ptc = session("ptc");
  ptc.liveSend("Read input.txt and save the number of lines to output.txt.");
  await waitFor(() => !ptc.liveMeta().busy);
  assert.equal(requests.length, 2, "one program handles both dependent tools");
  assert.ok(requests[0].tools.includes("execute_ts"));
  assert.match(requests[0].messages[0].content, /Plan-Then-Code/);
  assert.ok(!JSON.stringify(requests[1].messages).includes("RAW_INTERMEDIATE"));
  assert.ok(ptc.liveSnapshot("test").messages.some(m => m.role === "tool" && m.name === "read_file" && m.result.includes("RAW_INTERMEDIATE")), "full actual tool output remains available in history");
  assert.deepEqual(ptc.liveSnapshot("test").plan.steps.map(s => s.status), ["done", "done"]);

  // Per-call approval uses the actual nested tool and arguments.
  const outside = path.join(fixture, "forbidden.txt");
  script = [{ calls: [call(program(`async () => {
    await codemode.write_file({path: ${JSON.stringify(outside)}, content: "x", reason: "Write the requested outside fixture"});
    await codemode.write_file({path: "after-denial.txt", content: "x", reason: "Continue"});
  }`))] }, { text: "The write was denied." }];
  const gated = session("ptc");
  gated.liveSend("Attempt a write to the outside fixture.");
  await waitFor(() => Boolean(gated.liveMeta().approval));
  assert.equal(gated.liveMeta().approval.tool, "write_file");
  assert.equal(gated.liveMeta().approval.arguments.path, outside);
  gated.liveApprove(false);
  await waitFor(() => !gated.liveMeta().busy);
  assert.ok(!fs.existsSync(outside));
  assert.ok(!fs.existsSync(path.join(cwd, "after-denial.txt")));

  // A program that burns CPU while a nested call awaits approval must clean
  // up both the worker and that approval, rather than wait forever for input.
  script = [{ calls: [call(program(`async () => {
    codemode.write_file({path: ${JSON.stringify(outside)}, content: "x", reason: "Exercise cancellation while approval is pending"});
    while (true) {}
  }`))] }, { text: "Execution stopped." }];
  const interrupted = session("ptc");
  interrupted.liveSend("Exercise program timeout handling.");
  await waitFor(() => Boolean(interrupted.liveMeta().approval));
  await waitFor(() => !interrupted.liveMeta().busy);
  assert.equal(interrupted.liveMeta().approval, null);
  assert.ok(!fs.existsSync(outside));

  // Integrate with a shared task runtime when one is installed.
  if ("task_timeout_ms" in config.DEFAULT_CONFIG) {
    // The shared task deadline must also cancel PTC's pending approval.
    const originalConfig = config.loadConfig();
    try {
      config.saveConfig({ ...originalConfig, task_budget_scope: "task", task_timeout_ms: 600 });
      script = [{ calls: [call(program(`async () => {
        await codemode.write_file({path: ${JSON.stringify(outside)}, content: "x", reason: "Exercise the shared task deadline"});
      }`))] }, { text: "Task deadline reached." }];
      const timed = session("ptc");
      timed.liveSend("Exercise the shared task deadline.");
      await waitFor(() => !timed.liveMeta().busy);
      assert.equal(timed.liveMeta().approval, null);
      assert.ok(!fs.existsSync(outside));
    } finally { config.saveConfig(originalConfig); }
  }

  // A mid-turn selection applies only to the next user turn.
  let release;
  script = [{ text: "First answer", wait: new Promise(resolve => { release = resolve; }) }];
  const changing = session("fast");
  requests.length = 0;
  changing.liveSend("First turn");
  await waitFor(() => requests.length > 0);
  changing.liveSetAgentMode("ptc");
  assert.equal(changing.liveMeta().activeAgentMode, "fast");
  assert.equal(changing.liveMeta().agentMode, "ptc");
  release(); await waitFor(() => !changing.liveMeta().busy);
  script = [{ text: "Next answer" }];
  changing.liveSend("Second turn");
  await waitFor(() => !changing.liveMeta().busy);
  assert.ok(requests[1].tools.includes("execute_ts"));

  const screen = new ChatScreen("");
  screen.app = { width: 100, height: 32, state: defaultState(), render() {}, popScreen() {}, showToast() {}, bell() {} };
  screen.loadedCwd = cwd;
  screen.loadedAgentMode = "ptc";
  screen.onActivate(); screens.push(screen);
  script = [{ calls: [call(program(code))] }, { text: "Terminal PTC finished" }];
  requests.length = 0;
  screen.liveSend("Read input.txt and save the count.");
  await waitFor(() => !screen.liveMeta().busy);
  assert.ok(requests[0].tools.includes("execute_ts"));
  assert.equal(config.loadSession(screen.sessionId).agent_mode, "ptc");
  assert.ok(hub.setAgentMode(screen.liveKey, "fast").ok);
  assert.equal(screen.liveMeta().agentMode, "fast");
  console.log("ok modes: web and terminal execution, persistence, approval and turn isolation");

  server = await startWebServer({ port: 0, auth: false });
  const request = async (route, body) => {
    const response = await fetch(server.url + route, body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const assetResponse = await fetch(server.url + "/app.js");
  const asset = Buffer.from(await assetResponse.arrayBuffer());
  assert.ok(asset.equals(fs.readFileSync(new URL("../web/app.js", import.meta.url))), "static JavaScript arrives intact");
  const created = await request("/api/conversations", { cwd, selection: { provider: "Fixture", model: model.name, intensity: "High" }, agent_mode: "ptc" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.snapshot.agentMode, "ptc");
  const key = created.body.key;
  const changed = await request(`/api/live/${key}/agent-mode`, { mode: "fast" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.snapshot.agentMode, "fast");
  assert.equal((await request(`/api/live/${key}/agent-mode`, { mode: "unknown" })).status, 400);
  assert.equal((await request("/api/conversations", { cwd, agent_mode: "pro" })).status, 400);
  const pro = await request("/pro/api/conversations", { cwd });
  assert.equal(pro.status, 200);
  assert.equal(pro.body.cwd, cwd, "professional entry creates a fresh conversation in the same directory");
  assert.notEqual(pro.body.key, key);
  assert.equal((await request(`/api/live/${pro.body.key}`)).status, 404);
  assert.equal((await request(`/pro/api/live/${key}/agent-mode`, { mode: "ptc" })).status, 404);
  const continued = await request(`/api/session/${saved.id}/continue`, { agent_mode: "ptc" });
  assert.equal(continued.status, 200);
  assert.equal((await request(`/api/live/${continued.body.key}`)).body.agentMode, "ptc");
  console.log("ok mode API: creation, validation, continuation and same-directory Pro isolation");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  for (const screen of screens) screen.onDeactivate();
  for (const value of sessions) value.dispose();
  if (server) await server.close();
  os.homedir = originalHomedir;
  fs.rmSync(fixture, { recursive: true, force: true });
}
