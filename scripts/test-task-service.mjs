import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { try { const value = await read(); if (value) return value; } catch (e) { last = e; } await sleep(40); }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ""}`);
}

if (process.argv.includes("--blocked-service")) {
  const { NEUTRINO_DIR } = await import("../dist/config.js");
  const { TaskController } = await import("../dist/tasks/controller.js");
  const { ensureTaskService } = await import("../dist/tasks/service.js");
  const controller = new TaskController(path.join(NEUTRINO_DIR, "tasks", "supervisor"), "fixture", "Supervise task execution service");
  controller.finish("blocked", "worker_restart_budget_exhausted");
  await assert.rejects(ensureTaskService(), /automatic relaunch is blocked/);
  await assert.rejects(ensureTaskService(), /automatic relaunch is blocked/);
  assert.equal(fs.existsSync(path.join(NEUTRINO_DIR, "task-service.json")), false);
  console.log("ok durable crash budget cannot be reset by reconnecting clients");
} else if (process.argv.includes("--view")) {
  const { TaskClient } = await import("../dist/tasks/service.js");
  const client = new TaskClient({ cwd: process.env.NEUTRINO_FIXTURE, agentMode: "ptc" }, snapshot => {
    if (snapshot.task?.state === "running") process.send?.({ running: true, sessionId: snapshot.sessionId });
  });
  await client.connect();
  await client.action("message", { text: "VIEW_SURVIVAL fixture" });
  setInterval(() => {}, 60000);
} else {
  const fixture = fs.mkdtempSync(path.join(process.cwd(), ".test-task-service-"));
  process.env.NEUTRINO_HOME = path.join(fixture, ".neutrino");
  process.env.NEUTRINO_FIXTURE = fixture;
  process.env.NEUTRINO_PLAN = "off";
  process.env.NEUTRINO_RETRY_DELAY_MS = "1";
  process.env.NEUTRINO_NETWORK_ATTEMPTS = "2";
  const counts = new Map();
  const gates = new Map();
  const sockets = new Set();
  const clients = new Set();
  const ownedPids = new Set();
  const children = new Set();
  const screens = new Set();
  let consoleServer;
  const fake = http.createServer((req, res) => {
    let raw = ""; req.on("data", part => { raw += part; });
    req.on("end", async () => {
      const body = JSON.parse(raw);
      const input = body.messages.filter(m => m.role === "user").at(-1)?.content ?? "";
      const marker = input.split(" ")[0];
      counts.set(marker, (counts.get(marker) ?? 0) + 1);
      if (gates.has(marker)) await gates.get(marker).promise;
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const command = "node -e \"require('node:fs').writeFileSync('command-pid.txt',String(process.pid));require('node:fs').appendFileSync('effect.txt','x');setTimeout(()=>{},30000)\"";
      const delta = marker === "APPROVAL_GATE" && !body.messages.some(m => m.role === "tool")
        ? { tool_calls: [{ index: 0, id: "approval-one", function: { name: "run_command", arguments: JSON.stringify({ command: "git clean -fdx __never_execute__", reason: "Test the explicitly requested isolated approval gate" }) } }] }
        : marker === "UNKNOWN_COMMAND" && !body.messages.some(m => m.role === "tool")
        ? { tool_calls: [{ index: 0, id: "command-one", function: { name: "run_command", arguments: JSON.stringify({ command, reason: "Run the requested isolated command fixture" }) } }] }
        : { content: `Finished ${marker}` };
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  fake.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(resolve => fake.listen(0, "127.0.0.1", resolve));
  const { saveModels, saveConfig, loadSession, saveSession } = await import("../dist/config.js");
  const { TaskClient, ensureTaskService, readTaskService } = await import("../dist/tasks/service.js");
  const { startWebServer } = await import("../dist/web/server.js");
  const { ChatScreen } = await import("../dist/screens/chat.js");
  const { hub } = await import("../dist/web/hub.js");
  const model = { name: "fixture", url: `http://127.0.0.1:${fake.address().port}/v1`, api_key: "local-fixture", intensity: ["High"], supports_streaming: true };
  saveModels({ providers: [{ name: "Fixture", models: [model] }] });
  saveConfig({ selected_provider: "Fixture", selected_model: model.name, selected_intensity: "High", auto_title: false, approval_mode: "request", plan_first: false });
  const gate = marker => {
    let release; const promise = new Promise(resolve => { release = resolve; });
    const value = { promise, release }; gates.set(marker, value); return value;
  };
  const client = async options => {
    const value = new TaskClient({ cwd: fixture, agentMode: "ptc", ...options }, () => {});
    clients.add(value); await value.connect(); return value;
  };
  const trackService = status => { ownedPids.add(status.pid); ownedPids.add(status.supervisorPid); return status; };
  const kill = async pid => {
    try { process.kill(pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
    await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === "ESRCH"; } }, `process ${pid} exit`);
    ownedPids.delete(pid);
  };
  try {
    const blocked = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--blocked-service"], {
      env: { ...process.env, NEUTRINO_HOME: path.join(fixture, "blocked-service") }, encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(blocked.status, 0, blocked.stderr); process.stdout.write(blocked.stdout);
    const discovery = path.join(process.env.NEUTRINO_HOME, "api.json");
    fs.mkdirSync(process.env.NEUTRINO_HOME, { recursive: true }); fs.writeFileSync(discovery, "public-discovery-sentinel");
    let status = trackService(await ensureTaskService());
    assert.equal(fs.readFileSync(discovery, "utf8"), "public-discovery-sentinel");
    const privateStatus = path.join(process.env.NEUTRINO_HOME, "task-service.json");
    fs.writeFileSync(privateStatus, JSON.stringify({ ...status, build: "different-fixture-build" }));
    try { await assert.rejects(ensureTaskService(), /different build/); }
    finally { fs.writeFileSync(privateStatus, JSON.stringify(status)); }
    assert.equal((await ensureTaskService()).pid, status.pid);
    console.log("ok incompatible service builds are detected without replacing active executors");

    const terminalGate = gate("TERMINAL_SWITCH");
    const screen = new ChatScreen(); screens.add(screen);
    screen.loadedCwd = fixture; screen.loadedAgentMode = "ptc";
    screen.app = { managedTasks: true, state: { selectedProvider: "Fixture", selectedModelName: model.name,
      selectedModelUrl: model.url, selectedModelApiKey: model.api_key, selectedModelStreaming: true, selectedIntensity: "High" }, render() {}, showToast() {} };
    screen.onActivate(); await screen.remoteReady;
    screen.liveSend("TERMINAL_SWITCH fixture");
    await until(() => screen.remoteSnapshot?.task?.state === "running", "production terminal proxy active");
    assert.equal(screen.taskRuntime, null, "terminal is a subscriber and cannot create a second local executor");
    const terminalId = screen.sessionId, terminalTaskId = screen.remoteSnapshot.task.spec.taskId;
    const terminalKey = screen.liveKey; screen.onDeactivate(); assert.equal(hub.has(terminalKey), false);
    terminalGate.release();
    const terminalAttached = await client({ sessionId: terminalId });
    await until(() => terminalAttached.snapshot?.task?.state === "completed", "task survives terminal navigation");
    screen.onActivate();
    await until(() => screen.remoteSnapshot?.task?.state === "completed", "terminal reattaches after navigation");
    assert.equal(screen.remoteSnapshot.task.spec.taskId, terminalTaskId);
    screen.onDeactivate(); screens.delete(screen);
    console.log("ok actual production ChatScreen detaches and reattaches without owning execution");

    const viewGate = gate("VIEW_SURVIVAL");
    const view = spawn(process.execPath, [fileURLToPath(import.meta.url), "--view"], { env: process.env, stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
    children.add(view);
    const viewId = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("view startup timed out")), 15000);
      view.on("message", message => { if (message.running) { clearTimeout(timer); resolve(message.sessionId); } });
      view.once("error", reject);
    });
    await until(() => counts.get("VIEW_SURVIVAL"), "view model active");
    consoleServer = await startWebServer({ port: 0, apiPort: 0, publishApi: false, auth: false, managedTasks: true });
    const visible = await until(async () => {
      const overview = await fetch(`${consoleServer.url}/api/overview`).then(r => r.json());
      return overview.live.find(entry => entry.sessionId === viewId);
    }, "console discovers task independently of terminal bridge");
    await kill(view.pid); children.delete(view);
    const surviving = await fetch(`${consoleServer.url}/api/live/${visible.key}`).then(r => r.json());
    assert.equal(surviving.busy, true); assert.notEqual(surviving.connection, "disconnected");
    viewGate.release();
    const attached = await client({ sessionId: viewId });
    await until(() => attached.snapshot?.task?.state === "completed", "task survives client process death");
    assert.equal(counts.get("VIEW_SURVIVAL"), 1);
    await consoleServer.close(); consoleServer = undefined;
    console.log("ok actual view process killed; console discovery and background execution survive without replay");

    const recoveryGate = gate("SAFE_RECOVERY");
    const recovering = await client();
    await recovering.action("message", { text: "SAFE_RECOVERY keep the original complete objective" });
    await until(() => counts.get("SAFE_RECOVERY") === 1, "first model attempt");
    const taskId = recovering.snapshot.task.spec.taskId;
    const sessionId = recovering.snapshot.sessionId;
    await kill(status.pid);
    recoveryGate.release();
    await until(() => { const next = readTaskService(); if (next && next.pid !== status.pid) { trackService(next); return next; } }, "supervisor restart");
    await until(() => recovering.snapshot?.connection !== "disconnected" && recovering.snapshot?.task?.state === "completed", "safe automatic recovery");
    status = trackService(readTaskService());
    assert.equal(recovering.snapshot.task.spec.taskId, taskId);
    assert.equal(recovering.snapshot.task.spec.objective, "SAFE_RECOVERY keep the original complete objective");
    assert.equal(counts.get("SAFE_RECOVERY"), 2);
    console.log("ok real worker SIGKILL triggers supervised recovery with original task identity");

    const receipt = "durable-message-id";
    await recovering.action("message", { text: "RECEIPT once", request_id: receipt });
    await until(() => recovering.snapshot?.task?.state === "completed", "receipt task completion");
    // Simulate a response being lost after the server committed the request.
    const originalFetch = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (!dropped && String(url).endsWith("/message")) { dropped = true; await response.arrayBuffer(); throw new Error("injected response loss"); }
      return response;
    };
    try { await recovering.action("message", { text: "RECEIPT once", request_id: receipt }); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(counts.get("RECEIPT"), 1);
    assert.equal(recovering.snapshot.messages.filter(m => m.role === "user" && m.content === "RECEIPT once").length, 1);
    await assert.rejects(recovering.action("message", { text: "DIFFERENT payload", request_id: receipt }), /different message/);
    console.log("ok committed message receipts survive lost responses and reject changed payload reuse");

    const queueGate = gate("QUEUE_FIRST");
    const queued = await client();
    await queued.action("message", { text: "QUEUE_FIRST fixture" });
    await until(() => counts.get("QUEUE_FIRST"), "queue active");
    await queued.action("message", { text: "QUEUE_SECOND fixture" });
    queueGate.release();
    await until(() => counts.get("QUEUE_SECOND") === 1 && queued.snapshot?.task?.state === "completed", "queued turn after lease release");
    assert.equal(queued.snapshot.task.spec.objective, "QUEUE_SECOND fixture");
    console.log("ok queued input starts exactly once after the prior executor releases ownership");

    const webGate = gate("WEB_SURVIVAL");
    consoleServer = await startWebServer({ port: 0, apiPort: 0, publishApi: false, auth: false, managedTasks: true });
    const created = await fetch(`${consoleServer.url}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: fixture, agent_mode: "ptc" }) }).then(r => r.json());
    assert.ok(created.key, JSON.stringify(created));
    await fetch(`${consoleServer.url}/api/live/${created.key}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "WEB_SURVIVAL fixture" }) });
    await until(() => counts.get("WEB_SURVIVAL"), "web model active");
    const webId = (await fetch(`${consoleServer.url}/api/live/${created.key}`).then(r => r.json())).sessionId;
    await consoleServer.close(); consoleServer = undefined;
    webGate.release();
    const webReconnected = await client({ sessionId: webId });
    await until(() => webReconnected.snapshot?.task?.state === "completed", "web task survives console shutdown");
    console.log("ok production web console shutdown detaches and preserves background execution");

    consoleServer = await startWebServer({ port: 0, apiPort: 0, publishApi: false, auth: false, managedTasks: true });
    const approvalCreated = await fetch(`${consoleServer.url}/api/conversations`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd: fixture, agent_mode: "ptc" }) }).then(r => r.json());
    const approvalUrl = `${consoleServer.url}/api/live/${approvalCreated.key}`;
    await fetch(`${approvalUrl}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "APPROVAL_GATE fixture" }) });
    const approval = await until(async () => (await fetch(approvalUrl).then(r => r.json())).approval, "managed web human approval");
    const approve = async body => fetch(`${approvalUrl}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await approve({ approved: true, approval_id: "stale-approval" })).status, 409);
    assert.equal((await approve({ approved: false })).status, 200, "legacy web approval action binds the current displayed approval");
    await until(async () => (await fetch(approvalUrl).then(r => r.json())).task?.state === "completed", "denied managed approval finishes safely");
    await consoleServer.close(); consoleServer = undefined;
    assert.ok(approval.id);
    console.log("ok production web approval forwarding preserves approval IDs and rejects stale decisions");

    // A legacy live task must not be rewritten by the managed recovery scan.
    const legacy = structuredClone(loadSession(sessionId));
    legacy.task_run.state = "running"; delete legacy.task_run.spec;
    const legacyId = saveSession(legacy.messages, model.name, "Fixture", "High", fixture, "legacy-live", undefined, undefined, undefined, null, "standard", undefined, "ptc", legacy.task_run);
    const legacyFile = path.join(process.env.NEUTRINO_HOME, "session", `${legacyId}.json`);
    const legacyBytes = fs.readFileSync(legacyFile, "utf8");

    const commandClient = await client();
    await commandClient.action("message", { text: "UNKNOWN_COMMAND 无需审批" });
    await until(() => fs.existsSync(path.join(fixture, "command-pid.txt")), "command side effect started");
    const commandPid = Number(fs.readFileSync(path.join(fixture, "command-pid.txt"), "utf8")); ownedPids.add(commandPid);
    await commandClient.action("message", { text: "AFTER_UNKNOWN queued input" });
    await kill(status.pid);
    await until(() => { const next = readTaskService(); if (next && next.pid !== status.pid) { trackService(next); return next; } }, "second worker restart");
    await until(() => commandClient.snapshot?.connection !== "disconnected" && commandClient.snapshot?.task?.state === "blocked", "unknown command visibly blocked");
    assert.equal(commandClient.snapshot.task.stopReason, "tool_outcome_unknown");
    assert.equal(fs.readFileSync(path.join(fixture, "effect.txt"), "utf8"), "x");
    assert.equal(counts.get("UNKNOWN_COMMAND"), 1);
    assert.equal(counts.get("AFTER_UNKNOWN"), undefined, "queued input cannot hide or bypass an unknown side effect");
    assert.equal(fs.readFileSync(legacyFile, "utf8"), legacyBytes);
    assert.equal(fs.readFileSync(discovery, "utf8"), "public-discovery-sentinel");
    console.log("ok hard kill during side effect blocks replay, preserves legacy live tasks and public API discovery");
  } finally {
    for (const screen of screens) screen.onDeactivate();
    for (const value of clients) value.detach();
    await consoleServer?.close();
    const status = readTaskService(); if (status) trackService(status);
    // Stop only PIDs issued by this isolated fixture; stop supervisors first.
    const supervisors = [...ownedPids].filter(pid => pid && pid !== status?.pid && pid === status?.supervisorPid);
    for (const pid of supervisors) await kill(pid);
    for (const child of children) if (child.pid) await kill(child.pid);
    for (const pid of ownedPids) if (!supervisors.includes(pid)) await kill(pid);
    for (const value of gates.values()) value.release();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => fake.close(resolve));
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
