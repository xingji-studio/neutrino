import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-pro-runtime-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { LLMClient } = await import("../dist/llm/client.js");
const { ProAgentTeam, getProToolDefinitions, PRO_AGENT_TOOL } = await import("../dist/pro/agents.js");
const { ACTIVE_PRO_ROLES } = await import("../dist/pro/config.js");
const originalStream = LLMClient.prototype.streamTurn;
const originalFetch = globalThis.fetch;
const models = Object.fromEntries(ACTIVE_PRO_ROLES.map(role => [role, {
  role, provider: "Test", tier: "medium", intensity: "xhigh", context_window: 272_000,
  model: { name: role, url: "https://test.invalid/v1", api_key: "never-expose", supports_streaming: true },
}]));
const allowed = { approved: true, source: "prompt", reason: "routine call" };
const options = overrides => ({
  models, cwd: process.cwd(), maxDepth: 10, cancelled: () => false,
  approve: async () => allowed,
  execute: async () => "executed",
  ...overrides,
});
const tool = (client, name, args) => {
  client.toolCalls = [{ id: "T1", name, arguments: JSON.stringify(args) }];
};
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const response = events => new Response(events.map(event).join("") + "data: [DONE]\n\n", {
  headers: { "Content-Type": "text/event-stream" },
});

try {
  assert.ok(getProToolDefinitions().some(entry => entry.function.name === PRO_AGENT_TOOL));

  // Every depth uses the requested specialist, with a private transcript.
  const seen = [];
  LLMClient.prototype.streamTurn = async function* (messages, tools) {
    this.toolCalls = [];
    seen.push({ model: this.model.name, messages: structuredClone(messages), tools });
    assert.equal(this.professional, true);
    assert.equal(this.intensity, "xhigh");
    if (this.model.name === "backend_output_model" && messages.length === 2) {
      tool(this, PRO_AGENT_TOOL, { role: "thinking_model", task: "reason", reason: "investigate" });
    } else if (this.model.name === "thinking_model" && messages.length === 2) {
      tool(this, PRO_AGENT_TOOL, { role: "modeling_model", task: "model", reason: "analyze" });
    } else yield `${this.model.name} report`;
  };
  const report = await new ProAgentTeam(options()).call("backend_output_model", "implementation", "known facts");
  assert.equal(report, "backend_output_model report");
  assert.deepEqual(seen.map(item => item.model), ["backend_output_model", "thinking_model", "modeling_model", "thinking_model", "backend_output_model"]);
  assert.ok(!seen[1].messages.some(message => message.content?.includes("known facts")), "child only sees explicitly passed context");

  // Cycles terminate at the configurable depth, including calls back to main.
  let recursiveCalls = 0;
  LLMClient.prototype.streamTurn = async function* (messages) {
    this.toolCalls = [];
    if (messages.length === 2) {
      recursiveCalls++;
      tool(this, PRO_AGENT_TOOL, { role: "main_model", task: "recur", reason: "test depth" });
    } else yield messages.at(-1).content;
  };
  const limited = await new ProAgentTeam(options({ maxDepth: 3 })).call("backend_output_model", "begin");
  assert.equal(recursiveCalls, 2, "a repeated ancestor task is stopped before the depth limit");
  assert.match(limited, /Repeated task|delegation_cycle|recursion limit/);

  // Planning and review remain read-only even through a nested coding agent.
  let executions = 0;
  LLMClient.prototype.streamTurn = async function* (messages, tools) {
    this.toolCalls = [];
    assert.ok(!tools.some(entry => entry.function.name === "write_file" || entry.function.name === "run_command"));
    assert.ok(tools.some(entry => entry.function.name === "web_search"), "read-only specialists can research public sources through the approval gate");
    if (messages.length === 2 && this.model.name === "plan_model") {
      tool(this, PRO_AGENT_TOOL, { role: "backend_output_model", task: "inspect", reason: "consult" });
    } else if (messages.length === 2) {
      tool(this, "write_file", { path: "never.txt", content: "blocked", reason: "attempt" });
    } else yield messages.at(-1).content;
  };
  const readOnly = await new ProAgentTeam(options({ execute: async () => { executions++; return "bad"; } }))
    .call("plan_model", "plan", "", 0, true);
  assert.equal(executions, 0);
  assert.match(readOnly, /not available/);
  assert.match(await new ProAgentTeam(options()).call("genimage_model", "draw"), /reserved/);
  assert.match(await new ProAgentTeam(options()).call("unknown", "bad"), /unknown/);

  // A denied coding action uses the same approval gate as its parent.
  let reviews = 0;
  LLMClient.prototype.streamTurn = async function* (messages) {
    this.toolCalls = [];
    if (messages.length === 2) tool(this, "run_command", { command: "touch never", reason: "test" });
    else yield messages.at(-1).content;
  };
  const denied = await new ProAgentTeam(options({
    approve: async () => { reviews++; return { approved: false, source: "human", reason: "no" }; },
    execute: async () => { executions++; return "bad"; },
  })).call("backend_output_model", "work");
  assert.equal(reviews, 1);
  assert.equal(executions, 0);
  assert.match(denied, /approval denied/);

  // Per-role context compression never leaves orphaned tool results.
  let compressed = false;
  LLMClient.prototype.streamTurn = async function* (messages) {
    this.toolCalls = [];
    if (messages[0].content.startsWith("You compress")) { compressed = true; yield "prior file inspected"; return; }
    if (messages.length === 2) tool(this, "read_file", { path: "large.txt", reason: "inspect" });
    else {
      assert.equal(messages.some(message => message.role === "tool"), false);
      assert.ok(messages.some(message => message.content?.includes("prior file inspected")));
      yield "finished";
    }
  };
  const small = { ...models, backend_output_model: { ...models.backend_output_model, context_window: 8000 } };
  const compacted = await new ProAgentTeam(options({ models: small, execute: async () => "x".repeat(40000) }))
    .call("backend_output_model", "inspect file");
  assert.equal(compacted, "finished");
  assert.equal(compressed, true);

  LLMClient.prototype.streamTurn = originalStream;
  const captured = [];
  globalThis.fetch = async (_url, init) => {
    captured.push(JSON.parse(init.body));
    return response([{ choices: [{ delta: { content: "ok" } }] }]);
  };
  const proClient = new LLMClient(models.main_model.model, "Test", "xhigh", { professional: true });
  assert.equal(await proClient.complete("system", "user"), "ok");
  assert.equal(captured[0].reasoning_effort, "xhigh");
  assert.equal("temperature" in captured[0], false);
  assert.equal("top_p" in captured[0], false);

  // Anthropic tool calls, signed thinking, tool results and usage all survive.
  globalThis.fetch = async (_url, init) => {
    captured.push(JSON.parse(init.body));
    return response([
      { type: "message_start", message: { usage: { input_tokens: 42, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "consider" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-block" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool1", name: "read_file", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"file.txt"}' } },
      { type: "message_delta", usage: { output_tokens: 9 } },
      { type: "message_stop" },
    ]);
  };
  const anthropic = new LLMClient({ ...models.main_model.model, name: "claude" }, "Anthropic", "xhigh", { professional: true });
  for await (const _chunk of anthropic.streamTurn([{ role: "system", content: "system" }, { role: "user", content: "inspect" }], getProToolDefinitions())) {}
  assert.deepEqual(anthropic.toolCalls, [{ id: "tool1", name: "read_file", arguments: '{"path":"file.txt"}' }]);
  assert.deepEqual(anthropic.usage, { prompt: 42, completion: 9, total: 51 });
  assert.equal(anthropic.anthropicContent[0].signature, "signed-block");
  const signed = structuredClone(anthropic.anthropicContent);
  for await (const _chunk of anthropic.streamTurn([
    { role: "system", content: "system" },
    { role: "user", content: "inspect" },
    { role: "assistant", content: "", anthropic_content: signed },
    { role: "tool", tool_call_id: "tool1", content: "file contents" },
  ], getProToolDefinitions())) {}
  const payload = captured.at(-1);
  assert.equal(payload.output_config.effort, "xhigh");
  assert.equal(payload.tools.at(-1).name, PRO_AGENT_TOOL);
  assert.ok(payload.tools.at(-1).input_schema);
  assert.equal(payload.messages[1].content[0].signature, "signed-block");
  assert.deepEqual(payload.messages[2].content, [{ type: "tool_result", tool_use_id: "tool1", content: "file contents" }]);

  // Catalogue entries that disable streaming use the same execution protocol.
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, false);
    assert.equal("stream_options" in body, false);
    return Response.json({
      choices: [{ message: { content: "nonstream result", tool_calls: [{ id: "n1", function: { name: "read_file", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
  };
  const nonstream = new LLMClient({ ...models.main_model.model, supports_streaming: false }, "Test", "high", { professional: true });
  assert.equal(await nonstream.complete("system", "user"), "nonstream result");
  assert.deepEqual(nonstream.toolCalls, [{ id: "n1", name: "read_file", arguments: "{}" }]);
  assert.equal(nonstream.usage.total, 10);
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(init.body).stream, false);
    return Response.json({ content: [{ type: "text", text: "anthropic nonstream" }], usage: { input_tokens: 8, output_tokens: 2 } });
  };
  const nonstreamAnthropic = new LLMClient({ ...models.main_model.model, supports_streaming: false }, "Anthropic", "max", { professional: true });
  assert.equal(await nonstreamAnthropic.complete("system", "user"), "anthropic nonstream");
  assert.equal(nonstreamAnthropic.usage.total, 10);

  // Pausing a turn interrupts even a response body that has stopped producing.
  let cancelled = false;
  let aborted = false;
  globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener("abort", () => { aborted = true; controller.error(new Error("aborted")); }, { once: true });
    },
  }));
  const timer = setTimeout(() => { cancelled = true; }, 20);
  const chunks = [];
  for await (const chunk of proClient.streamTurn([{ role: "user", content: "stall" }], undefined, { cancelled: () => cancelled })) chunks.push(chunk);
  clearTimeout(timer);
  assert.equal(aborted, true);
  assert.deepEqual(chunks, []);

  console.log("Pro runtime tests passed: specialist routing, recursion, shared approvals, read-only planning, context capacities, effort, Anthropic tools, cancellation");
} finally {
  LLMClient.prototype.streamTurn = originalStream;
  globalThis.fetch = originalFetch;
  fs.rmSync(testHome, { recursive: true, force: true });
}
