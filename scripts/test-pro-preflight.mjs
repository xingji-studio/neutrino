import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-pro-preflight-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
const { saveConfig, saveModels, MODEL_FILE } = await import("../dist/config.js");
const {
  ACTIVE_PRO_ROLES, PRO_ROLES, PRO_MODEL_FILE, defaultProPreset,
  loadProModels, loadProPrompt, proMaxRecursionDepth, requireProPreset,
} = await import("../dist/pro/config.js");
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
  // Initial install is byte-for-byte, and never overwrites a user's file.
  loadProModels();
  assert.deepEqual(fs.readFileSync(PRO_MODEL_FILE), fs.readFileSync(new URL("../assets/pro/model-template.json", import.meta.url)));
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
