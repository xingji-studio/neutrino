import { t, getLanguage } from "./i18n.js";

const ROLES = {
  main_model: "Main model", thinking_model: "Reasoning model",
  front_output_model: "Frontend model", backend_output_model: "Backend model",
  confirm_model: "Approval model", genimage_model: "Image model",
  plan_model: "Planning model", modeling_model: "Modeling model",
};

/** The preset is a conversation choice; effective fallbacks belong to one task. */
export function createProUI({ changePreset }) {
  const control = document.getElementById("pro-preset-control");
  if (!control) return null;
  const label = document.getElementById("pro-preset-label");
  const slider = document.getElementById("pro-preset-slider");
  const stops = document.getElementById("pro-slider-stops");
  const range = document.getElementById("pro-preset-range");
  const name = document.getElementById("pro-preset-name");
  const ticks = document.getElementById("pro-preset-ticks");
  const models = document.getElementById("pro-preset-models");
  const note = document.getElementById("pro-preset-note");
  const feedback = document.getElementById("pro-preset-feedback");
  const fallbackDialog = document.getElementById("pro-fallback-dialog");
  const fallbackRows = document.getElementById("pro-fallback-rows");
  const fallbackError = document.getElementById("pro-fallback-error");
  const seenChecks = new Set();
  let presets = [];
  let selected = "";
  let committed = "";
  let defaultPreset = "";
  let target = null;
  let snapshot = null;
  let applying = false;
  let pending = Promise.resolve();
  let failure = null;
  const title = preset => getLanguage() === "zh" ? preset.chinese_name || preset.name : preset.name;
  const presetFor = value => presets.find(entry => entry.name === value);
  const modelName = value => value == null || value === "null" || value === "" ? t("Reserved") : value;
  const reference = value => value?.provider ? `${value.provider}/${modelName(value.model)}` : modelName(value?.model);

  function render() {
    const preset = presetFor(selected) || presets[0];
    control.classList.toggle("hidden", !preset);
    if (!preset) return;
    selected = preset.name;
    const busy = Boolean(snapshot?.busy || snapshot?.approval || applying);
    label.textContent = `Pro · ${title(preset)}`;
    name.textContent = title(preset);
    const selectedIndex = presets.indexOf(preset);
    const lastIndex = presets.length - 1;
    const position = lastIndex > 0 ? selectedIndex / lastIndex : 0;
    slider.setAttribute("style", `--pro-slider-position: ${position}`);
    slider.classList.toggle("is-disabled", busy);
    control.classList.toggle("is-max", lastIndex > 0 && selectedIndex === lastIndex);
    stops.replaceChildren();
    presets.forEach((_entry, index) => {
      const stop = document.createElement("span");
      stop.className = "pro-slider-stop";
      stop.setAttribute("style", `left: ${lastIndex > 0 ? index / lastIndex * 100 : 0}%`);
      stop.classList.toggle("is-filled", index <= selectedIndex);
      stops.appendChild(stop);
    });
    range.max = String(Math.max(0, presets.length - 1));
    range.value = String(selectedIndex);
    range.disabled = busy;
    range.setAttribute("aria-valuetext", title(preset));
    ticks.replaceChildren();
    presets.forEach((entry, index) => {
      const tick = document.createElement("button");
      tick.type = "button";
      tick.textContent = title(entry);
      tick.disabled = busy;
      tick.setAttribute("style", `left: ${lastIndex > 0 ? index / lastIndex * 100 : 0}%`);
      tick.setAttribute("aria-pressed", String(entry.name === selected));
      tick.addEventListener("click", () => choose(entry.name));
      ticks.appendChild(tick);
    });
    models.replaceChildren();
    for (const role of Object.keys(ROLES)) {
      const configured = preset["model-setting"]?.find(entry => entry.type === role);
      const effective = snapshot?.pro?.preset === selected && !snapshot.pro.checking
        ? snapshot.pro.models?.find(entry => entry.role === role) : null;
      const row = document.createElement("div");
      row.className = "pro-model-row";
      const roleLabel = document.createElement("span");
      roleLabel.textContent = t(ROLES[role]);
      const value = document.createElement("span");
      value.textContent = modelName(effective?.model ?? configured?.model);
      value.title = [effective?.provider ?? configured?.provider, effective?.intensity ?? configured?.intensity].filter(Boolean).join(" · ");
      if (effective && effective.tier !== selected) {
        value.classList.add("pro-model-fallback");
        value.title += ` · ${t("Temporary fallback")}: ${effective.tier}`;
      }
      row.append(roleLabel, value);
      models.appendChild(row);
    }
    note.textContent = snapshot?.pro?.checking
      ? t("Checking every professional model before this task…")
      : busy ? t("Pause the current turn to change presets.")
        : t("Models are checked before each task. Unavailable roles temporarily use a lower preset.");
  }

  function choose(value) {
    if (snapshot?.busy || snapshot?.approval || applying || !presetFor(value)) return;
    const previous = committed || selected;
    const originalTarget = target;
    selected = value;
    failure = null;
    feedback.textContent = "";
    applying = true;
    render();
    pending = Promise.resolve().then(() => changePreset(value)).then(() => {
      if (target === originalTarget) committed = value;
    }).catch(error => {
      if (target !== originalTarget) return;
      failure = error;
      selected = previous;
      feedback.textContent = error.message;
    }).finally(() => { applying = false; render(); });
  }

  function showFallbacks(pro, key) {
    if (!pro || pro.checking || !pro.checkId) return;
    const id = `${key || ""}:${pro.checkId}`;
    if (seenChecks.has(id)) return;
    seenChecks.add(id);
    if (!(pro.fallbacks?.length) && !pro.error) return;
    fallbackRows.replaceChildren();
    for (const fallback of pro.fallbacks || []) {
      const row = document.createElement("div");
      row.className = "pro-fallback-row";
      const role = document.createElement("strong");
      role.textContent = t(ROLES[fallback.role] || fallback.role);
      const from = document.createElement("span");
      from.textContent = `${reference(fallback.requested)} → ${fallback.replacement ? reference(fallback.replacement) : t("No available model")}`;
      const detail = document.createElement("small");
      detail.textContent = [fallback.reason, fallback.replacement?.tier].filter(Boolean).join(" · ");
      row.append(role, from, detail);
      fallbackRows.appendChild(row);
    }
    fallbackError.textContent = pro.error || "";
    fallbackError.classList.toggle("hidden", !pro.error);
    if (!fallbackDialog.open) fallbackDialog.showModal();
  }

  range.addEventListener("input", () => {
    if (snapshot?.busy || applying) return;
    selected = presets[Number(range.value)]?.name || selected;
    render();
  });
  range.addEventListener("change", () => choose(selected));
  control.addEventListener("keydown", event => {
    if (event.key === "Escape") { control.open = false; event.stopPropagation(); }
  });
  document.addEventListener("pointerdown", event => {
    if (control.open && !control.contains(event.target)) control.open = false;
  });
  document.getElementById("pro-fallback-close").addEventListener("click", () => fallbackDialog.close());

  return {
    load(catalog) {
      presets = Array.isArray(catalog?.pro?.presets) ? catalog.pro.presets : [];
      defaultPreset = catalog?.pro?.preset || presets[0]?.name || "";
      if (!presetFor(selected) || (!target && !applying)) selected = defaultPreset;
      if (!committed) committed = selected;
      render();
    },
    show(info, key) {
      if (target !== key) {
        selected = info?.pro?.preset || info?.pro_preset || defaultPreset;
        committed = selected;
        target = key;
        failure = null;
        feedback.textContent = "";
      } else if (!applying && info?.pro?.preset) committed = selected = info.pro.preset;
      snapshot = info;
      render();
      showFallbacks(info?.pro, key);
    },
    refresh: render,
    preset: () => selected,
    async flush() { await pending; if (failure) throw failure; },
  };
}
