// Settings and model controls share the same server-side catalog. No API keys
// are returned to this controller or kept in browser storage.
import { t, getLanguage } from "./i18n.js";

export function createSettingsUI({ apiFetch, applyModel, onLanguageChange, proMode = false, onCatalogChange }) {
  const ids = ["model-picker", "model-picker-summary", "model-picker-label", "model-provider", "model-name", "model-intensity",
    "model-intensity-label", "model-intensity-slider", "model-intensity-stops", "model-intensity-ticks", "model-feedback",
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
  let draftIntensity = "";
  let applying = null;
  let generation = 0;
  let failure = null;
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
  function unavailableOption(select, value) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = `${value} ${t("(unavailable)")}`;
    option.disabled = true;
    select.appendChild(option);
    select.value = value;
  }
  function choice() {
    return { provider: el["model-provider"].value, model: el["model-name"].value, intensity: draftIntensity };
  }
  function renderPicker() {
    el["model-picker"].classList.toggle("hidden", proMode || !config || !conversation);
    if (proMode || !config || !conversation) return;
    if (!dirty) {
      providers(el["model-provider"], conversation.provider || config.selection?.provider);
      if (conversation.provider && !config.providers.some(entry => entry.name === conversation.provider)) {
        unavailableOption(el["model-provider"], conversation.provider);
      }
      models(el["model-provider"], el["model-name"], conversation.model || config.selection?.model);
      if (conversation.model && !modelEntry(el["model-provider"].value, conversation.model)) {
        unavailableOption(el["model-name"], conversation.model);
      }
      draftIntensity = pickIntensity(el["model-provider"].value, el["model-name"].value,
        conversation.intensity || config.selection?.intensity);
    } else {
      // Keep a draft across live snapshots, while honoring the chosen model's limits.
      draftIntensity = pickIntensity(el["model-provider"].value, el["model-name"].value, draftIntensity);
    }
    const selection = choice();
    const displayed = dirty || target?.startsWith("new:") ? selection : {
      model: conversation.model || selection.model,
      intensity: conversation.intensity || selection.intensity,
    };
    el["model-picker-label"].textContent = [displayed.model, displayed.intensity && t(displayed.intensity)]
      .filter(Boolean).join(" · ") || t("Choose a model");
    const summary = t("Conversation model: {selection}", { selection: el["model-picker-label"].textContent });
    el["model-picker-summary"].setAttribute("aria-label", summary);
    el["model-picker-summary"].title = summary;
    el["model-intensity-label"].textContent = selection.intensity ? t(selection.intensity) : "";

    const levels = modelEntry(selection.provider, selection.model) ? intensitiesFor(selection.provider, selection.model) : [];
    const index = Math.max(0, levels.indexOf(selection.intensity));
    const last = Math.max(0, levels.length - 1);
    const busy = Boolean(conversation.busy || conversation.approval);
    const locked = busy || Boolean(applying && applying.generation === generation);
    const slider = el["model-intensity-slider"];
    slider.setAttribute("style", `--pro-slider-position: ${last ? index / last : 0}`);
    slider.classList.toggle("is-disabled", locked || !levels.length);
    el["model-picker"].classList.toggle("is-max", last > 0 && index === last);
    el["model-provider"].disabled = locked;
    el["model-name"].disabled = locked || !selection.provider;
    el["model-intensity"].disabled = locked || !levels.length;
    el["model-intensity"].max = String(last);
    el["model-intensity"].value = String(index);
    el["model-intensity"].setAttribute("aria-valuetext", selection.intensity ? t(selection.intensity) : "");

    const stops = el["model-intensity-stops"];
    const ticks = el["model-intensity-ticks"];
    stops.replaceChildren();
    ticks.replaceChildren();
    levels.forEach((level, levelIndex) => {
      const position = last ? levelIndex / last * 100 : 0;
      const stop = document.createElement("span");
      stop.className = "pro-slider-stop";
      stop.setAttribute("style", `left: ${position}%`);
      stop.classList.toggle("is-filled", levelIndex <= index);
      stops.appendChild(stop);
      const tick = document.createElement("button");
      tick.type = "button";
      tick.textContent = t(level);
      tick.disabled = locked;
      tick.setAttribute("style", `left: ${position}%`);
      tick.setAttribute("aria-pressed", String(level === selection.intensity));
      tick.addEventListener("click", () => {
        if (tick.disabled) return;
        draftIntensity = level;
        changeChoice();
      });
      ticks.appendChild(tick);
    });
    const status = busy ? t("Pause the current turn to change models.")
      : feedback || (locked ? t("Applying…") : t("Applies to the next turn."));
    message(el["model-feedback"], status, !busy && feedbackError);
  }
  async function load() {
    config = await json("/api/settings");
    onCatalogChange?.(config);
    renderPicker();
    return config;
  }
  function showConversation(info, key) {
    if (target !== key) {
      generation++;
      dirty = false;
      failure = null;
      feedback = "";
      feedbackError = false;
      el["model-picker"].open = false;
    }
    target = key;
    conversation = info;
    // A turn may start elsewhere while the slider is being dragged. Discard
    // that uncommitted preview so it cannot masquerade as the active setting.
    if (target?.startsWith("live:") && dirty && (info?.busy || info?.approval) && applying?.generation !== generation) {
      dirty = false;
      feedback = "";
      feedbackError = false;
    }
    renderPicker();
  }
  function clear() {
    generation++;
    target = null;
    conversation = null;
    dirty = false;
    failure = null;
    feedback = "";
    el["model-picker"].open = false;
    renderPicker();
  }
  function changeChoice() {
    if (!config || !conversation || conversation.busy || conversation.approval || applying?.generation === generation) return;
    dirty = true;
    failure = null;
    feedback = "";
    feedbackError = false;
    renderPicker();
    // Saved and not-yet-created conversations keep the choice as a local draft.
    if (!target?.startsWith("live:")) return;
    const selection = choice();
    if (!selection.provider || !modelEntry(selection.provider, selection.model) || !selection.intensity) return;
    if (selection.provider === conversation.provider && selection.model === conversation.model && selection.intensity === conversation.intensity) {
      dirty = false;
      renderPicker();
      return;
    }
    const request = { generation, promise: null };
    applying = request;
    renderPicker();
    request.promise = (async () => {
      try {
        await applyModel(selection);
        if (request.generation !== generation) return;
        conversation = { ...conversation, ...selection };
        dirty = false;
        feedback = t("Model and intensity updated.");
      } catch (error) {
        if (request.generation !== generation) return;
        dirty = false;
        failure = error;
        feedback = t(error.message);
        feedbackError = true;
      } finally {
        if (applying === request) applying = null;
        renderPicker();
      }
    })();
  }
  el["model-provider"].addEventListener("change", () => {
    if (!config) return;
    const provider = config.providers.find(entry => entry.name === el["model-provider"].value);
    models(el["model-provider"], el["model-name"], provider?.models.find(model => model.configured)?.name);
    changeChoice();
  });
  el["model-name"].addEventListener("change", changeChoice);
  el["model-intensity"].addEventListener("input", () => {
    if (!config || !conversation || conversation.busy || conversation.approval || applying?.generation === generation) return;
    const levels = intensitiesFor(el["model-provider"].value, el["model-name"].value);
    draftIntensity = levels[Number(el["model-intensity"].value)] || draftIntensity;
    dirty = true;
    failure = null;
    feedback = "";
    feedbackError = false;
    renderPicker();
  });
  el["model-intensity"].addEventListener("change", changeChoice);
  el["model-picker"].addEventListener("keydown", event => {
    if (event.key === "Escape") { el["model-picker"].open = false; event.stopPropagation(); }
  });
  document.addEventListener?.("pointerdown", event => {
    if (el["model-picker"].open && !el["model-picker"].contains(event.target)) el["model-picker"].open = false;
  });
  async function flush() {
    // A keyboard send can happen before a range input emits its change event.
    if (dirty && target?.startsWith("live:") && applying?.generation !== generation) changeChoice();
    const request = applying;
    const currentGeneration = generation;
    if (request?.generation === currentGeneration) await request.promise;
    if (currentGeneration === generation && failure) {
      const error = failure;
      failure = null;
      throw error;
    }
  }

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
    flush,
    catalog: () => config,
    defaultSelection: () => (config ? (target?.startsWith("new:") && dirty ? choice() : {
      provider: config.selection.provider,
      model: config.selection.model,
      intensity: config.selection.intensity,
    }) : undefined),
    selectionForFile: id => target === `file:${id}` && dirty ? choice() : undefined,
  };
}
