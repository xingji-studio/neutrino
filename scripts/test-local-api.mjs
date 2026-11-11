import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-local-api-"));
process.env.NEUTRINO_HOME = path.join(home, ".neutrino");
process.env.NEUTRINO_PLAN = "off";
const { saveModels, saveConfig } = await import("../dist/config.js");
const { startWebServer } = await import("../dist/web/server.js");
const { WebSession } = await import("../dist/web/session.js");
const { hub } = await import("../dist/web/hub.js");
const { ApprovalQueue } = await import("../dist/web/approvalQueue.js");
const { PRO_MODEL_FILE } = await import("../dist/pro/config.js");
const { proPresets } = await import("./pro-presets.mjs");
const { startTerminalBridge } = await import("../dist/web/terminalBridge.js");
const llm = http.createServer((req, res) => {
  let raw = ""; req.on("data", chunk => { raw += chunk; });
  req.on("end", () => {
    const messages = JSON.parse(raw).messages;
    const hasResult = messages.some(message => message.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = hasResult ? { content: "API turn finished" } : { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "git clean -fdx api-test", reason: "remove test files" }) } }] };
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise(resolve => llm.listen(0, "127.0.0.1", resolve));
const model = { name: "m", url: `http://127.0.0.1:${llm.address().port}/v1`, api_key: "secret", supports_streaming: true, intensity: ["High"] };
let server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn) { for (let i = 0; i < 200; i++) { const v = fn(); if (v) return v; await sleep(10); } throw new Error("timed out"); }
try {
  saveModels({ providers: [{ name: "A", models: [model] }] });
  saveConfig({ selected_provider: "A", selected_model: "m", selected_intensity: "High", approval_mode: "request", plan_first: false });
  const presets = proPresets(["medium"], "A");
  for (const setting of presets[0]["model-setting"]) if (setting.model) { setting.model = "m"; setting.intensity = "High"; }
  fs.mkdirSync(path.dirname(PRO_MODEL_FILE), { recursive: true });
  fs.writeFileSync(PRO_MODEL_FILE, JSON.stringify({ tier: presets }));
  server = await startWebServer({ port: 0, host: "0.0.0.0", auth: false, publishApi: true });
  assert.match(server.api.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
  const discovery = JSON.parse(fs.readFileSync(path.join(process.env.NEUTRINO_HOME, "api.json"), "utf8"));
  assert.equal(discovery.url, server.api.url);
  assert.equal(discovery.token, server.api.token);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(process.env.NEUTRINO_HOME, "api.json")).mode & 0o077, 0);
  const headers = { Authorization: `Bearer ${server.api.token}` };
  async function request(route, data, extra = {}) {
    const response = await fetch(server.api.url + route, { method: data === undefined ? "GET" : "POST", headers: { ...headers, ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await fetch(server.api.url + "/health")).status, 401);
  assert.equal((await request("/health", undefined, { Origin: "https://attacker.invalid" })).status, 403);
  assert.equal((await request("/settings")).status, 404);
  assert.equal((await request("/capabilities")).data.agent_modes.includes("fast_dag"), true);
  assert.equal(JSON.stringify((await request("/models")).data).includes("secret"), false);
  assert.equal((await request("/pro/models")).data.pro.presets[0].name, "medium");
  const pro = await request("/pro/conversations", { cwd: home, pro_preset: "medium", approval_mode: "request" });
  assert.equal(pro.status, 200);
  assert.equal((await request(`/live/${pro.data.key}`)).status, 404);
  assert.equal((await request(`/pro/live/${pro.data.key}`)).status, 200);
  assert.equal((await request(`/pro/live/${pro.data.key}/close`, {})).status, 200);
  const created = await request("/conversations", { cwd: home, selection: { provider: "A", model: "m", intensity: "High" }, agent_mode: "ptc", approval_mode: "request" });
  assert.equal(created.status, 200);
  assert.equal(created.data.snapshot.cwd, home);
  assert.equal(created.data.snapshot.agentMode, "ptc");
  assert.equal((await request("/conversations", { cwd: home, selection: { provider: "A", model: "m", intensity: "Low" } })).status, 400);
  assert.equal((await request(`/live/${created.data.key}/close`, {})).status, 200);
  const live = await request("/conversations", { cwd: home, selection: { provider: "A", model: "m", intensity: "High" }, agent_mode: "standard", approval_mode: "request" });
  const liveKey = live.data.key;
  const realAbort = new AbortController();
  const realStream = await fetch(`${server.api.url}/live/${liveKey}/events`, { headers, signal: realAbort.signal });
  const realReader = realStream.body.getReader();
  let realEvents = "";
  const realPump = (async () => { try { for (;;) { const part = await realReader.read(); if (part.done) break; realEvents += new TextDecoder().decode(part.value); } } catch {} })();
  assert.equal((await request(`/live/${liveKey}/message`, { text: "run a test" })).status, 200);
  const realApproval = await waitFor(() => hub.snapshot(liveKey)?.approval);
  await waitFor(() => realEvents.includes(realApproval.id));
  assert.equal((await request(`/live/${liveKey}/approvals/${realApproval.id}`, { approved: false })).status, 200);
  await waitFor(() => hub.snapshot(liveKey)?.messages.some(message => message.role === "assistant" && message.content.includes("API turn finished")));
  await waitFor(() => realEvents.includes("API turn finished"));
  realAbort.abort(); await realPump;
  assert.equal((await request(`/live/${liveKey}/close`, {})).status, 200);

  const session = new WebSession({ id: "api-approval", provider: "A", model: "m", intensity: "High", cwd: home, messages: [], tokens: { prompt: 0, completion: 0 } }, model);
  const key = session.start();
  const controller = new AbortController();
  const stream = await fetch(`${server.api.url}/live/${key}/events`, { headers, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const chunks = []; let buffered = "";
  const pump = (async () => { try { while (true) { const part = await reader.read(); if (part.done) break; buffered += new TextDecoder().decode(part.value); const frames = buffered.split("\n\n"); buffered = frames.pop(); chunks.push(...frames); } } catch {} })();
  const args1 = { command: "git clean -fdx test-one", reason: "remove test files" };
  const args2 = { command: "git clean -fdx test-two", reason: "remove other test files" };
  const first = session.requestApproval("run_command", args1);
  const second = session.requestApproval("run_command", args2);
  const one = await waitFor(() => hub.snapshot(key).approval);
  assert.ok(one.id);
  assert.equal(one.arguments.command, args1.command);
  const bridge = await startTerminalBridge();
  const bridgeRequest = async approval_id => fetch(`${bridge.url}/action`, {
    method: "POST", headers: { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ key, action: "approve", body: { approval_id, approved: true } }),
  });
  assert.equal((await bridgeRequest("stale-id")).status, 409);
  assert.equal(hub.snapshot(key).approval.id, one.id);
  bridge.close();
  await waitFor(() => chunks.some(c => c.includes("event: approval.requested") && c.includes(one.id)));
  assert.equal((await request(`/live/${key}/approvals/${one.id}`, { approved: true })).status, 200);
  assert.equal((await first).approved, true);
  const two = await waitFor(() => { const a = hub.snapshot(key).approval; return a && a.id !== one.id ? a : null; });
  assert.equal(two.arguments.command, args2.command);
  assert.equal((await request(`/live/${key}/approvals/${one.id}`, { approved: true })).status, 409);
  assert.equal((await request(`/live/${key}/approvals/${two.id}`, { approved: "yes" })).status, 400);
  assert.equal((await request(`/live/${key}/approvals/${two.id}`, { approved: false })).status, 200);
  assert.equal((await second).approved, false);
  await waitFor(() => chunks.some(c => c.startsWith("id:")));
  const eventId = chunks.find(c => c.startsWith("id:")).split("\n")[0].slice(4).trim();
  controller.abort(); await pump;
  const reconnectAbort = new AbortController();
  const reconnect = await fetch(`${server.api.url}/live/${key}/events`, { headers: { ...headers, "Last-Event-ID": eventId }, signal: reconnectAbort.signal });
  const replay = await reconnect.body.getReader().read();
  assert.match(new TextDecoder().decode(replay.value), /event: (snapshot|approval)/);
  reconnectAbort.abort();
  const resetAbort = new AbortController();
  const reset = await fetch(`${server.api.url}/live/${key}/events`, { headers: { ...headers, "Last-Event-ID": "expired" }, signal: resetAbort.signal });
  let text = ""; const resetReader = reset.body.getReader();
  for (let i = 0; i < 3 && !text.includes("event: reset"); i++) { const v = await resetReader.read(); text += new TextDecoder().decode(v.value); }
  assert.match(text, /event: reset/); resetAbort.abort();
  session.dispose();
  // Cancelling a queued request must not wait for an unrelated approval.
  const queue = new ApprovalQueue(); let release;
  const pending = queue.run(() => new Promise(resolve => { release = resolve; }));
  const abort = new AbortController();
  const cancelled = queue.run(() => { throw new Error("cancelled prompt was shown"); }, abort.signal);
  abort.abort(); assert.equal(await cancelled, false);
  const abandoned = queue.run(() => { throw new Error("closed session showed a prompt"); });
  queue.cancelWaiting(); assert.equal(await abandoned, false);
  release(false); await pending;
  // A headless API can run without binding a Web listener.
  const apiHome = path.join(home, "standalone");
  const child = spawn(process.execPath, ["dist/bin.js", "api", "--port", "0"], {
    cwd: process.cwd(), env: { ...process.env, NEUTRINO_HOME: apiHome }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    const info = await waitFor(() => {
      if (child.exitCode !== null) throw new Error(`standalone API exited: ${stderr}`);
      try { return JSON.parse(fs.readFileSync(path.join(apiHome, "api.json"), "utf8")); } catch { return null; }
    });
    const health = await fetch(info.url + "/health", { headers: { Authorization: `Bearer ${info.token}` } });
    assert.equal(health.status, 200);
    assert.equal((await fetch(info.url.replace("/api/v1", "/"))).status, 401);
  } finally {
    child.kill("SIGTERM");
    await new Promise(resolve => child.once("exit", resolve));
  }
  assert.equal(fs.existsSync(path.join(apiHome, "api.json")), false);
  console.log("LOCAL API TESTS PASSED");
} finally {
  if (server) await server.close();
  await new Promise(resolve => llm.close(resolve));
  assert.equal(fs.existsSync(path.join(process.env.NEUTRINO_HOME, "api.json")), false);
  fs.rmSync(home, { recursive: true, force: true });
}
