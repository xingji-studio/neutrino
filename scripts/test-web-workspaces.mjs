// Working directories, the folder picker, new browser conversations, clearing
// and deletion, plus read-only history from other agents. Everything runs over
// real HTTP against a temporary home directory.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-workspaces-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.NEUTRINO_PLAN = "off";
const { saveModels, saveConfig, loadConfig, saveSession, loadSession } = await import("../dist/config.js");
const { startWebServer } = await import("../dist/web/server.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { claudeProjectKey } = await import("../dist/cwd.js");

const project = path.join(testHome, "project one");
fs.mkdirSync(path.join(project, "src"), { recursive: true });
fs.writeFileSync(path.join(project, "note.txt"), "not a folder\n");
const originalStream = LLMClient.prototype.streamTurn;
let server;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label = "condition") {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(15);
  }
}

async function request(route, { body, method, headers = {} } = {}) {
  const response = await fetch(server.url + route, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

try {
  saveModels({ providers: [{
    name: "A",
    models: [{ name: "m", url: "http://127.0.0.1:1/v1", api_key: "workspace-secret", supports_streaming: true }],
  }] });
  saveConfig({
    selected_provider: "A", selected_model: "m", selected_intensity: "High",
    approval_mode: "request", plan_first: false, unrelated: "keep",
  });
  server = await startWebServer({ port: 0, auth: false });

  // --- language and new settings fields over HTTP ---------------------------
  {
    const settings = await request("/api/settings");
    assert.equal(settings.status, 200);
    assert.equal(settings.data.settings.language, "en");
    assert.equal(settings.data.settings.plan_first, false);
    assert.equal(settings.data.settings.web_console, true);
    assert.deepEqual(settings.data.languages.map(entry => entry.value), ["en", "zh"]);
    assert.equal((await request("/api/settings", { body: { settings: { web_console: "yes" } } })).status, 400);
    assert.equal((await request("/api/settings", { body: { settings: { web_console: false } } })).status, 200);
    assert.equal(loadConfig().web_console, false);
    assert.equal((await request("/api/settings", { body: { settings: { web_console: true } } })).status, 200);
    assert.equal((await request("/api/settings", { body: { settings: { language: "fr" } } })).status, 400);
    assert.equal((await request("/api/settings", { body: { settings: { plan_first: "no" } } })).status, 400);
    assert.equal((await request("/api/settings", { body: { settings: { approval_mode: "sometimes" } } })).status, 400);
    const saved = await request("/api/settings", {
      body: { settings: { language: "zh", plan_first: true, approval_mode: "auto" } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.settings.language, "zh");
    assert.equal(saved.data.settings.plan_first, true);
    assert.equal(saved.data.settings.approval_mode, "auto");
    assert.equal(loadConfig().language, "zh");
    assert.equal(loadConfig().unrelated, "keep", "other config keys survive a settings patch");
    assert.equal((await request("/api/settings", { body: { settings: { language: "en" } } })).status, 200);
  }

  // --- recent workspaces and folder browsing -------------------------------
  {
    let list = await request("/api/workspaces");
    assert.equal(list.status, 200);
    assert.equal(list.data.cwd, process.cwd());
    assert.ok(list.data.workspaces.some(entry => entry.path === process.cwd()));

    const open = await request("/api/workspaces", { body: { path: project } });
    assert.equal(open.status, 200);
    assert.equal(open.data.path, project);
    assert.equal(open.data.workspaces[0].path, project, "an opened folder is remembered first");
    assert.equal(open.data.workspaces[0].exists, true);

    list = await request("/api/workspaces");
    assert.equal(list.data.workspaces[0].path, project);

    const folders = await request(`/api/fs?path=${encodeURIComponent(project)}`);
    assert.equal(folders.status, 200);
    assert.equal(folders.data.path, project);
    assert.equal(folders.data.parent, testHome);
    assert.deepEqual(folders.data.entries.map(entry => entry.name), ["src"], "the picker lists folders only");
    assert.ok(Array.isArray(folders.data.roots) && folders.data.roots.length > 0);

    assert.equal((await request(`/api/fs?path=${encodeURIComponent("relative/path")}`)).status, 400);
    assert.equal((await request(`/api/fs?path=${encodeURIComponent(path.join(testHome, "missing"))}`)).status, 400);
    const file = await request(`/api/fs?path=${encodeURIComponent(path.join(project, "note.txt"))}`);
    assert.equal(file.status, 400);
    assert.equal(file.data.code, "working directory is not a folder");

    const createdPath = path.join(project, "new folder");
    const created = await request("/api/fs/mkdir", { body: { path: createdPath } });
    assert.equal(created.status, 200);
    assert.equal(created.data.path, createdPath);
    assert.ok(fs.statSync(createdPath).isDirectory());
    const again = await request("/api/fs/mkdir", { body: { path: createdPath } });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, "folder already exists");
    assert.equal((await request("/api/fs/mkdir", { body: { path: path.join(testHome, "missing", "child") } })).status, 400);
  }

  // --- a new conversation in a chosen folder, then clear and delete ---------
  {
    const started = await request("/api/conversations", {
      body: {
        cwd: project,
        selection: { provider: "A", model: "m", intensity: "Ultra" },
        approval_mode: "auto",
      },
      headers: { Origin: "https://evil.invalid" },
    });
    assert.equal(started.status, 403, "starting a conversation is a same-origin mutation");
    assert.equal((await request("/api/conversations", { body: { cwd: "relative" } })).status, 400);
    assert.equal((await request("/api/conversations", { body: { cwd: path.join(testHome, "missing") } })).status, 400);

    const newChat = await request("/api/conversations", {
      body: {
        cwd: project,
        selection: { provider: "A", model: "m", intensity: "Ultra" },
        approval_mode: "auto",
      },
    });
    assert.equal(newChat.status, 200);
    assert.ok(newChat.data.key);
    assert.equal(newChat.data.cwd, project);
    assert.equal(newChat.data.snapshot.cwd, project);
    assert.equal(newChat.data.snapshot.provider, "A");
    assert.equal(newChat.data.snapshot.intensity, "Ultra");
    assert.equal(newChat.data.snapshot.approvalMode, "auto");
    assert.deepEqual(newChat.data.snapshot.messages, []);
    assert.ok(newChat.data.snapshot.sessionId, "a new conversation has an id before its first message");
    const key = newChat.data.key;

    const overview = await request("/api/overview");
    const group = overview.data.groups.find(entry => entry.cwd === project);
    assert.ok(group, "the new folder appears in the sidebar");
    assert.ok(group.sessions.some(session => session.liveKey === key && session.title === ""), "an unnamed live chat is titled by the client");

    // A deterministic stream: this exercises the ordinary browser turn and the
    // transcript it writes, without contacting a provider.
    LLMClient.prototype.streamTurn = async function* () { yield "workspace reply"; };
    assert.equal((await request(`/api/live/${key}/message`, { body: { text: "hello from the new folder" } })).status, 200);
    let snapshot;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      snapshot = (await request(`/api/live/${key}`)).data;
      if (!snapshot.busy && snapshot.messages.some(message => message.role === "assistant")) break;
      await sleep(20);
    }
    assert.ok(snapshot.messages.some(message => message.role === "assistant" && message.content === "workspace reply"));
    const savedId = snapshot.sessionId;
    assert.ok(loadSession(savedId), "the transcript is written to disk");
    assert.equal(loadSession(savedId).cwd, project);
    assert.equal(loadSession(savedId).intensity, "Ultra");

    // Clear: the finished transcript is kept, the live conversation restarts.
    const cleared = await request(`/api/live/${key}/clear`, { method: "POST", headers: { Origin: "https://evil.invalid" } });
    assert.equal(cleared.status, 403);
    const clear = await request(`/api/live/${key}/clear`, { method: "POST" });
    assert.equal(clear.status, 200);
    assert.deepEqual(clear.data.snapshot.messages, []);
    assert.notEqual(clear.data.snapshot.sessionId, savedId, "clearing starts a new transcript id");
    assert.ok(loadSession(savedId), "clearing never deletes the previous transcript");

    // A running conversation cannot be deleted out from under itself.
    const liveDelete = await request(`/api/session/${clear.data.snapshot.sessionId}/delete`, { method: "POST" });
    assert.equal(liveDelete.status, 409);
    const deleted = await request(`/api/session/${savedId}/delete`, { method: "POST" });
    assert.equal(deleted.status, 200);
    assert.equal(loadSession(savedId), null);
    assert.equal((await request(`/api/session/${savedId}/delete`, { method: "POST" })).status, 404);
    assert.equal((await request("/api/session/..%2f..%2fetc%2fpasswd/delete", { method: "POST" })).status, 400);

    // Close the browser-owned session so it does not outlive the test.
    assert.equal((await request(`/api/live/${key}/close`, { method: "POST" })).status, 200);
  }

  // --- saved sessions in another folder (delete cleanly) --------------------
  {
    const savedId = saveSession(
      [{ role: "user", content: "saved elsewhere" }],
      "m", "A", "High", project,
    );
    assert.ok(loadSession(savedId));
    const deleted = await request(`/api/session/${savedId}/delete`, { method: "POST" });
    assert.equal(deleted.status, 200);
    assert.equal(loadSession(savedId), null);
  }

  // --- other agents' history is read-only and scoped to a folder ------------
  {
    const claudeDir = path.join(testHome, ".claude", "projects", claudeProjectKey(project));
    fs.mkdirSync(claudeDir, { recursive: true });
    const lines = [
      { type: "user", message: { role: "user", content: "other agent prompt" }, cwd: project },
      { type: "assistant", message: { role: "assistant", content: "other agent answer" }, cwd: project },
    ];
    fs.writeFileSync(path.join(claudeDir, "sess-one.jsonl"), lines.map(line => JSON.stringify(line)).join("\n"));
    const sessions = await request(`/api/agents/claude/sessions?cwd=${encodeURIComponent(project)}`);
    assert.equal(sessions.status, 200);
    assert.equal(sessions.data.sessions.length, 1);
    assert.equal(sessions.data.sessions[0].id, "sess-one");
    assert.equal(sessions.data.sessions[0].title, "other agent prompt");
    const transcript = await request("/api/agents/claude/sessions/sess-one");
    assert.equal(transcript.status, 200);
    assert.deepEqual(transcript.data.messages.map(message => message.content), ["other agent prompt", "other agent answer"]);
    assert.equal((await request("/api/agents/claude/sessions/..%2fescape")).status, 400);
    assert.equal((await request("/api/agents/nope/sessions")).status, 400);
  }

  console.log("ok workspaces: folder browsing, new conversation, clear/delete and other-agent history");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  if (server) await server.close();
  fs.rmSync(testHome, { recursive: true, force: true });
}
