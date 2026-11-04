// Exercise the browser's real other-agent handlers, including navigation while
// reads/migrations are pending, retries, double clicks, and directory scoping.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { setLanguage, t } from "../web/i18n.js";

class Element {
  children = [];
  events = new Map();
  classes = new Set();
  textContent = "";
  disabled = false;
  classList = {
    add: name => this.classes.add(name), remove: name => this.classes.delete(name),
    contains: name => this.classes.has(name),
  };
  set innerHTML(_value) { this.children = []; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  fire(name) { return this.events.get(name)?.(); }
  focus() { this.focused = true; }
  close() {}
}

const appSource = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
assert.ok(html.indexOf('id="agent-actions"') > html.indexOf('id="messages"'));
assert.ok(html.indexOf('id="agent-actions"') < html.indexOf('id="composer"'));
assert.match(appSource, /el\.agentMigrate\.addEventListener\("click", \(\) => migrateSelectedAgentSession\(\)\)/);

const el = Object.fromEntries([
  "agentsList", "agentsDialog", "agentActions", "agentMigrate", "agentMigrateFeedback",
  "controls", "title", "sub", "composer", "input",
].map(name => [name, new Element()]));
const project = "/project with spaces/中文";
const history = [{ role: "user", content: "Original question" }, { role: "assistant", content: "Original answer" }];
const state = {
  selection: null, agentData: null, agentMigration: null,
  workspace: null, workspaces: { cwd: project },
};
const requests = [];
let fetchImpl;
let rendered;
let attached = [];
let workspace;
let refreshes = 0;
const context = vm.createContext({
  state, el, PRO_MODE: false,
  tr: t,
  document: { createElement: () => new Element() },
  preferences: { clear() {} },
  closeStream() {}, renderSidebar() {}, renderApproval() {}, renderPlanCard() {}, renderComposerAction() {},
  renderMessageList(messages) { rendered = messages; },
  resetMessagePane(text) { rendered = text; },
  firstUserMessage: messages => messages.find(message => message.role === "user")?.content,
  escapeHtml: value => String(value), formatTime: value => value,
  setConversationView() {},
  apiError: data => data.error,
  currentProPreset: () => "pro-preset",
  setWorkspace(value) { workspace = value; },
  async loadOverview() { refreshes++; },
  async selectLive(key) {
    attached.push(key);
    state.selection = { kind: "live", key };
    state.agentData = null;
    context.setComposerMode("live");
  },
  apiFetch(url, options) { requests.push({ url, options }); return fetchImpl(url, options); },
});
for (const name of ["setComposerMode", "hideComposer"]) {
  const fn = appSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(fn);
  vm.runInContext(fn, context);
}
vm.runInContext(appSource.slice(appSource.indexOf("const OTHER_AGENTS = ["), appSource.indexOf("// ------------------------------------------------------------------ language")), context);
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, async json() { return data; } });
const readSource = async () => {
  fetchImpl = async () => response({ cwd: project, messages: history });
  await context.selectAgentSession("claude", "source-id", "Source title", project);
};

setLanguage("zh");
try {
  // The list passes its captured scope even when All directories is selected.
  const select = context.selectAgentSession;
  let args;
  context.selectAgentSession = (...values) => { args = values; };
  context.renderAgentList([{ id: "claude", label: "Claude Code", cwd: project,
    sessions: [{ id: "source-id", title: "Source title" }] }]);
  el.agentsList.children[0].children[1].fire("click");
  assert.equal(args[3], project);
  context.selectAgentSession = select;

  await readSource();
  assert.match(requests.at(-1).url, new RegExp(`cwd=${encodeURIComponent(project)}$`));
  assert.equal(state.agentData.cwd, project);
  assert.equal(rendered, history);
  assert.equal(el.agentActions.classList.contains("hidden"), false);
  assert.equal(el.agentMigrate.textContent, "迁移会话");
  assert.equal(el.agentMigrate.disabled, false);
  assert.equal(el.composer.classList.contains("hidden"), true);

  // A slow POST disables the button; repeated clicks cannot create duplicates.
  let resolvePost;
  fetchImpl = () => new Promise(resolve => { resolvePost = resolve; });
  const pending = context.migrateSelectedAgentSession();
  assert.equal(el.agentMigrate.disabled, true);
  assert.equal(el.agentMigrate.textContent, "迁移中…");
  const requestCount = requests.length;
  await context.migrateSelectedAgentSession();
  assert.equal(requests.length, requestCount);
  assert.equal(requests.at(-1).options.method, "POST");
  assert.deepEqual(JSON.parse(requests.at(-1).options.body), { cwd: project });
  context.renderAgentView(state.agentData);
  assert.equal(el.agentMigrate.disabled, true, "repainting while a migration is pending retains its busy state");
  resolvePost(response({ key: "migrated-live", cwd: project }, 201));
  await pending;
  assert.deepEqual(attached, ["migrated-live"]);
  assert.equal(workspace.path, project);
  assert.equal(el.agentActions.classList.contains("hidden"), true);
  assert.equal(el.input.focused, true);
  assert.ok(refreshes);

  // Save failures retain the source and allow a retry with a readable message.
  await readSource();
  fetchImpl = async () => response({ error: "disk is full" }, 500);
  await context.migrateSelectedAgentSession();
  assert.equal(state.selection.kind, "agent");
  assert.equal(rendered, history);
  assert.equal(el.agentMigrate.disabled, false);
  assert.match(el.agentMigrateFeedback.textContent, /无法迁移此会话.*disk is full/);
  assert.equal(attached.length, 1);

  // A completed request must not steal focus after the reader navigated away.
  fetchImpl = () => new Promise(resolve => { resolvePost = resolve; });
  const navigating = context.migrateSelectedAgentSession();
  state.selection = { kind: "new", cwd: "/another-project" };
  context.setComposerMode("new");
  resolvePost(response({ key: "background-migration", cwd: project }, 201));
  await navigating;
  assert.equal(state.selection.kind, "new");
  assert.equal(attached.length, 1);
  assert.equal(el.agentActions.classList.contains("hidden"), true);

  // Likewise, an older GET cannot overwrite a newer foreign transcript.
  let resolveRead;
  fetchImpl = () => new Promise(resolve => { resolveRead = resolve; });
  const slowRead = context.selectAgentSession("codex", "old", "Old title", project);
  fetchImpl = async () => response({ cwd: project, messages: [{ role: "user", content: "newer source" }] });
  await context.selectAgentSession("claude", "newer", "New title", project);
  resolveRead(response({ cwd: project, messages: history }));
  await slowRead;
  assert.equal(state.selection.id, "newer");
  assert.equal(state.agentData.messages[0].content, "newer source");

  // Empty histories have no action, and Pro carries its current preset.
  fetchImpl = async () => response({ cwd: project, messages: [] });
  await context.selectAgentSession("codex", "empty", "Empty", project);
  assert.equal(el.agentMigrate.disabled, true);
  const beforeEmpty = requests.length;
  await context.migrateSelectedAgentSession();
  assert.equal(requests.length, beforeEmpty);
  await readSource();
  context.PRO_MODE = true;
  fetchImpl = async () => response({ key: "pro-migration", cwd: project }, 201);
  await context.migrateSelectedAgentSession();
  assert.equal(JSON.parse(requests.at(-1).options.body).pro_preset, "pro-preset");

  setLanguage("en");
  await readSource();
  assert.equal(el.agentMigrate.textContent, "Migrate session");
  context.hideComposer();
  assert.equal(el.agentActions.classList.contains("hidden"), true);
  console.log("ok web migration: directory scope, button, duplicate clicks, failure/retry, navigation races and translations");
} finally { setLanguage("en"); }
