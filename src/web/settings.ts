import {
  DEFAULT_CONFIG, INTENSITY_LEVELS, contextWindow, isContextWindow,
  loadConfig, loadModels, resolveModelSelection, saveConfig, saveModels,
} from "../config.js";

import { hashWebPassword, validateWebPassword } from "./auth.js";

/** Public settings use a whitelist: API keys and cached credentials stay on disk. */
export function getWebSettings() {
  const config = { ...DEFAULT_CONFIG, ...loadConfig() };
  const providers = loadModels().providers.map((provider) => ({
    name: provider.name,
    models: provider.models.map((model) => ({ name: model.name, configured: Boolean(model.api_key?.trim()), context_window: contextWindow(model.context_window) })),
  }));
  const preferred = providers.find((p) => p.name === config.selected_provider);
  const provider = preferred ?? providers.find((p) => p.models.some((m) => m.configured)) ?? providers[0];
  const model = provider?.models.find((m) => m.name === config.selected_model) ??
    provider?.models.find((m) => m.configured) ?? provider?.models[0];
  const intensity = String(config.selected_intensity ?? config.default_intensity);
  return {
    providers,
    intensities: INTENSITY_LEVELS,
    selection: {
      provider: provider?.name ?? "",
      model: model?.name ?? "",
      intensity: INTENSITY_LEVELS.includes(intensity) ? intensity : "High",
    },
    settings: {
      default_intensity: String(config.default_intensity),
      model_context_window: model?.context_window ?? contextWindow(undefined),
      approval_model: String(config.approval_model ?? ""),
      auto_approve_extreme_risk: config.auto_approve_extreme_risk === true,
      sound_alerts: config.sound_alerts !== false,
    },
  };
}

/** Validate the complete patch before writing anything, preserving unrelated settings. */
export function updateWebSettings(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid settings body");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== "selection" && key !== "settings")) throw new Error("unknown settings field");
  const config = loadConfig();
  if (body.settings !== undefined) {
    if (!body.settings || typeof body.settings !== "object" || Array.isArray(body.settings)) throw new Error("invalid settings");
    const patch = body.settings as Record<string, unknown>;
    for (const [key, val] of Object.entries(patch)) {
      if (key === "default_intensity") {
        if (typeof val !== "string" || !INTENSITY_LEVELS.includes(val)) throw new Error("invalid default intensity");
        config.default_intensity = val;
        config.selected_intensity = val;
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
      } else if (key === "web_password") {
        validateWebPassword(val);
      } else {
        throw new Error("unknown settings field");
      }
    }
  }
  if (body.selection !== undefined) {
    const chosen = resolveModelSelection(body.selection, false);
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
    const selection = body.selection ?? getWebSettings().selection;
    const chosen = resolveModelSelection(selection, false);
    const models = loadModels();
    const model = models.providers.find((p) => p.name === chosen.provider)!.models.find((m) => m.name === chosen.model.name)!;
    model.context_window = window as number;
    saveModels(models);
  }
  saveConfig(config);
}
