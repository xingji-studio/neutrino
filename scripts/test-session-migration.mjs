// Migrate real foreign transcripts, persist them before the first new turn,
// and continue them through the terminal and HTTP entry points.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-migration-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
process.env.NEUTRINO_PLAN = "off";
const { migrateAgentSession } = await import("../dist/migration.js");
const { loadAgentSession, loadAgentMessages } = await import("../dist/agents.js");
const { claudeProjectKey } = await import("../dist/cwd.js");
const { loadSession, listSessions, loadModels, saveModels, saveConfig, sessionDir } = await import("../dist/config.js");
const { startWebServer } = await import("../dist/web/server.js");
const { AgentConversationScreen } = await import("../dist/screens/agentConversation.js");
const { App } = await import("../dist/app.js");
const { Buffer: ScreenBuffer } = await import("../dist/terminal/buffer.js");
const { defaultState } = await import("../dist/state.js");
const { LLMClient } = await import("../dist/llm/client.js");

const project = path.join(home, "project 中文");
const other = path.join(home, "other project");
fs.mkdirSync(project);
fs.mkdirSync(other);
const selection = { provider: "Local", model: "current-model", intensity: "High" };
const expected = [
  { role: "user", content: "Continue my project\n保留历史内容" },
  { role: "assistant", content: "Previous answer\n```js\nconst answer = 42;\n```" },
  { role: "user", content: "And the next step?" },
  { role: "assistant", content: "Here is the next step." },
];
function jsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n"));
  return file;
}
const claudeFile = jsonl(path.join(home, ".claude", "projects", claudeProjectKey(project), "claude-source.jsonl"), [
  { type: "system", cwd: project, message: { content: "foreign system prompt" } },
  "{broken JSON",
  ...expected.map(message => ({ type: message.role, cwd: project,
    message: { ...message, content: [{ type: "text", text: message.content }] } })),
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ignored" } }] } },
]);
const claudeOriginal = fs.readFileSync(claudeFile, "utf8");
jsonl(path.join(home, ".claude", "projects", "000-first-project", "claude-source.jsonl"), [
  { type: "user", cwd: other, message: { content: "a different source with the same id" } },
]);
jsonl(path.join(home, ".claude", "projects", claudeProjectKey(project), "legacy-source.jsonl"), [
  { type: "user", message: { content: "Legacy message without a cwd field" } },
]);
jsonl(path.join(home, ".claude", "projects", claudeProjectKey(project), "empty-source.jsonl"), [
  { type: "system", cwd: project },
]);
const codexFile = jsonl(path.join(home, ".codex", "archived_sessions", "2026", "rollout-2026-11-04T10-20-30-codex-source.jsonl"), [
  { type: "session_meta", payload: { cwd: project } },
  { type: "response_item", payload: { type: "message", role: "developer", content: [{ text: "foreign developer prompt" }] } },
  ...expected.flatMap(message => [
    { type: "response_item", payload: { type: "message", role: message.role,
      content: [{ type: message.role === "user" ? "input_text" : "output_text", text: message.content }] } },
    { type: "event_msg", payload: { type: "agent_message", message: message.content } },
  ]),
]);
const codexOriginal = fs.readFileSync(codexFile, "utf8");

let database;
let sqlite;
try { sqlite = createRequire(import.meta.url)("node:sqlite"); } catch { /* Node 18 has no SQLite reader. */ }
if (sqlite) {
  const dir = path.join(home, ".local", "share", "opencode");
  fs.mkdirSync(dir, { recursive: true });
  database = new sqlite.DatabaseSync(path.join(dir, "opencode.db"));
  database.exec(`
    CREATE TABLE session (id TEXT, title TEXT, agent TEXT, model TEXT, time_created INTEGER, time_updated INTEGER, directory TEXT);
    CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created INTEGER);
    CREATE TABLE part (message_id TEXT, data TEXT, time_created INTEGER, id TEXT);
  `);
  database.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?)").run("opencode-source", "OpenCode history", "build", "{}", 1, 2, project);
  expected.forEach((message, index) => {
    database.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(String(index), "opencode-source", JSON.stringify({ role: message.role }), index);
    database.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(String(index), JSON.stringify({ type: "text", text: message.content }), index, String(index));
  });
  database.close();
  database = undefined;
}

let server;
const originalStream = LLMClient.prototype.streamTurn;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(route, body, options = {}) {
  const response = await fetch(server.url + route, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    ...options,
  });
  return { status: response.status, data: await response.json() };
}

try {
  saveModels({ providers: [{ name: selection.provider, models: [{
    name: selection.model, url: "http://127.0.0.1:1/v1", api_key: "migration-test-secret", supports_streaming: true,
  }] }] });
  saveConfig({ selected_provider: selection.provider, selected_model: selection.model,
    selected_intensity: selection.intensity, approval_mode: "request", plan_first: false });

  for (const agent of ["claude", "codex", ...(sqlite ? ["opencode"] : [])]) {
    let source;
    let saved;
    if (agent === "opencode") {
      // The history reader caches a SQLite handle. Keep it in a child process
      // so the fixture can also be deleted on Windows after the reader exits.
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
        const { loadAgentSession } = await import(${JSON.stringify(new URL("../dist/agents.js", import.meta.url).href)});
        const { migrateAgentSession } = await import(${JSON.stringify(new URL("../dist/migration.js", import.meta.url).href)});
        const source = loadAgentSession("opencode", "opencode-source", ${JSON.stringify(project)});
        const saved = migrateAgentSession("opencode", "opencode-source", ${JSON.stringify(project)}, ${JSON.stringify(selection)});
        process.stdout.write(JSON.stringify({ source, saved }));
      `], { encoding: "utf8" });
      ({ source, saved } = JSON.parse(output));
    } else {
      source = loadAgentSession(agent, `${agent}-source`, project);
      saved = migrateAgentSession(agent, `${agent}-source`, project, selection);
    }
    assert.deepEqual(source.messages, expected, `${agent}: ordered text, roles and code survive parsing`);
    assert.notEqual(saved.id, `${agent}-source`);
    assert.deepEqual(saved.messages, expected);
    assert.deepEqual(loadSession(saved.id), saved, "the migrated transcript is on disk before chatting");
    assert.equal(saved.cwd, project);
    assert.equal(saved.model, selection.model);
    assert.equal(saved.provider, selection.provider);
    assert.equal(saved.intensity, selection.intensity);
    assert.equal(saved.approval_mode, "request");
    assert.deepEqual(saved.tokens, { prompt: 0, completion: 0 });
  }
  if (!sqlite) console.log("skip OpenCode migration fixture: node:sqlite is unavailable on this Node version");
  assert.equal(fs.readFileSync(claudeFile, "utf8"), claudeOriginal, "migration leaves the source unchanged");
  assert.equal(loadAgentSession("codex", "codex-source", other), null);
  assert.deepEqual(loadAgentMessages("claude", "../escape"), []);
  assert.equal(migrateAgentSession("claude", "legacy-source", project, selection).cwd, project);
  const before = listSessions().length;
  for (const [agent, id, cwd, status] of [
    ["claude", "missing", project, 404], ["claude", "empty-source", project, 400],
    ["codex", "codex-source", other, 404], ["claude", "../escape", project, 400],
  ]) {
    assert.throws(() => migrateAgentSession(agent, id, cwd, selection), error => error.status === status);
  }
  assert.equal(listSessions().length, before, "invalid sources cannot create empty native transcripts");

  // Exercise the terminal's actual bottom-right click and keyboard shortcut.
  let opened;
  let renders = 0;
  const app = {
    width: 90, height: 30, state: { ...defaultState(), selectedProvider: selection.provider,
      selectedModelName: selection.model, selectedIntensity: selection.intensity },
    render() { renders++; }, loadSession(data) { opened = data; }, popScreen() {},
  };
  const viewer = new AgentConversationScreen("Claude history", expected, { agent: "claude", id: "claude-source", cwd: project });
  viewer.app = app;
  const screen = new ScreenBuffer(app.width, app.height);
  viewer.render(screen);
  assert.match(screen.cells[app.height - 2].map(cell => cell.ch).join(""), /迁移会话/);
  assert.ok(viewer.migrateButton.x > app.width / 2, "the terminal button is on the right");
  viewer.onMouse({ type: "click", button: 0, x: viewer.migrateButton.x + 2, y: viewer.migrateButton.y });
  assert.deepEqual(opened.messages, expected);
  const firstId = opened.id;
  viewer.onKey({ name: "m", char: "m", ctrl: false, meta: false });
  assert.notEqual(opened.id, firstId, "migration creates a separate native identity");

  let native;
  App.prototype.loadSession.call({ state: app.state, pushScreen(screen) { native = screen; } }, opened);
  native.app = app;
  native.onActivate();
  assert.equal(native.liveCwd(), project);
  assert.deepEqual(native.liveSnapshot("test").messages, expected);
  native.onDeactivate();

  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error("simulated disk write failure"); };
    opened = null;
    viewer.onKey({ name: "enter", char: "", ctrl: false, meta: false });
    assert.equal(opened, null, "failed saves do not open a phantom session");
    assert.match(viewer.migrationError, /disk write failure/);
    assert.ok(renders);
    assert.ok(fs.readdirSync(sessionDir()).every(file => file.endsWith(".json")), "failed migrations clean up temporary files");
  } finally { fs.renameSync = rename; }

  // HTTP migration validates the project, persists, and opens a live session.
  server = await startWebServer({ port: 0, auth: false });
  const route = "/api/agents/codex/sessions/codex-source/migrate";
  assert.equal((await request(route)).status, 405);
  assert.equal((await request(route, { cwd: project }, { headers: { Origin: "https://evil.invalid" } })).status, 403);
  assert.equal((await request(route, { cwd: other })).status, 404);
  assert.equal((await request(route, { cwd: "relative" })).status, 400);
  assert.equal((await request("/api/agents/unknown/sessions/id/migrate", { cwd: project })).status, 400);
  assert.equal((await request("/api/agents/claude/sessions/..%2fescape/migrate", { cwd: project })).status, 400);
  assert.equal((await request("/api/agents/claude/sessions/missing/migrate", { cwd: project })).status, 404);
  assert.equal((await request("/api/agents/claude/sessions/empty-source/migrate", { cwd: project })).status, 400);
  const beforeHttpFailure = listSessions().length;
  try {
    fs.renameSync = () => { throw Object.assign(new Error("disk is full"), { code: "ENOSPC" }); };
    const failed = await request(route, { cwd: project });
    assert.equal(failed.status, 500);
    assert.match(failed.data.error, /disk is full/);
    assert.equal(listSessions().length, beforeHttpFailure);
  } finally { fs.renameSync = rename; }
  const loaded = await request(`/api/agents/claude/sessions/claude-source?cwd=${encodeURIComponent(project)}`);
  assert.equal(loaded.data.cwd, project);
  assert.deepEqual(loaded.data.messages, expected, "viewing and migration resolve the same source in this folder");

  const migrated = await request(route, { cwd: project });
  assert.equal(migrated.status, 201);
  assert.equal(migrated.data.cwd, project);
  assert.ok(migrated.data.key);
  assert.deepEqual(migrated.data.snapshot.messages, expected);
  assert.deepEqual(loadSession(migrated.data.id).messages, expected);
  assert.ok(!JSON.stringify(migrated).includes("migration-test-secret"));
  const overview = await request("/api/overview");
  assert.ok(overview.data.groups.find(group => group.cwd === project).sessions.some(session => session.id === migrated.data.id));

  let context;
  LLMClient.prototype.streamTurn = async function* (messages) { context = messages; yield "Continued in Neutrino."; };
  await request(`/api/live/${migrated.data.key}/message`, { text: "Please continue" });
  let snapshot;
  for (const deadline = Date.now() + 4000; Date.now() < deadline;) {
    snapshot = (await request(`/api/live/${migrated.data.key}`)).data;
    if (!snapshot.busy && snapshot.messages.at(-1)?.content === "Continued in Neutrino.") break;
    await delay(15);
  }
  assert.equal(snapshot.messages.at(-1).content, "Continued in Neutrino.");
  for (const message of expected) assert.ok(context.some(entry => entry.role === message.role && entry.content === message.content));
  assert.deepEqual(loadSession(migrated.data.id).messages.slice(0, expected.length), expected);
  assert.equal(loadSession(migrated.data.id).cwd, project);
  assert.equal(fs.readFileSync(codexFile, "utf8"), codexOriginal);

  const models = loadModels();
  try {
    const offline = structuredClone(models);
    offline.providers[0].models[0].api_key = "";
    saveModels(offline);
    const copied = await request(route, { cwd: project });
    assert.equal(copied.status, 201, "copying history does not require an API key or contact a provider");
    assert.deepEqual(copied.data.snapshot.messages, expected);
  } finally { saveModels(models); }

  const pro = await request("/pro/api/agents/claude/sessions/claude-source/migrate", { cwd: project });
  assert.equal(pro.status, 201);
  assert.ok(loadSession(pro.data.id, "pro")?.pro_preset);
  assert.equal(loadSession(pro.data.id), null, "Pro migration stays in the Pro workspace");
  assert.deepEqual(pro.data.snapshot.messages, expected);
  console.log("ok session migration: source formats, working directories, native persistence, terminal actions, HTTP and continuation");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  if (server) await server.close();
  database?.close();
  fs.rmSync(home, { recursive: true, force: true });
}
