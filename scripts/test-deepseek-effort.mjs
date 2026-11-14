import assert from "node:assert/strict";
import { LLMClient, deepSeekEffort } from "../dist/llm/client.js";

const model = { name: "deepseek-flash", url: "https://api.deepseek.com", api_key: "mock-key", supports_streaming: false };
const original = globalThis.fetch;
const requests = [];
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body); requests.push(body);
  return new Response(JSON.stringify({ choices: [{ message: { content: "OK", reasoning_content: "checked" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }), { headers: { "content-type": "application/json" } });
};
try {
  for (const [level, expected] of [["Low", "low"], ["Medium", "high"], ["High", "high"], ["Max", "max"], ["Ultra", "max"]]) {
    const client = new LLMClient(model, "DeepSeek", level);
    for await (const ignored of client.streamTurn([{ role: "user", content: "OK" }], [], { maxOutputTokens: 16384 })) { }
    assert.equal(requests.at(-1).reasoning_effort, expected);
    assert.deepEqual(requests.at(-1).thinking, { type: "enabled" });
    assert.equal(requests.at(-1).max_tokens, 16384);
  }
  assert.equal(deepSeekEffort({ ...model, url: "http://127.0.0.1/v1" }, "DeepSeek", "Max"), "max", "Metered routes retain explicit effort");
  assert.equal(deepSeekEffort({ ...model, name: "unrelated", url: "https://other.invalid" }, "Other", "Max"), undefined);
  assert.equal(deepSeekEffort({ ...model, name: "deepseek-chat" }, "DeepSeek", "Max"), undefined, "Legacy models keep their existing transport");
  console.log("PASS DeepSeek API effort: real max/ultra, low/high mapping, metered routes, unchanged legacy transport");
} finally { globalThis.fetch = original; }
