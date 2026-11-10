import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEventListeners } from "node:events";
import { analyzeTimeline } from "./fast-timeline-analysis.mjs";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-diagnostics-test-"));
const original = { fetch: globalThis.fetch, home: os.homedir,
  environment: Object.fromEntries(["NEUTRINO_HOME", "NEUTRINO_PLUGIN_HOME", "NEUTRINO_DIAGNOSTICS_DIR"].map(key => [key, process.env[key]])) };
process.env.NEUTRINO_HOME = path.join(fixture, "home"); process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
delete process.env.NEUTRINO_DIAGNOSTICS_DIR; os.homedir = () => fixture;
const { DiagnosticRecorder } = await import("../dist/llm/diagnostics.js");
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { LLMClient } = await import("../dist/llm/client.js");
const secret = "PRIVATE_PROMPT_MUST_NOT_APPEAR", key = "PRIVATE_API_KEY_MUST_NOT_APPEAR";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const model = { name: "deepseek-flash", url: "https://offline.invalid/v1", api_key: key, intensity: ["High"], supports_streaming: true };
function streamResponse(chunks, signal) {
  let cancelled = false;
  return new Response(new ReadableStream({
    async start(controller) {
      const abort = () => { cancelled = true; controller.error(new DOMException("Cancelled", "AbortError")); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        for (const chunk of chunks) {
          await sleep(2); if (cancelled) return;
          controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(chunk) + "\n\n"));
        }
        if (!cancelled) { controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close(); }
      } catch (error) { if (!cancelled) controller.error(error); }
      finally { signal?.removeEventListener("abort", abort); }
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } });
}
async function runClient(name, enabled, response, options = {}, provider = "DeepSeek") {
  const file = path.join(fixture, name + ".jsonl");
  const diagnostics = enabled ? new DiagnosticRecorder(file, { mode: "standard" }) : undefined;
  const runtime = new TaskRuntime({ request: secret, cwd: fixture, diagnostics });
  const client = new LLMClient(model, provider, "High");
  const wire = []; globalThis.fetch = async (url, init) => { wire.push(init.body); return response(init.signal, wire.length); };
  let text = "";
  await runtime.run(async () => {
    for await (const chunk of client.streamTurn([{ role: "user", content: secret }], [], options)) text += chunk;
  });
  runtime.finish(client.outcome.status); await runtime.drain();
  assert.equal(getEventListeners(runtime.signal, "abort").length, 0);
  return { file, events: diagnostics ? read(file) : [], client, text, wire, diagnostics };
}
try {
  // Multiple flushes append intact records; privacy filtering rejects arbitrary strings.
  const file = path.join(fixture, "append.jsonl"), recorder = new DiagnosticRecorder(file);
  recorder.emit("probe", { content: secret, command: key, private: { prompt: secret }, count: 1 }); await recorder.flush();
  recorder.emit("probe", { count: 2 }); await recorder.close();
  const events = read(file);
  assert.deepEqual(events.map(e => e.seq), events.map((e, i) => i + 1));
  assert.deepEqual(events.filter(e => e.event === "probe").map(e => e.data.count), [1, 2]);
  assert.equal(fs.readFileSync(file, "utf8").includes(secret), false);
  assert.equal(fs.readFileSync(file, "utf8").includes(key), false);
  assert.equal(events.at(-1).event, "trace_summary");

  const deniedPath = path.join(fixture, "not-a-directory"); fs.writeFileSync(deniedPath, "owned");
  const unavailable = new DiagnosticRecorder(path.join(deniedPath, "trace.jsonl"));
  unavailable.emit("probe"); await unavailable.close(); assert.equal(unavailable.ioErrors, 1);
  const bounded = new DiagnosticRecorder(path.join(fixture, "bounded.jsonl"), { maxBufferedBytes: 128 });
  for (let i = 0; i < 30; i++) bounded.emit("probe", { count: i }); await bounded.close(); assert.ok(bounded.dropped > 0);
  const deletedDir = path.join(fixture, "deleted"), deleted = new DiagnosticRecorder(path.join(deletedDir, "trace.jsonl"));
  await deleted.flush(); fs.rmSync(deletedDir, { recursive: true }); deleted.emit("late"); await deleted.close();
  assert.equal(fs.existsSync(deletedDir), false, "a deleted run is never recreated by trace flushing");

  const chunks = [
    { choices: [{ delta: { reasoning_content: secret } }] },
    { choices: [{ delta: { content: "VISIBLE" } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "tool1", function: { name: "read_file", arguments: '{"path":"private.txt"}' } }] }, finish_reason: "tool_calls" }] },
    { usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 4 } }, choices: [] },
  ];
  const off = await runClient("off", false, signal => streamResponse(chunks, signal));
  const on = await runClient("on", true, signal => streamResponse(chunks, signal));
  assert.deepEqual(on.wire, off.wire, "enabling diagnostics must not alter a provider request");
  assert.equal(on.text, off.text); assert.deepEqual(on.client.toolCalls, off.client.toolCalls); assert.deepEqual(on.client.usage, off.client.usage);
  assert.equal(fs.existsSync(path.join(fixture, "off.jsonl")), false);
  const eventAt = name => on.events.find(e => e.event === name).at_ms;
  assert.ok(eventAt("provider_first_reasoning") < eventAt("provider_first_text"));
  assert.ok(eventAt("provider_first_text") < eventAt("provider_first_tool"));
  assert.equal(on.events.find(e => e.event === "provider_first_content").seq + 1,
    on.events.find(e => e.event === "provider_first_reasoning").seq, "first reasoning is first model content, not first visible text");
  const usage = on.events.find(e => e.event === "provider_attempt_end").data;
  assert.equal(usage.input_tokens, 11); assert.equal(usage.output_tokens, 7); assert.equal(usage.cached_input_tokens, 3); assert.equal(usage.reasoning_tokens, 4);
  const raw = fs.readFileSync(on.file, "utf8"); assert.equal(raw.includes(secret), false); assert.equal(raw.includes(key), false); assert.equal(raw.includes("private.txt"), false);
  const analysis = analyzeTimeline(on.events);
  assert.equal(analysis.valid_for_attribution, true, analysis.issues.join(","));
  assert.equal(analysis.roles.main.logical_requests, 1); assert.equal(analysis.roles.main.reported_input_tokens, 11);
  assert.equal(analysis.roles.main.reported_cached_input_tokens, 3); assert.equal(analysis.roles.main.reported_reasoning_tokens, 4);
  assert.equal(analyzeTimeline(on.events.filter(e => e.event !== "model_stream_end")).valid_for_attribution, false);

  const retry = await runClient("retry", true, (signal, attempt) => attempt === 1
    ? new Response("fixture unavailable", { status: 503 }) : streamResponse([{ choices: [{ delta: { content: "OK" } }] }], signal), { retry: { attempts: 2, baseDelayMs: 1 } });
  assert.equal(retry.wire.length, 2); assert.equal(retry.text, "OK");
  assert.deepEqual(retry.events.filter(e => e.event === "provider_attempt_end").map(e => e.data.status), ["retry", "completed"]);
  assert.equal(retry.events.filter(e => e.event === "model_stream_start").length, 1);
  assert.equal(retry.events.filter(e => e.event === "model_retry_wait").length, 1);

  const anthropic = await runClient("anthropic", true, () => new Response(JSON.stringify({ content: [
    { type: "thinking", thinking: secret }, { type: "text", text: "OK" }, { type: "tool_use", id: "t", name: "read_file", input: { path: "private.txt" } }],
    usage: { input_tokens: 9, output_tokens: 6, cache_read_input_tokens: 2 } }), { headers: { "content-type": "application/json" } }), {}, "Anthropic");
  assert.equal(anthropic.text, "OK");
  assert.equal(anthropic.events.find(e => e.event === "provider_attempt_end").data.cached_input_tokens, 2);
  assert.ok(anthropic.events.some(e => e.event === "provider_first_reasoning"));
  assert.ok(anthropic.events.some(e => e.event === "provider_first_tool"));

  const controller = new AbortController();
  const cancellingFile = path.join(fixture, "cancel.jsonl"), cancellingTrace = new DiagnosticRecorder(cancellingFile);
  const cancellingRuntime = new TaskRuntime({ request: secret, diagnostics: cancellingTrace });
  const cancellingClient = new LLMClient(model, "DeepSeek", "High");
  globalThis.fetch = async (url, init) => streamResponse([{ choices: [{ delta: { content: "first" } }] }, { choices: [{ delta: { content: "later" } }] }], init.signal);
  await cancellingRuntime.run(async () => {
    for await (const chunk of cancellingClient.streamTurn([{ role: "user", content: secret }], [], { signal: controller.signal })) { controller.abort(); break; }
  });
  cancellingRuntime.finish("cancelled"); await cancellingRuntime.drain();
  assert.equal(read(cancellingFile).find(e => e.event === "provider_attempt_end").data.status, "cancelled");
  assert.equal(getEventListeners(cancellingRuntime.signal, "abort").length, 0);

  const delegatedFile = path.join(fixture, "delegated.jsonl"), delegatedTrace = new DiagnosticRecorder(delegatedFile);
  const delegatedRuntime = new TaskRuntime({ request: secret, diagnostics: delegatedTrace });
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 4, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } });
  await delegatedRuntime.run(() => delegatedRuntime.child("subagent", "controlled delegated task", async () => {
    const client = new LLMClient(model, "DeepSeek", "High");
    for await (const ignored of client.streamTurn([{ role: "user", content: secret }])) {}
  }));
  delegatedRuntime.finish("completed"); await delegatedRuntime.drain();
  assert.equal(read(delegatedFile).find(e => e.event === "model_stream_start").role, "worker", "ordinary delegated agents are distinct from the main coordinator");
  console.log("PASS diagnostics: private metadata, append/bounds/deletion, identical requests when enabled, distinct reasoning/text/tool timing, retries, provider cache usage, cancellation and cleanup");
} finally {
  globalThis.fetch = original.fetch; os.homedir = original.home;
  for (const [name, value] of Object.entries(original.environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  fs.rmSync(fixture, { recursive: true, force: true });
}
