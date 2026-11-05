// Real HTTP coverage of role routing, preflight fallback, recursion and approval.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-pro-team-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.NEUTRINO_PLAN = "off"; // Pro always plans, independently of standard mode.
const { saveModels, loadSession, loadConfig } = await import("../dist/config.js");
const { PRO_MODEL_FILE, PRO_ROLES, loadProModels, loadProPrompt } = await import("../dist/pro/config.js");
const { seedProPresets } = await import("./pro-presets.mjs");
const { resolveProTeam, ProPreflightError } = await import("../dist/pro/preflight.js");
const { ProAgentTeam } = await import("../dist/pro/agents.js");
const { startWebServer } = await import("../dist/web/server.js");
const { hub } = await import("../dist/web/hub.js");

const calls = [];
const provider = "shared-pro-provider";
let web;
let loopCalls = 0;
let stallProbe = false;
let probeStalled = false;
let holdPlan = false;
let releasePlan = null;
let singleStep = false;
let emptyMain = false;
let longMain = false;
let longMainRounds = 0;
const mock = http.createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  const body = JSON.parse(raw);
  calls.push(body);
  if (body.model.startsWith("dead")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "private-key-must-not-be-exposed" }));
    return;
  }
  if (!body.stream) {
    if (stallProbe) { stallProbe = false; probeStalled = true; return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    return;
  }
  const complete = (content, toolCalls = []) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }] })}\n\ndata: [DONE]\n\n`);
  };
  const tool = (role) => ({ index: 0, id: `call-${calls.length}`, type: "function", function: {
    name: "call_pro_agent", arguments: JSON.stringify({ role, task: `Complete ${role} work`, reason: "Finish the requested task" }),
  } });
  const results = body.messages.filter((entry) => entry.role === "tool");
  if (body.model === "loop") {
    loopCalls++;
    if (!results.length) complete("", [tool("thinking_model")]);
    else complete(results.at(-1).content);
  } else if (body.model.endsWith("plan_model")) {
    const steps = [
      { title: "Implement frontend and backend" }, { title: "Check the modeling result" },
    ];
    const finish = () => complete(JSON.stringify({ goal: "Implement the requested feature", steps: singleStep ? steps.slice(0, 1) : steps }));
    if (holdPlan) { holdPlan = false; releasePlan = finish; }
    else finish();
  } else if (body.model.endsWith("confirm_model")) {
    complete(JSON.stringify({ approve: true, safety_score: 100, relevance_score: 100, hard_block: false, obvious_mismatch: false, mismatch_evidence: "", reason: "A bounded project operation requested by the user" }));
  } else if (body.model.endsWith("main_model")) {
    if (longMain) {
      longMainRounds++;
      if (longMainRounds <= 26) complete("", [{ index: 0, id: `long-${longMainRounds}`, type: "function", function: {
        name: "read_file", arguments: JSON.stringify({ path: "pro-result.txt", reason: "Inspect the task result" }),
      } }]);
      else complete("Long professional task complete.");
    } else if (emptyMain) complete("");
    else if (!results.length) complete("", [tool("front_output_model")]);
    else if (results.length === 1) complete("", [tool("modeling_model")]);
    else complete("All professional tasks completed.");
  } else if (body.model.endsWith("front_output_model")) {
    if (!results.length) complete("", [tool("backend_output_model")]);
    else complete("Frontend completed using the backend report.");
  } else if (body.model.endsWith("backend_output_model")) {
    if (!results.length) complete("", [{ index: 0, id: "write-command", type: "function", function: {
      name: "run_command", arguments: JSON.stringify({ command: "printf pro-success > pro-result.txt", reason: "Write the requested project result" }),
    } }]);
    else complete("Backend completed and verified.");
  } else complete("Modeling report ready.");
});
await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${mock.address().port}/v1`;

async function request(route, body) {
  const response = await fetch(web.url + route, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for Pro turn");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
try {
  // Presets are downloaded, not bundled: this throwaway home writes its own.
  seedProPresets(["cheap", "medium", "best"]);
  assert.equal(loadProModels().tier.length, 3);
  for (const role of PRO_ROLES) assert.ok(loadProPrompt(role).length > 80, `prompt exists for ${role}`);
  const tier = ["cheap", "medium", "best"].map((name) => ({
    name, chinese_name: name,
    "model-setting": PRO_ROLES.map((role) => ({
      type: role, provider, model: role === "genimage_model" ? null : `${name === "cheap" || role !== "main_model" ? name : "dead-" + name}_${role}`,
      intensity: "xhigh", context_window: 272000,
    })),
  }));
  const configText = JSON.stringify({ tier, api_key: "private-pro-setting" }, null, 2);
  fs.writeFileSync(PRO_MODEL_FILE, configText);
  const names = [...new Set(tier.flatMap((entry) => entry["model-setting"].map((entry) => entry.model)).filter(Boolean)), "loop"];
  saveModels({ providers: [{ name: provider, models: names.map((name) => ({
    name, url: base, api_key: "shared-private-key", supports_streaming: true,
  })) }] });
  const resolved = await resolveProTeam("best");
  assert.equal(resolved.models.main_model.tier, "cheap", "main recursively falls back two tiers");
  assert.equal(resolved.models.front_output_model.tier, "best", "other roles keep the selected tier");
  assert.equal(resolved.models.genimage_model, undefined, "image placeholder is never probed");
  assert.equal(resolved.fallbacks.length, 1);
  assert.ok(!JSON.stringify(resolved.fallbacks).includes("private-key"), "probe failures do not leak response bodies");
  assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), configText, "fallback leaves presets untouched");
  assert.ok(calls.filter((entry) => !entry.stream).every((entry) => entry.reasoning_effort === "xhigh"));

  web = await startWebServer({ port: 0, auth: false });
  const settings = await request("/pro/api/settings");
  assert.equal(settings.body.pro.max_recursion_depth, 10);
  assert.ok(!JSON.stringify(settings.body).includes("private"), "public config is a whitelist");
  const invalid = await request("/pro/api/settings", { settings: { pro_max_recursion_depth: 0 } });
  assert.equal(invalid.status, 400);
  assert.equal((await request("/pro/api/settings", { settings: { pro_preset: "best", pro_max_recursion_depth: 4 } })).status, 200);
  assert.equal(loadConfig("pro").pro_max_recursion_depth, 4);
  assert.equal(loadConfig().pro_max_recursion_depth, undefined, "recursion is Pro-only");
  const created = await request("/pro/api/conversations", { cwd: testHome, pro_preset: "best", approval_mode: "auto" });
  assert.equal(created.status, 200);
  const key = created.body.key;
  assert.equal((await request(`/pro/api/live/${key}/pro-preset`, { preset: "unknown" })).status, 400);
  const start = calls.length;
  assert.equal((await request(`/pro/api/live/${key}/message`, { text: "Implement frontend, backend and modeling; write the result into pro-result.txt." })).status, 200);
  await waitFor(() => !hub.snapshot(key).busy);
  const snapshot = hub.snapshot(key);
  assert.equal(snapshot.pro.error, undefined, JSON.stringify(snapshot.messages));
  assert.equal(snapshot.pro.preset, "best");
  assert.equal(snapshot.pro.fallbacks[0].replacement.tier, "cheap");
  assert.equal(snapshot.pro.checking, false);
  assert.ok(snapshot.plan.steps.every((entry) => entry.status === "done"));
  assert.equal(fs.readFileSync(path.join(testHome, "pro-result.txt"), "utf8"), "pro-success", "nested backend executes through the shared gate");
  const turnCalls = calls.slice(start).filter((entry) => entry.stream);
  assert.equal(turnCalls[0].model, "best_plan_model", "planner runs before the main model even for standard-plan=off");
  const mainCall = turnCalls.find((entry) => entry.model.endsWith("main_model"));
  assert.ok(mainCall.messages.some((entry) => String(entry.content).includes("Implement frontend and backend")), "main receives the plan");
  for (const role of ["front_output_model", "backend_output_model", "confirm_model", "modeling_model"]) {
    assert.ok(turnCalls.some((entry) => entry.model === `best_${role}`), `routes ${role} to its selected model`);
  }
  assert.ok(!JSON.stringify(snapshot).includes("shared-private-key"));
  assert.equal(loadSession(snapshot.sessionId, "pro").pro_preset, "best", "history remembers the chosen preset");
  assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), configText);

  // The Pro main agent must also reach its final reply after a long tool run.
  longMain = true;
  longMainRounds = 0;
  await request(`/pro/api/live/${key}/message`, { text: "Inspect the task result repeatedly and then report." });
  await waitFor(() => !hub.snapshot(key).busy);
  longMain = false;
  const longTurn = hub.snapshot(key);
  assert.equal(longMainRounds, 27, "Pro continues past 24 model/tool rounds");
  assert.equal(longTurn.messages.at(-1).content, "Long professional task complete.");
  assert.ok(longTurn.plan.steps.every((entry) => entry.status === "done"));
  assert.equal(longTurn.messages.slice(-27, -1).filter((entry) => entry.role === "tool").length, 26);

  // Pausing a stalled availability request cannot mutate the replacement turn.
  stallProbe = true;
  await request(`/pro/api/live/${key}/message`, { text: "Task interrupted during preflight" });
  await waitFor(() => probeStalled && hub.snapshot(key).pro.checking);
  await request(`/pro/api/live/${key}/pause`, {});
  assert.equal(hub.snapshot(key).pro.checking, false);
  assert.equal((await request(`/pro/api/live/${key}/pro-preset`, { preset: "cheap" })).status, 200);
  await request(`/pro/api/live/${key}/message`, { text: "Finish after pause" });
  await request(`/pro/api/live/${key}/resume`, {});
  await waitFor(() => !hub.snapshot(key).busy);
  assert.equal(hub.snapshot(key).pro.preset, "cheap");
  assert.equal(hub.snapshot(key).pro.error, undefined);
  assert.equal(hub.snapshot(key).reviewing, null);
  await request(`/pro/api/live/${key}/pro-preset`, { preset: "best" });

  // New queued input must not enter the first task's planner or reviewers.
  const queueStart = calls.length;
  holdPlan = true;
  await request(`/pro/api/live/${key}/message`, { text: "First-turn-only request" });
  await waitFor(() => typeof releasePlan === "function");
  await request(`/pro/api/live/${key}/message`, { text: "Queued-turn-only request" });
  releasePlan(); releasePlan = null;
  await waitFor(() => !hub.snapshot(key).busy);
  const queueCalls = calls.slice(queueStart).filter((entry) => entry.stream);
  const planners = queueCalls.filter((entry) => entry.model.endsWith("plan_model"));
  assert.equal(planners.length, 2);
  assert.ok(!JSON.stringify(planners[0].messages).includes("Queued-turn-only"));
  assert.ok(JSON.stringify(planners[1].messages).includes("Queued-turn-only"));
  const reviews = queueCalls.filter((entry) => entry.model.endsWith("confirm_model"));
  assert.ok(reviews.length >= 4);
  for (const review of reviews.slice(0, 2)) assert.ok(!JSON.stringify(review.messages).includes("Queued-turn-only"));
  for (const review of reviews.slice(2)) assert.ok(JSON.stringify(review.messages).includes("Queued-turn-only"));

  singleStep = true;
  await request(`/pro/api/live/${key}/message`, { text: "One simple action" });
  await waitFor(() => !hub.snapshot(key).busy);
  assert.equal(hub.snapshot(key).plan.steps.length, 1, "even simple Pro requests produce a visible plan");
  singleStep = false;
  emptyMain = true;
  await request(`/pro/api/live/${key}/message`, { text: "Empty completion must not mark work done" });
  await waitFor(() => !hub.snapshot(key).busy);
  assert.equal(hub.snapshot(key).plan.steps[0].status, "failed");
  assert.ok(hub.snapshot(key).messages.some((entry) => entry.content?.includes("empty completion")));
  emptyMain = false;

  const models = Object.fromEntries(Object.entries(resolved.models).map(([role, entry]) => [role, {
    ...entry, model: { ...entry.model, name: "loop" },
  }]));
  const team = new ProAgentTeam({ models, maxDepth: 2, cwd: testHome, cancelled: () => false,
    approve: async () => ({ approved: true, source: "prompt", reason: "test" }), execute: async () => "unused",
  });
  const report = await team.call("thinking_model", "Exercise the recursion limit");
  assert.match(report, /depth|recursion|limit/i);
  assert.ok(loopCalls <= 6, `recursive requests remain bounded: ${loopCalls}`);

  const empty = JSON.parse(configText);
  empty.tier.forEach((entry) => { entry["model-setting"].find((entry) => entry.type === "modeling_model").model = "not-configured"; });
  fs.writeFileSync(PRO_MODEL_FILE, JSON.stringify(empty));
  await assert.rejects(resolveProTeam("best"), (error) => error instanceof ProPreflightError && error.fallbacks.some((entry) => entry.role === "modeling_model" && entry.replacement === null));
  const beforeBlocked = calls.length;
  await request(`/pro/api/live/${key}/message`, { text: "Try another task" });
  await waitFor(() => !hub.snapshot(key).busy);
  assert.ok(hub.snapshot(key).pro.error, "unavailable lowest tier blocks execution");
  assert.ok(!calls.slice(beforeBlocked).some((entry) => entry.stream), "no planning or work occurs before all required roles are available");
  console.log("Pro team: fallback, planning, role routing, approvals, recursion, pause, queue isolation and failure checks passed");
} finally {
  if (web) await web.close();
  mock.closeAllConnections?.();
  await new Promise((resolve) => mock.close(resolve));
  fs.rmSync(testHome, { recursive: true, force: true });
}
