import {
  DEFAULT_CONFIG, INTENSITY_LEVELS, WEB_LANGUAGES, contextWindow, intensityForModel, isContextWindow,
  loadConfig, loadModels, modelContextWindow, modelContextWindowKey, modelIntensities, normalizeApprovalMode,
  normalizeIntensity, normalizeWebLanguage, resolveModelSelection, saveConfig, saveModels,
  type Mode, type ResolvedModelSelection,
} from "../config.js";

import { hashWebPassword, validateWebPassword } from "./auth.js";
import { defaultProPreset, loadProModels, proMaxRecursionDepth, requireProPreset } from "../pro/config.js";

/**
 * Public settings use a whitelist: API keys and cached credentials stay on disk.
 *
 * `mode` selects the workspace. The Pro workspace has its own defaults,
 * language, plan and reviewer settings; the login password and the approval
 * policy are layered in from the shared config by loadConfig(), so the two
 * pages cannot drift apart on those.
 */
export function getWebSettings(mode: Mode = "standard") {
  const config = { ...DEFAULT_CONFIG, ...loadConfig(mode) };
  const catalog = loadModels();
  const providers = catalog.providers.map((provider) => ({
    name: provider.name,
    models: provider.models.map((model) => ({
      name: model.name,
      configured: Boolean(model.api_key?.trim()),
      context_window: modelContextWindow(provider.name, model, mode),
      // The browser only offers these, so it cannot submit a level the model
      // does not declare. Missing field = every intensity.
      intensities: modelIntensities(model),
    })),
  }));
  const preferred = providers.find((p) => p.name === config.selected_provider);
  const provider = preferred ?? providers.find((p) => p.models.some((m) => m.configured)) ?? providers[0];
  const model = provider?.models.find((m) => m.name === config.selected_model) ??
    provider?.models.find((m) => m.configured) ?? provider?.models[0];
  const configuredModel = provider && model
    ? catalog.providers.find((p) => p.name === provider.name)?.models.find((m) => m.name === model.name) ?? null
    : null;
  const intensity = intensityForModel(
    configuredModel,
    config.selected_intensity ?? config.default_intensity,
    config.default_intensity,
  );
  return {
    ...(mode === "pro" ? { pro: {
      presets: loadProModels().tier.map((preset) => ({
        name: preset.name, chinese_name: preset.chinese_name,
        "model-setting": preset["model-setting"].map((setting) => ({
          type: setting.type, provider: setting.provider, model: setting.model,
          intensity: setting.intensity, context_window: setting.context_window,
        })),
      })),
      preset: defaultProPreset(),
      max_recursion_depth: proMaxRecursionDepth(),
    } } : {}),
    providers,
    intensities: INTENSITY_LEVELS,
    languages: WEB_LANGUAGES.map((value) => ({ value, label: value === "zh" ? "简体中文" : "English" })),
    selection: {
      provider: provider?.name ?? "",
      model: model?.name ?? "",
      intensity,
    },
    settings: {
      default_intensity: intensityForModel(configuredModel, config.default_intensity, "High"),
      model_context_window: model?.context_window ?? contextWindow(undefined),
      approval_model: String(config.approval_model ?? ""),
      auto_approve_extreme_risk: config.auto_approve_extreme_risk === true,
      sound_alerts: config.sound_alerts !== false,
      language: normalizeWebLanguage(config.language),
      plan_first: config.plan_first !== false,
      approval_mode: normalizeApprovalMode(config.approval_mode),
      web_console: config.web_console !== false,
      web_lan: config.web_lan === true,
    },
  };
}

/** Validate the complete patch before writing anything, preserving unrelated settings. */
export function updateWebSettings(value: unknown, mode: Mode = "standard"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid settings body");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "selection" && key !== "settings")) throw new Error("unknown settings field");
  const config = loadConfig(mode);
  // Resolve the requested model first: its declared intensities decide which
  // default level can be saved with this patch. Settings that do not touch a
  // model stay editable even when the catalogue is empty.
  const chosen = body.selection !== undefined ? resolveModelSelection(body.selection, false) : undefined;
  let target: ResolvedModelSelection | null = chosen ?? null;
  const settingsTarget = (): ResolvedModelSelection => {
    target ??= resolveModelSelection(getWebSettings(mode).selection, false);
    return target;
  };
  if (body.settings !== undefined) {
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new Error("invalid settings");
    const patch = body.settings as Record<string, unknown>;
    for (const [key, val] of Object.entries(patch)) {
      if (key === "pro_preset" && mode === "pro") {
        config.pro_preset = requireProPreset(val);
      } else if (key === "pro_max_recursion_depth" && mode === "pro") {
        if (typeof val !== "number" || !Number.isSafeInteger(val) || val < 1 || val > 100) {
          throw new Error("Pro recursion depth must be a whole number from 1 to 100");
        }
        config.pro_max_recursion_depth = val;
      } else if (key === "default_intensity") {
        const level = normalizeIntensity(val);
        if (!level) throw new Error("invalid default intensity");
        if (!modelIntensities(settingsTarget().model).includes(level)) throw new Error("this model does not support that thinking intensity");
        config.default_intensity = level;
        config.selected_intensity = level;
      } else if (key === "model_context_window") {
        if (!isContextWindow(val)) throw new Error("invalid model context window");
      } else if (key === "approval_model") {
        if (typeof val !== "string" || (val && !loadModels().providers.some((p) => p.models.some((m) => m.name === val)))) throw new Error("unknown approval model");
        config[key] = val;
      } else if (key === "sound_alerts") {
        if (typeof val !== "boolean") throw new Error("sound alerts must be a boolean");
        config[key] = val;
      } else if (key === "auto_approve_extreme_risk") {
        if (typeof val !== "boolean") throw new Error("auto-approval must be a boolean");
        config[key] = val;
      } else if (key === "language") {
        if (typeof val !== "string" || !WEB_LANGUAGES.includes(val as (typeof WEB_LANGUAGES)[number])) {
          throw new Error("invalid language");
        }
        config.language = val;
      } else if (key === "plan_first") {
        if (typeof val !== "boolean") throw new Error("invalid plan setting");
        config.plan_first = val;
      } else if (key === "approval_mode") {
        if (val !== "request" && val !== "auto") throw new Error("invalid approval mode");
        config.approval_mode = val;
      } else if (key === "web_console") {
        if (typeof val !== "boolean") throw new Error("web console must be a boolean");
        config.web_console = val;
      } else if (key === "web_lan") {
        if (typeof val !== "boolean") throw new Error("LAN access must be a boolean");
        config.web_lan = val;
      } else if (key === "web_password") {
        validateWebPassword(val);
      } else {
        throw new Error("unknown settings field");
      }
    }
  }
  if (chosen) {
    config.selected_provider = chosen.provider;
    config.selected_model = chosen.model.name;
    config.selected_model_url = chosen.model.url;
    config.selected_model_api_key = chosen.model.api_key;
    config.selected_model_streaming = chosen.model.supports_streaming;
    config.selected_intensity = chosen.intensity;
    config.default_intensity = chosen.intensity;
  }
  const password = (body.settings as Record<string, unknown> | undefined)?.web_password;
  if (password !== undefined) config.web_password_hash = hashWebPassword(password);
  const window = (body.settings as Record<string, unknown> | undefined)?.model_context_window;
  if (window !== undefined) {
    const selected = settingsTarget();
    if (mode === "pro") {
      // Context capacity is part of a workspace's compression settings. Pro
      // stores its own copy instead of editing the shared model catalog.
      const current = config.model_context_windows;
      const overrides = current && typeof current === "object" && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
      overrides[modelContextWindowKey(selected.provider, selected.model.name)] = window;
      config.model_context_windows = overrides;
    } else {
      const models = loadModels();
      const model = models.providers.find((p) => p.name === selected.provider)!.models.find((m) => m.name === selected.model.name)!;
      model.context_window = window as number;
      saveModels(models);
    }
  }
  saveConfig(config, mode);
}
