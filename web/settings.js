// Settings and model controls share the same server-side catalog. No API keys
// are returned to this controller or kept in browser storage.
import { t, getLanguage } from "./i18n.js";

export function createSettingsUI({ apiFetch, applyModel, onLanguageChange, proMode = false, onCatalogChange }) {
  const ids = ["model-picker", "model-provider", "model-name", "model-intensity", "model-apply", "model-feedback",
    "settings-open", "settings-dialog", "settings-form", "settings-close", "settings-cancel", "settings-save", "settings-feedback",
    "default-provider", "default-model", "default-intensity", "settings-context", "settings-compress-note", "settings-reviewer",
    "settings-extreme", "settings-sound", "settings-password", "settings-password-confirm",
    "settings-language", "settings-plan", "settings-approval", "settings-web-console", "settings-web-lan", "settings-background",
    "settings-pro", "settings-pro-preset", "settings-pro-depth"];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  let config = null;
  let target = null;
  let conversation = null;
  let dirty = false;
  let applying = false;
  let feedback = "";
  let feedbackError = false;
  // Value the LAN switch had when the dialog opened. Only an actual flip is
  // saved, so editing another setting never pins an interface that came from
  // --lan/--host on the command line.
  let lanInitial = false;
  // Same idea for background residency: the dialog must not overwrite a value
  // changed from the terminal while it was open.
  let backgroundInitial = false;
  let backgroundChanging = false;

  async function json(path, body) {
    const response = await apiFetch(path, body === undefined ? { cache: "no-store" } : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  function message(node, text, error = false) {
    node.textContent = text;
    node.classList.toggle("error", error);
  }
  function options(select, values, selected) {
    select.replaceChildren();
    for (const entry of values) {
      const option = document.createElement("option");
      option.value = entry.value;
      option.textContent = entry.label;
      select.appendChild(option);
    }
    select.value = values.some(entry => entry.value === selected) ? selected : values[0]?.value ?? "";
  }
  function providers(select, selected) {
    options(select, config.providers.map(provider => ({ value: provider.name, label: provider.name })), selected);
  }
  function models(providerSelect, modelSelect, selected) {
    const provider = config.providers.find(entry => entry.name === providerSelect.value);
    options(modelSelect, (provider?.models ?? []).map(model => ({
      value: model.name, label: model.name + (model.configured ? "" : ` ${t("(API key missing)")}`),
    })), selected);
  }
  function intensities(select, selected, providerName, modelName) {
    options(select, intensitiesFor(providerName, modelName).map(value => ({ value, label: value })),
      pickIntensity(providerName, modelName, selected));
  }
  function modelEntry(providerName, modelName) {
    const provider = config?.providers.find(entry => entry.name === providerName);
    return provider?.models.find(entry => entry.name === modelName);
  }
  // Servers that do not know per-model limits omit the list; offer every level.
  function intensitiesFor(providerName, modelName) {
    const model = modelEntry(providerName, modelName);
    return Array.isArray(model?.intensities) && model.intensities.length ? model.intensities : config?.intensities ?? [];
  }
  /** Keep the current level when the model accepts it, else its fallback. */
  function pickIntensity(providerName, modelName, selected) {
    const levels = intensitiesFor(providerName, modelName);
    if (levels.includes(selected)) return selected;
    const fallback = config?.settings?.default_intensity;
    if (levels.includes(fallback)) return fallback;
    if (levels.includes("High")) return "High";
    return levels[0] ?? "";
  }
  function reviewerOptions(selected) {
    const reviewers = [...new Set(config.providers.flatMap(provider => provider.models.map(model => model.name)))];
    options(el["settings-reviewer"], [{ value: "", label: t("Same as conversation") }, ...reviewers.map(value => ({ value, label: value }))], selected);
  }
  function proPresets(selected) {
    options(el["settings-pro-preset"], (config.pro?.presets || []).map(preset => ({
      value: preset.name, label: getLanguage() === "zh" ? preset.chinese_name || preset.name : preset.name,
    })), selected);
  }
  function choice() {
    return { provider: el["model-provider"].value, model: el["model-name"].value, intensity: el["model-intensity"].value };
  }
  function renderPicker() {
    el["model-picker"].classList.toggle("hidden", proMode || !config || !conversation);
    if (proMode || !config || !conversation) return;
    if (!dirty) {
      providers(el["model-provider"], conversation.provider);
      models(el["model-provider"], el["model-name"], conversation.model);
      intensities(el["model-intensity"], conversation.intensity, conversation.provider, conversation.model);
    } else {
      // A provider/model change narrows the intensity list even though the rest
      // of the draft must survive the next server snapshot.
      intensities(el["model-intensity"], el["model-intensity"].value,
        el["model-provider"].value, el["model-name"].value);
    }
    const busy = Boolean(conversation.busy || conversation.approval);
    el["model-apply"].disabled = applying || busy || !choice().provider || !choice().model;
    el["model-apply"].textContent = applying
      ? t("Applying…")
      : target?.startsWith("file:") ? t("Continue with model") : t("Apply to conversation");
    message(
      el["model-feedback"],
      feedback || (busy ? t("Pause the current turn to change models.") : t("Applies to the next turn.")),
      feedbackError,
    );
  }
  async function load() {
    config = await json("/api/settings");
    onCatalogChange?.(config);
    renderPicker();
    return config;
  }
  function showConversation(info, key) {
    if (target !== key) { dirty = false; feedback = ""; feedbackError = false; }
    target = key;
    conversation = info;
    renderPicker();
  }
  function clear() {
    target = null;
    conversation = null;
    dirty = false;
    feedback = "";
    renderPicker();
  }
  el["model-provider"].addEventListener("change", () => {
    if (!config) return;
    models(el["model-provider"], el["model-name"]);
    dirty = true; feedback = ""; feedbackError = false;
    renderPicker();
  });
  for (const id of ["model-name", "model-intensity"]) {
    el[id].addEventListener("change", () => { dirty = true; feedback = ""; feedbackError = false; renderPicker(); });
  }
  el["model-picker"].addEventListener("submit", async event => {
    event.preventDefault();
    if (el["model-apply"].disabled) return;
    const originalTarget = target;
    applying = true;
    feedback = "";
    renderPicker();
    try {
      await applyModel(choice());
      if (target === originalTarget) { dirty = false; feedback = t("Model and intensity updated."); feedbackError = false; }
    } catch (error) {
      if (target === originalTarget) { feedback = t(error.message); feedbackError = true; }
    } finally {
      applying = false;
      renderPicker();
    }
  });

  function renderSettings() {
    el["settings-password"].value = "";
    el["settings-password-confirm"].value = "";
    el["settings-language"].value = config.settings.language === "zh" ? "zh" : "en";
    el["settings-plan"].checked = config.settings.plan_first !== false;
    el["settings-approval"].value = config.settings.approval_mode === "auto" ? "auto" : "request";
    providers(el["default-provider"], config.selection.provider);
    models(el["default-provider"], el["default-model"], config.selection.model);
    intensities(el["default-intensity"], config.selection.intensity,
      el["default-provider"].value, el["default-model"].value);
    renderContextWindow();
    reviewerOptions(config.settings.approval_model);
    if (proMode && el["settings-pro"]) {
      el["settings-pro"].classList.remove("hidden");
      proPresets(config.pro?.preset);
      el["settings-pro-depth"].value = String(config.pro?.max_recursion_depth ?? 10);
    }
    el["settings-extreme"].checked = config.settings.auto_approve_extreme_risk;
    el["settings-sound"].checked = config.settings.sound_alerts !== false;
    el["settings-web-console"].checked = config.settings.web_console !== false;
    el["settings-web-lan"].checked = config.settings.web_lan === true;
    el["settings-background"].checked = config.settings.background_running === true;
    backgroundInitial = el["settings-background"].checked;
    lanInitial = el["settings-web-lan"].checked;
  }
  el["settings-background"].addEventListener("change", async () => {
    if (!config || backgroundChanging) return;
    const enabled = el["settings-background"].checked;
    backgroundChanging = true;
    el["settings-background"].disabled = true;
    el["settings-save"].disabled = true;
    message(el["settings-feedback"], t("Applying…"));
    try {
      const updated = await json("/api/settings", { settings: { background: enabled } });
      if (updated.settings.background_running !== enabled) {
        throw new Error(t("Background residency could not be applied. Restart the console and try again."));
      }
      config = updated;
      backgroundInitial = config.settings.background_running === true;
      el["settings-background"].checked = backgroundInitial;
      onCatalogChange?.(config);
      message(el["settings-feedback"], t(enabled
        ? "Background residency is on. Browser tasks keep running after the terminal closes."
        : "Background residency is off. Current tasks can finish before the console closes."));
    } catch (error) {
      // A response can be lost after the service applied the change. Ask the
      // service for its actual state before putting the switch back.
      try {
        config = await json("/api/settings");
        backgroundInitial = config.settings.background_running === true;
      } catch { /* Keep the last confirmed value and show the error. */ }
      el["settings-background"].checked = backgroundInitial;
      message(el["settings-feedback"], t(error.message), true);
    } finally {
      backgroundChanging = false;
      el["settings-background"].disabled = false;
      el["settings-save"].disabled = false;
    }
  });

  function renderContextWindow() {
    const provider = config.providers.find(entry => entry.name === el["default-provider"].value);
    const model = provider?.models.find(entry => entry.name === el["default-model"].value);
    el["settings-context"].disabled = proMode || !model;
    el["settings-context"].value = String(model?.context_window ?? 1_000_000);
    renderCompressionNote();
  }
  function renderCompressionNote() {
    const tokens = Number(el["settings-context"].value);
    el["settings-compress-note"].textContent = Number.isSafeInteger(tokens) && tokens > 0
      ? t("Auto-compress at 80%: {tokens} tokens. Applies to this model in all conversations.", {
        tokens: Math.max(1, Math.floor(tokens * 0.8)).toLocaleString("en-US"),
      })
      : t("Enter a positive whole number of tokens. Default: 1,000,000.");
  }
  /** Repaint option labels after a language switch without losing form edits. */
  function refreshTexts() {
    if (!config) return;
    providers(el["model-provider"], el["model-provider"].value);
    models(el["model-provider"], el["model-name"], el["model-name"].value);
    intensities(el["model-intensity"], el["model-intensity"].value,
      el["model-provider"].value, el["model-name"].value);
    if (el["settings-dialog"].open) {
      providers(el["default-provider"], el["default-provider"].value);
      models(el["default-provider"], el["default-model"], el["default-model"].value);
      intensities(el["default-intensity"], el["default-intensity"].value,
        el["default-provider"].value, el["default-model"].value);
      reviewerOptions(el["settings-reviewer"].value);
      renderCompressionNote();
      if (proMode) proPresets(el["settings-pro-preset"].value);
    }
    renderPicker();
  }
  el["settings-context"].addEventListener("input", renderCompressionNote);
  el["default-model"].addEventListener("change", () => {
    if (!config) return;
    intensities(el["default-intensity"], el["default-intensity"].value,
      el["default-provider"].value, el["default-model"].value);
    renderContextWindow();
  });
  el["settings-language"].addEventListener("change", () => {
    if (typeof onLanguageChange === "function") onLanguageChange(el["settings-language"].value);
  });
  el["settings-open"].addEventListener("click", async () => {
    if (!el["settings-dialog"].open) el["settings-dialog"].showModal();
    el["settings-save"].disabled = true;
    message(el["settings-feedback"], t("Loading…"));
    try {
      await load();
      renderSettings();
      message(el["settings-feedback"], t("Defaults apply to new conversations. Other settings apply to future turns."));
      el["settings-save"].disabled = false;
    } catch (error) { message(el["settings-feedback"], t(error.message), true); }
  });
  for (const id of ["settings-close", "settings-cancel"]) {
    el[id].addEventListener("click", () => el["settings-dialog"].close());
  }
  el["default-provider"].addEventListener("change", () => {
    if (config) {
      models(el["default-provider"], el["default-model"]);
      intensities(el["default-intensity"], el["default-intensity"].value,
        el["default-provider"].value, el["default-model"].value);
      renderContextWindow();
    }
  });
  el["settings-form"].addEventListener("submit", async event => {
    event.preventDefault();
    if (el["settings-save"].disabled) return;
    const password = el["settings-password"].value;
    if (password !== el["settings-password-confirm"].value) {
      message(el["settings-feedback"], t("Passwords do not match."), true);
      return;
    }
    if (password && !password.trim()) {
      message(el["settings-feedback"], t("Password cannot be blank."), true);
      return;
    }
    el["settings-save"].disabled = true;
    const wasLan = config?.settings?.web_lan === true;
    const lanChanged = el["settings-web-lan"].checked !== lanInitial;
    const backgroundChanged = el["settings-background"].checked !== backgroundInitial;
    const selection = { provider: el["default-provider"].value, model: el["default-model"].value, intensity: el["default-intensity"].value };
    const settings = {
      ...(!proMode ? {
        default_intensity: selection.intensity,
        ...(!el["settings-context"].disabled ? { model_context_window: Number(el["settings-context"].value) } : {}),
        approval_model: el["settings-reviewer"].value,
        plan_first: el["settings-plan"].checked,
      } : {
        pro_preset: el["settings-pro-preset"].value,
        pro_max_recursion_depth: Number(el["settings-pro-depth"].value),
      }),
      auto_approve_extreme_risk: el["settings-extreme"].checked,
      sound_alerts: el["settings-sound"].checked,
      web_console: el["settings-web-console"].checked,
      ...(lanChanged ? { web_lan: el["settings-web-lan"].checked } : {}),
      ...(backgroundChanged ? { background: el["settings-background"].checked } : {}),
      language: el["settings-language"].value,
      approval_mode: el["settings-approval"].value,
    };
    if (password) settings.web_password = password;
    try {
      config = await json("/api/settings", { ...(!proMode && selection.provider && selection.model ? { selection } : {}), settings });
      onCatalogChange?.(config);
      renderPicker();
      el["settings-password"].value = "";
      el["settings-password-confirm"].value = "";
      // The switch takes effect on the live socket, so report exactly what the
      // server bound and (when available) the address to open elsewhere.
      el["settings-web-lan"].checked = config.settings.web_lan === true;
      lanInitial = el["settings-web-lan"].checked;
      el["settings-background"].checked = config.settings.background_running === true;
      backgroundInitial = el["settings-background"].checked;
      const urls = Array.isArray(config.settings.web_urls) ? config.settings.web_urls : [];
      const lanNote = config.settings.web_lan === wasLan ? "" : config.settings.web_lan
        ? urls.length
          ? t("LAN access is on. Open {urls} from another device.", { urls: urls.join(" · ") })
          : t("LAN access is on, but no network address was found. Only this machine can connect.")
        : t("LAN access is off. Only this machine can connect.");
      const backgroundNote = !backgroundChanged
        ? ""
        : config.settings.background
          ? t("Background residency is on. Browser tasks keep running after the terminal closes.")
          : t("Background residency is off. Current tasks can finish before the console closes.");
      const savedText = password
        ? t("Settings saved. Web password updated permanently.")
        : t("Settings saved.");
      const notes = [lanNote, backgroundNote].filter(Boolean).join(" ");
      message(el["settings-feedback"], notes ? `${savedText} ${notes}` : savedText);
    } catch (error) { message(el["settings-feedback"], t(error.message), true); }
    finally { el["settings-save"].disabled = false; }
  });
  // Read by the sound cues in app.js. Until the settings land, the feature is
  // on, matching the server-side default.
  const soundAlerts = () => config?.settings?.sound_alerts !== false;
  return {
    load,
    showConversation,
    clear,
    soundAlerts,
    refreshTexts,
    catalog: () => config,
    defaultSelection: () => (config ? {
      provider: config.selection.provider,
      model: config.selection.model,
      intensity: config.selection.intensity,
    } : undefined),
    selectionForFile: id => target === `file:${id}` && dirty ? choice() : undefined,
  };
}
