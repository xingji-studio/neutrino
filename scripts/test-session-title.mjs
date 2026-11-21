import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-title-"));
process.env.NEUTRINO_HOME = testHome;
process.env.NEUTRINO_PLAN = "off";
const { saveConfig, loadConfig, saveModels, saveSession, loadSession, deleteSession, listSessions } = await import("../dist/config.js");
const { SessionTitle, cleanSessionTitle } = await import("../dist/sessionTitle.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { currentTask, TaskRuntime } = await import("../dist/llm/runtime.js");
const { ChatScreen } = await import("../dist/screens/chat.js");
const { createWebSession, resumeSession } = await import("../dist/web/session.js");
const { SettingsScreen } = await import("../dist/screens/settings.js");
const { getWebSettings, updateWebSettings } = await import("../dist/web/settings.js");
const { defaultState } = await import("../dist/state.js");

const originalFetch = globalThis.fetch;
const active = new Set();
const requests = [];
const model = { name: "gpt-5.2", url: "https://title-test.invalid/v1", api_key: "private-key", supports_streaming: false };
const otherModel = { ...model, url: "https://provider-b.invalid/v1", api_key: "provider-b-key", intensity: ["Medium", "High"] };
const selection = { model, provider: "A", intensity: "Ultra" };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function waitFor(predicate, label = "condition") {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await sleep(5);
  }
}
let titleReply = "修复登录页面错误";
let titleGate = null;
let titleStatus = 200;
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body);
  const title = (payload.system ?? payload.messages[0]?.content ?? "").startsWith("Generate a short, specific conversation title");
  const request = { url, payload, title, scope: currentTask(), signal: init.signal };
  requests.push(request);
  const reply = title ? titleReply : "Main task finished.";
  const status = title ? titleStatus : 200;
  if (title && titleGate) await titleGate.promise;
  if (init.signal.aborted) throw init.signal.reason ?? new Error("aborted");
  return new Response(JSON.stringify(status !== 200 ? { error: "test provider failed" }
    : url.endsWith("/messages")
      ? { content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }
      : { choices: [{ message: { content: reply }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  { status, headers: { "content-type": "application/json" } });
};
const titles = () => requests.filter(request => request.title);
function runner(kind, source) {
  let agent;
  if (kind === "terminal") {
    agent = new ChatScreen();
    agent.loadedAgentMode = "ptc";
    if (source) {
      agent.sessionId = source.id;
      agent.loadedMessages = source.messages;
      agent.loadedTitle = source.title;
      agent.loadedAgentMode = source.agent_mode;
      agent.loadedTokens = source.tokens;
    }
    agent.app = { state: { ...defaultState(), selectedProvider: "A", selectedModelName: model.name,
      selectedModelUrl: model.url, selectedModelApiKey: model.api_key, selectedModelStreaming: false, selectedIntensity: "Ultra" }, render() {} };
    agent.onActivate();
  } else {
    if (source) {
      const resumed = resumeSession(source);
      assert.ok(resumed.ok);
      agent = resumed.session;
    } else agent = createWebSession(process.cwd(), selection, undefined, "standard", undefined, "ptc");
    agent.start();
  }
  active.add(agent);
  return agent;
}
function close(agent) {
  if (agent instanceof ChatScreen) { agent.sessionTitle.cancel(); agent.onDeactivate(); }
  else agent.dispose();
  active.delete(agent);
}

try {
  saveModels({ providers: [{ name: "A", models: [model] }, { name: "B", models: [otherModel] }] });
  saveConfig({ plan_first: false });
  assert.equal(getWebSettings().settings.auto_title, true, "existing config files default to enabled");
  assert.equal(getWebSettings().settings.title_model, "");
  for (const patch of [{ auto_title: "false" }, { title_model: model.name }, { title_model: { provider: "missing", model: model.name } }]) {
    const before = loadConfig();
    assert.throws(() => updateWebSettings({ settings: patch }));
    assert.deepEqual(loadConfig(), before);
  }
  updateWebSettings({ settings: { title_model: { provider: "B", model: model.name } } });
  assert.deepEqual(getWebSettings().settings.title_model, { provider: "B", model: model.name });
  assert.ok(!JSON.stringify(getWebSettings()).includes(model.api_key));
  updateWebSettings({ settings: { title_model: "" } });
  updateWebSettings({ settings: { auto_title: false } }, "pro");
  assert.equal(getWebSettings().settings.auto_title, true, "Pro settings remain isolated");

  for (const kind of ["terminal", "web"]) {
    const before = titles().length;
    titleGate = defer();
    const agent = runner(kind);
    agent.liveSend("请修复登录页面上的错误，并验证修改。");
    await waitFor(() => !agent.busy && titles().length === before + 1, `${kind} main turn and title request`);
    assert.equal(agent.liveMeta().title, "请修复登录页面上的错误，并验证修改。", "fallback is shown while generation is pending");
    const first = titles().at(-1);
    assert.equal(first.payload.model, model.name);
    assert.equal(first.payload.reasoning_effort, "none");
    assert.equal(first.payload.temperature, undefined);
    assert.equal(first.payload.tools, undefined);
    assert.equal(first.payload.messages.length, 2);
    assert.equal(first.scope, undefined);
    assert.equal(agent.liveMeta().intensity, "Ultra");
    agent.liveSend("再检查一下后端接口。");
    await waitFor(() => !agent.busy);
    assert.equal(titles().length, before + 1, "later messages do not generate another title");
    const snapshot = loadSession(agent.sessionId);
    const gate = titleGate; titleGate = null; gate.resolve();
    await waitFor(() => agent.liveMeta().title === titleReply, `${kind} generated title`);
    const saved = loadSession(agent.sessionId);
    assert.equal(saved.title, titleReply);
    assert.deepEqual(saved.messages, snapshot.messages, "title generation does not change transcript");
    assert.deepEqual(saved.tokens, snapshot.tokens, "title generation has no task usage side effects");
    assert.equal(listSessions().find(session => session.id === saved.id).title, titleReply);
    agent.liveSend("第三条消息");
    await waitFor(() => !agent.busy);
    assert.equal(loadSession(agent.sessionId).title, titleReply, "checkpoints retain generated titles");
    close(agent);

    const resumed = runner(kind, saved);
    resumed.liveSend("继续旧会话");
    await waitFor(() => !resumed.busy);
    assert.equal(titles().length, before + 1, "resuming a titled conversation makes no title request");
    assert.equal(resumed.liveMeta().title, titleReply);
    close(resumed);

    const cleared = runner(kind);
    titleReply = "旧会话标题"; titleGate = defer();
    cleared.liveSend("old request");
    await waitFor(() => !cleared.busy && titles().length === before + 2);
    const oldRequest = titles().at(-1);
    cleared.liveClear();
    assert.equal(oldRequest.signal.aborted, true);
    titleReply = "全新会话标题";
    const oldGate = titleGate; titleGate = null;
    cleared.liveSend("new request"); oldGate.resolve();
    await waitFor(() => !cleared.busy && cleared.liveMeta().title === titleReply);
    assert.equal(titles().length, before + 3);
    close(cleared);
    titleReply = "修复登录页面错误";
    console.log(`ok ${kind}: background completion, first-message-only, stable persistence, resume, clear races`);
  }

  for (const kind of ["terminal", "web"]) {
    updateWebSettings({ settings: { auto_title: false } });
    const agent = runner(kind);
    const before = titles().length;
    agent.liveSend("feature disabled");
    await waitFor(() => !agent.busy);
    await sleep(15);
    assert.equal(titles().length, before);
    updateWebSettings({ settings: { auto_title: true } });
    agent.liveSend("enabled later, same chat");
    await waitFor(() => !agent.busy);
    assert.equal(titles().length, before, "enabling later only affects new conversations");
    close(agent);
  }

  // Legacy/empty resumed transcripts never become eligible, even without a generated title.
  for (const kind of ["terminal", "web"]) for (const messages of [[], [{ role: "user", content: "legacy message" }]]) {
    const id = saveSession(messages, model.name, "A", "Ultra", process.cwd());
    const saved = loadSession(id);
    const resumed = runner(kind, saved);
    const before = titles().length;
    resumed.liveSend("continue without renaming");
    await waitFor(() => !resumed.busy);
    assert.equal(titles().length, before);
    close(resumed);
    deleteSession(id);
  }

  // An auxiliary request created inside a task does not inherit its exhausted budget or abort signal.
  updateWebSettings({ settings: { title_model: { provider: "B", model: model.name } } });
  const title = new SessionTitle("", true);
  const aborted = new AbortController(); aborted.abort();
  const runtime = new TaskRuntime({ request: "task scope isolation", cwd: process.cwd(), goalTokenBudget: 0, signal: aborted.signal });
  const before = titles().length;
  runtime.run(() => title.generate("separate title", model, "A", "standard", () => {}));
  await waitFor(() => title.value !== "");
  assert.equal(titles().length, before + 1);
  assert.equal(titles().at(-1).scope, undefined);
  assert.equal(titles().at(-1).payload.reasoning_effort, "medium", "the lowest configured intensity is respected");
  assert.equal(runtime.snapshot().counts.modelRequests, 0);
  assert.equal(titles().at(-1).payload.model, otherModel.name);
  assert.equal(titles().at(-1).url, otherModel.url + "/chat/completions", "duplicate model names use the explicitly chosen provider");
  updateWebSettings({ settings: { title_model: "" } });

  const proDisabled = new SessionTitle("", true);
  const proBefore = titles().length;
  proDisabled.generate("Pro setting disabled", model, "A", "pro", () => {});
  await sleep(15);
  assert.equal(titles().length, proBefore);
  updateWebSettings({ settings: { auto_title: true, title_model: { provider: "B", model: model.name } } }, "pro");
  const proTitle = new SessionTitle("", true);
  proTitle.generate("Pro title model override", model, "A", "pro", () => {});
  await waitFor(() => proTitle.value !== "");
  assert.equal(titles().at(-1).url, otherModel.url + "/chat/completions");
  assert.equal(getWebSettings().settings.title_model, "", "Pro title model changes do not affect regular chats");

  // A transient title error is not retried and does not affect the main turn or its history.
  titleStatus = 503;
  const failed = runner("web");
  const failedBefore = titles().length;
  failed.liveSend("keep this fallback");
  await waitFor(() => !failed.busy && titles().length === failedBefore + 1);
  await sleep(15);
  assert.equal(failed.liveMeta().title, "keep this fallback");
  assert.ok(!JSON.stringify(loadSession(failed.sessionId).messages).includes("test provider failed"));
  close(failed); titleStatus = 200;

  // Exercise the actual provider payloads rather than treating sampling temperature as thinking effort.
  for (const [provider, name, expected] of [
    ["OpenAI", "gpt-5", { reasoning_effort: "minimal" }],
    ["OpenAI", "gpt-6.1-sol", { reasoning_effort: "low" }],
    ["OpenAI", "o3-mini", { reasoning_effort: "low" }],
    ["Compatible", "custom-thinking", { reasoning_effort: "low" }],
    ["DeepSeek", "deepseek-v4-pro", { thinking: { type: "disabled" } }],
    ["Anthropic", "claude-sonnet-4-6", { thinking: { type: "disabled" } }],
    ["Anthropic", "claude-opus-5-5", { thinking: { type: "adaptive" }, output_config: { effort: "low" } }],
  ]) {
    const client = new LLMClient({ ...model, name }, provider, "Low");
    await client.complete("payload probe", "title", { minimizeReasoning: true });
    assert.equal(client.outcome.status, "completed");
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(requests.at(-1).payload[key], value);
    assert.equal(client.intensity, "Low");
  }

  assert.equal(cleanSessionTitle(' <think>hidden</think>\n“登录修复”\nexplanation'), "登录修复");
  assert.equal(cleanSessionTitle("[Error: bad request]"), "");
  assert.equal(cleanSessionTitle("\u001b[31m标题：测试标题\u001b[0m"), "测试标题");
  assert.equal(Array.from(cleanSessionTitle("🙂".repeat(100))).length, 80);

  const screen = new SettingsScreen();
  screen.app = { state: { ...defaultState(), selectedProvider: "A", selectedModelName: model.name }, render() {} };
  screen.onActivate();
  screen.cycle("title_model", -1);
  assert.equal(loadConfig().auto_title, false);
  screen.cycle("title_model", 3);
  assert.deepEqual(loadConfig().title_model, { provider: "B", model: model.name });
  assert.equal(loadConfig().auto_title, true);
  screen.cycle("title_model", -2);
  assert.equal(loadConfig().title_model, "");
  console.log("ok title settings, provider selection, task isolation, failure handling, transport controls and title cleanup");
} finally {
  titleGate?.resolve();
  for (const agent of active) close(agent);
  globalThis.fetch = originalFetch;
  fs.rmSync(testHome, { recursive: true, force: true });
}
