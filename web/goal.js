// The goal rail belongs to the composer, so it stays visible while the transcript scrolls.
export function createGoalUI({ document, tr, getSelection, getSource, submitCommand, input, onDraftChange }) {
  const ids = ["goal-card", "goal-status", "goal-objective", "goal-usage", "goal-turns", "goal-progress", "goal-progress-fill",
    "goal-reason", "goal-pause", "goal-resume", "goal-clear", "goal-open", "goal-dialog", "goal-form", "goal-input", "goal-budget",
    "goal-start", "goal-form-feedback", "goal-action-feedback", "goal-command-menu", "goal-command-option"];
  const el = Object.fromEntries(ids.map(id => [id.replace(/^goal-/, ""), document.getElementById(id)]));
  let source = null;
  let submitting = false;
  let menuDismissed = false;
  let dialogSelection = null;
  const hidden = (node, value) => node.classList.toggle("hidden", value);
  const isBareCommand = text => /^\s*\/(?:goal|目标)\s*$/i.test(text);
  const isCommand = text => /^\s*\/(?:goal|目标)(?:\s|$)/i.test(text);
  const statusLabel = status => ({ active: tr("Working toward goal"), paused: tr("Goal paused"), completed: tr("Goal completed"),
    blocked: tr("Goal needs attention"), budget_exhausted: tr("Goal budget reached") })[status] ?? tr("Goal paused");

  function hideMenu() {
    hidden(el["command-menu"], true);
    input.setAttribute("aria-expanded", "false");
  }
  function show(next) {
    source = next;
    const goal = source?.goal;
    hidden(el.card, !goal);
    const busy = Boolean(source?.busy);
    el.open.disabled = busy || submitting;
    if (!goal) return;
    el.card.dataset.status = goal.status;
    el.status.textContent = statusLabel(goal.status);
    el.objective.textContent = goal.objective;
    el.objective.title = goal.objective;
    const used = Math.max(0, Number(goal.tokensUsed) || 0);
    const budget = Number(goal.tokenBudget) || 0;
    el.usage.textContent = budget > 0 ? tr("{used} / {budget} tokens", { used: used.toLocaleString(), budget: budget.toLocaleString() }) :
      tr("{used} tokens used", { used: used.toLocaleString() });
    el.turns.textContent = tr("{count} turns", { count: goal.turns ?? 0 });
    hidden(el.progress, budget <= 0);
    if (budget > 0) {
      el.progress.setAttribute("aria-valuemin", "0");
      el.progress.setAttribute("aria-valuemax", String(budget));
      el.progress.setAttribute("aria-valuenow", String(Math.min(used, budget)));
      el["progress-fill"].style.width = `${Math.min(100, used / budget * 100)}%`;
    }
    el.reason.textContent = goal.reason || "";
    hidden(el.reason, !goal.reason);
    hidden(el.pause, goal.status !== "active");
    hidden(el.resume, !["paused", "blocked"].includes(goal.status));
    el.pause.disabled = submitting;
    el.resume.disabled = submitting || busy;
    el.clear.disabled = submitting;
  }
  function open() {
    if (!getSelection()) return;
    source = getSource();
    if (source?.busy || submitting) return;
    dialogSelection = getSelection();
    hideMenu();
    const draft = input.value;
    if (/^\/(?:g(?:o(?:a(?:l)?)?)?|目标)?$/i.test(draft.trim())) el.input.value = "";
    else if (/^\s*\/(?:goal|目标)(?:\s|$)/i.test(draft)) {
      el.input.value = draft.replace(/^\s*\/(?:goal|目标)\s*/i, "");
    } else el.input.value = draft.trim();
    el.budget.value = "";
    el["form-feedback"].textContent = "";
    if (!el.dialog.open) el.dialog.showModal();
    el.input.focus();
  }
  const close = () => { el.dialog.close(); input.focus(); };
  for (const id of ["goal-dialog-close", "goal-dialog-cancel"]) document.getElementById(id).addEventListener("click", close);
  el.open.addEventListener("click", open);
  el["command-option"].addEventListener("click", open);
  async function action(command) {
    if (submitting || !getSelection()) return;
    submitting = true;
    hidden(el["action-feedback"], true);
    show(source);
    try {
      if (await submitCommand(command) === false) throw new Error(tr("Could not update the goal. Try again."));
    } catch (error) {
      el["action-feedback"].textContent = error.message;
      hidden(el["action-feedback"], false);
    } finally { submitting = false; show(getSource()); }
  }
  el.pause.addEventListener("click", () => void action("/goal pause"));
  el.resume.addEventListener("click", () => void action("/goal resume"));
  el.clear.addEventListener("click", () => void action("/goal clear"));
  el.form.addEventListener("submit", async event => {
    event.preventDefault();
    if (submitting) return;
    const objective = el.input.value.trim();
    const rawBudget = el.budget.value.trim();
    const budget = rawBudget ? Number(rawBudget) : undefined;
    if (!objective || objective.length > 8000) {
      el["form-feedback"].textContent = tr("Enter a goal of 1–8000 characters."); return;
    }
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)) {
      el["form-feedback"].textContent = tr("Enter a positive whole number for the token budget."); return;
    }
    if (getSelection() !== dialogSelection) {
      el["form-feedback"].textContent = tr("The conversation changed. Reopen the goal dialog."); return;
    }
    if (getSource()?.busy) {
      el["form-feedback"].textContent = tr("Pause the current turn before setting a goal."); return;
    }
    submitting = true;
    el.start.disabled = true;
    const draft = input.value;
    const command = `/goal set ${budget === undefined ? "" : `--tokens ${budget} `}${objective}`;
    try {
      if (await submitCommand(command) === false) throw new Error(tr("Could not start the goal. Try again."));
      // Preserve edits the user made while the request was in flight.
      if (input.value === draft) { input.value = ""; onDraftChange(); }
      close();
    } catch (error) { el["form-feedback"].textContent = error.message; }
    finally { submitting = false; el.start.disabled = false; show(getSource()); }
  });
  function onInput() {
    menuDismissed = false;
    const match = /^\/(?:g(?:o(?:a(?:l)?)?)?|目标)?$/i.test(input.value.trim());
    hidden(el["command-menu"], !match);
    input.setAttribute("aria-expanded", String(match));
    if (match) input.setAttribute("aria-controls", "goal-command-menu");
  }
  function onKey(event) {
    if (event.isComposing || event.keyCode === 229) return false;
    if (event.key === "Escape") { hideMenu(); menuDismissed = true; return false; }
    if (!menuDismissed && !el["command-menu"].classList.contains("hidden") &&
        (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey))) {
      event.preventDefault(); open(); return true;
    }
    return false;
  }
  input.addEventListener("blur", () => { if (!el["command-menu"].contains(document.activeElement)) hideMenu(); });
  el["command-option"].addEventListener("pointerdown", event => event.preventDefault());
  return { show, open, onInput, onKey, isBareCommand, isCommand };
}
