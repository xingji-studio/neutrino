// Settings and model controls share the same server-side catalog. No API keys
// are returned to this controller or kept in browser storage.
import { t } from "./i18n.js";

export function createSettingsUI({ apiFetch, applyModel, onLanguageChange }) {
  const ids = ["model-picker", "model-provider", "model-name", "model-intensity", "model-apply", "model-feedback",
    "settings-open", "settings-dialog", "settings-form", "settings-close", "settings-cancel", "settings-save", "settings-feedback",
    "default-provider", "default-model", "default-intensity", "settings-context", "settings-compress-note", "settings-reviewer",
    "settings-extreme", "settings-sound", "settings-password", "settings-password-confirm",
    "settings-language", "settings-plan", "settings-approval", "settings-web-console"];
  const el = Object.fromEntries(ids.map(id => [id, document.getElementById(id)]));
  let config = null;
  let target = null;
  let conversation = null;
  let dirty = false;
  let applying = false;
  let feedback = "";
  let feedbackError = false;

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
  function intensities(select, selected) {
    options(select, config.intensities.map(value => ({ value, label: value })), selected);
  }
  function reviewerOptions(selected) {
    const reviewers = [...new Set(config.providers.flatMap(provider => provider.models.map(model => model.name)))];
    options(el["settings-reviewer"], [{ value: "", label: t("Same as conversation") }, ...reviewers.map(value => ({ value, label: value }))], selected);
  }
  function choice() {
    return { provider: el["model-provider"].value, model: el["model-name"].value, intensity: el["model-intensity"].value };
  }
  function renderPicker() {
    el["model-picker"].classList.toggle("hidden", !config || !conversation);
    if (!config || !conversation) return;
    if (!dirty) {
      providers(el["model-provider"], conversation.provider);
      models(el["model-provider"], el["model-name"], conversation.model);
      intensities(el["model-intensity"], conversation.intensity);
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
    intensities(el["default-intensity"], config.selection.intensity);
    renderContextWindow();
    reviewerOptions(config.settings.approval_model);
    el["settings-extreme"].checked = config.settings.auto_approve_extreme_risk;
    el["settings-sound"].checked = config.settings.sound_alerts !== false;
    el["settings-web-console"].checked = config.settings.web_console !== false;
  }
  function renderContextWindow() {
    const provider = config.providers.find(entry => entry.name === el["default-provider"].value);
    const model = provider?.models.find(entry => entry.name === el["default-model"].value);
    el["settings-context"].disabled = !model;
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
    intensities(el["model-intensity"], el["model-intensity"].value);
    if (el["settings-dialog"].open) {
      providers(el["default-provider"], el["default-provider"].value);
      models(el["default-provider"], el["default-model"], el["default-model"].value);
      intensities(el["default-intensity"], el["default-intensity"].value);
      reviewerOptions(el["settings-reviewer"].value);
      renderCompressionNote();
    }
    renderPicker();
  }
  el["settings-context"].addEventListener("input", renderCompressionNote);
  el["default-model"].addEventListener("change", () => { if (config) renderContextWindow(); });
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
    const selection = { provider: el["default-provider"].value, model: el["default-model"].value, intensity: el["default-intensity"].value };
    const settings = {
      default_intensity: selection.intensity,
      ...(!el["settings-context"].disabled ? { model_context_window: Number(el["settings-context"].value) } : {}),
      approval_model: el["settings-reviewer"].value,
      auto_approve_extreme_risk: el["settings-extreme"].checked,
      sound_alerts: el["settings-sound"].checked,
      web_console: el["settings-web-console"].checked,
      language: el["settings-language"].value,
      plan_first: el["settings-plan"].checked,
      approval_mode: el["settings-approval"].value,
    };
    if (password) settings.web_password = password;
    try {
      config = await json("/api/settings", { ...(selection.provider && selection.model ? { selection } : {}), settings });
      renderPicker();
      el["settings-password"].value = "";
      el["settings-password-confirm"].value = "";
      message(el["settings-feedback"], password ? t("Settings saved. Web password updated permanently.") : t("Settings saved."));
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
