import fs from "node:fs";
import { LLMClient } from "../dist/llm/client.js";
const input = JSON.parse(fs.readFileSync("/opt/neutrino/runtime-input.json", "utf8"));
const client = new LLMClient(input.model, input.provider, "Max");
let answer = "";
for await (const part of client.streamTurn([{ role: "user", content: "Reply exactly OK to confirm this endpoint is reachable." }], [],
  { maxOutputTokens: 16384, retry: { attempts: 1 }, signal: AbortSignal.timeout(180000) })) answer += part;
fs.writeFileSync("/logs/agent/chat-probe.json", JSON.stringify({ outcome: client.outcome, usage: client.usage,
  reply_contains_ok: answer.includes("OK") }, null, 2) + "\n");
if (client.outcome?.status !== "completed" || !client.usage) process.exitCode = 1;
