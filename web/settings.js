// Settings and model controls share the same server-side catalog. No API keys
// are returned to this controller or kept in browser storage.
export function createSettingsUI({ apiFetch, applyModel }) {
  const ids = ["model-picker", "model-provider", "model-name", "model-intensity", "model-apply", "model-feedback",
    "settings-open", "settings-dialog", "settings-form", "settings-close", "settings-cancel", "settings-save", "settings-feedback",
    "default-provider", "default-model", "default-intensity", "settings-context", "settings-compress-note", "settings-reviewer", "settings-extreme", "settings-sound", "settings-password", "settings-password-confirm"];
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
      value: model.name, label: model.name + (model.configured ? "" : " (API key missing)"),
    })), selected);
  }
  function intensities(select, selected) {
    options(select, config.intensities.map(value => ({ value, label: value })), selected);
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
    el["model-apply"].textContent = applying ? "Applying…" : target?.startsWith("file:") ? "Continue with model" : "Apply to conversation";
    message(el["model-feedback"], feedback || (busy ? "Pause the current turn to change models." : "Applies to the next turn."), feedbackError);
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
      if (target === originalTarget) { dirty = false; feedback = "Model and intensity updated."; feedbackError = false; }
    } catch (error) {
      if (target === originalTarget) { feedback = error.message; feedbackError = true; }
    } finally {
      applying = false;
      renderPicker();
    }
  });

  function renderSettings() {
    el["settings-password"].value = "";
    el["settings-password-confirm"].value = "";
    providers(el["default-provider"], config.selection.provider);
    models(el["default-provider"], el["default-model"], config.selection.model);
    intensities(el["default-intensity"], config.selection.intensity);
    renderContextWindow();
    const reviewers = [...new Set(config.providers.flatMap(provider => provider.models.map(model => model.name)))];
    options(el["settings-reviewer"], [{ value: "", label: "Same as conversation" }, ...reviewers.map(value => ({ value, label: value }))], config.settings.approval_model);
    el["settings-extreme"].checked = config.settings.auto_approve_extreme_risk;
    el["settings-sound"].checked = config.settings.sound_alerts !== false;
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
      ? `Auto-compress at 80%: ${Math.max(1, Math.floor(tokens * 0.8)).toLocaleString("en-US")} tokens. Applies to this model in all conversations.`
      : "Enter a positive whole number of tokens. Default: 1,000,000.";
  }
  el["settings-context"].addEventListener("input", renderCompressionNote);
  el["default-model"].addEventListener("change", () => { if (config) renderContextWindow(); });
  el["settings-open"].addEventListener("click", async () => {
    if (!el["settings-dialog"].open) el["settings-dialog"].showModal();
    el["settings-save"].disabled = true;
    message(el["settings-feedback"], "Loading…");
    try {
      await load();
      renderSettings();
      message(el["settings-feedback"], "Defaults apply to new conversations. Other settings apply to future turns.");
      el["settings-save"].disabled = false;
    } catch (error) { message(el["settings-feedback"], error.message, true); }
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
      message(el["settings-feedback"], "Passwords do not match.", true);
      return;
    }
    if (password && !password.trim()) {
      message(el["settings-feedback"], "Password cannot be blank.", true);
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
    };
    if (password) settings.web_password = password;
    try {
      config = await json("/api/settings", { ...(selection.provider && selection.model ? { selection } : {}), settings });
      renderPicker();
      el["settings-password"].value = "";
      el["settings-password-confirm"].value = "";
      message(el["settings-feedback"], password ? "Settings saved. Web password updated permanently." : "Settings saved.");
    } catch (error) { message(el["settings-feedback"], error.message, true); }
    finally { el["settings-save"].disabled = false; }
  });
  // Read by the sound cues in app.js. Until the settings land, the feature is
  // on, matching the server-side default.
  const soundAlerts = () => config?.settings?.sound_alerts !== false;
  return { load, showConversation, clear, soundAlerts, selectionForFile: id => target === `file:${id}` && dirty ? choice() : undefined };
}
