import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-pro-preflight-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { saveConfig, saveModels, MODEL_FILE } = await import("../dist/config.js");
const {
  ACTIVE_PRO_ROLES, PRO_CUSTOM_MODEL_FILE, PRO_MODELS_URL, PRO_ROLES, PRO_MODEL_FILE, defaultProPreset, ensureProModels,
  loadProModels, loadProPrompt, proMaxRecursionDepth, requireProPreset, syncProModels,
} = await import("../dist/pro/config.js");
const { seedProPresets } = await import("./pro-presets.mjs");
const { resolveProTeam, ProPreflightError } = await import("../dist/pro/preflight.js");

const originalFetch = globalThis.fetch;
const requests = [];
let failed = new Set();
const providers = ["Shared", "Other"];
const catalog = { providers: providers.map((name) => ({ name, models: ["good", "bad", "lowest", "no-key"].map((model) => ({
  name: model, url: `https://${name.toLowerCase()}.invalid/v1`,
  api_key: model === "no-key" ? "" : `private-${name}-key`, supports_streaming: true,
})) })) };
function preset(name, model, overrides = {}) {
  return {
    name, chinese_name: name,
    "model-setting": PRO_ROLES.map((type) => ({
      type, provider: "Shared", model: type === "genimage_model" ? null : model,
      intensity: "xhigh", context_window: 272000, ...overrides[type],
    })),
  };
}
function configure(tier) {
  fs.writeFileSync(PRO_MODEL_FILE, JSON.stringify({ tier }));
}
// No template ships with the package: the first use downloads the official
// presets, and a failed download must leave nothing behind.
const downloaded = JSON.stringify({ tier: [preset("medium", "good")] });
let downloadUrl = null;
globalThis.fetch = async (url) => {
  downloadUrl = String(url);
  return new Response(downloaded, { status: 200 });
};
await ensureProModels();
assert.equal(downloadUrl, PRO_MODELS_URL, "the official presets are the only download");
assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), downloaded, "the download is written verbatim");
assert.equal(loadProModels().tier[0].name, "medium", "the downloaded presets load as written");
// A file that already exists belongs to the user: no request, no rewrite.
globalThis.fetch = async () => { throw new Error("an existing file is never downloaded again"); };
await ensureProModels();
assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), downloaded);
// Offline first run: no partial file, and Pro says where the file comes from.
fs.rmSync(PRO_MODEL_FILE);
globalThis.fetch = async () => { throw new Error("getaddrinfo ENOENT"); };
await assert.rejects(ensureProModels(), /could not download the Pro model presets from/);
assert.equal(fs.existsSync(PRO_MODEL_FILE), false, "a failed download leaves no partial file");
assert.throws(() => loadProModels(), /is missing; it is downloaded from/);

// The official copy owns model.json: any difference is overwritten, a failed
// fetch keeps the local presets, and start-up is never blocked by either.
const official = JSON.stringify({ tier: [preset("medium", "good"), preset("best", "good")] });
globalThis.fetch = async () => new Response(official, { status: 200 });
assert.equal((await syncProModels()).status, "updated", "a missing file is written from the official copy");
assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), official, "the official copy is written verbatim");
// Reformatting alone is not a difference: the local file keeps its shape.
fs.writeFileSync(PRO_MODEL_FILE, JSON.stringify(JSON.parse(official), null, 2));
assert.equal((await syncProModels()).status, "unchanged", "a matching file is not rewritten");
assert.ok(fs.readFileSync(PRO_MODEL_FILE, "utf8").includes('\n  "tier": ['), "a matching file keeps its formatting");
// An edited or hand-broken file is replaced: user presets belong in model-custom.json.
fs.writeFileSync(PRO_MODEL_FILE, JSON.stringify({ tier: [preset("custom", "good")] }));
assert.equal((await syncProModels()).status, "updated", "a differing file is overwritten");
assert.deepEqual(loadProModels(), JSON.parse(official), "the official presets replace local edits");
fs.writeFileSync(PRO_MODEL_FILE, "{broken");
assert.equal((await syncProModels()).status, "updated", "a hand-broken file heals instead of blocking Pro");
// Offline: the local presets stay exactly as they are.
globalThis.fetch = async () => { throw new Error("getaddrinfo ENOENT"); };
const kept = await syncProModels();
assert.equal(kept.status, "kept", "a failed fetch keeps the local presets");
assert.match(kept.detail, /could not download the Pro model presets from/);
assert.deepEqual(loadProModels(), JSON.parse(official), "the kept presets still load");
// An offline first run has nothing to fall back on, so it reports the failure.
fs.rmSync(PRO_MODEL_FILE);
await assert.rejects(syncProModels(), /could not download the Pro model presets from/);
assert.equal(fs.existsSync(PRO_MODEL_FILE), false, "a failed first download leaves no partial file");
// An empty document from the server never replaces usable presets.
fs.writeFileSync(PRO_MODEL_FILE, official);
globalThis.fetch = async () => new Response('{"tier":[]}', { status: 200 });
assert.equal((await syncProModels()).status, "kept", "an empty remote document keeps the local presets");
assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), official);

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url, body, headers: init.headers });
  assert.equal(body.stream, false, "availability is a real inference request");
  assert.equal(body.reasoning_effort, "xhigh", "Pro intensity is not normalized to standard mode");
  assert.ok(body.tools.length, "the endpoint must accept tool definitions");
  assert.equal(body.temperature, undefined, "reasoning endpoints are not forced to accept sampling parameters");
  assert.equal(body.max_tokens, undefined, "reasoning endpoints are not forced to accept a tiny output budget");
  return failed.has(`${url}:${body.model}`)
    ? new Response("provider accidentally repeated private-Shared-key", { status: 503 })
    : Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } });
};

try {
  // A throwaway home keeps its own presets; loading them must not rewrite them.
  seedProPresets(["custom", "cheap", "medium", "best"]);
  assert.equal(loadProModels().tier.length, 4, "the home's own presets load as written");
  // The slider reads left to right as strength, so the presets a user writes in
  // model-custom.json lead the list instead of landing on the maximum end.
  seedProPresets(["custom", "mine"], PRO_CUSTOM_MODEL_FILE);
  assert.deepEqual(loadProModels().tier.map((entry) => entry.name), ["mine", "custom", "cheap", "medium", "best"],
    "user presets lead, official rungs keep their order, and a same-named entry keeps its rung");
  fs.rmSync(PRO_CUSTOM_MODEL_FILE);
  assert.equal(ACTIVE_PRO_ROLES.length, 7, "image generation is reserved; modeling is active");
  assert.ok(ACTIVE_PRO_ROLES.includes("modeling_model"));
  for (const role of PRO_ROLES) assert.ok(loadProPrompt(role).length > 100);
  assert.equal(defaultProPreset(), "medium");
  assert.equal(proMaxRecursionDepth(), 10);
  assert.throws(() => requireProPreset("missing"), /Unknown Pro preset/);
  saveConfig({ pro_max_recursion_depth: 23, pro_preset: "cheap" }, "pro");
  assert.equal(proMaxRecursionDepth(), 23);
  assert.equal(defaultProPreset(), "cheap");
  saveModels(catalog);

  configure([
    preset("custom", "lowest"), preset("cheap", "lowest"), preset("medium", "good"),
    preset("best", "good", {
      thinking_model: { model: "bad" },
      front_output_model: { model: "no-key" },
      backend_output_model: { provider: "Other", model: "good" },
      modeling_model: { provider: "Missing", model: "bad" },
    }),
  ]);
  const configBefore = fs.readFileSync(PRO_MODEL_FILE, "utf8");
  const sharedBefore = fs.readFileSync(MODEL_FILE, "utf8");
  failed = new Set(["https://shared.invalid/v1/chat/completions:bad"]);
  let spent = 0;
  const result = await resolveProTeam("best", { onUsage: (usage) => { spent += usage.total; } });
  assert.equal(result.models.main_model.tier, "best");
  assert.equal(result.models.thinking_model.tier, "medium");
  assert.equal(result.models.front_output_model.tier, "medium");
  assert.equal(result.models.backend_output_model.provider, "Other", "provider names must resolve exactly");
  assert.equal(result.models.modeling_model.tier, "medium");
  assert.equal(result.models.genimage_model, undefined, "reserved image generation makes no request");
  assert.equal(result.models.main_model.context_window, 272000);
  assert.equal(result.fallbacks.length, 3);
  assert.equal(requests.length, 3, "same model and intensity are probed once per task, across roles and fallback tiers");
  assert.equal(spent, 8, "only actual successful probes count their tokens once");
  assert.ok(!JSON.stringify(result.fallbacks).includes("private-"), "provider bodies and API keys never appear in fallback reasons");
  assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), configBefore, "temporary replacements do not rewrite presets");
  assert.equal(fs.readFileSync(MODEL_FILE, "utf8"), sharedBefore, "temporary replacements do not rewrite provider settings");
  assert.deepEqual(loadProModels(), JSON.parse(configBefore), "loading an existing file never restores defaults over it");

  // Retry fresh on the next task rather than caching availability globally.
  requests.length = 0;
  failed.clear();
  const recovered = await resolveProTeam("best");
  assert.equal(recovered.models.thinking_model.tier, "best");
  assert.equal(requests.length, 3);

  // Exhaust all lower ranks; custom must not become an implicit final fallback.
  configure([preset("custom", "good"), preset("cheap", "bad"), preset("best", "bad")]);
  failed.add("https://shared.invalid/v1/chat/completions:bad");
  requests.length = 0;
  await assert.rejects(resolveProTeam("best"), (error) => {
    assert.ok(error instanceof ProPreflightError);
    assert.equal(error.fallbacks.length, 7);
    assert.ok(error.fallbacks.every((entry) => entry.replacement === null));
    assert.ok(error.fallbacks.every((entry) => entry.reason.includes("best") && entry.reason.includes("cheap")));
    return true;
  });
  assert.equal(requests.length, 1, "failed duplicate models are also deduplicated");

  // Missing roles can descend to the same role in a complete lower preset.
  configure([preset("cheap", "good"), { name: "best", chinese_name: "最佳", "model-setting": [] }]);
  failed.clear();
  const missing = await resolveProTeam("best");
  assert.equal(missing.fallbacks.length, 7);
  assert.ok(Object.values(missing.models).every((entry) => entry.tier === "cheap"));

  const controller = new AbortController();
  controller.abort();
  const countBeforeAbort = requests.length;
  await assert.rejects(resolveProTeam("best", { signal: controller.signal }), /cancelled/);
  assert.equal(requests.length, countBeforeAbort, "already cancelled tasks do not call providers");

  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("provider timeout includes private-key")), { once: true });
  });
  configure([preset("cheap", "good")]);
  await assert.rejects(resolveProTeam("cheap", { timeoutMs: 5 }), (error) => {
    assert.ok(error instanceof ProPreflightError);
    assert.ok(error.fallbacks.every((entry) => entry.reason.includes("timed out")));
    assert.ok(!JSON.stringify(error.fallbacks).includes("private-key"));
    return true;
  });

  // Anthropic's native request uses its own effort/tool schema.
  saveModels({ providers: [{ name: "Anthropic", models: [{ name: "native", url: "https://anthropic.invalid/v1", api_key: "native-secret", supports_streaming: true }] }] });
  configure([preset("cheap", "native", Object.fromEntries(ACTIVE_PRO_ROLES.map((role) => [role, { provider: "Anthropic" }]))) ]);
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(url, "https://anthropic.invalid/v1/messages");
    assert.equal(payload.output_config.effort, "xhigh");
    assert.equal(payload.tools[0].input_schema.type, "object");
    assert.equal(init.headers["x-api-key"], "native-secret");
    return Response.json({ content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  assert.equal(Object.keys((await resolveProTeam("cheap")).models).length, 7);

  fs.writeFileSync(PRO_MODEL_FILE, "{broken");
  assert.throws(() => loadProModels(), /not valid JSON/);
  assert.equal(fs.readFileSync(PRO_MODEL_FILE, "utf8"), "{broken", "invalid hand-edited files must not be silently overwritten");
  console.log("Pro preset configuration and availability fallback tests passed.");
} finally {
  globalThis.fetch = originalFetch;
  fs.rmSync(testHome, { recursive: true, force: true });
}
