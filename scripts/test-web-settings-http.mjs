// Exercise settings, model switching and transcript resumption through HTTP.
// The model stream is local and deterministic; no provider receives a request.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-settings-http-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { saveModels, saveConfig, loadConfig, saveSession, loadSession } = await import("../dist/config.js");
const { startWebServer } = await import("../dist/web/server.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { hub } = await import("../dist/web/hub.js");

const a = { provider: "A", model: "shared", intensity: "High" };
const b = { provider: "B", model: "shared", intensity: "Ultra" };
const originalStream = LLMClient.prototype.streamTurn;
let server;
let cookie;
let finishStream;
async function request(route, { body, method, headers = {}, anonymous = false } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(!anonymous && cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, data: JSON.parse(text) };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for the model stream");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

try {
  saveModels({ providers: [
    { name: "A", models: [{ name: "shared", url: "https://a.invalid/v1", api_key: "http-secret-a", supports_streaming: true }] },
    { name: "B", models: [
      { name: "shared", url: "https://b.invalid/v1", api_key: "http-secret-b", supports_streaming: true },
      { name: "unconfigured", url: "https://b.invalid/v1", api_key: "" },
    ] },
  ] });
  saveConfig({ selected_provider: "A", selected_model: "shared", selected_intensity: "High", unrelated: "keep" });
  const id = "settings-http-session";
  saveSession([{ role: "user", content: "original history" }], "removed", "Removed", "Medium", process.cwd(), id, { prompt: 2, completion: 3 });
  server = await startWebServer({ port: 0 });
  assert.equal((await request("/api/settings", { anonymous: true })).status, 401);
  const login = await request("/api/auth/login", { body: { password: "114514" } });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];

  const catalog = await request("/api/settings");
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.providers.length, 2);
  for (const secret of ["http-secret", "https://", "web_password_hash"]) assert.ok(!catalog.text.includes(secret));
  assert.equal((await request("/api/settings", { method: "DELETE" })).status, 405);
  assert.equal((await request("/api/settings", { body: { selection: b }, headers: { Origin: "http://evil.example" } })).status, 403);
  const updated = await request("/api/settings", { body: { selection: b, settings: { model_context_window: 128000, approval_model: "", auto_approve_extreme_risk: false } } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.selection, b);
  assert.equal(loadConfig().unrelated, "keep");
  const before = loadConfig();
  assert.equal((await request("/api/settings", { body: { settings: { model_context_window: -1 } } })).status, 400);
  assert.deepEqual(loadConfig(), before);

  const continuation = `/api/session/${id}/continue`;
  assert.equal((await request(continuation, { method: "POST" })).status, 400, "removed model needs a replacement");
  assert.equal((await request(continuation, { body: { selection: b }, headers: { Origin: "http://evil.example" } })).status, 403);
  const resumed = await request(continuation, { body: { selection: b } });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.attached, false);
  const key = resumed.data.key;
  const modelRoute = `/api/live/${key}/model`;
  assert.equal(loadSession(id).provider, "B");
  assert.equal(loadSession(id).messages[0].content, "original history");
  assert.equal((await request(modelRoute, { body: a, anonymous: true })).status, 401);
  assert.equal((await request(modelRoute, { body: a, headers: { Origin: "http://evil.example" } })).status, 403);
  assert.equal((await request(modelRoute, { body: { ...a, provider: "missing" } })).status, 400);
  assert.equal((await request(modelRoute, { body: { ...b, model: "unconfigured" } })).status, 400);
  assert.equal(hub.snapshot(key).provider, "B", "invalid requests cannot change the live model");
  const attached = await request(continuation, { body: { selection: a } });
  assert.equal(attached.status, 200);
  assert.equal(attached.data.key, key);
  assert.equal(attached.data.attached, true);
  const changed = await request(modelRoute, { body: b });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.snapshot.intensity, "Ultra");
  assert.equal(changed.data.snapshot.provider, "B");
  assert.ok(!changed.text.includes("http-secret"));

  const requests = [];
  let finished;
  const done = new Promise(resolve => { finished = resolve; });
  const stalled = new Promise(resolve => { finishStream = resolve; });
  LLMClient.prototype.streamTurn = async function* () {
    requests.push({ model: this.model, intensity: this.intensity, provider: this.provider });
    try { yield "partial response"; await stalled; yield "late data"; }
    finally { finished(); }
  };
  assert.equal((await request(`/api/live/${key}/message`, { body: { text: "use the selected model" } })).status, 200);
  await waitFor(() => requests.length === 1 && hub.snapshot(key).streamingContent === "partial response");
  assert.equal(requests[0].provider, "B");
  assert.equal(requests[0].model.api_key, "http-secret-b");
  assert.equal(requests[0].intensity, "Ultra");
  assert.equal((await request(modelRoute, { body: a })).status, 409, "running turns cannot switch");
  assert.equal((await request(continuation, { body: { selection: a } })).status, 409);
  assert.equal((await request(`/api/live/${key}/pause`, { method: "POST" })).status, 200);
  assert.equal((await request(modelRoute, { body: a })).status, 200);
  finishStream();
  await done;
  assert.equal(loadSession(id).provider, "A");
  assert.equal(loadSession(id).intensity, "High");
  assert.equal(loadConfig().selected_provider, "B", "conversation selection leaves defaults intact");
  assert.equal((await request(`/api/live/${key}/close`, { method: "POST" })).status, 200);
  const reopened = await request(continuation, { method: "POST" });
  assert.equal(reopened.status, 200);
  assert.equal(hub.snapshot(reopened.data.key).provider, "A", "reopening uses the saved conversation selection");
  console.log("ok HTTP settings: login, redaction, origin checks, validation, persistence, resumption and next-request model");
} finally {
  finishStream?.();
  if (server) await server.close();
  LLMClient.prototype.streamTurn = originalStream;
  fs.rmSync(testHome, { recursive: true, force: true });
}
