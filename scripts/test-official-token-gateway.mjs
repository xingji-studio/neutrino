import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTokenGateway } from "./benchmark-token-gateway.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-token-gateway-"));
const auth = { authorization: "Bearer local-mock-key", "content-type": "application/json" };
const chat = { model: "deepseek-flash", messages: [{ role: "user", content: "test" }],
  reasoning_effort: "max", thinking: { type: "enabled" }, max_tokens: 16 };
const messages = { ...chat, reasoning_effort: undefined, output_config: { effort: "max" } };
const fakeChat = () => new Response(JSON.stringify({ model: "deepseek-flash", choices: [{ finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 5 } }),
  { headers: { "content-type": "application/json" } });
const common = { upstream: "https://mock.invalid/v1", apiKey: "upstream-mock", clientKey: "local-mock-key", maxOutputTokens: 16 };
const send = (gateway, body, route = "/v1/chat/completions", signal) => fetch(gateway.url + route,
  { method: "POST", headers: auth, body: JSON.stringify(body), signal });
try {
  let calls = [];
  const gateway = await createTokenGateway({ ...common, tokenCap: 100000, ledgerFile: path.join(root, "both.json"),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) });
      if (!String(url).includes("messages")) return fakeChat();
      const frames = [{ type: "message_start", message: { model: "deepseek-flash", usage: { input_tokens: 7, cache_read_input_tokens: 30, output_tokens: 0 } } },
        { type: "message_delta", usage: { output_tokens: 5 } }, { type: "message_stop" }];
      const wire = frames.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("");
      // Every byte separately exercises SSE boundaries, including split CRLF.
      return new Response(new ReadableStream({ start(controller) {
        for (const byte of Buffer.from(wire)) controller.enqueue(Uint8Array.of(byte)); controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    } });
  await (await send(gateway, chat)).text();
  await (await send(gateway, messages, "/v1/messages")).text();
  assert.equal((await send(gateway, { ...chat, reasoning_effort: "high" })).status, 400);
  assert.equal((await send(gateway, { ...chat, model: "different" })).status, 400);
  await gateway.close();
  assert.equal(calls.length, 2, "Wrong model/effort are refused before provider dispatch");
  assert.equal(calls[1].url, "https://mock.invalid/anthropic/v1/messages");
  assert(calls.every(call => call.body.top_p === 1 && call.body.temperature === 1));
  assert.equal(gateway.state.spent_protected, 54, "Messages cache tokens must be included once");
  assert.equal(gateway.state.input_tokens, 47); assert.equal(gateway.state.output_tokens, 7);
  assert.equal(gateway.state.cached_input_tokens, 35); assert.equal(gateway.state.unknown_requests, 0);

  let release, dispatched = 0;
  const concurrent = await createTokenGateway({ ...common, tokenCap: 1000, fetchImpl: async () => {
    dispatched++; await new Promise(resolve => { release = resolve; }); return fakeChat();
  } });
  const first = send(concurrent, chat);
  while (!release) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal((await send(concurrent, chat)).status, 400, "Held reservation blocks a concurrent over-budget attempt");
  release(); await (await first).text(); await concurrent.close();
  assert.equal(dispatched, 1); assert.equal(concurrent.state.spent_protected, 12); assert.equal(concurrent.state.held_tokens, 0);

  const missing = await createTokenGateway({ ...common, tokenCap: 100000,
    fetchImpl: async () => new Response("data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", { headers: { "content-type": "text/event-stream" } }) });
  await (await send(missing, chat)).text(); await missing.close();
  assert.equal(missing.state.unknown_requests, 1); assert.equal(missing.state.spent_protected, missing.state.attempts[0].reserved);

  const abort = new AbortController();
  const draining = await createTokenGateway({ ...common, tokenCap: 100000, fetchImpl: async () =>
    new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from('data: {"choices":[{"delta":{"content":"start"}}]}\n\n'));
      setTimeout(() => { controller.enqueue(Buffer.from('data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\ndata: [DONE]\n\n')); controller.close(); }, 20);
    } }), { headers: { "content-type": "text/event-stream" } }) });
  const interrupted = await send(draining, chat, "/v1/chat/completions", abort.signal);
  await interrupted.body.getReader().read(); abort.abort(); await draining.close();
  assert.equal(draining.state.spent_protected, 12); assert.equal(draining.state.unknown_requests, 0, "Disconnected agents still drain final usage");

  const orphanFile = path.join(root, "orphan.json");
  fs.writeFileSync(orphanFile, JSON.stringify({ ...gateway.state, cap: 1000, spent_protected: 0, held_tokens: 500,
    unknown_requests: 0, attempts: [{ reserved: 500, protected_tokens: null }] }));
  const restarted = await createTokenGateway({ ...common, tokenCap: 1000, ledgerFile: orphanFile, fetchImpl: async () => { throw new Error("Must not dispatch"); } });
  assert.equal(restarted.state.spent_protected, 500); assert.equal(restarted.state.held_tokens, 0);
  assert.equal((await send(restarted, chat)).status, 400); await restarted.close();
  console.log("PASS common provider metering: Chat/Messages, cache accounting, explicit Max, concurrent caps, missing usage, aborted-client drain and restart reservations");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
