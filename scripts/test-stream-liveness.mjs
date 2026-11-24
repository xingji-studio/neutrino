import assert from "node:assert/strict";
import { LLMClient } from "../dist/llm/client.js";

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();
const event = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const model = { name: "fixture", url: "http://127.0.0.1:1/v1", api_key: "fixture", supports_streaming: true };
const options = { streamIdleTimeoutMs: 25, retry: { attempts: 2, baseDelayMs: 1 } };
const consume = async (client, opts = options) => {
  let text = ""; for await (const part of client.streamTurn([{ role: "user", content: "fixture" }], undefined, opts)) text += part; return text;
};
const response = (text, extra = {}) => new Response(text, { headers: { "Content-Type": "text/event-stream", ...extra } });
try {
  let calls = 0, cancelled = 0, retries = 0;
  globalThis.fetch = async () => ++calls === 1 ? response(new ReadableStream({ cancel() { cancelled++; } })) : response(event({ content: "recovered" }) + "data: [DONE]\n\n");
  const retry = new LLMClient(model, "Fixture", "High");
  assert.equal(await consume(retry, { ...options, onRetry() { retries++; } }), "recovered");
  assert.equal(retry.outcome.status, "completed"); assert.equal(calls, 2); assert.equal(retries, 1); assert.equal(cancelled, 1);
  console.log("ok silent response body is cancelled and retried within a bounded policy");

  calls = 0;
  globalThis.fetch = async () => { calls++; return response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(event({ content: "partial" }))); } })); };
  const stalled = new LLMClient(model, "Fixture", "High");
  assert.match(await consume(stalled), /partial[\s\S]*timed out/); assert.equal(stalled.outcome.status, "failed"); assert.equal(calls, 1);
  console.log("ok a stall after partial output is visible failure and never replays output or tools");

  globalThis.fetch = async () => response(event({ content: "unfinished progress" }));
  const eof = new LLMClient(model, "Fixture", "High");
  assert.match(await consume(eof), /premature close/); assert.equal(eof.outcome.status, "failed");
  globalThis.fetch = async () => response(event({ tool_calls: [{ index: 0, id: "bad", function: { name: "run_command", arguments: "{}" } }] }));
  const tool = new LLMClient(model, "Fixture", "High");
  await consume(tool); assert.equal(tool.outcome.status, "failed"); assert.deepEqual(tool.toolCalls, []);
  console.log("ok EOF without a completion marker cannot produce success or executable tool calls");

  let timer;
  globalThis.fetch = async () => response(new ReadableStream({
    start(controller) {
      let count = 0;
      timer = setInterval(() => {
        if (++count < 12) controller.enqueue(encoder.encode(": keepalive\n\n"));
        else { clearInterval(timer); controller.enqueue(encoder.encode(event({ content: "long active response" }) + "data: [DONE]\n\n")); controller.close(); }
      }, 5);
    }, cancel() { clearInterval(timer); },
  }));
  const active = new LLMClient(model, "Fixture", "High");
  assert.equal(await consume(active), "long active response"); assert.equal(active.outcome.status, "completed");
  console.log("ok activity resets the inactivity watchdog instead of imposing a task duration limit");

  globalThis.fetch = async () => response(new ReadableStream({
    start(controller) { timer = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 5); },
    cancel() { clearInterval(timer); },
  }));
  const heartbeat = new LLMClient(model, "Fixture", "High");
  assert.match(await consume(heartbeat, { ...options, retry: { attempts: 1 }, streamProgressTimeoutMs: 40 }), /no content progress/);
  assert.equal(heartbeat.outcome.status, "failed");
  console.log("ok endless keepalive comments cannot hide a model that makes no content progress");

  globalThis.fetch = async () => response('data: {"type":"content_block_delta","index":0,"delta":{"text":"anthropic partial"}}\n\n');
  const anthropic = new LLMClient(model, "Anthropic", "High");
  assert.match(await consume(anthropic), /missing message_stop/); assert.equal(anthropic.outcome.status, "failed");
  globalThis.fetch = async () => response('data: {"type":"content_block_delta","index":0,"delta":{"text":"anthropic complete"}}\n\ndata: {"type":"message_stop"}\n\n');
  const complete = new LLMClient(model, "Anthropic", "High");
  assert.equal(await consume(complete), "anthropic complete"); assert.equal(complete.outcome.status, "completed");
  console.log("ok Anthropic requires an explicit completed stream as well");

  globalThis.fetch = async () => response(new ReadableStream({}), { "Content-Type": "application/json" });
  const json = new LLMClient({ ...model, supports_streaming: false }, "Fixture", "High");
  assert.match(await consume(json), /timed out/); assert.equal(json.outcome.status, "failed");
  console.log("ok nonstreaming response bodies also have inactivity protection");

  for (const provider of ["Fixture", "Anthropic"]) {
    let attempts = 0, cancellations = 0;
    const complete = provider === "Anthropic"
      ? 'data: {"type":"content_block_delta","index":0,"delta":{"text":"error recovered"}}\n\ndata: {"type":"message_stop"}\n\n'
      : event({ content: "error recovered" }) + "data: [DONE]\n\n";
    globalThis.fetch = async () => ++attempts === 1
      ? new Response(new ReadableStream({ cancel() { cancellations++; } }), { status: 503 })
      : response(complete);
    const client = new LLMClient(model, provider, "High");
    assert.equal(await consume(client), "error recovered");
    assert.equal(client.outcome.status, "completed");
    assert.equal(attempts, 2); assert.equal(cancellations, 1);
  }
  console.log("ok stalled HTTP error bodies are bounded and preserve status-based retries in both protocols");
} finally { globalThis.fetch = originalFetch; }
