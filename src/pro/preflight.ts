import { loadModels, type ModelsData } from "../config.js";
import type { UsageInfo } from "../llm/client.js";
import {
  ACTIVE_PRO_ROLES, loadProModels,
  type ProFallback, type ProModelReference, type ProModelSetting, type ProPreset,
  type ProResolvedModel, type ProRole,
} from "./config.js";

export interface ProPreflightResult {
  models: Partial<Record<ProRole, ProResolvedModel>>;
  fallbacks: ProFallback[];
}

export class ProPreflightError extends Error {
  constructor(message: string, public readonly fallbacks: ProFallback[]) {
    super(message);
    this.name = "ProPreflightError";
  }
}

export interface ProPreflightOptions {
  signal?: AbortSignal;
  onUsage?(usage: UsageInfo): void;
  /** Bounded for each actual inference, including its response body. */
  timeoutMs?: number;
}

interface ProbeResult {
  ok: boolean;
  reason: string;
}

function reference(preset: ProPreset, setting?: ProModelSetting): ProModelReference {
  return { provider: setting?.provider ?? "", model: setting?.model ?? "", tier: preset.name };
}

function resolveSetting(
  role: ProRole, preset: ProPreset, catalog: ModelsData,
): { resolved: ProResolvedModel } | { reason: string } {
  const setting = preset["model-setting"].find((entry) => entry.type === role);
  if (!setting?.provider.trim() || !setting.model?.trim() || setting.model.trim().toLowerCase() === "null") {
    return { reason: "role has no model configured" };
  }
  const provider = catalog.providers.find((entry) => entry.name === setting.provider);
  const model = provider?.models.find((entry) => entry.name === setting.model);
  if (!model) return { reason: "provider/model is missing from the shared catalogue" };
  if (!model.api_key?.trim()) return { reason: "API key is missing in the shared catalogue" };
  let endpoint: URL;
  try { endpoint = new URL(model.url); } catch { return { reason: "model endpoint is invalid" }; }
  if (!["http:", "https:"].includes(endpoint.protocol)) return { reason: "model endpoint must use HTTP or HTTPS" };
  const intensity = setting.intensity.trim().toLowerCase() || "high";
  if (!["low", "medium", "high", "xhigh", "max", "ultra"].includes(intensity)) {
    return { reason: "thinking intensity is invalid" };
  }
  // The Pro file can use xhigh, which must not be normalized through the
  // ordinary mode's five intensity labels. Explicit shared limits still apply.
  if (model.intensity?.length && !model.intensity.some((level) => level.toLowerCase() === intensity)) {
    return { reason: "thinking intensity is not supported by this model" };
  }
  return {
    resolved: {
      role, provider: provider!.name, model: { ...model }, intensity,
      context_window: setting.context_window, tier: preset.name,
    },
  };
}

/** An authenticated, tiny inference validates the same intensity/tool contract. */
async function probe(model: ProResolvedModel, options: ProPreflightOptions): Promise<ProbeResult> {
  const controller = new AbortController();
  const relay = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relay();
  else options.signal?.addEventListener("abort", relay, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  const anthropic = model.provider === "Anthropic";
  const parameters = { type: "object", properties: {}, additionalProperties: false };
  const tool = {
    name: "pro_availability_check", description: "A harmless availability check; this tool is never executed.",
  };
  const payload = anthropic ? {
    model: model.model.name, stream: false, max_tokens: 4096,
    output_config: { effort: model.intensity },
    messages: [{ role: "user", content: "Availability check. Reply only OK. Do not call tools." }],
    tools: [{ ...tool, input_schema: parameters }],
  } : {
    model: model.model.name, stream: false, reasoning_effort: model.intensity,
    messages: [{ role: "user", content: "Availability check. Reply only OK. Do not call tools." }],
    tools: [{ type: "function", function: { ...tool, parameters } }],
  };
  try {
    const response = await fetch(model.model.url.replace(/\/+$/, "") + (anthropic ? "/messages" : "/chat/completions"), {
      method: "POST", signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(anthropic
          ? { "x-api-key": model.model.api_key, "anthropic-version": "2023-06-01" }
          : { Authorization: `Bearer ${model.model.api_key}` }),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      // Never echo endpoint responses: they can repeat credentials or URLs.
      await response.body?.cancel();
      return { ok: false, reason: `availability request returned HTTP ${response.status}` };
    }
    const body = await response.json() as {
      choices?: Array<{ message?: unknown }>;
      content?: unknown[];
      error?: unknown;
      usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    if (body.error || (anthropic ? !Array.isArray(body.content) : !body.choices?.[0]?.message)) {
      return { ok: false, reason: "endpoint did not return a valid model completion" };
    }
    if (body.usage) {
      const prompt = body.usage.prompt_tokens ?? body.usage.input_tokens ?? 0;
      const completion = body.usage.completion_tokens ?? body.usage.output_tokens ?? 0;
      options.onUsage?.({ prompt, completion, total: prompt + completion });
    }
    return { ok: true, reason: "" };
  } catch {
    if (options.signal?.aborted) throw new Error("Pro availability check was cancelled");
    return { ok: false, reason: controller.signal.aborted ? "availability request timed out" : "availability request failed" };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", relay);
  }
}

/**
 * Resolve each job independently, descending only within that job. Neither the
 * shared catalogue nor the Pro presets are edited by a temporary replacement.
 */
export async function resolveProTeam(presetName: string, options: ProPreflightOptions = {}): Promise<ProPreflightResult> {
  const presets = loadProModels().tier;
  const selected = presets.find((preset) => preset.name === presetName);
  if (!selected) throw new Error("Unknown Pro preset");
  const catalog = loadModels();
  const ranked = presets.filter((preset) => preset.name !== "custom" && preset.name !== "auto");
  const selectedIndex = ranked.findIndex((preset) => preset.name === selected.name);
  // Custom/auto entries define their own team rather than a quality rank.
  const candidates = selectedIndex < 0 ? [selected] : ranked.slice(0, selectedIndex + 1).reverse();
  const cache = new Map<string, Promise<ProbeResult>>();
  const outcomes = await Promise.all(ACTIVE_PRO_ROLES.map(async (role) => {
    const failures: string[] = [];
    const requested = reference(selected, selected["model-setting"].find((entry) => entry.type === role));
    for (const preset of candidates) {
      if (options.signal?.aborted) throw new Error("Pro availability check was cancelled");
      const lookup = resolveSetting(role, preset, catalog);
      if ("reason" in lookup) {
        failures.push(`${preset.name}: ${lookup.reason}`);
        continue;
      }
      const resolved = lookup.resolved;
      const key = JSON.stringify([resolved.provider, resolved.model.name, resolved.intensity]);
      let pending = cache.get(key);
      if (!pending) {
        pending = probe(resolved, options);
        cache.set(key, pending);
      }
      const result = await pending;
      if (!result.ok) {
        failures.push(`${preset.name}: ${result.reason}`);
        continue;
      }
      return {
        role, resolved,
        fallback: failures.length ? {
          role, requested, replacement: { provider: resolved.provider, model: resolved.model.name, tier: resolved.tier },
          reason: failures.join("; "),
        } satisfies ProFallback : null,
      };
    }
    return { role, resolved: null, fallback: { role, requested, replacement: null, reason: failures.join("; ") } satisfies ProFallback };
  }));
  const models: Partial<Record<ProRole, ProResolvedModel>> = {};
  const fallbacks: ProFallback[] = [];
  for (const outcome of outcomes) {
    if (outcome.resolved) models[outcome.role] = outcome.resolved;
    if (outcome.fallback) fallbacks.push(outcome.fallback);
  }
  const unavailable = outcomes.filter((outcome) => !outcome.resolved).map((outcome) => outcome.role);
  if (unavailable.length) {
    throw new ProPreflightError(`No available Pro model for: ${unavailable.join(", ")}`, fallbacks);
  }
  return { models, fallbacks };
}
