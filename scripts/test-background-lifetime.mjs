// Exercise real detached processes, a streaming turn, and the terminal bridge.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[2] === "--owner") {
  const { App } = await import("../dist/app.js");
  const { hub } = await import("../dist/web/hub.js");
  const cwd = process.cwd();
  let paused = false;
  let intensity = "High";
  let approvalMode = "request";
  let approvalPending = true;
  const messages = [{ role: "user", content: "terminal session" }];
  const agent = {
    liveCwd: () => cwd,
    liveMeta: () => ({
      sessionId: "terminal-session", title: "terminal bridge test", provider: "Test", model: "mock-model",
      intensity, busy: true, paused, queued: null, compressing: false, approvalMode,
      tokens: { prompt: 0, completion: 0 },
      approval: approvalPending ? { tool: "run_command", level: "high", arguments: {}, cwd, summary: "test", reasons: [] } : null,
    }),
    liveSnapshot(key) { return { ...this.liveMeta(), key, cwd, messages, streamingContent: null }; },
    livePause() { paused = true; },
    liveResume() { paused = false; },
    liveSend(text) { messages.push({ role: "user", content: text }); },
    liveApprove() { if (!approvalPending) return false; approvalPending = false; return true; },
    liveSetApprovalMode(mode) { approvalMode = mode; },
    liveConfigure(selection) {
      if (!paused) return { ok: false, error: "pause before changing models" };
      intensity = selection.intensity;
      return { ok: true };
    },
    liveClear() { messages.splice(0); },
  };
  hub.register(agent);
  const app = new App();
  app.render = () => {};
  app.showToast = () => {};
  app.configureWeb(0, "127.0.0.1", false, true, false);
  const status = await app.enableWeb(0, "127.0.0.1", false);
  process.send?.({ type: "ready", pid: status.pid, url: status.url });
  process.on("message", async (message) => {
    if (message?.type === "residency") {
      const result = await app.setBackgroundResidency(message.enabled);
      process.send?.({ type: "residency", ...result });
    }
  });
  setInterval(() => {}, 60_000);
} else {
  const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-lifetime-"));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.NEUTRINO_NO_TRAY = "1";
  process.env.NEUTRINO_PLAN = "off";
  const { loadConfig, saveConfig, saveModels, loadSession } = await import("../dist/config.js");
  const { readBackgroundStatus, startBackgroundService, configureBackgroundService, stopBackgroundService } = await import("../dist/background.js");
  const { startWebServer } = await import("../dist/web/server.js");
  const children = new Set();
  const gates = [];
  let streams = [];

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitFor(fn, label, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
      await delay(40);
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
  }
  async function request(base, route, { method = "GET", body, token } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }
  async function spawnOwner() {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--owner"], {
      env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
    });
    children.add(child);
    let diagnostic = "";
    child.stderr.on("data", chunk => { diagnostic += chunk.toString().slice(0, 4000); });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`owner did not start: ${diagnostic}`)), 12_000);
      child.once("error", reject);
      child.on("message", message => {
        if (message?.type === "ready") { clearTimeout(timer); resolve(message); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`owner exited: ${diagnostic}`)); });
    });
    return { child, ...ready };
  }
  async function ownerSwitch(child, enabled) {
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("terminal setting timed out")), 6000);
      const onMessage = message => {
        if (message?.type !== "residency") return;
        clearTimeout(timer); child.off("message", onMessage); resolve(message);
      };
      child.on("message", onMessage);
    });
    child.send({ type: "residency", enabled });
    const result = await reply;
    assert.equal(result.ok, true, result.error);
  }
  async function killOwner(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill();
    await exited;
    children.delete(child);
  }
  async function newTurn(base) {
    const created = await request(base, "/api/conversations", {
      method: "POST", body: { cwd: process.cwd(), selection: { provider: "Test", model: "mock-model", intensity: "High" } },
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const key = created.data.key;
    const sent = await request(base, `/api/live/${key}/message`, { method: "POST", body: { text: "work in progress" } });
    assert.equal(sent.status, 200);
    const snapshot = await waitFor(async () => {
      const current = await request(base, `/api/live/${key}`);
      return current.data.busy && current.data.streamingContent?.includes("before ") ? current.data : null;
    }, "a streaming browser turn");
    return { key, sessionId: snapshot.sessionId };
  }

  const llm = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "before " } }] })}\n\n`);
    gates.push(() => {
      if (res.destroyed || res.writableEnded) return;
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "after" } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => llm.listen(0, "127.0.0.1", resolve));
  const provider = { name: "Test", models: [{
    name: "mock-model", url: `http://127.0.0.1:${llm.address().port}`,
    api_key: "test", supports_streaming: true, reasoning: false,
  }] };

  try {
    saveModels({ providers: [provider] });
    saveConfig({ ...loadConfig(), background: false, plan_first: false });

    const owner = await spawnOwner();
    const initial = readBackgroundStatus();
    assert.equal(initial.resident, false);
    assert.ok(initial.owner_pids.includes(owner.child.pid));
    const conflictingAuth = await startBackgroundService({ port: 0, host: "127.0.0.1", auth: true });
    assert.equal(conflictingAuth.ok, false, "an existing console cannot silently ignore the requested authentication");
    const conflictingPort = await startBackgroundService({
      port: initial.port === 65535 ? 65534 : initial.port + 1, host: "127.0.0.1", auth: false, strictPort: true,
    });
    assert.equal(conflictingPort.ok, false, "an explicit standalone port cannot be silently ignored");
    const promoted = await startBackgroundService({ port: 0, host: "127.0.0.1", auth: false });
    assert.equal(promoted.ok, true);
    assert.equal(promoted.started, false);
    assert.equal(promoted.status.resident, true, "background commands promote an existing console");
    assert.equal((await configureBackgroundService(promoted.status, { resident: false })).resident, false);
    const staleStop = await stopBackgroundService({ ...initial, token: "0".repeat(64) });
    assert.equal(staleStop.ok, false, "a stale handle must not stop another service");
    assert.equal((await request(owner.url, "/api/health")).status, 200);
    const bridgeEntry = await waitFor(async () => {
      const overview = await request(owner.url, "/api/overview");
      return overview.data.live.find(entry => entry.title === "terminal bridge test");
    }, "the terminal session in the browser");
    assert.equal((await request(owner.url, `/pro/api/live/${bridgeEntry.key}`)).status, 404);
    assert.equal((await request(owner.url, `/api/live/${bridgeEntry.key}/close`, { method: "POST" })).status, 400);
    const choice = { provider: "Test", model: "mock-model", intensity: "Medium" };
    assert.equal((await request(owner.url, `/api/live/${bridgeEntry.key}/model`, { method: "POST", body: choice })).status, 409);
    const approval = await request(owner.url, `/api/live/${bridgeEntry.key}/approve`, { method: "POST", body: { approved: false } });
    assert.equal(approval.data.approved, false);
    assert.equal((await request(owner.url, `/api/live/${bridgeEntry.key}/approve`, { method: "POST", body: { approved: true } })).status, 409);
    const paused = await request(owner.url, `/api/live/${bridgeEntry.key}/pause`, { method: "POST" });
    assert.equal(paused.status, 200);
    assert.equal(paused.data.paused, true);
    assert.equal((await request(owner.url, `/api/live/${bridgeEntry.key}`)).data.paused, true);
    const model = await request(owner.url, `/api/live/${bridgeEntry.key}/model`, { method: "POST", body: choice });
    assert.equal(model.data.snapshot.intensity, "Medium");
    const mode = await request(owner.url, `/api/live/${bridgeEntry.key}/approval-mode`, { method: "POST", body: { mode: "auto" } });
    assert.equal(mode.data.snapshot.approvalMode, "auto");
    assert.equal((await request(owner.url, `/api/live/${bridgeEntry.key}/message`, {
      method: "POST", body: { text: "sent from the browser" },
    })).status, 200);
    const mirrored = await request(owner.url, `/api/live/${bridgeEntry.key}`);
    assert.ok(mirrored.data.messages.some(message => message.content === "sent from the browser"));
    assert.deepEqual((await request(owner.url, `/api/live/${bridgeEntry.key}/clear`, { method: "POST" })).data.snapshot.messages, []);
    assert.equal((await request(owner.url, `/api/live/${bridgeEntry.key}/resume`, { method: "POST" })).data.paused, false);

    const turn = await newTurn(owner.url);
    const streamController = new AbortController();
    const stream = await fetch(`${owner.url}/api/live/${turn.key}/stream`, { signal: streamController.signal });
    assert.equal(stream.status, 200);
    let events = "";
    const reading = (async () => {
      const reader = stream.body.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          events += new TextDecoder().decode(next.value);
        }
      } catch { /* The test closes the stream after the assertion. */ }
    })();
    streams.push(() => streamController.abort());
    await waitFor(() => events.includes("before "), "the initial browser stream");

    const unauthorized = await request(owner.url, "/api/background/configure", { method: "POST", body: { resident: true } });
    assert.equal(unauthorized.status, 401, "management changes require the local token");
    const invalidBridge = await request(owner.url, "/api/background/configure", {
      method: "POST", token: initial.token,
      body: { ownerPid: process.pid, bridge: { url: "http://example.com/", token: "a".repeat(64) } },
    });
    assert.equal(invalidBridge.status, 400, "a terminal bridge cannot target a remote server");
    const enabled = await request(owner.url, "/pro/api/settings", { method: "POST", body: { settings: { background: true } } });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.data.settings.background_running, true);
    assert.equal(JSON.stringify(enabled.data).includes(initial.token), false, "browser settings never expose the management token");
    const switched = readBackgroundStatus();
    assert.equal(switched.pid, initial.pid, "the running conversation keeps its process");
    assert.equal(switched.resident, true);

    await killOwner(owner.child);
    await delay(800);
    assert.equal(readBackgroundStatus()?.pid, initial.pid, "the resident service outlives its terminal");
    assert.equal((await request(owner.url, `/api/live/${turn.key}`)).data.busy, true);
    gates.shift()();
    const finished = await waitFor(async () => {
      const current = await request(owner.url, `/api/live/${turn.key}`);
      return !current.data.busy && current.data.messages.some(message => message.content === "before after") ? current.data : null;
    }, "the same browser turn to finish");
    assert.equal(finished.sessionId, turn.sessionId);
    await waitFor(() => events.includes("before after"), "the original SSE connection to receive the answer");
    assert.equal(loadSession(turn.sessionId).messages.some(message => message.content === "before after"), true);
    streamController.abort();
    await reading;
    streams = [];

    const disabled = await request(owner.url, "/api/settings", { method: "POST", body: { settings: { background: false } } });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.settings.background_running, false);
    await waitFor(() => !readBackgroundStatus(), "an idle non-resident console to exit");

    // Switching off while a turn runs must let that turn finish after the
    // terminal disappears. The terminal switch changes the same service.
    const owner2 = await spawnOwner();
    const turn2 = await newTurn(owner2.url);
    await ownerSwitch(owner2.child, true);
    assert.equal(readBackgroundStatus().resident, true);
    await ownerSwitch(owner2.child, false);
    assert.equal(readBackgroundStatus().resident, false);
    await killOwner(owner2.child);
    await delay(800);
    assert.ok(readBackgroundStatus(), "a running turn keeps the non-resident worker alive");
    gates.shift()();
    await waitFor(() => loadSession(turn2.sessionId)?.messages?.some(message => message.content === "before after"), "the orphaned turn to be saved");
    await waitFor(() => !readBackgroundStatus(), "the non-resident worker to exit after the turn");

    // A paused turn still needs a console so the browser can resume it.
    const pausedOwner = await spawnOwner();
    const pausedTurn = await newTurn(pausedOwner.url);
    assert.equal((await request(pausedOwner.url, `/api/live/${pausedTurn.key}/pause`, { method: "POST" })).status, 200);
    await killOwner(pausedOwner.child);
    await delay(800);
    assert.ok(readBackgroundStatus(), "a paused browser turn keeps the worker reachable");
    assert.equal((await request(pausedOwner.url, `/api/live/${pausedTurn.key}`)).data.paused, true);
    gates.shift()();
    assert.equal((await request(pausedOwner.url, `/api/live/${pausedTurn.key}/message`, {
      method: "POST", body: { text: "continue the work" },
    })).status, 200);
    assert.equal((await request(pausedOwner.url, `/api/live/${pausedTurn.key}/resume`, { method: "POST" })).status, 200);
    await waitFor(() => gates.length > 0, "the paused turn to resume");
    gates.shift()();
    await waitFor(() => loadSession(pausedTurn.sessionId)?.messages?.some(message => message.content?.includes("after")), "the resumed turn to be saved");
    await waitFor(() => !readBackgroundStatus(), "the resumed worker to finish and exit");

    // Multiple terminals can share a non-resident service; it follows the last one.
    const ownerA = await spawnOwner();
    const ownerB = await spawnOwner();
    assert.equal(ownerA.pid, ownerB.pid);
    await killOwner(ownerA.child);
    await delay(800);
    assert.equal(readBackgroundStatus()?.pid, ownerB.pid);
    await killOwner(ownerB.child);
    await waitFor(() => !readBackgroundStatus(), "the service to follow the last terminal");

    // The standalone `web` command must also apply residency immediately.
    const standalone = spawn(process.execPath, [fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
      "web", "--port", "0", "--no-auth", "--no-tray"], { env: process.env, stdio: "ignore", windowsHide: true });
    children.add(standalone);
    const standaloneStatus = await waitFor(() => {
      const status = readBackgroundStatus();
      return status?.owner_pids.includes(standalone.pid) ? status : null;
    }, "the standalone console");
    const standaloneEnabled = await request(standaloneStatus.url, "/api/settings", {
      method: "POST", body: { settings: { background: true } },
    });
    assert.equal(standaloneEnabled.data.settings.background_running, true);
    await killOwner(standalone);
    await delay(800);
    assert.equal(readBackgroundStatus()?.pid, standaloneStatus.pid);
    assert.equal((await request(standaloneStatus.url, "/api/settings", {
      method: "POST", body: { settings: { background: false } },
    })).data.settings.background_running, false);
    await waitFor(() => !readBackgroundStatus(), "the standalone console to stop after residency is disabled");

    // A server without a lifetime controller rejects the change and rolls back
    // its saved value, so an unsupported embedding cannot claim success.
    const embedded = await startWebServer({ port: 0, auth: false });
    try {
      const failed = await request(embedded.url, "/api/settings", {
        method: "POST", body: { settings: { background: true, web_lan: true } },
      });
      assert.equal(failed.status, 400);
      assert.equal(loadConfig().background, false);
      assert.equal(loadConfig().web_lan, false);
      assert.equal(embedded.host, "127.0.0.1", "a failed switch also restores the listener");
      assert.equal((await request(embedded.url, "/api/health")).status, 200);
    } finally { await embedded.close(); }
    console.log("BACKGROUND LIFETIME TESTS PASSED");
  } finally {
    for (const close of streams) close();
    for (const release of gates) release();
    for (const child of children) { try { child.kill(); } catch {} }
    await stopBackgroundService().catch(() => {});
    await new Promise(resolve => llm.close(resolve));
    fs.rmSync(testHome, { recursive: true, force: true });
  }
}
