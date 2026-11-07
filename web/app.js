import { createSettingsUI } from "./settings.js";
import { createProUI } from "./pro.js";
import { renderMarkdown as renderMarkdownHtml } from "./markdown.js";
import { turnAnswerIndex, turnFolds, turnRanges } from "./turns.js";
import { applyTranslations, getLanguage as currentLanguage, locale as currentLocale, setLanguage as setI18nLanguage, t as translate } from "./i18n.js";

// Neutrino web UI — a dependency-free single page app.
//
// It talks to the server API:
//   GET  /api/overview                      every saved conversation grouped by cwd
//   GET  /api/session/:id                   one saved transcript
//   GET  /api/live/:key/stream              SSE stream of a running conversation
//   POST /api/live/:key/{pause|resume|message|model}
//   GET/POST /api/settings                  model defaults and conversation settings
//
// The sidebar is refreshed on a timer; the open live conversation is pushed
// over SSE so tokens appear as they are generated.

const MAX_VISIBLE = 5;
const REFRESH_MS = 4000;

// -------------------------------------------------------------------- access
//
// Login is remembered in an HttpOnly cookie shared by fetch and EventSource.
// Remove credentials left behind by older versions of the UI.
try { localStorage.removeItem("neutrino.token"); } catch { /* Storage may be blocked. */ }

// ------------------------------------------------------------------ pro mode
//
// The "Pro" workspace is served at /pro and owns an isolated API under
// /pro/api, while this page and the login cookie are shared. Detect the mode
// before the request helpers below so no call can leak between the workspaces.
const PRO_MODE = (() => {
  try {
    const pathname = String(location?.pathname ?? "");
    return pathname === "/pro" || pathname.startsWith("/pro/");
  } catch {
    return false; // Test sandboxes and unusual embedders have no location.
  }
})();

const API_BASE = PRO_MODE ? "/pro/api" : "/api";
// Lets Pro-specific chrome (the wider sidebar needed by the longer brand name)
// apply before the first paint of this module.
if (PRO_MODE) document.body?.classList.add("pro-mode");

/** Point an /api request at the active workspace; other paths are unchanged. */
function apiPath(path) {
  if (!PRO_MODE) return path;
  const text = String(path);
  return text.startsWith("/api/") ? `${API_BASE}${text.slice(4)}` : path;
}

/** Namespace a remembered preference so both workspaces keep their own copy. */
function modeStorageKey(key) {
  return PRO_MODE ? `neutrino.pro.${key}` : key;
}

// Translation lookup. `translate` is an ES-module import; the browser tests
// that evaluate this file in a sandbox strip imports, so the helper degrades to
// the English source text instead of throwing. Interpolation is kept here too.
const tr = (text, values) => {
  if (typeof translate === "function") return translate(text, values);
  return String(text ?? "").replace(/\{(\w+)\}/g, (match, name) =>
    values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
};

function uiLanguage() {
  return typeof currentLanguage === "function" ? currentLanguage() : "en";
}

function setUiLanguage(value) {
  return typeof setI18nLanguage === "function" ? setI18nLanguage(value) : "en";
}

function localeTag() {
  return typeof currentLocale === "function" ? currentLocale() : "en-US";
}

function applyStaticTranslations() {
  if (typeof applyTranslations === "function") applyTranslations(document);
}

function readStorage(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* Private mode may block storage. */ }
}
async function loginWithPassword(password) {
  const response = await fetch("/api/auth/login", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not sign in.");
}

// Complete URL login before API requests start, so a slow password check cannot
// flash the login dialog or race the initial conversation/settings requests.
const initialLogin = (() => {
  const params = new URLSearchParams(location.search);
  const password = params.get("pwd");
  if (params.has("pwd") || params.has("t") || params.has("token")) {
    params.delete("pwd");
    params.delete("t");
    params.delete("token");
    const query = params.toString();
    try {
      history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    } catch { /* Login still works when history updates are unavailable. */ }
  }
  if (password === null) return Promise.resolve(true);
  return loginWithPassword(password).then(() => true).catch(error => {
    showGate(error.message);
    return false;
  });
})();

async function apiFetch(path, init = {}) {
  if (!await initialLogin) throw new Error("Password login required.");
  const response = await fetch(apiPath(path), { ...init, credentials: "same-origin" });
  if (response.status === 401) {
    showGate();
    throw new Error("Password login required.");
  }
  return response;
}

// The orbit mark is shared by the sidebar, the favicon and the login card, so
// the console never falls back to a typed glyph for its own identity.
const LOGO_MARK =
  '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
  '<ellipse cx="12" cy="12" rx="9.4" ry="3.8" transform="rotate(-30 12 12)" stroke="currentColor" stroke-width="1.7"/>' +
  '<circle cx="12" cy="12" r="3.1" stroke="currentColor" stroke-width="1.7"/></svg>';

let gateShown = false;

function showGate(message = "") {
  if (gateShown) return;
  gateShown = true;
  closeStream();
  closeUpdateEvents();
  setStatus("locked", "offline");
  document.getElementById("settings-dialog").close();
  document.getElementById("background-dialog")?.close?.();

  // A modal dialog stays above streaming repaints and traps keyboard focus.
  const gate = document.createElement("dialog");
  gate.className = "gate";
  gate.setAttribute("aria-labelledby", "login-title");
  gate.innerHTML =
    '<form class="gate-card">' +
    '<div class="gate-brand"><span class="logo">' + LOGO_MARK + "</span><strong>Neutrino</strong></div>" +
    '<h2 id="login-title">' + tr("Sign in") + "</h2>" +
    "<p>" + tr("Enter your Web password to open this console. The default password is 114514.") + "</p>" +
    '<label for="login-password">' + tr("Password") + "</label>" +
    '<input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="256" required autofocus>' +
    '<p class="form-feedback error" role="alert"></p>' +
    '<button class="primary" type="submit">' + tr("Sign in") + "</button>" +
    "</form>";
  gate.querySelector(".form-feedback").textContent = message;
  gate.addEventListener("cancel", event => event.preventDefault());
  gate.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    const input = gate.querySelector("input");
    const button = gate.querySelector("button");
    const feedback = gate.querySelector(".form-feedback");
    button.disabled = true;
    feedback.textContent = "";
    try {
      await loginWithPassword(input.value);
      location.reload();
    } catch (error) {
      feedback.textContent = error.message;
      input.focus();
      input.select();
    } finally { button.disabled = false; }
  });
  document.body.appendChild(gate);
  gate.showModal();
}

// -------------------------------------------------------- background invite
//
// Accepting changes the running console's lifetime immediately, including
// conversations already in flight. A resident console never offers the prompt.

let backgroundPromptAnswered = false;

function showBackgroundPrompt() {
  if (backgroundPromptAnswered || !el.backgroundDialog?.showModal) return;
  if (el.backgroundDialog.open) return;
  if (el.backgroundFeedback) {
    el.backgroundFeedback.textContent = "";
    el.backgroundFeedback.classList.remove("error");
  }
  try {
    el.backgroundDialog.showModal();
  } catch {
    // An embedder without dialog support still gets the setting in Settings.
  }
}

function maybePromptBackground(config) {
  if (!config?.settings?.background_prompt) return;
  if (config.settings.background === true) return;
  showBackgroundPrompt();
}

async function answerBackgroundPrompt(enable) {
  if (backgroundPromptAnswered) return;
  backgroundPromptAnswered = true;
  const feedback = el.backgroundFeedback;
  const cancel = el.backgroundCancel;
  const confirm = el.backgroundEnable;
  if (cancel) cancel.disabled = true;
  if (confirm) confirm.disabled = true;
  if (feedback) {
    feedback.textContent = "";
    feedback.classList.remove("error");
  }
  try {
    if (enable) {
      const response = await apiFetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { background: true } }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (body.settings?.background_running !== true) {
        throw new Error(tr("Background residency could not be applied. Restart the console and try again."));
      }
      try { await preferences.load(); } catch { /* Residency is already active. */ }
    } else {
      // Consume the invitation for this CLI run. A failed dismissal is
      // harmless: the prompt simply returns on the next page load.
      try {
        await apiFetch("/api/background/dismiss", { method: "POST" });
      } catch { /* Keep the close local. */ }
    }
    el.backgroundDialog?.close?.();
  } catch (error) {
    backgroundPromptAnswered = false;
    if (feedback) {
      feedback.textContent = tr(error.message);
      feedback.classList.add("error");
    }
  } finally {
    if (cancel) cancel.disabled = false;
    if (confirm) confirm.disabled = false;
  }
}

// ------------------------------------------------------------- update notice
//
// The server compares the version it runs with the one npm publishes — at
// start-up, every 30 minutes and on demand from Settings — and every answer
// reaches the page through one announcement stream, so the notice shown when
// the console opens and the corner badge cannot disagree about the release. A
// Pro tab listens to the same stream under its own API prefix. Confirming
// installs it on this machine; the running process keeps the old code either
// way, so a successful update ends by telling the user to restart.
//
// Two dialogs never open at once: the background invitation is modal too, so a
// release announced while it is up is offered once it is out of the way.

let updatePrompted = false;

// The release the page currently knows about. The notice and the corner badge
// read this one value, so the reminder can never name a different version.
let updateOffer = null;

// The console's own announcement stream, and the release that arrived while the
// background invitation was holding the screen.
let updateSource = null;
let pendingUpdate = null;

/**
 * Remember a release and light the corner badge. The announcement stream and a
 * check started in Settings both report here.
 */
function noteUpdateAvailable(update) {
  if (!update?.has_update) return false;
  updateOffer = update;
  if (el.updateBadge) {
    const label = tr("A new version is available");
    el.updateBadge.title = label;
    el.updateBadge.setAttribute("aria-label", label);
    el.updateBadge.classList.remove("hidden");
  }
  return true;
}

/** The release is installed or was never on offer: drop the reminder. */
function clearUpdateBadge() {
  updateOffer = null;
  pendingUpdate = null;
  el.updateBadge?.classList.add("hidden");
}

/**
 * Offer a known release. The notice shown on load and a check started from
 * Settings both end up here, so an update is announced with the same words and
 * the same buttons however the user found out about it.
 */
function openUpdateDialog(update) {
  if (!el.updateDialog || typeof el.updateDialog.showModal !== "function") return false;
  updatePrompted = true;
  if (el.updateVersions) {
    el.updateVersions.textContent = tr("Running {current} · published {latest}", {
      current: update.current_version, latest: update.latest_version,
    });
  }
  if (el.updateFeedback) {
    el.updateFeedback.textContent = "";
    el.updateFeedback.classList.remove("error");
  }
  el.updateCommandBlock?.classList.add("hidden");
  el.updateLater?.classList.remove("hidden");
  el.updateNow?.classList.remove("hidden");
  for (const button of [el.updateLater, el.updateNow, el.updateClose]) {
    if (button) button.disabled = false;
  }
  if (el.updateNow) el.updateNow.textContent = tr("Update now");
  try {
    if (!el.updateDialog.open) el.updateDialog.showModal();
  } catch {
    return false; // An embedder without modal support still gets the console.
  }
  return true;
}

/**
 * Announce a release. The console pushes what it knows when a tab connects and
 * again whenever the 30-minute background check finds a new one, so a window
 * that stays open is told in the same words as one that has just loaded.
 */
function applyUpdateStatus(update) {
  // The badge is lit even when the notice was already shown, so a dismissed
  // offer can still be picked up again from the corner.
  if (!noteUpdateAvailable(update)) {
    // The console reports no release any more, so the reminder has nothing
    // left to stand for.
    clearUpdateBadge();
    return false;
  }
  if (updatePrompted) return false;
  // The background invitation is a modal dialog too, and two of them must never
  // stack: this release is offered once that one is out of the way.
  if (el.backgroundDialog?.open) {
    pendingUpdate = update;
    return false;
  }
  return openUpdateDialog(update);
}

/**
 * Listen for the console's announcements. EventSource reconnects by itself, so
 * a dropped connection only leaves the page with the release it already knows.
 */
function openUpdateEvents() {
  if (updateSource) return;
  const source = new EventSource(apiPath("/api/update/events"));
  updateSource = source;
  source.addEventListener("update", (event) => {
    let update;
    try {
      update = JSON.parse(event.data);
    } catch {
      return;
    }
    applyUpdateStatus(update);
  });
}

/** The console is locked behind the login gate: its announcements are moot. */
function closeUpdateEvents() {
  if (!updateSource) return;
  updateSource.close();
  updateSource = null;
}

/** Run npm through the console's own server and report what happened. */
async function runUpdate() {
  if (!el.updateNow || el.updateNow.disabled) return;
  const buttons = [el.updateNow, el.updateLater, el.updateClose].filter(Boolean);
  for (const button of buttons) button.disabled = true;
  const feedback = el.updateFeedback;
  if (feedback) {
    feedback.textContent = tr("Updating with npm…");
    feedback.classList.remove("error");
  }
  let body = {};
  try {
    const response = await apiFetch("/api/update", { method: "POST" });
    body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(body.error || `HTTP ${response.status}`);
    if (feedback) {
      feedback.textContent = tr("Updated to {version}. Restart Neutrino to use it.", { version: body.version || "" });
      feedback.classList.remove("error");
    }
    el.updateCommandBlock?.classList.add("hidden");
    // The install is done: the only thing left is to close the notice.
    el.updateLater?.classList.add("hidden");
    el.updateNow?.classList.add("hidden");
    clearUpdateBadge();
  } catch (error) {
    if (feedback) {
      feedback.textContent = tr("Update failed: {error}", { error: error.message });
      feedback.classList.add("error");
    }
    // npm failures are usually something the user has to fix, so the dialog
    // keeps the command that finishes the job by hand.
    if (el.updateCommand && typeof body?.command === "string" && body.command) {
      el.updateCommand.textContent = body.command;
    }
    el.updateCommandBlock?.classList.remove("hidden");
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

const el = {
  app: document.getElementById("app"),
  back: document.getElementById("back-to-menu"),
  sessions: document.getElementById("sessions"),
  status: document.getElementById("status"),
  refresh: document.getElementById("refresh"),
  brandLogo: document.getElementById("brand-logo"),
  brandName: document.getElementById("brand-name"),
  proTip: document.getElementById("pro-tip"),
  proTipClose: document.getElementById("pro-tip-close"),
  proExit: document.getElementById("pro-exit"),
  header: document.getElementById("main-header"),
  title: document.getElementById("session-title"),
  sub: document.getElementById("session-sub"),
  controls: document.getElementById("controls"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  modePicker: document.getElementById("agent-mode-picker"),
  modeLabel: document.getElementById("agent-mode-label"),
  modeFeedback: document.getElementById("agent-mode-feedback"),
  send: document.getElementById("send"),
  approval: document.getElementById("approval"),
  emptyNewChat: document.getElementById("empty-new-chat"),
  newChat: document.getElementById("new-chat"),
  workspaceButton: document.getElementById("workspace-button"),
  workspaceLabel: document.getElementById("workspace-label"),
  languageSelect: document.getElementById("language-select"),
  planCard: document.getElementById("plan-card"),
  workspaceDialog: document.getElementById("workspace-dialog"),
  workspaceList: document.getElementById("workspace-list"),
  workspaceAll: document.getElementById("workspace-all"),
  workspaceAdd: document.getElementById("workspace-add"),
  workspaceClose: document.getElementById("workspace-close"),
  workspaceFeedback: document.getElementById("workspace-feedback"),
  newChatDialog: document.getElementById("new-chat-dialog"),
  newChatForm: document.getElementById("new-chat-form"),
  newChatTitle: document.getElementById("new-chat-title"),
  newChatClose: document.getElementById("new-chat-close"),
  newChatCancel: document.getElementById("new-chat-cancel"),
  newChatStart: document.getElementById("new-chat-start"),
  newChatCwd: document.getElementById("new-chat-cwd"),
  newChatBrowse: document.getElementById("new-chat-browse"),
  newChatRecents: document.getElementById("new-chat-recents"),
  newChatProvider: document.getElementById("new-chat-provider"),
  newChatModel: document.getElementById("new-chat-model"),
  newChatIntensity: document.getElementById("new-chat-intensity"),
  newChatApproval: document.getElementById("new-chat-approval"),
  newChatNote: document.getElementById("new-chat-note"),
  newChatFeedback: document.getElementById("new-chat-feedback"),
  folderDialog: document.getElementById("folder-dialog"),
  folderTitle: document.getElementById("folder-title"),
  folderClose: document.getElementById("folder-close"),
  folderCancel: document.getElementById("folder-cancel"),
  folderUse: document.getElementById("folder-use"),
  folderUp: document.getElementById("folder-up"),
  folderPath: document.getElementById("folder-path"),
  folderGo: document.getElementById("folder-go"),
  folderRoots: document.getElementById("folder-roots"),
  folderList: document.getElementById("folder-list"),
  folderNew: document.getElementById("folder-new"),
  folderNewName: document.getElementById("folder-new-name"),
  folderNewCreate: document.getElementById("folder-new-create"),
  folderNewCancel: document.getElementById("folder-new-cancel"),
  folderMkdir: document.getElementById("folder-mkdir"),
  folderFeedback: document.getElementById("folder-feedback"),
  agentsOpen: document.getElementById("agents-open"),
  agentsDialog: document.getElementById("agents-dialog"),
  agentsClose: document.getElementById("agents-close"),
  agentsList: document.getElementById("agents-list"),
  agentsFeedback: document.getElementById("agents-feedback"),
  agentsCwd: document.getElementById("agents-cwd"),
  agentActions: document.getElementById("agent-actions"),
  agentMigrate: document.getElementById("agent-migrate"),
  agentMigrateFeedback: document.getElementById("agent-migrate-feedback"),
  backgroundDialog: document.getElementById("background-dialog"),
  backgroundFeedback: document.getElementById("background-feedback"),
  backgroundCancel: document.getElementById("background-cancel"),
  backgroundEnable: document.getElementById("background-enable"),
  updateDialog: document.getElementById("update-dialog"),
  updateVersions: document.getElementById("update-versions"),
  updateCommandBlock: document.getElementById("update-command-block"),
  updateCommand: document.getElementById("update-command"),
  updateFeedback: document.getElementById("update-feedback"),
  updateClose: document.getElementById("update-close"),
  updateLater: document.getElementById("update-later"),
  updateNow: document.getElementById("update-now"),
  updateBadge: document.getElementById("update-badge"),
};

if (el.backgroundCancel) {
  el.backgroundCancel.addEventListener("click", () => { void answerBackgroundPrompt(false); });
}
if (el.backgroundEnable) {
  el.backgroundEnable.addEventListener("click", () => { void answerBackgroundPrompt(true); });
}
if (el.backgroundDialog) {
  el.backgroundDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void answerBackgroundPrompt(false);
  });
  // A release announced while the invitation was up is offered right after it.
  el.backgroundDialog.addEventListener("close", () => {
    const waiting = pendingUpdate;
    pendingUpdate = null;
    // The login gate closes this dialog on its way in, and nothing may sit on
    // top of it.
    if (waiting && !gateShown) openUpdateDialog(waiting);
  });
}

if (el.updateNow) el.updateNow.addEventListener("click", () => { void runUpdate(); });
if (el.updateLater) el.updateLater.addEventListener("click", () => el.updateDialog?.close?.());
if (el.updateClose) el.updateClose.addEventListener("click", () => el.updateDialog?.close?.());
if (el.updateDialog) {
  // Esc closes it like "Later": the notice is an offer, never a gate.
  el.updateDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    el.updateDialog.close();
  });
}
// The corner disc reopens the same notice, so a dismissal is never final.
if (el.updateBadge) {
  el.updateBadge.addEventListener("click", () => {
    if (updateOffer) openUpdateDialog(updateOffer);
  });
}

const state = {
  overview: null,
  // { kind: "live", key } | { kind: "file", id } | { kind: "new", cwd } |
  // { kind: "agent", agent, id, title } | null
  selection: null,
  snapshot: null,
  eventSource: null,
  lastSessionId: null,
  collapsed: new Set(),
  expanded: new Set(),
  openTools: new Set(),
  // Turns the reader expanded; a finished turn is folded unless listed here.
  openTurns: new Set(),
  openContext: null,
  // Last loaded saved transcript, kept so a language switch can repaint it.
  fileData: null,
  // Last loaded read-only transcript from another agent.
  agentData: null,
  agentMigration: null,
  // { key, path } | null — the working directory the sidebar is scoped to.
  workspace: storedWorkspace(),
  // Plan / usage card visibility and the plan it was opened for.
  planOpen: false,
  planSeen: "",
  composerMode: "live",
  // Folder-picker state: where it is, what to do with the picked path.
  folder: { path: "", parent: null, roots: [], onPick: null, mode: "workspace", loading: false },
  workspaces: null,
  // Translation key and colour class of the sidebar status line.
  status: { key: "connecting…", kind: "" },
  // { identity: 1 } of finished conversations the reader has already opened,
  // restored from the server before the first sidebar paint (see loadSeen).
  seen: {},
};

function storedWorkspace() {
  const path = readStorage(modeStorageKey("neutrino.workspace"));
  if (!path) return null;
  return { key: pathKey(path), path };
}

const AGENT_MODE_LABELS = { standard: "Standard mode", ptc: "PTC mode", fast: "Fast mode", pro: "Professional mode" };
let newAgentMode = readStorage("neutrino.agent-mode");
if (!["standard", "ptc", "fast"].includes(newAgentMode)) newAgentMode = "standard";
let agentModePending = Promise.resolve();
let agentModeChanging = false;
let workspaceNavigation = false;
let agentModeError = "";

function clearAgentModeFeedback() {
  agentModeError = "";
  agentModePending = Promise.resolve();
}

function currentAgentMode() {
  if (PRO_MODE) return "pro";
  if (state.selection?.kind === "live") return state.snapshot?.agentMode || "standard";
  if (state.selection?.kind === "file") return state.fileData?.agent_mode || "standard";
  return newAgentMode;
}

function renderAgentMode() {
  if (!el.modePicker || !el.modeLabel) return;
  const mode = currentAgentMode();
  el.modeLabel.removeAttribute?.("data-i18n");
  el.modeLabel.textContent = tr(AGENT_MODE_LABELS[mode] || AGENT_MODE_LABELS.standard);
  const nextTurn = state.snapshot?.busy && state.snapshot.activeAgentMode !== state.snapshot.agentMode;
  el.modePicker.classList.toggle("is-pending", Boolean(agentModeChanging || nextTurn));
  for (const button of el.modePicker.querySelectorAll?.("[data-agent-mode]") || []) {
    button.setAttribute("aria-checked", String(button.dataset.agentMode === mode));
    button.disabled = agentModeChanging || workspaceNavigation;
  }
  if (el.modeFeedback) {
    el.modeFeedback.textContent = agentModeError || (agentModeChanging ? tr("Changing mode…") : nextTurn ? tr("Applies to the next turn") : "");
    el.modeFeedback.classList.toggle("error", Boolean(agentModeError));
  }
}

async function chooseAgentMode(mode) {
  if (!Object.hasOwn(AGENT_MODE_LABELS, mode) || agentModeChanging || workspaceNavigation || mode === currentAgentMode()) return;
  const selected = state.selection;
  agentModeChanging = true;
  agentModeError = "";
  if (el.modePicker) renderAgentMode();
  el.modePicker.open = false;
  try {
    if (mode === "pro" || PRO_MODE) {
      await switchWorkspaceMode(mode);
    } else if (selected?.kind === "live") {
      const response = await apiFetch(`/api/live/${encodeURIComponent(selected.key)}/agent-mode`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(apiError(body, `HTTP ${response.status}`));
      if (state.selection === selected) { state.snapshot = body.snapshot; renderLive(); }
    } else if (selected?.kind === "file") {
      await continueSession(selected.id, preferences.selectionForFile(selected.id), mode);
    } else {
      newAgentMode = mode;
    }
    if (mode !== "pro") { newAgentMode = mode; writeStorage("neutrino.agent-mode", mode); }
  } catch (error) {
    if (state.selection !== selected) return;
    agentModeError = tr("Could not change mode: {error}", { error: error.message });
    throw error;
  } finally { agentModeChanging = false; renderAgentMode(); }
}

async function switchWorkspaceMode(mode) {
  const cwd = selectionCwd() || state.workspace?.path;
  if (!cwd) throw new Error(tr("Select a working directory first."));
  const targetPro = mode === "pro";
  const response = await fetch(targetPro ? "/pro/api/conversations" : "/api/conversations", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, ...(targetPro ? {} : { agent_mode: mode }) }),
  });
  const body = await response.json();
  if (response.status === 401) showGate();
  if (!response.ok) throw new Error(apiError(body, `HTTP ${response.status}`));
  workspaceNavigation = true;
  if (el.modePicker) renderAgentMode();
  try { sessionStorage.setItem(`neutrino.workspace-draft.${body.key}`, el.input.value); } catch { /* Navigation still works without storage. */ }
  const target = `${targetPro ? "/pro" : "/"}?live=${encodeURIComponent(body.key)}`;
  if (targetPro) startProTransition(target);
  else { try { location.assign(target); } catch { location.href = target; } }
}

/** A transferred chat remains reloadable until the user chooses another view. */
function clearLinkedConversation(keepKey) {
  const params = new URLSearchParams(location.search);
  if (!params.has("live") || params.get("live") === keepKey) return;
  params.delete("live");
  const query = params.toString();
  try { history.replaceState(history.state, "", location.pathname + (query ? `?${query}` : "") + location.hash); } catch { /* History is optional. */ }
}

async function openLinkedConversation() {
  const key = new URLSearchParams(location.search).get("live");
  if (!key || state.selection) return false;
  try {
    const response = await apiFetch(`/api/live/${encodeURIComponent(key)}`, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(apiError(body, `HTTP ${response.status}`));
    if (state.selection) return false;
    setWorkspace({ path: body.cwd });
    await selectLive(key);
    state.snapshot = body;
    renderLive();
    setConversationView(true);
    try {
      const storageKey = `neutrino.workspace-draft.${key}`;
      el.input.value = sessionStorage.getItem(storageKey) || "";
      sessionStorage.removeItem(storageKey);
    } catch { /* Storage is optional. */ }
    autosize(); el.input.focus();
    return true;
  } catch (error) { el.sub.textContent = error.message; return false; }
}

function initializeAgentMode() {
  if (!el.modePicker?.querySelectorAll) return;
  for (const button of el.modePicker.querySelectorAll("[data-agent-mode]")) {
    button.addEventListener("click", () => {
      agentModePending = chooseAgentMode(button.dataset.agentMode);
      // Keep the rejection available to sendMessage while avoiding an unhandled promise.
      void agentModePending.catch(() => {});
    });
  }
  el.modePicker.addEventListener("keydown", event => {
    if (event.key === "Escape") { el.modePicker.open = false; el.modePicker.querySelector("summary")?.focus(); event.stopPropagation(); }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); el.modePicker.open = true;
    const buttons = [...el.modePicker.querySelectorAll("[data-agent-mode]")];
    let index = buttons.indexOf(document.activeElement);
    index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[index]?.focus();
  });
  document.addEventListener("pointerdown", event => {
    if (el.modePicker.open && !el.modePicker.contains(event.target)) el.modePicker.open = false;
  });
  if (el.modePicker) renderAgentMode();
}

let proUI = null;
const preferences = createSettingsUI({
  apiFetch,
  proMode: PRO_MODE,
  onCatalogChange: (catalog) => proUI?.load(catalog),
  onLanguageChange: (language) => changeInterfaceLanguage(language),
  // A check started from Settings offers its result through the same dialog as
  // the notice shown on load, and lights the corner badge with it.
  onUpdateFound: (update) => {
    noteUpdateAvailable(update);
    return openUpdateDialog(update);
  },
  async applyModel(selection) {
    const current = state.selection;
    if (!current) throw new Error("Select a conversation first.");
    if (current.kind === "file") {
      await continueSession(current.id, selection);
      return;
    }
    const response = await apiFetch(`/api/live/${encodeURIComponent(current.key)}/model`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(selection),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (state.selection?.kind === "live" && state.selection.key === current.key) {
      state.snapshot = body.snapshot;
      renderLive();
    }
  },
});

if (PRO_MODE && typeof createProUI === "function") {
  proUI = createProUI({
    async changePreset(preset) {
      const current = state.selection;
      if (current?.kind === "live") {
        const response = await apiFetch(`/api/live/${encodeURIComponent(current.key)}/pro-preset`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preset }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        if (state.selection?.kind === "live" && state.selection.key === current.key) {
          state.snapshot = body.snapshot;
          renderLive();
        }
      } else if (current?.kind !== "file") {
        const response = await apiFetch("/api/settings", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ settings: { pro_preset: preset } }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        await preferences.load();
      }
    },
  });
}

function currentProPreset() {
  return proUI?.preset() || preferences.catalog?.()?.pro?.preset;
}

// ------------------------------------------------------------------- sounds
//
// A turn that ends while the tab is in the background is invisible, so finished
// turns and waiting approvals each get a short motif. Browsers refuse to start
// audio without a user gesture, so the context is created on the first
// interaction and reused; before that a cue is skipped rather than queued.

let audioContext = null;

function unlockAudio() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!audioContext) audioContext = new Ctor();
    if (audioContext.state === "suspended") audioContext.resume().catch(() => {});
  } catch {
    // No audio available (blocked, unsupported, mocked): stay silent.
    audioContext = null;
  }
}

// Feature-detected: some embedders (and the test harness) expose no events.
if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
  document.addEventListener("pointerdown", unlockAudio, true);
  document.addEventListener("keydown", unlockAudio, true);
}

const SOUND_MOTIFS = {
  // Turn finished: two short rising notes.
  turn: [[660, 0], [988, 0.13]],
  // Approval waiting: three insistent notes, because this blocks the agent.
  approval: [[784, 0], [587, 0.16], [784, 0.32]],
};

function chime(kind) {
  if (!preferences.soundAlerts()) return;
  unlockAudio();
  if (!audioContext || audioContext.state === "closed") return;
  const start = audioContext.currentTime + 0.01;
  for (const [frequency, offset] of SOUND_MOTIFS[kind] || SOUND_MOTIFS.turn) {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    const at = start + offset;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.16, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.15);
  }
}

/**
 * Cues fire on transitions, not on every frame: the stream re-sends a snapshot
 * on every update, so comparing against the previous one keeps this from
 * turning into a metronome. The first frame is skipped because it describes a
 * state the page has just loaded.
 */
function announce(previous, next) {
  if (!previous || previous.key !== next.key) return;
  if (!previous.approval && next.approval) chime("approval");
  else if (previous.busy && !next.busy && !next.approval) chime("turn");
}

/** Whether a live conversation has anything to show (and so belongs in the list). */
function liveHasContent(snapshot) {
  return Boolean(snapshot.messages?.length || snapshot.streamingContent);
}

// ------------------------------------------------------------------ helpers

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function truncate(value, max) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Sidebar paths are identifiers, not navigation: keep the project end of a long
// path so two checkouts under different parents stay tellable apart.
function shortenPath(value, depth = 2) {
  const text = String(value ?? "");
  const separator = text.includes("\\") ? "\\" : "/";
  const parts = text.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= depth + 1) return text;
  return `…${separator}${parts.slice(-depth).join(separator)}`;
}

/**
 * Canonical form of a working directory, matching the server's `normalizeCwd`.
 * It is only used to decide which sidebar group a path belongs to.
 */
function pathKey(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  text = text.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const wsl = /^\/(?:mnt|cygdrive)\/([a-zA-Z])(\/.*)?$/.exec(text);
  const win = /^([a-zA-Z]):(\/.*)?$/.exec(text);
  const drive = wsl ?? win;
  if (drive) {
    const rest = (drive[2] || "/").replace(/\/+$/, "") || "/";
    return `${drive[1].toLowerCase()}:${rest.toLowerCase()}`;
  }
  return text.length > 1 ? text.replace(/\/+$/, "") : text;
}

/** Last path segment, used for compact workspace labels. */
function workspaceName(value) {
  const parts = String(value ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(value ?? "");
}

function setWorkspace(workspace, { persist = true } = {}) {
  state.workspace = workspace ? { key: pathKey(workspace.path), path: workspace.path } : null;
  if (persist) writeStorage(modeStorageKey("neutrino.workspace"), state.workspace?.path ?? "");
  renderWorkspaceChrome();
  renderSidebar();
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function formatTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60_000) return tr("just now");
  if (diff < 3_600_000) return tr("{n}m ago", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return tr("{n}h ago", { n: Math.floor(diff / 3_600_000) });
  return date.toLocaleDateString(localeTag(), { month: "short", day: "numeric" });
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(localeTag());
}

function setStatus(key, kind) {
  // Store the translation key, not the rendered text: switching languages must
  // not leave a stale word in the sidebar.
  state.status = { key, kind };
  el.status.textContent = tr(key);
  el.status.className = `status${kind ? ` ${kind}` : ""}`;
}

// Full markdown lives in web/markdown.js: headings, lists, tables, code,
// quotes, links, images and the inline emphasis family. The fallback keeps the
// sandboxed browser tests working when module imports are stripped; it still
// escapes all model output before adding line breaks.
function renderMarkdown(value) {
  if (typeof renderMarkdownHtml === "function") return renderMarkdownHtml(value);
  return escapeHtml(String(value ?? "")).replace(/\n/g, "<br>");
}

// ------------------------------------------------------------------- status

async function loadOverview(options = {}) {
  // Once the gate is up every poll would only produce another 401.
  if (gateShown) return;
  try {
    const response = await apiFetch("/api/overview", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const overview = await response.json();
    if (gateShown) return;
    state.overview = overview;
    setStatus(state.selection?.kind === "live" ? "live" : "online", state.selection?.kind === "live" ? "live" : "online");
    renderWorkspaceChrome();
    renderSidebar();
    syncSelection();
  } catch (error) {
    if (!gateShown) setStatus("offline", "offline");
    if (!options.silent) console.error(error);
  }
}

function syncSelection() {
  const selection = state.selection;
  if (!selection || selection.kind !== "live") return;
  const live = state.overview?.live ?? [];
  if (live.some((entry) => entry.key === selection.key)) return;

  // The terminal session went away. Prefer the saved transcript when we have it.
  const sessionId = state.lastSessionId;
  closeStream();
  if (sessionId) {
    selectFile(sessionId);
    return;
  }
  state.selection = null;
  state.snapshot = null;
  renderSidebar();
  hideComposer();
  el.controls.innerHTML = "";
  el.title.textContent = tr("Session ended");
  el.sub.textContent = tr("The terminal session was closed.");
  el.messages.innerHTML = `<div class="empty">${escapeHtml(tr("This live session has ended."))}</div>`;
  renderPlanCard(null);
}

// ------------------------------------------------------------------ sidebar

/** Sidebar groups for the current view: every folder, or only the open workspace. */
function viewGroups() {
  if (!state.overview) return null;
  if (!state.workspace) return state.overview.groups;
  const found = state.overview.groups.find((group) => group.key === state.workspace.key);
  return found ? [found] : [{ key: state.workspace.key, cwd: state.workspace.path, updated_at: "", sessions: [] }];
}

function renderSidebar() {
  el.sessions.innerHTML = "";
  const groups = viewGroups();

  if (!groups || groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-side";
    empty.textContent = state.workspace ? tr("No conversations in this folder yet.") : tr("No conversations yet.");
    el.sessions.appendChild(empty);
    return;
  }

  for (const group of groups) el.sessions.appendChild(renderGroup(group, { forceOpen: Boolean(state.workspace) }));

  if (state.workspace && groups[0] && groups[0].sessions.length === 0) {
    const note = document.createElement("div");
    note.className = "empty-side workspace-hint";
    note.textContent = tr("Type a message below to start a conversation in this folder.");
    el.sessions.appendChild(note);
  }
}

function renderGroup(group, options = {}) {
  const wrap = document.createElement("section");
  wrap.className = "group";

  const collapsed = !options.forceOpen && state.collapsed.has(group.key);
  // The row answers "start something here", not "how much is already here": a
  // plus beside the folder opens a fresh conversation in it, the way Codex puts
  // a project's own new-chat control next to the project. Two actions cannot
  // share one button, so the row holds the folder and the plus side by side.
  const head = document.createElement("div");
  head.className = "group-head";

  const header = document.createElement("button");
  header.className = "group-header";
  header.type = "button";
  header.setAttribute("aria-expanded", String(!collapsed));
  header.innerHTML =
    `<span class="chevron${collapsed ? " collapsed" : ""}">` +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>' +
    "</span>" +
    `<span class="path" title="${escapeHtml(group.cwd)}">${escapeHtml(shortenPath(group.cwd))}</span>`;
  header.addEventListener("click", () => {
    if (state.collapsed.has(group.key)) state.collapsed.delete(group.key);
    else state.collapsed.add(group.key);
    renderSidebar();
  });
  head.appendChild(header);

  if (group.cwd) {
    const start = document.createElement("button");
    start.className = "icon-btn group-new";
    start.type = "button";
    start.title = tr("New conversation in this folder");
    start.setAttribute("aria-label", tr("New conversation in this folder"));
    start.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    start.addEventListener("click", () => startConversationIn(group.cwd));
    head.appendChild(start);
  }

  wrap.appendChild(head);

  if (collapsed) return wrap;

  const list = document.createElement("div");
  list.className = "group-items";
  const expanded = state.expanded.has(group.key);
  const visible = expanded ? group.sessions : group.sessions.slice(0, MAX_VISIBLE);
  for (const session of visible) list.appendChild(renderSession(session));

  if (group.sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-side";
    empty.textContent = tr("No conversations in this folder yet.");
    list.appendChild(empty);
  }

  const hiddenCount = group.sessions.length - MAX_VISIBLE;
  if (hiddenCount > 0) {
    const more = document.createElement("button");
    more.className = "more";
    more.textContent = expanded ? tr("Show less") : tr("Show {n} more", { n: hiddenCount });
    more.addEventListener("click", () => {
      if (state.expanded.has(group.key)) state.expanded.delete(group.key);
      else state.expanded.add(group.key);
      renderSidebar();
    });
    list.appendChild(more);
  }

  wrap.appendChild(list);
  return wrap;
}

/**
 * The plus on a folder header. It opens that folder's landing view, where the
 * next message becomes a new conversation in that directory, so starting one
 * costs a click instead of a dialog.
 */
function startConversationIn(cwd) {
  const path = String(cwd ?? "").trim();
  if (!path) return;
  renderWorkspaceLanding(path);
  setConversationView(true);
  el.input?.focus?.();
}

function isSelected(session) {
  const selection = state.selection;
  if (!selection) return false;
  if (selection.kind === "live") return Boolean(session.liveKey) && selection.key === session.liveKey;
  return !session.liveKey && session.id === selection.id;
}

// --------------------------------------------------- the "already seen" record
//
// A blue dot means "this conversation finished and you have not looked at it
// since". Opening a row records that, so the dot is not a permanent decoration;
// new activity forgets the record again, so the next finished turn gets a mark
// of its own. The record survives a reload and a restart of the console: a
// conversation the reader has already read must not keep asking.

/**
 * Identity of a row in the record. A conversation keeps its id while it becomes
 * live, so the id is the stable name; a conversation with no history yet has
 * only its live key.
 */
function sessionIdentity(session) {
  if (session.id) return `id:${session.id}`;
  return session.liveKey ? `live:${session.liveKey}` : "";
}

// Key of the record an older console kept in localStorage. It is only read once
// now, to hand that history over to the server.
const SEEN_KEY = "neutrino.seen";

/**
 * Turn the server's list into the lookup the renderer uses.
 *
 * The record lives in ~/.neutrino/web.json (src/web/clientState.ts): one file
 * the console owns, so the terminal UI never carries data it does not read and
 * the answer survives a restart. localStorage could not do that — it is scoped
 * to the address and port the console happened to listen on.
 */
function seenMap(list) {
  const out = {};
  if (Array.isArray(list)) {
    for (const identity of list) {
      if (typeof identity === "string" && identity) out[identity] = 1;
    }
  }
  return out;
}

/** Report a change. A write that fails costs one dot, so it is never surfaced. */
async function persistSeen(identities, seen) {
  if (!identities.length) return true;
  try {
    const response = await apiFetch("/api/seen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identities, seen }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The record left in localStorage by an older console, if any. */
function legacySeen() {
  try {
    const stored = JSON.parse(readStorage(modeStorageKey(SEEN_KEY)) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch {
    return {};
  }
}

/**
 * Load the record before the first sidebar paint, so a reload never starts by
 * marking every finished conversation again. The localStorage record of an
 * older console is handed over once, and dropped as soon as the server has it.
 */
async function loadSeen() {
  let stored;
  try {
    const response = await apiFetch("/api/seen", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    stored = seenMap((await response.json())?.seen);
  } catch {
    // Without a record every finished conversation shows its dot again, which
    // is a readable page rather than a broken one.
    return;
  }
  state.seen = stored;
  const identities = Object.keys(legacySeen());
  if (!identities.length) return;
  const missing = identities.filter((identity) => !stored[identity]);
  for (const identity of missing) state.seen[identity] = 1;
  if (await persistSeen(missing, true)) writeStorage(modeStorageKey(SEEN_KEY), "");
}

function isSeen(identity) {
  return Boolean(identity) && Boolean(state.seen[identity]);
}

/** The reader opened this row. */
function rememberSeen(identity) {
  if (!identity || state.seen[identity]) return;
  state.seen[identity] = 1;
  // The dot is already gone from the page; the write only has to reach the disk.
  void persistSeen([identity], true);
}

/** New activity: the turn that comes next deserves a mark of its own. */
function forgetSeen(identity) {
  if (!identity || !state.seen[identity]) return;
  delete state.seen[identity];
  void persistSeen([identity], false);
}

/**
 * Status of a live conversation: a tool call waiting for the user's decision, a
 * turn in flight, or nothing left to run. An automated review answers for the
 * user, so only manual approval leaves a conversation waiting on a human.
 */
function statusOfLive(live) {
  if (!live) return "done";
  if (live.approval && (live.approvalMode ?? "request") === "request") return "approval";
  return live.busy || live.paused || live.queued || live.compressing ? "running" : "done";
}

/** Status of a sidebar row; a saved transcript has finished by definition. */
function sessionStatus(session) {
  if (!session.liveKey) return "done";
  // The open stream is newer than the last overview poll.
  const snapshot = state.snapshot;
  if (snapshot && snapshot.key === session.liveKey) return statusOfLive(snapshot);
  return statusOfLive((state.overview?.live ?? []).find((entry) => entry.key === session.liveKey));
}

/**
 * The status mark of a row: blue dot when done, ring when running, amber when
 * waiting. The blue dot asks for attention once — opening the conversation takes
 * it away. Running and waiting are live states, so they are always drawn, and
 * seeing one clears the record for the turn that follows.
 */
function sessionStatusMark(session) {
  const status = sessionStatus(session);
  const identity = sessionIdentity(session);
  if (status === "done") {
    if (isSeen(identity)) return "";
  } else {
    forgetSeen(identity);
  }
  const label = status === "running"
    ? tr("Running")
    : status === "approval" ? tr("Waiting for approval") : tr("Done");
  return `<span class="session-state ${status}" title="${escapeHtml(label)}"></span>`;
}

function renderSession(session) {
  const item = document.createElement("button");
  item.className = "session";
  if (isSelected(session)) item.classList.add("selected");
  if (session.live) item.classList.add("live");

  const title = session.title || tr("New conversation");
  const count = Number(session.message_count ?? 0);
  item.title = title;
  item.innerHTML =
    `<div class="session-top"><span class="session-title">${escapeHtml(title)}</span>` +
    `${sessionStatusMark(session)}</div>` +
    `<div class="session-meta"><span class="model">${escapeHtml(session.model || "?")}</span>` +
    `<span class="time">${escapeHtml(formatTime(session.updated_at))}</span>` +
    `<span class="count">${escapeHtml(count === 1 ? tr("{n} message", { n: count }) : tr("{n} messages", { n: count }))}</span></div>`;

  item.addEventListener("click", () => {
    if (!session.liveKey && !session.id) return;
    rememberSeen(sessionIdentity(session));
    if (session.liveKey) selectLive(session.liveKey);
    else selectFile(session.id);
    setConversationView(true);
  });
  return item;
}

// ------------------------------------------------------------------- select

// Only explicit navigation changes the mobile pane. Background refreshes and
// live-to-saved transitions must not take the user away from the menu.
//
// On a phone the two panes share one screen, so the browser's own Back button
// has to walk the same levels as the back arrow in the header: from an open
// conversation to the list, and Forward back into that conversation. Each
// explicit navigation records one marked entry, and the entries beneath it are
// the list.
const CONVERSATION_ENTRY = "conversation";

function isConversationEntry(entry) {
  return Boolean(entry) && entry.neutrinoView === CONVERSATION_ENTRY;
}

/** The narrow layout that swaps the panes; wider screens show both at once. */
function stackedPanes() {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(max-width: 760px)").matches;
  } catch {
    return false;
  }
}

/** Record the open conversation as a level the browser can return from. */
function pushConversationEntry() {
  try {
    // Forward restored this entry already; recording it twice would take two
    // presses to leave the conversation.
    if (isConversationEntry(history.state)) return;
    history.pushState({ neutrinoView: CONVERSATION_ENTRY }, "", location.href);
  } catch {
    // Without history the header's back arrow still closes the pane.
  }
}

/** The list is the entry beneath an open conversation: step back onto it. */
function stepBackToList() {
  try {
    if (isConversationEntry(history.state)) history.back();
  } catch {
    // Without history the header's back arrow still closes the pane.
  }
}

function setConversationView(open, { record = true } = {}) {
  const wasOpen = el.app.classList.contains("conversation-open");
  el.app.classList.toggle("conversation-open", open);
  const stacked = stackedPanes();
  // A click records one level; Back and Forward already moved the browser.
  if (record && stacked && open !== wasOpen) {
    if (open) pushConversationEntry();
    else stepBackToList();
  }
  if (!stacked) return;
  if (open) el.back.focus();
  else (el.sessions.querySelector(".session.selected") || el.refresh).focus();
}

/** Back and Forward: show the level the browser landed on, without recording it. */
function followViewHistory(event) {
  setConversationView(isConversationEntry(event?.state), { record: false });
}

/**
 * A reload starts on the list, but the browser is still on the entry that
 * recorded a conversation. Forget the mark, so the first Back press tells the
 * truth instead of leaving a screen that never looked like a conversation.
 */
function forgetStaleConversationEntry() {
  try {
    if (!isConversationEntry(history.state)) return;
    history.replaceState(null, "", location.href);
  } catch {
    // No history in this embedder: there is nothing to correct.
  }
}

/**
 * Rotating a phone crosses the width that swaps the panes. A conversation
 * opened while both panes were shown never recorded a level, so record it on
 * the way into the single-pane layout: otherwise Back would leave the console
 * from a screen that shows nothing but a conversation.
 */
function watchPanes() {
  const query = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 760px)")
    : null;
  if (!query || typeof query.addEventListener !== "function") return;
  query.addEventListener("change", (event) => {
    if (!event?.matches) return;
    if (el.app.classList.contains("conversation-open")) pushConversationEntry();
  });
}

function resetMessagePane(text) {
  el.messages.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  el.messages.appendChild(empty);
}

async function selectLive(key) {
  if (el.modePicker) { clearAgentModeFeedback(); clearLinkedConversation(key); }
  preferences.clear();
  closeStream();
  state.selection = { kind: "live", key };
  state.snapshot = null;
  state.fileData = null;
  state.agentData = null;
  state.lastSessionId = null;
  state.openTools.clear();
  state.openTurns.clear();
  state.openContext = null;
  state.planOpen = false;
  state.planSeen = "";
  renderSidebar();
  el.controls.innerHTML = "";
  renderApproval(null);
  renderPlanCard(null);
  el.title.textContent = tr("Connecting…");
  el.sub.textContent = "";
  setComposerMode("live");
  resetMessagePane(tr("Connecting…"));
  openStream(key);
}

function openStream(key) {
  closeStream();
  const source = new EventSource(apiPath(`/api/live/${encodeURIComponent(key)}/stream`));
  state.eventSource = source;

  source.addEventListener("snapshot", (event) => {
    let snapshot;
    try {
      snapshot = JSON.parse(event.data);
    } catch {
      return;
    }
    if (gateShown) return;
    const previous = state.snapshot;
    state.snapshot = snapshot;
    if (snapshot.sessionId) state.lastSessionId = snapshot.sessionId;
    announce(previous, snapshot);
    setStatus("live", "live");
    renderLive();
    // A turn that finishes in the conversation on screen needs no blue dot:
    // recording it before the repaint keeps the mark off as the turn ends.
    if (snapshot.sessionId && statusOfLive(snapshot) === "done") rememberSeen(`id:${snapshot.sessionId}`);
    // The sidebar mirrors the open conversation, so a turn that starts, waits
    // for approval or finishes shows there instead of on the next poll.
    if (statusOfLive(previous) !== statusOfLive(snapshot)) renderSidebar();
    // A conversation stays out of the sidebar until it has content; the first
    // message makes it history, so list it now instead of on the next poll.
    const started = previous && !liveHasContent(previous) && liveHasContent(snapshot);
    if (started) loadOverview({ silent: true });
  });

  source.addEventListener("gone", () => {
    closeStream();
    syncSelection();
  });

  source.onopen = () => setStatus("live", "live");
  source.onerror = () => {
    // EventSource retries automatically; wait for a fresh snapshot to flash.
    el.header?.classList.remove("is-thinking");
    setStatus("reconnecting…", "offline");
  };
}

function closeStream() {
  el.header?.classList.remove("is-thinking");
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

async function selectFile(id) {
  if (el.modePicker) { clearAgentModeFeedback(); clearLinkedConversation(); }
  preferences.clear();
  closeStream();
  state.selection = { kind: "file", id };
  state.snapshot = null;
  state.fileData = null;
  state.agentData = null;
  state.openTools.clear();
  state.openTurns.clear();
  state.openContext = null;
  state.planOpen = false;
  state.planSeen = "";
  renderSidebar();
  el.controls.innerHTML = "";
  renderApproval(null);
  renderPlanCard(null);
  setComposerMode("resume");
  el.title.textContent = tr("Loading…");
  el.sub.textContent = "";
  resetMessagePane(tr("Loading…"));

  try {
    const response = await apiFetch(`/api/session/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderFile(data);
  } catch (error) {
    el.title.textContent = tr("Conversation");
    resetMessagePane(tr("Could not load this conversation: {error}", { error: error.message }));
  }
}

// -------------------------------------------------------------------- render

function renderFile(data) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  state.fileData = data;
  state.agentData = null;
  el.title.textContent = firstUserMessage(messages) || tr("Conversation");
  el.sub.textContent = [data.cwd, data.model, data.provider].filter(Boolean).join(" · ");
  preferences.showConversation(data, `file:${data.id}`);
  proUI?.show(data, `file:${data.id}`);
  renderMessageList(messages, null, { readOnly: true, context: data.context, active: false });
  renderFileControls(data);
  maybeOpenPlan(data.plan);
  renderPlanCard(data);
  if (el.modePicker) renderAgentMode();
}

/**
 * A saved transcript is read-only by nature: nothing is running on the machine.
 * Offer to pick it up in a browser-owned session, which is created on demand.
 */
function renderFileControls(data) {
  el.controls.innerHTML = "";
  el.controls.appendChild(planToggleButton());

  const badge = document.createElement("span");
  badge.className = "badge readonly";
  badge.textContent = tr("Read-only");
  el.controls.appendChild(badge);

  const button = document.createElement("button");
  button.className = "control primary";
  button.textContent = tr("Continue here");
  button.title = tr("Resume this conversation in the browser and keep chatting");
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = tr("Starting…");
    try {
      await continueSession(data.id);
      el.input.focus();
    } catch (error) {
      button.disabled = false;
      button.textContent = tr("Continue here");
      el.sub.textContent = tr("Could not continue this conversation: {error}", { error: error.message });
    }
  });
  el.controls.appendChild(button);
  renderApprovalModeControl(data.approval_mode, async (mode) => {
    const key = await continueSession(data.id);
    await changeApprovalMode(key, mode);
  });

  const remove = document.createElement("button");
  remove.className = "control danger";
  remove.textContent = tr("Delete");
  remove.title = tr("Delete conversation");
  remove.addEventListener("click", () => deleteConversation(data.id, remove));
  el.controls.appendChild(remove);
}

/** Attach to a resumed conversation, creating it server-side when needed. */
async function continueSession(id, selection = preferences.selectionForFile(id), agentMode) {
  const payload = PRO_MODE ? { pro_preset: currentProPreset() } : {
    ...(selection ? { selection } : {}), ...(agentMode ? { agent_mode: agentMode } : {}),
  };
  const response = await apiFetch(`/api/session/${encodeURIComponent(id)}/continue`, {
    method: "POST",
    headers: payload ? { "Content-Type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  await selectLive(body.key);
  return body.key;
}

function setComposerMode(mode) {
  state.composerMode = mode;
  if (el.modePicker) renderAgentMode();
  el.agentActions.classList.add("hidden");
  el.composer.classList.remove("hidden");
  el.input.placeholder = mode === "resume"
    ? tr("Continue this conversation…")
    : mode === "new"
      ? tr("Message Neutrino in this folder…")
      : tr("Message Neutrino…");
  renderComposerAction();
}

function canPauseFromComposer() {
  const selection = state.selection;
  const snapshot = state.snapshot;
  return Boolean(selection?.kind === "live" && snapshot?.key === selection.key
    && snapshot.busy && !snapshot.paused && !el.input.value.trim());
}

function renderComposerAction() {
  const pause = canPauseFromComposer();
  const label = pause ? "Pause" : "Send message";
  el.send.classList.toggle("is-pause", pause);
  el.send.setAttribute("data-i18n-title", label);
  el.send.setAttribute("data-i18n-aria-label", label);
  el.send.title = tr(label);
  el.send.setAttribute("aria-label", tr(label));
}

function hideComposer() {
  preferences.clear();
  el.composer.classList.add("hidden");
  el.agentActions.classList.add("hidden");
  renderApproval(null);
}

function renderApprovalDetails(request, fallbackCwd = "") {
  // The approval renderer is exercised on its own in the browser tests; fall
  // back to the English source if the translation helper is out of scope.
  const tx = (text, values) => (typeof tr === "function"
    ? tr(text, values)
    : String(text).replace(/\{(\w+)\}/g, (match, name) =>
      values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match));
  const details = document.createElement("div");
  details.className = "approval-details";
  const tool = document.createElement("div");
  tool.className = "approval-tool";
  tool.textContent = request.tool || tx("Tool call");
  details.appendChild(tool);

  const cwd = request.cwd || fallbackCwd;
  if (cwd) {
    const location = document.createElement("div");
    location.className = "approval-location";
    location.textContent = tx("Working directory: {path}", { path: cwd });
    details.appendChild(location);
  }

  const args = request.arguments;
  // `reason` is the agent's own justification for asking. It gets its own line so
  // the command block below stays exactly what would run.
  const stated = args && typeof args.reason === "string" ? args.reason.trim() : "";
  const callArgs = args
    ? Object.fromEntries(Object.entries(args).filter(([name]) => name !== "reason"))
    : null;
  const command = callArgs && typeof callArgs.command === "string" ? callArgs.command : null;
  const code = document.createElement("pre");
  code.className = "approval-code";
  // Literal text preserves the complete command and prevents tool arguments
  // from becoming markup. Risk summaries may be shortened; arguments are not.
  code.textContent = command !== null ? command
    : callArgs ? JSON.stringify(callArgs, null, 2) : request.summary || tx("Command details unavailable.");
  details.appendChild(code);

  if (stated) {
    const why = document.createElement("div");
    why.className = "approval-why";
    const label = document.createElement("strong");
    label.textContent = tx("Why: ");
    const claim = document.createElement("span");
    claim.textContent = stated;
    why.append(label, claim);
    details.appendChild(why);
  }

  if (command !== null && Object.keys(callArgs).some(name => name !== "command")) {
    const argumentsBox = document.createElement("details");
    argumentsBox.className = "approval-arguments";
    const label = document.createElement("summary");
    label.textContent = tx("All arguments");
    const parameters = document.createElement("pre");
    parameters.className = "approval-code";
    parameters.textContent = JSON.stringify(callArgs, null, 2);
    argumentsBox.append(label, parameters);
    details.appendChild(argumentsBox);
  }

  if (Array.isArray(request.reasons) && request.reasons.length) {
    const reasons = document.createElement("ul");
    reasons.className = "approval-reasons";
    for (const reason of request.reasons) {
      const item = document.createElement("li");
      item.textContent = reason;
      reasons.appendChild(item);
    }
    details.appendChild(reasons);
  }
  return details;
}

/**
 * Progress text for an automated review. It belongs in the status badge, not
 * in the approval banner: automatic review needs no answer from the user, and
 * reusing the approval card made the browser look like it was still asking for
 * one while the reviewers were already deciding.
 */
function reviewStatus(review) {
  const tx = (text, values) => (typeof tr === "function"
    ? tr(text, values)
    : String(text).replace(/\{(\w+)\}/g, (match, name) =>
      values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match));
  const rounds = Number(review && review.rounds) || 1;
  const total = Number(review && review.total) || 0;
  if (rounds > 1) {
    return tx("reviewing round {round}/{rounds}", { round: (review && review.round) || 1, rounds });
  }
  if (total === 1) return tx("reviewing · {n} reviewer", { n: total });
  if (total > 1) return tx("reviewing · {n} reviewers", { n: total });
  return tx("reviewing");
}

function renderApproval(snapshot) {
  const tx = (text, values) => (typeof tr === "function"
    ? tr(text, values)
    : String(text).replace(/\{(\w+)\}/g, (match, name) =>
      values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match));
  const pending = snapshot && snapshot.approval;
  if (!pending) {
    // The banner is reserved for a call that is really waiting for a human.
    // Automatic review progress lives in the controls badge (see renderControls),
    // because otherwise it reads as a second approval request that then
    // disappears by itself.
    el.approval.className = "approval hidden";
    el.approval.replaceChildren();
    return;
  }
  const extreme = pending.level === "extreme";
  el.approval.className = "approval " + (extreme ? "extreme" : "high");

  const head = document.createElement("div");
  head.className = "approval-head";
  const title = document.createElement("strong");
  title.textContent = tx("Approval required");
  const risk = document.createElement("span");
  risk.className = "approval-risk";
  risk.textContent = extreme ? tx("EXTREME RISK") : tx("HIGH RISK");
  head.append(title, risk);

  const details = renderApprovalDetails(pending, snapshot.cwd);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approve = document.createElement("button");
  approve.className = "approve-btn";
  approve.textContent = tx("Approve");
  approve.addEventListener("click", () => decideApproval(true));
  const deny = document.createElement("button");
  deny.className = "deny-btn";
  deny.textContent = tx("Deny");
  deny.addEventListener("click", () => decideApproval(false));
  actions.append(approve, deny);

  el.approval.replaceChildren(head, details, actions);
}

function decideApproval(approved) {
  const snapshot = state.snapshot;
  if (!snapshot || !snapshot.approval) return;
  postAction(snapshot.key, "approve", { approved });
}

function renderLive() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  renderComposerAction();
  el.header?.classList.toggle("is-thinking", Boolean(snapshot.busy && !snapshot.paused && !snapshot.approval));
  state.fileData = null;
  state.agentData = null;
  el.title.textContent = snapshot.title || tr("New conversation");
  el.sub.textContent = [snapshot.cwd, snapshot.model, snapshot.provider].filter(Boolean).join(" · ");
  preferences.showConversation(snapshot, `live:${snapshot.key}`);
  proUI?.show(snapshot, `live:${snapshot.key}`);
  renderControls(snapshot);
  renderApproval(snapshot);
  renderMessageList(snapshot.messages ?? [], snapshot.streamingContent, {
    readOnly: false,
    context: snapshot.context,
    // The turn in flight must stay readable: only a finished turn folds. A
    // paused turn is unfinished by the user's own choice, so it stays open too.
    active: Boolean(snapshot.busy || snapshot.paused),
  });
  maybeOpenPlan(snapshot.plan);
  renderPlanCard(snapshot);
  if (el.modePicker) renderAgentMode();
}

async function changeApprovalMode(key, mode) {
  const response = await apiFetch(`/api/live/${encodeURIComponent(key)}/approval-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  if (state.selection?.kind === "live" && state.selection.key === key) {
    state.snapshot = body.snapshot;
    renderLive();
  }
}

function renderApprovalModeControl(mode, change) {
  const tx = (text, values) => (typeof tr === "function"
    ? tr(text, values)
    : String(text).replace(/\{(\w+)\}/g, (match, name) =>
      values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match));
  const automatic = mode === "auto";
  const button = document.createElement("button");
  button.className = "control";
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", tx("Auto Approval"));
  button.setAttribute("aria-checked", String(automatic));
  button.textContent = automatic ? tx("Auto Approval") : tx("Request Approval");
  button.title = tx("Switch between requesting approval and automatic review");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await change(automatic ? "request" : "auto");
    } catch (error) {
      el.sub.textContent = tx("Could not change approval mode: {error}", { error: error.message });
    } finally {
      button.disabled = false;
    }
  });
  el.controls.appendChild(button);
}

function renderControls(snapshot) {
  el.controls.innerHTML = "";
  el.controls.appendChild(planToggleButton());
  renderApprovalModeControl(snapshot.approvalMode, mode =>
    changeApprovalMode(snapshot.key, mode));

  const badge = document.createElement("span");
  const mode = snapshot.paused ? "paused" : snapshot.busy ? "busy" : "idle";
  badge.className = `badge ${mode}`;
  // A retried request leaves the session busy but silent: name the retry so the
  // badge does not just say "working" for minutes. The same goes for a
  // sub-agent, whose own messages never reach this transcript. An automated
  // review is reported here too, so it never needs the approval banner.
  const retrying = snapshot.retrying;
  // A pending human decision is an approval, not a review, even if an earlier
  // review callback is still winding down.
  const reviewing = snapshot.approval ? null : snapshot.reviewing;
  const subagent = snapshot.subagent;
  badge.textContent = snapshot.task?.state === "cancelling" ? tr("Stopping tasks…") : snapshot.paused
    ? tr("paused")
    : snapshot.busy
      ? snapshot.compressing
        ? tr("compressing")
        : retrying
          ? tr("retrying {attempt}/{attempts}", { attempt: retrying.attempt, attempts: retrying.attempts })
          : reviewing
            ? reviewStatus(reviewing)
            : subagent
              ? tr("sub-agent: {label}", { label: subagent })
              : tr("working")
      : tr("idle");
  el.controls.appendChild(badge);

  if (snapshot.saveError || snapshot.task?.persistenceError) {
    const warning = document.createElement("span");
    warning.className = "badge paused";
    warning.textContent = tr("History save failed: {error}", { error: snapshot.saveError || snapshot.task?.persistenceError });
    el.controls.appendChild(warning);
  }

  if (snapshot.busy || snapshot.paused) {
    const button = document.createElement("button");
    button.className = "control";
    button.textContent = snapshot.paused ? tr("Resume") : tr("Pause");
    button.addEventListener("click", () => {
      postAction(snapshot.key, snapshot.paused ? "resume" : "pause");
    });
    el.controls.appendChild(button);
  }

  if ((snapshot.messages?.length ?? 0) > 0 || snapshot.busy) {
    const clear = document.createElement("button");
    clear.className = "control danger";
    clear.textContent = tr("Clear");
    clear.title = tr("Clear conversation");
    clear.addEventListener("click", () => clearConversation(snapshot.key));
    el.controls.appendChild(clear);
  }

  if (snapshot.queued) {
    const queued = document.createElement("span");
    queued.className = "queued";
    queued.title = snapshot.queued;
    queued.textContent = tr("queued");
    el.controls.appendChild(queued);
  }

  if (snapshot.tokens && (snapshot.tokens.prompt || snapshot.tokens.completion)) {
    const tokens = document.createElement("span");
    tokens.className = "tokens";
    tokens.textContent = tr("{prompt}→{completion} tok", { prompt: snapshot.tokens.prompt, completion: snapshot.tokens.completion });
    el.controls.appendChild(tokens);
  }
}

function renderMessageList(messages, streaming, options) {
  // Re-rendering swaps the whole list, so remember where the reader was: if
  // they scrolled up to read history, keep them there while tokens stream in.
  const nearBottom = isNearBottom();
  const previousTop = el.messages.scrollTop;
  el.messages.innerHTML = "";

  if (messages.length === 0 && !streaming) {
    const empty = document.createElement("div");
    empty.className = "empty";
    const emptyText = options?.readOnly ? "This conversation is empty." : "Send a message to get started.";
    empty.textContent = typeof tr === "function" ? tr(emptyText) : emptyText;
    el.messages.appendChild(empty);
    return;
  }

  const original = messages.filter(message => message.role !== "system");
  const context = options?.context;
  const end = context && Number.isInteger(context.end) && context.end > 0 &&
    context.end <= original.length && typeof context.summary === "string" && context.summary.trim()
    ? context.end : 0;
  if (end) {
    // Keep user input in place and fold only the AI output between prompts.
    // The disclosures share one expansion state for this compressed prefix.
    const sections = [];
    for (let index = 0; index < end;) {
      if (original[index].role === "user") {
        el.messages.appendChild(renderMessage(original[index], index));
        index++;
        continue;
      }
      const start = index;
      while (index < end && original[index].role !== "user") index++;
      const archived = original.slice(start, index);
      const details = document.createElement("details");
      details.className = "conversation-history";
      const summary = document.createElement("summary");
      summary.textContent = typeof tr === "function"
        ? tr("Earlier conversation · {n} messages", { n: archived.length })
        : `Earlier conversation · ${archived.length} messages`;
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "history-messages";
      details.appendChild(body);
      const populate = () => {
        if (body.childNodes.length) return;
        archived.forEach((message, offset) => body.appendChild(renderMessage(message, start + offset)));
      };
      const sync = (open) => {
        if (details.open !== open) details.open = open;
        if (open) populate();
        else body.replaceChildren();
      };
      sections.push(sync);
      sync(state.openContext === end);
      details.addEventListener("toggle", () => {
        // Detached disclosures can emit a delayed toggle during a stream repaint.
        if (!details.isConnected) return;
        const open = details.open;
        state.openContext = open ? end : null;
        for (const sync of sections) sync(open);
      });
      el.messages.appendChild(details);
    }
  }
  // Render the tail one turn at a time: a finished turn folds its work behind a
  // summary line and keeps its reply; a running one stays fully open. The turn in
  // flight is the last one, so `active` decides its state; a turn cut in half by
  // the compressed prefix is rendered as plain messages instead.
  const turns = turnRanges(original);
  const running = options?.active && turns.length > 0 ? turns[turns.length - 1].start : -1;
  for (const turn of turns) {
    const from = Math.max(turn.start, end);
    if (from >= turn.end) continue;
    const body = original.slice(turn.start, turn.end);
    if (from === turn.start && turn.start !== running && turnFolds(body)) {
      el.messages.appendChild(renderTurnFold(turn.start, body));
      continue;
    }
    for (let index = from; index < turn.end; index++) {
      el.messages.appendChild(renderMessage(original[index], index));
    }
  }

  if (streaming !== null && streaming !== undefined && streaming !== "") {
    const block = renderMessage({ role: "assistant", content: streaming }, -1);
    block.classList.add("streaming");
    el.messages.appendChild(block);
  }

  if (nearBottom) scrollToBottom();
  else el.messages.scrollTop = previousTop;
}

function renderMessage(message, index) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;

  if (message.role === "tool") {
    const details = document.createElement("details");
    details.className = "tool";
    details.dataset.index = String(index);
    if (state.openTools.has(index)) details.open = true;
    details.addEventListener("toggle", () => {
      if (details.open) state.openTools.add(index);
      else state.openTools.delete(index);
    });

    const summary = document.createElement("summary");
    summary.innerHTML =
      '<span class="tool-name">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>' +
      `${escapeHtml(message.name || "tool")}</span>` +
      `<span class="tool-args">${escapeHtml(truncate(safeJson(message.arguments), 120))}</span>`;
    details.appendChild(summary);

    if (message.name === "execute_ts" && typeof message.arguments?.code === "string") {
      const program = document.createElement("pre");
      program.className = "tool-result program-source";
      program.textContent = message.arguments.code;
      details.appendChild(program);
    }
    const result = document.createElement("pre");
    result.className = "tool-result";
    result.textContent = message.result || "(no output)";
    details.appendChild(result);

    article.appendChild(details);
    return article;
  }

  if (message.role === "summary") {
    article.classList.add("summary");
    article.innerHTML =
      `<div class="summary-label">${escapeHtml(tr("Context summary · {n} messages", { n: Number(message.count ?? 0) }))}</div>` +
      `<div class="body">${renderMarkdown(message.content)}</div>`;
    return article;
  }

  const who = message.role === "user" ? tr("You") : "Neutrino";
  article.innerHTML = `<div class="who">${escapeHtml(who)}</div><div class="body">${renderMarkdown(message.content)}</div>`;
  return article;
}

/**
 * A finished turn: its complete user input above the fold, its reply below it.
 * The folded AI messages are rendered on first open and dropped
 * again on close, so a long transcript costs nothing until the reader asks for
 * it. Nothing is lost either way: this is presentation only, and the saved
 * transcript always holds every message.
 */
function renderTurnFold(start, messages) {
  // This renderer is also exercised standalone by the web tests, so it carries
  // an English fallback for the translation helper.
  const tx = (text, values) => (typeof tr === "function"
    ? tr(text, values)
    : String(text).replace(/\{(\w+)\}/g, (match, name) =>
      values && Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match));
  // User input and the reply stay outside the disclosure, in transcript order.
  const reply = turnAnswerIndex(messages);
  const group = document.createElement("div");
  group.className = "turn-group";
  messages.forEach((message, offset) => {
    if (message.role === "user") group.appendChild(renderMessage(message, start + offset));
  });

  const details = document.createElement("details");
  details.className = "turn";
  details.open = state.openTurns.has(start);

  const hidden = messages.filter((message, offset) => message.role !== "user" && offset !== reply).length;
  const summary = document.createElement("summary");
  const chevron = document.createElement("span");
  chevron.className = "turn-chevron";
  chevron.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  const label = document.createElement("span");
  label.className = "turn-label";
  label.textContent = "Neutrino";
  const meta = document.createElement("span");
  meta.className = "turn-meta";
  meta.textContent = tx("{n} of {m} messages folded", { n: hidden, m: messages.length });
  // The hint cannot live in the static text: it says the opposite once open.
  const hint = document.createElement("span");
  hint.className = "turn-hint";
  meta.appendChild(hint);
  summary.appendChild(chevron);
  summary.appendChild(label);
  summary.appendChild(meta);
  details.appendChild(summary);
  group.appendChild(details);

  const syncHint = () => {
    hint.textContent = details.open ? tx(" — click to collapse") : tx(" — click to expand");
  };
  syncHint();

  const body = document.createElement("div");
  body.className = "turn-messages";
  details.appendChild(body);
  const populate = () => {
    if (body.childNodes.length) return;
    messages.forEach((message, offset) => {
      if (message.role === "user" || offset === reply) return;
      body.appendChild(renderMessage(message, start + offset));
    });
  };
  if (details.open) populate();
  details.addEventListener("toggle", () => {
    // Detached disclosures can emit a delayed toggle during a stream repaint.
    if (!details.isConnected) return;
    if (details.open) {
      state.openTurns.add(start);
      populate();
    } else {
      state.openTurns.delete(start);
      body.replaceChildren();
    }
    syncHint();
  });
  // The answer comes with the fold, so a finished exchange ends on its reply
  // even while the work that produced it stays hidden.
  if (reply >= 0) group.appendChild(renderMessage(messages[reply], start + reply));
  return group;
}

function firstUserMessage(messages) {
  for (const message of messages) {
    if (message.role === "user" && message.content) {
      return truncate(message.content.replace(/\s+/g, " ").trim(), 120);
    }
  }
  return "";
}

function isNearBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 90;
}

function scrollToBottom() {
  el.messages.scrollTop = el.messages.scrollHeight;
}

// ------------------------------------------------------------------- actions

async function postAction(key, action, body) {
  try {
    await apiFetch(`/api/live/${encodeURIComponent(key)}/${action}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.error(error);
  }
}

function activateComposer() {
  if (canPauseFromComposer()) return postAction(state.selection.key, "pause");
  return sendMessage();
}

async function sendMessage() {
  try { await agentModePending; } catch (error) { el.sub.textContent = error.message; return; }
  const selection = state.selection;
  if (!selection) return;
  const text = el.input.value;
  if (!text.trim()) return;
  try {
    if (PRO_MODE) await proUI?.flush();
    else await preferences.flush?.();
  } catch (error) { el.sub.textContent = tr(error.message); return; }
  if (state.selection !== selection) return;

  if (selection.kind === "live") {
    el.input.value = "";
    autosize();
    await postAction(selection.key, "message", { text });
    return;
  }

  if (selection.kind === "new") {
    // A workspace landing page: typing starts a fresh conversation there, just
    // like typing on the terminal's start screen.
    el.input.value = "";
    autosize();
    try {
      const created = await createConversation(selection.cwd, preferences.defaultSelection?.());
      await selectLive(created.key);
      setConversationView(true);
      await postAction(created.key, "message", { text });
    } catch (error) {
      el.input.value = text;
      autosize();
      el.sub.textContent = tr("Could not start the conversation: {error}", { error: error.message });
    }
    return;
  }

  // Reading a saved transcript: resume it in the browser, then deliver the text.
  el.input.value = "";
  autosize();
  try {
    const key = await continueSession(selection.id);
    await postAction(key, "message", { text });
  } catch (error) {
    el.input.value = text;
    autosize();
    el.sub.textContent = tr("Could not continue this conversation: {error}", { error: error.message });
  }
}

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
  renderComposerAction();
}

// ------------------------------------------------------- workspaces & dialogs

function renderWorkspaceChrome() {
  if (!el.workspaceLabel) return;
  const workspace = state.workspace;
  el.workspaceLabel.textContent = workspace ? workspaceName(workspace.path) : tr("All directories");
  if (el.workspaceButton) {
    el.workspaceButton.title = workspace ? workspace.path : tr("Working directory");
    el.workspaceButton.classList.toggle("active", Boolean(workspace));
  }
}

function joinPath(parent, name) {
  const separator = String(parent ?? "").includes("\\") ? "\\" : "/";
  return `${String(parent ?? "").replace(/[\\/]+$/, "")}${separator}${name}`;
}

function selectionCwd() {
  const selection = state.selection;
  if (!selection) return "";
  if (selection.kind === "live") return state.snapshot?.cwd || "";
  if (selection.kind === "file") return state.fileData?.cwd || "";
  if (selection.kind === "new") return selection.cwd || "";
  if (selection.kind === "agent") return state.agentData?.cwd || state.workspace?.path || "";
  return "";
}

function confirmAction(message) {
  try {
    return typeof window === "undefined" || typeof window.confirm !== "function" ? true : window.confirm(message);
  } catch {
    return true;
  }
}

function apiError(data, fallback) {
  return tr(data && typeof data.error === "string" ? data.error : fallback);
}

function renderHomeEmpty() {
  el.messages.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.innerHTML =
    '<span class="empty-mark" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<ellipse cx="12" cy="12" rx="9.4" ry="3.8" transform="rotate(-30 12 12)" stroke="currentColor" stroke-width="1.7" />' +
    '<circle cx="12" cy="12" r="3.1" stroke="currentColor" stroke-width="1.7" />' +
    "</svg></span>" +
    `<strong>${escapeHtml(tr("No conversation open"))}</strong>` +
    `<span>${escapeHtml(tr("Choose a conversation from the sidebar to view it."))}</span>`;
  const button = document.createElement("button");
  button.className = "control primary";
  button.type = "button";
  button.textContent = tr("New conversation");
  button.addEventListener("click", () => openNewChatDialog());
  empty.appendChild(button);
  el.messages.appendChild(empty);
}

/** Back to the neutral landing view, with no conversation selected. */
function showHome({ menu = true } = {}) {
  closeStream();
  state.selection = null;
  state.snapshot = null;
  state.fileData = null;
  state.agentData = null;
  state.planOpen = false;
  state.planSeen = "";
  preferences.clear();
  renderSidebar();
  renderWorkspaceChrome();
  el.controls.innerHTML = "";
  renderApproval(null);
  renderPlanCard(null);
  hideComposer();
  el.title.textContent = tr("Select a conversation");
  el.sub.textContent = "";
  renderHomeEmpty();
  if (menu) setConversationView(false);
}

/** Show a folder as an empty workspace ready for its first message. */
function renderWorkspaceLanding(path) {
  if (el.modePicker) { clearAgentModeFeedback(); clearLinkedConversation(); }
  const sameLanding = state.selection?.kind === "new" && state.selection.cwd === path;
  state.selection = { kind: "new", cwd: path };
  state.snapshot = null;
  state.fileData = null;
  state.planOpen = false;
  state.planSeen = "";
  closeStream();
  if (!sameLanding) preferences.clear();
  renderSidebar();
  renderWorkspaceChrome();
  el.controls.innerHTML = "";
  renderApproval(null);
  renderPlanCard(null);
  el.title.textContent = workspaceName(path) || tr("Working directory");
  el.sub.textContent = path;
  setComposerMode("new");
  preferences.showConversation({}, `new:${path}`);
  proUI?.show(null, `new:${path}`);
  el.messages.innerHTML = "";

  const empty = document.createElement("div");
  empty.className = "empty workspace-empty";
  empty.innerHTML =
    '<span class="empty-mark" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z" />' +
    "</svg></span>" +
    `<strong>${escapeHtml(workspaceName(path) || path)}</strong>` +
    `<span class="workspace-path">${escapeHtml(path)}</span>` +
    `<p class="workspace-prompt">${escapeHtml(tr("Type a message below to start a conversation in this folder."))}</p>`;
  const button = document.createElement("button");
  button.className = "control primary";
  button.type = "button";
  button.textContent = tr("New conversation");
  button.addEventListener("click", () => openNewChatDialog({ cwd: path }));
  empty.appendChild(button);
  el.messages.appendChild(empty);
}

/** Open a working directory and make it the active sidebar scope. */
async function openWorkspace(path, { record = true } = {}) {
  const target = String(path ?? "").trim();
  if (!target) return;
  setWorkspace({ path: target });
  renderWorkspaceLanding(target);
  setConversationView(true);
  if (record) {
    try {
      const response = await apiFetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target }),
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && Array.isArray(data.workspaces)) {
        state.workspaces = { ...(state.workspaces ?? {}), workspaces: data.workspaces };
      }
    } catch {
      // Opening the folder still works when remembering it does not.
    }
  }
  await loadOverview({ silent: true });
}

function renderWorkspaceList() {
  if (!el.workspaceList) return;
  el.workspaceList.innerHTML = "";
  const folders = state.workspaces?.workspaces ?? [];
  if (!folders.length) {
    const empty = document.createElement("div");
    empty.className = "empty-side";
    empty.textContent = tr("No recent folders.");
    el.workspaceList.appendChild(empty);
    return;
  }
  for (const folder of folders) {
    const item = document.createElement("button");
    item.className = "workspace-item";
    item.type = "button";
    item.title = folder.path;
    if (state.workspace && pathKey(state.workspace.path) === pathKey(folder.path)) {
      item.classList.add("selected");
    }
    if (!folder.exists) item.classList.add("missing");
    const count = Number(folder.sessions ?? 0);
    item.innerHTML =
      '<span class="workspace-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z" /></svg>' +
      "</span>" +
      `<span class="workspace-info"><strong>${escapeHtml(folder.name || workspaceName(folder.path))}</strong>` +
      `<small>${escapeHtml(shortenPath(folder.path, 3))}</small></span>` +
      `<span class="workspace-count">${escapeHtml(tr("{n} conversations", { n: count }))}</span>`;
    item.addEventListener("click", async () => {
      if (!folder.exists) {
        el.workspaceFeedback.textContent = tr("This folder no longer exists.");
        return;
      }
      el.workspaceDialog.close();
      await openWorkspace(folder.path, { record: false });
    });
    el.workspaceList.appendChild(item);
  }
}

async function openWorkspaceDialog() {
  el.workspaceFeedback.textContent = "";
  if (!el.workspaceDialog.open) el.workspaceDialog.showModal();
  renderWorkspaceList();
  try {
    const response = await apiFetch("/api/workspaces", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
    state.workspaces = data;
    renderWorkspaceList();
  } catch (error) {
    el.workspaceFeedback.textContent = tr("Could not open this folder: {error}", { error: error.message });
  }
}

function renderNewChatRecents() {
  if (!el.newChatRecents) return;
  el.newChatRecents.innerHTML = "";
  const folders = (state.workspaces?.workspaces ?? []).filter((folder) => folder.exists !== false).slice(0, 8);
  if (!folders.length) {
    const empty = document.createElement("span");
    empty.className = "recents-empty";
    empty.textContent = tr("No recent folders.");
    el.newChatRecents.appendChild(empty);
    return;
  }
  for (const folder of folders) {
    const chip = document.createElement("button");
    chip.className = "path-chip";
    chip.type = "button";
    chip.title = folder.path;
    chip.textContent = workspaceName(folder.path) || folder.path;
    if (el.newChatCwd.value.trim() && pathKey(el.newChatCwd.value) === pathKey(folder.path)) {
      chip.classList.add("selected");
    }
    chip.addEventListener("click", () => {
      el.newChatCwd.value = folder.path;
      renderNewChatRecents();
    });
    el.newChatRecents.appendChild(chip);
  }
}

function fillSelect(select, entries, selected) {
  select.replaceChildren();
  for (const entry of entries) {
    const option = document.createElement("option");
    option.value = entry.value;
    option.textContent = entry.label;
    select.appendChild(option);
  }
  select.value = entries.some((entry) => entry.value === selected) ? selected : entries[0]?.value ?? "";
}

function fillNewChatModels(catalog, selectedModel) {
  const provider = catalog.providers.find((entry) => entry.name === el.newChatProvider.value) ?? catalog.providers[0];
  const models = provider?.models ?? [];
  fillSelect(el.newChatModel, models.map((model) => ({
    value: model.name,
    label: model.name + (model.configured ? "" : ` ${tr("(API key missing)")}`),
  })), selectedModel);
}

/** Offer only the levels the chosen model declares, keeping the draft if valid. */
function fillNewChatIntensities(catalog, selected) {
  const provider = catalog.providers.find((entry) => entry.name === el.newChatProvider.value) ?? catalog.providers[0];
  const model = provider?.models.find((entry) => entry.name === el.newChatModel.value);
  const levels = Array.isArray(model?.intensities) && model.intensities.length ? model.intensities : catalog.intensities;
  let wanted = selected;
  if (!levels.includes(wanted)) {
    const fallback = catalog.settings?.default_intensity;
    wanted = levels.includes(fallback) ? fallback : levels.includes("High") ? "High" : levels[0] ?? "";
  }
  fillSelect(el.newChatIntensity, levels.map((value) => ({ value, label: value })), wanted);
}

function updateNewChatNote(catalog) {
  const provider = catalog?.providers.find((entry) => entry.name === el.newChatProvider.value);
  const model = provider?.models.find((entry) => entry.name === el.newChatModel.value);
  if (model && !model.configured) {
    el.newChatNote.textContent = tr("This model has no API key configured. Add one in the terminal model screen, or choose another model.");
  } else {
    el.newChatNote.textContent = "";
  }
}

function renderProNewChatPresets(catalog, selected = catalog.pro?.preset) {
  if (!PRO_MODE) return;
  const select = document.getElementById("new-chat-pro-preset");
  if (!select) return;
  fillSelect(select, (catalog.pro?.presets || []).map(preset => ({
    value: preset.name, label: uiLanguage() === "zh" ? preset.chinese_name || preset.name : preset.name,
  })), selected);
}

/** Relabel the open new-conversation sheet without losing its selections. */
function refreshNewChatTexts() {
  if (!el.newChatDialog?.open) return;
  const catalog = preferences.catalog?.();
  if (!catalog) return;
  const provider = el.newChatProvider.value;
  const model = el.newChatModel.value;
  const intensity = el.newChatIntensity.value;
  const approval = el.newChatApproval.value;
  fillSelect(el.newChatProvider, catalog.providers.map((entry) => ({ value: entry.name, label: entry.name })), provider);
  fillNewChatModels(catalog, model);
  fillNewChatIntensities(catalog, intensity);
  el.newChatApproval.value = approval;
  updateNewChatNote(catalog);
  renderProNewChatPresets(catalog, document.getElementById("new-chat-pro-preset")?.value);
  renderNewChatRecents();
}

async function openNewChatDialog(options = {}) {
  el.newChatFeedback.textContent = "";
  if (!el.newChatDialog.open) el.newChatDialog.showModal();
  let catalog;
  try {
    catalog = await preferences.load();
    const response = await apiFetch("/api/workspaces", { cache: "no-store" });
    if (response.ok) state.workspaces = await response.json();
  } catch (error) {
    el.newChatFeedback.textContent = tr(error.message);
  }
  if (!catalog) return;

  const defaults = catalog.selection;
  fillSelect(el.newChatProvider, catalog.providers.map((provider) => ({ value: provider.name, label: provider.name })), defaults.provider);
  fillNewChatModels(catalog, defaults.model);
  fillNewChatIntensities(catalog, defaults.intensity);
  el.newChatApproval.value = catalog.settings.approval_mode === "auto" ? "auto" : "request";

  const start = String(options.cwd || selectionCwd() || state.workspace?.path || state.workspaces?.cwd || "").trim();
  el.newChatCwd.value = start;
  renderNewChatRecents();
  updateNewChatNote(catalog);
  renderProNewChatPresets(catalog);
  if (typeof el.newChatCwd.focus === "function") el.newChatCwd.focus();
}

async function submitNewChat() {
  if (el.newChatStart.disabled) return;
  const cwd = el.newChatCwd.value.trim();
  if (!cwd) {
    el.newChatFeedback.textContent = tr("working directory is required");
    el.newChatCwd.focus();
    return;
  }
  const selection = {
    provider: el.newChatProvider.value,
    model: el.newChatModel.value,
    intensity: el.newChatIntensity.value,
  };
  el.newChatStart.disabled = true;
  el.newChatStart.textContent = tr("Creating…");
  el.newChatFeedback.textContent = "";
  try {
    const created = await createConversation(cwd, selection, el.newChatApproval.value,
      PRO_MODE ? document.getElementById("new-chat-pro-preset")?.value : undefined);
    el.newChatDialog.close();
    await selectLive(created.key);
    setConversationView(true);
    el.input.focus();
  } catch (error) {
    el.newChatFeedback.textContent = tr("Could not start the conversation: {error}", { error: error.message });
  } finally {
    el.newChatStart.disabled = false;
    el.newChatStart.textContent = tr("Start conversation");
  }
}

/** Create a browser-owned conversation in `cwd` and show all sidebar directories. */
async function createConversation(cwd, selection, approvalMode, proPreset = currentProPreset()) {
  const payload = { cwd };
  if (PRO_MODE) payload.pro_preset = proPreset;
  else {
    payload.agent_mode = currentAgentMode();
    if (selection && selection.provider && selection.model) payload.selection = selection;
  }
  if (approvalMode === "request" || approvalMode === "auto") payload.approval_mode = approvalMode;
  const response = await apiFetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
  setWorkspace(null);
  await loadOverview({ silent: true });
  return data;
}

// ------------------------------------------------------------- folder picker

function renderFolder() {
  if (!el.folderList) return;
  const folder = state.folder;
  el.folderPath.value = folder.path || "";
  el.folderUp.disabled = !folder.parent;
  el.folderUse.disabled = !folder.path || folder.loading;

  el.folderRoots.innerHTML = "";
  for (const root of folder.roots ?? []) {
    const button = document.createElement("button");
    button.className = "root-chip";
    button.type = "button";
    button.textContent = root;
    button.addEventListener("click", () => loadFolder(root));
    el.folderRoots.appendChild(button);
  }

  el.folderList.innerHTML = "";
  const entries = folder.entries ?? [];
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-side";
    empty.textContent = folder.loading ? tr("Loading folders…") : tr("No subfolders.");
    el.folderList.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("button");
    item.className = "folder-item";
    item.type = "button";
    item.title = entry.path;
    item.innerHTML =
      '<span class="folder-item-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z" /></svg>' +
      `</span><span>${escapeHtml(entry.name)}</span>`;
    item.addEventListener("click", () => loadFolder(entry.path));
    if (typeof item.addEventListener === "function") {
      item.addEventListener("dblclick", () => useCurrentFolder());
    }
    el.folderList.appendChild(item);
  }
}

let folderLoadSeq = 0;

async function loadFolder(path) {
  const folder = state.folder;
  const request = ++folderLoadSeq;
  folder.loading = true;
  el.folderFeedback.textContent = tr("Loading folders…");
  el.folderUse.disabled = true;
  try {
    const query = path ? `?path=${encodeURIComponent(path)}` : "";
    const response = await apiFetch(`/api/fs${query}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
    // A slower, older answer must not replace the folder the user is on now.
    if (request !== folderLoadSeq) return;
    state.folder = {
      ...folder,
      loading: false,
      path: data.path,
      parent: data.parent,
      roots: data.roots ?? [],
      entries: data.entries ?? [],
    };
    el.folderFeedback.textContent = "";
    renderFolder();
    if (typeof el.folderPath.focus === "function") el.folderPath.focus();
  } catch (error) {
    if (request !== folderLoadSeq) return;
    folder.loading = false;
    el.folderFeedback.textContent = tr("Could not open this folder: {error}", { error: error.message });
    el.folderUse.disabled = !state.folder.path;
  }
}

function openFolderDialog({ start = "", onPick = null } = {}) {
  state.folder = {
    path: "",
    parent: null,
    roots: [],
    entries: [],
    loading: false,
    onPick,
  };
  el.folderNew.classList.add("hidden");
  el.folderNewName.value = "";
  el.folderFeedback.textContent = "";
  if (!el.folderDialog.open) el.folderDialog.showModal();
  renderFolder();
  const from = String(start || state.workspace?.path || state.workspaces?.cwd || "").trim();
  void loadFolder(from);
}

function useCurrentFolder() {
  const path = state.folder.path;
  if (!path) return;
  const onPick = state.folder.onPick;
  el.folderDialog.close();
  if (typeof onPick === "function") onPick(path);
}

async function createFolderFromDialog() {
  const name = el.folderNewName.value.trim();
  if (!name) {
    el.folderFeedback.textContent = tr("Enter a folder name.");
    el.folderNewName.focus();
    return;
  }
  if (/[\\/]/.test(name)) {
    el.folderFeedback.textContent = tr("folder name cannot contain a path separator");
    return;
  }
  const target = joinPath(state.folder.path, name);
  el.folderNewCreate.disabled = true;
  try {
    const response = await apiFetch("/api/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
    el.folderNew.classList.add("hidden");
    el.folderNewName.value = "";
    await loadFolder(data.path || target);
    el.folderFeedback.textContent = tr("Folder created.");
  } catch (error) {
    el.folderFeedback.textContent = apiError({ error: error.message }, error.message);
  } finally {
    el.folderNewCreate.disabled = false;
  }
}

// -------------------------------------------------------------- plan / usage

function planSignature(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return "";
  return `${plan.goal ?? ""}|${plan.steps.map((step) => step.title ?? "").join("|")}`;
}

function maybeOpenPlan(plan) {
  const signature = planSignature(plan);
  if (signature && signature !== state.planSeen) {
    state.planSeen = signature;
    state.planOpen = true;
  }
}

function planToggleButton() {
  const button = document.createElement("button");
  button.className = "icon-btn plan-toggle";
  button.type = "button";
  button.setAttribute("aria-expanded", String(state.planOpen));
  button.title = state.planOpen ? tr("Hide plan") : tr("Show plan");
  button.setAttribute("aria-label", button.title);
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>';
  button.addEventListener("click", () => {
    state.planOpen = !state.planOpen;
    button.classList.toggle("active", state.planOpen);
    button.setAttribute("aria-expanded", String(state.planOpen));
    button.title = state.planOpen ? tr("Hide plan") : tr("Show plan");
    renderPlanCard(state.snapshot ?? state.fileData ?? null);
  });
  button.classList.toggle("active", state.planOpen);
  return button;
}

function planStatusLabel(status) {
  if (status === "done") return tr("Done");
  if (status === "active") return tr("Active");
  if (status === "failed") return tr("Failed");
  if (status === "blocked") return tr("Blocked");
  if (status === "cancelled") return tr("Cancelled");
  if (status === "skipped") return tr("Skipped");
  return tr("Pending");
}

function renderPlanCard(source) {
  if (!el.planCard) return;
  const plan = source && source.plan && Array.isArray(source.plan.steps) && source.plan.steps.length ? source.plan : null;
  const tokens = source && source.tokens ? source.tokens : null;
  const hasUsage = tokens && (Number(tokens.prompt) > 0 || Number(tokens.completion) > 0);
  if (!state.planOpen || (!plan && !hasUsage)) {
    el.planCard.classList.add("hidden");
    el.planCard.replaceChildren();
    return;
  }

  const card = document.createElement("div");
  card.className = "plan-card-inner";
  const head = document.createElement("div");
  head.className = "plan-card-head";
  const title = document.createElement("strong");
  title.textContent = plan ? tr("Plan") : tr("Usage");
  const close = document.createElement("button");
  close.className = "icon-btn";
  close.type = "button";
  close.setAttribute("aria-label", tr("Close"));
  close.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>';
  close.addEventListener("click", () => {
    state.planOpen = false;
    renderPlanCard(source);
  });
  head.append(title, close);
  card.appendChild(head);

  if (plan) {
    if (plan.goal) {
      const goal = document.createElement("div");
      goal.className = "plan-goal";
      goal.textContent = plan.goal;
      card.appendChild(goal);
    }
    const steps = document.createElement("div");
    steps.className = "plan-steps";
    let done = 0;
    for (const step of plan.steps) {
      const status = ["done", "active", "failed", "pending", "blocked", "cancelled", "skipped"].includes(step.status) ? step.status : "pending";
      if (status === "done") done += 1;
      const row = document.createElement("div");
      row.className = `plan-step ${status}`;
      const node = document.createElement("span");
      node.className = "plan-node";
      node.setAttribute("aria-hidden", "true");
      const body = document.createElement("div");
      body.className = "plan-step-body";
      const stepTitle = document.createElement("strong");
      stepTitle.textContent = step.title || "";
      const stateLabel = document.createElement("span");
      stateLabel.className = "plan-step-state";
      stateLabel.textContent = planStatusLabel(status);
      const titleRow = document.createElement("div");
      titleRow.className = "plan-step-title";
      titleRow.append(stepTitle, stateLabel);
      body.appendChild(titleRow);
      if (step.detail) {
        const detail = document.createElement("div");
        detail.className = "plan-step-detail";
        detail.textContent = step.detail;
        body.appendChild(detail);
      }
      row.append(node, body);
      steps.appendChild(row);
    }
    card.appendChild(steps);
    const meta = document.createElement("div");
    meta.className = "plan-meta";
    const stopped = plan.stopped ? ` · ${tr("Stopped")}` : "";
    meta.textContent = tr("{done} of {total} steps done", { done, total: plan.steps.length }) + stopped;
    card.appendChild(meta);
  }

  if (hasUsage) {
    const usage = document.createElement("div");
    usage.className = "plan-usage";
    const rows = [
      [tr("Prompt"), Number(tokens.prompt)],
      [tr("Completion"), Number(tokens.completion)],
      [tr("Total"), Number(tokens.prompt) + Number(tokens.completion)],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "plan-usage-row";
      const name = document.createElement("span");
      name.textContent = label;
      const count = document.createElement("strong");
      count.textContent = value.toLocaleString(localeTag());
      row.append(name, count);
      usage.appendChild(row);
    }
    card.appendChild(usage);
  }

  el.planCard.replaceChildren(card);
  el.planCard.classList.remove("hidden");
}

// ------------------------------------------------------------------- actions

async function clearConversation(key) {
  try {
    const response = await apiFetch(`/api/live/${encodeURIComponent(key)}/clear`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
    if (state.selection?.kind === "live" && state.selection.key === key) {
      state.snapshot = data.snapshot ?? state.snapshot;
      // The cleared conversation has no transcript file until its next message.
      state.lastSessionId = null;
      state.planOpen = false;
      state.planSeen = "";
      if (state.snapshot) renderLive();
      if (state.snapshot) renderPlanCard(null);
      el.sub.textContent = tr("Conversation cleared.");
    }
  } catch (error) {
    el.sub.textContent = tr("Could not clear this conversation: {error}", { error: error.message });
  }
}

async function deleteConversation(id, button) {
  if (!confirmAction(tr("Delete this conversation? Its saved history will be removed."))) return;
  if (button) button.disabled = true;
  try {
    const response = await apiFetch(`/api/session/${encodeURIComponent(id)}/delete`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
    showHome();
    await loadOverview();
  } catch (error) {
    if (button) button.disabled = false;
    el.sub.textContent = tr("Could not delete this conversation: {error}", { error: error.message });
  }
}

// -------------------------------------------------------------- other agents

const OTHER_AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "opencode", label: "OpenCode" },
];

function agentLabel(agent) {
  return OTHER_AGENTS.find((entry) => entry.id === agent)?.label ?? agent;
}

/** Working directory the other-agent lists are scoped to. */
async function agentsScopeCwd() {
  if (!state.workspaces) {
    try {
      const response = await apiFetch("/api/workspaces", { cache: "no-store" });
      if (response.ok) state.workspaces = await response.json();
    } catch {
      // The dialog can still show a readable error below.
    }
  }
  return state.workspace?.path || selectionCwd() || state.agentData?.cwd || state.workspaces?.cwd || "";
}

function renderAgentList(groups) {
  el.agentsList.innerHTML = "";
  const total = groups.reduce((count, group) => count + group.sessions.length, 0);
  if (total === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-side";
    empty.textContent = tr("No saved sessions from other agents in this folder.");
    el.agentsList.appendChild(empty);
    return;
  }
  for (const group of groups) {
    if (!group.sessions.length) continue;
    const section = document.createElement("section");
    section.className = "agent-section";
    const title = document.createElement("h3");
    title.textContent = group.label;
    section.appendChild(title);
    for (const session of group.sessions) {
      const item = document.createElement("button");
      item.className = "agent-session";
      item.type = "button";
      item.title = session.title || session.id;
      item.innerHTML =
        '<span class="agent-session-body">' +
        `<span class="agent-session-title">${escapeHtml(session.title || tr("Conversation"))}</span>` +
        `<span class="agent-session-meta">${escapeHtml([session.model, formatTime(session.updated_at)].filter(Boolean).join(" · "))}</span>` +
        "</span>";
      item.addEventListener("click", () => {
        el.agentsDialog.close();
        void selectAgentSession(group.id, session.id, session.title || "", group.cwd);
      });
      section.appendChild(item);
    }
    el.agentsList.appendChild(section);
  }
}

async function openAgentsDialog() {
  el.agentsFeedback.textContent = tr("Loading…");
  el.agentsList.innerHTML = "";
  if (!el.agentsDialog.open) el.agentsDialog.showModal();
  const cwd = await agentsScopeCwd();
  el.agentsCwd.textContent = cwd;
  try {
    const groups = await Promise.all(OTHER_AGENTS.map(async (agent) => {
      const response = await apiFetch(`/api/agents/${agent.id}/sessions?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
      return { ...agent, cwd: data.cwd || cwd, sessions: Array.isArray(data.sessions) ? data.sessions : [] };
    }));
    el.agentsFeedback.textContent = "";
    renderAgentList(groups);
  } catch (error) {
    el.agentsFeedback.textContent = tr("Could not load other agents' history: {error}", { error: error.message });
  }
}

function renderAgentView(data) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  const label = agentLabel(state.selection?.agent ?? data.agent ?? "");
  el.title.textContent = state.selection?.title || firstUserMessage(messages) || tr("Conversation");
  el.sub.textContent = [label, data.cwd || state.agentData?.cwd].filter(Boolean).join(" · ");
  renderMessageList(messages, null, { readOnly: true, active: false });
  el.controls.innerHTML = "";
  const badge = document.createElement("span");
  badge.className = "badge readonly";
  badge.textContent = tr("Read-only");
  el.controls.appendChild(badge);
  const source = document.createElement("span");
  source.className = "badge readonly";
  source.textContent = label;
  el.controls.appendChild(source);
  renderApproval(null);
  renderPlanCard(null);
  hideComposer();
  renderAgentMigration(data);
}

function renderAgentMigration(data) {
  el.agentActions.classList.remove("hidden");
  el.agentMigrate.disabled = Boolean(state.agentMigration) || !data.cwd || !data.messages?.length;
  el.agentMigrate.textContent = state.agentMigration === state.selection ? tr("Migrating…") : tr("Migrate session");
}

async function migrateSelectedAgentSession() {
  const selection = state.selection;
  const source = state.agentData;
  if (selection?.kind !== "agent" || !source?.cwd || !source.messages?.length || state.agentMigration) return;
  state.agentMigration = selection;
  el.agentMigrateFeedback.textContent = "";
  renderAgentMigration(source);
  try {
    const payload = { cwd: source.cwd };
    if (PRO_MODE) payload.pro_preset = currentProPreset();
    const response = await apiFetch(`/api/agents/${encodeURIComponent(selection.agent)}/sessions/${encodeURIComponent(selection.id)}/migrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
    if (state.selection === selection) {
      setWorkspace({ path: data.cwd });
      await selectLive(data.key);
      el.input.focus();
    }
    await loadOverview({ silent: true });
  } catch (error) {
    if (state.selection === selection) {
      el.agentMigrateFeedback.textContent = tr("Could not migrate this session: {error}", { error: error.message });
    }
  } finally {
    state.agentMigration = null;
    if (state.selection?.kind === "agent" && state.agentData) renderAgentMigration(state.agentData);
  }
}

async function selectAgentSession(agent, id, title, cwd) {
  const scope = cwd || await agentsScopeCwd();
  closeStream();
  const selection = { kind: "agent", agent, id, title, cwd: scope };
  state.selection = selection;
  state.snapshot = null;
  state.fileData = null;
  state.agentData = null;
  state.planOpen = false;
  state.planSeen = "";
  preferences.clear();
  renderSidebar();
  el.controls.innerHTML = "";
  renderApproval(null);
  renderPlanCard(null);
  hideComposer();
  el.agentMigrateFeedback.textContent = "";
  el.title.textContent = tr("Loading…");
  el.sub.textContent = title || "";
  resetMessagePane(tr("Loading…"));
  setConversationView(true);
  try {
    const response = await apiFetch(`/api/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(id)}?cwd=${encodeURIComponent(scope)}`, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (state.selection !== selection) return;
    if (!response.ok) throw new Error(apiError(data, `HTTP ${response.status}`));
    state.agentData = { ...data, agent, cwd: data.cwd || scope };
    renderAgentView(state.agentData);
  } catch (error) {
    if (state.selection !== selection) return;
    el.title.textContent = title || tr("Conversation");
    el.sub.textContent = tr("Could not load this session: {error}", { error: error.message });
    resetMessagePane(tr("Could not load this session: {error}", { error: error.message }));
  }
}

// ------------------------------------------------------------------ language

function syncLanguageSelects(language) {
  if (el.languageSelect) el.languageSelect.value = language;
  const settingsLanguage = document.getElementById("settings-language");
  if (settingsLanguage) settingsLanguage.value = language;
}

async function changeInterfaceLanguage(language, { persist = true } = {}) {
  const normalized = String(language ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
  setUiLanguage(normalized);
  writeStorage(modeStorageKey("neutrino.language"), normalized);
  applyStaticTranslations();
  syncLanguageSelects(normalized);
  if (state.status) setStatus(state.status.key, state.status.kind);
  preferences.refreshTexts?.();
  proUI?.refresh();
  refreshNewChatTexts();
  renderWorkspaceChrome();
  renderSidebar();
  const kind = state.selection?.kind;
  if (kind === "live" && state.snapshot) renderLive();
  else if (kind === "file" && state.fileData) renderFile(state.fileData);
  else if (kind === "agent" && state.agentData) renderAgentView(state.agentData);
  else if (kind === "new" && state.selection.cwd) renderWorkspaceLanding(state.selection.cwd);
  else if (!state.selection) renderHomeEmpty();
  if (kind === "live") setComposerMode("live");
  else if (kind === "file") setComposerMode("resume");
  else if (kind === "new") setComposerMode("new");
  else if (!state.selection) hideComposer();
  if (persist) {
    try {
      await apiFetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { language: normalized } }),
      });
    } catch (error) {
      console.error(error);
    }
  }
}

function initializeLanguage() {
  const stored = readStorage(modeStorageKey("neutrino.language"));
  if (stored) setUiLanguage(stored);
  applyStaticTranslations();
  syncLanguageSelects(uiLanguage());
  if (state.status) setStatus(state.status.key, state.status.kind);
}

// ------------------------------------------------------------------ pro mode
//
// Both workspaces reuse this console. Clicking the orbit badge on the normal
// console starts a short wordmark curtain; the recorded start time lets /pro
// finish the same animation instead of flashing the freshly loaded page.

const PRO_TRANSITION_KEY = "neutrino.pro.transition";
const PRO_TIP_KEY = "neutrino.pro.tip.dismissed";
const PRO_TRANSITION_FADE_MS = 350; // curtain fade in / fade out
const PRO_TRANSITION_COVER_MS = 450; // navigate once the curtain is fully opaque
const PRO_TRANSITION_HOLD_MS = 3000; // wordmark stays up until 3s after the switch began
const PRO_TRANSITION_RESUME_MS = 8000; // older records are stale and never replayed
const PRO_LOGO_MARK = '<img class="pro-logo-mark" src="/neutrino.png" alt="Neutrino Pro">';

let proTransitionStarted = false;

function proCurtain() {
  const curtain = document.createElement("div");
  curtain.className = "pro-curtain";
  curtain.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.src = "/neutrino-pro.gif";
  image.alt = "";
  curtain.appendChild(image);
  return curtain;
}

/** Timers exist in the browser; the test sandboxes load this file without them. */
function proDelay(callback, ms) {
  if (typeof setTimeout === "function") setTimeout(callback, ms);
}

function startProTransition(target = "/pro") {
  if (PRO_MODE || proTransitionStarted) return;
  proTransitionStarted = true;
  const started = Date.now();
  try {
    sessionStorage.setItem(PRO_TRANSITION_KEY, String(started));
  } catch { /* Storage may be blocked; navigation still works. */ }

  const curtain = proCurtain();
  curtain.style.transition = `opacity ${PRO_TRANSITION_FADE_MS}ms ease`;
  document.body.appendChild(curtain);
  // Commit the transparent first frame, then let the style transition fade in.
  void curtain.offsetWidth;
  curtain.classList.add("pro-curtain-visible");

  proDelay(() => {
    try { location.assign(typeof target === "string" ? target : "/pro"); } catch { location.href = typeof target === "string" ? target : "/pro"; }
  }, PRO_TRANSITION_COVER_MS);
}

/** Remove every switch curtain left in this document. */
function removeProCurtains() {
  if (typeof document.querySelectorAll !== "function") return;
  for (const curtain of document.querySelectorAll(".pro-curtain")) curtain.remove?.();
}

/**
 * Drop the one-shot switch chrome.
 *
 * The curtain lives in the document that navigated away, so the browser's
 * back/forward cache can restore it fully opaque — a Back or Forward would
 * otherwise land on that frozen frame. `clearRecord` stays false while this
 * document is being hidden for /pro: the destination still needs the recorded
 * start time to finish the same animation.
 */
function resetProTransition({ clearRecord = true } = {}) {
  removeProCurtains();
  if (typeof workspaceNavigation !== "undefined") workspaceNavigation = false;
  if (typeof el !== "undefined" && el.modePicker) renderAgentMode();
  document.documentElement?.classList?.remove?.("pro-transitioning");
  proTransitionStarted = false;
  if (!clearRecord) return;
  try { sessionStorage.removeItem(PRO_TRANSITION_KEY); } catch { /* Storage may be blocked. */ }
}

/** Undo the switch chrome when the browser restores either page from bfcache. */
function watchProNavigation() {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  window.addEventListener("pagehide", (event) => {
    if (!event?.persisted) return;
    // The page is entering the back/forward cache: clean the snapshot, but
    // keep the record for the /pro page that is currently loading.
    resetProTransition({ clearRecord: false });
  });
  window.addEventListener("pageshow", (event) => {
    if (!event?.persisted) return;
    // Restored by Back/Forward: any curtain captured in the snapshot is stale.
    resetProTransition();
  });
}

/** Consume a just-recorded switch and finish the animation on /pro. */
function resumeProTransition() {
  if (!PRO_MODE) return;
  let started = 0;
  try { started = Number(sessionStorage.getItem(PRO_TRANSITION_KEY)) || 0; } catch { /* Storage may be blocked. */ }
  // Consume the record even when stale: direct visits never show a curtain.
  if (started) {
    try { sessionStorage.removeItem(PRO_TRANSITION_KEY); } catch { /* Ignore. */ }
  }
  const now = Date.now();
  const age = now - started;
  if (!started || age < 0 || age > PRO_TRANSITION_RESUME_MS) {
    document.documentElement.classList.remove("pro-transitioning");
    return;
  }

  const curtain = proCurtain();
  // Start fully opaque on the first frame so the new page never flashes through.
  curtain.style.transition = "none";
  curtain.style.opacity = "1";
  document.body.appendChild(curtain);
  // The real curtain is up: retire the pre-paint cover from index.html so it
  // cannot remain over the page after the fade completes.
  document.documentElement.classList.remove("pro-transitioning");

  proDelay(() => {
    curtain.style.transition = `opacity ${PRO_TRANSITION_FADE_MS}ms ease`;
    curtain.style.opacity = "0";
    proDelay(() => curtain.remove(), PRO_TRANSITION_FADE_MS);
  }, Math.max(0, started + PRO_TRANSITION_HOLD_MS - now));
}

/** In Pro mode the badge is a static "you are here" mark, not a control. */
function applyProBrand() {
  document.title = "Neutrino Pro";
  if (el.brandName) el.brandName.textContent = "Neutrino Pro";
  const logo = el.brandLogo;
  if (!logo) return;
  logo.innerHTML = PRO_LOGO_MARK;
  logo.classList.add("pro-logo");
  logo.tabIndex = -1;
  // Drop the i18n annotations too, or a language switch restores the tooltip.
  const annotations = ["title", "aria-label", "data-i18n-title", "data-i18n-aria-label"];
  for (const attribute of annotations) logo.removeAttribute?.(attribute);
}

/** The blue tip explains the badge on the normal console; Pro never shows it. */
function initializeProTip() {
  if (PRO_MODE || !el.proTip) return;
  if (readStorage(PRO_TIP_KEY) === "1") return;
  el.proTip.classList.remove("hidden");
  el.proTipClose?.addEventListener("click", () => {
    writeStorage(PRO_TIP_KEY, "1");
    el.proTip.classList.add("hidden");
  });
}

/** The Pro workspace's top-right escape hatch back to the regular console. */
function initializeProExit() {
  if (!el.proExit) return;
  el.proExit.classList.remove("hidden");
  el.proExit.addEventListener("click", () => {
    el.proExit.disabled = true;
    try {
      location.assign("/");
    } catch {
      location.href = "/";
    }
  });
}

/** Wire the shared brand and either start the switch or resume its animation. */
function initializeProWorkspace() {
  watchProNavigation();
  if (PRO_MODE) {
    applyProBrand();
    initializeProExit();
    resumeProTransition();
    return;
  }
  // A switch that was interrupted (Stop, Back, a failed navigation) can leave
  // the record and the pre-paint cover behind. Neither may ever affect the
  // regular console, so clear them before wiring the badge.
  resetProTransition();
  el.brandLogo?.addEventListener("click", () => startProTransition());
  initializeProTip();
}

// --------------------------------------------------------------------- init

el.refresh.addEventListener("click", () => loadOverview());
el.back.addEventListener("click", () => setConversationView(false));
el.send.addEventListener("click", activateComposer);
el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

el.newChat.addEventListener("click", () => openNewChatDialog());
if (el.emptyNewChat) el.emptyNewChat.addEventListener("click", () => openNewChatDialog());
el.workspaceButton.addEventListener("click", openWorkspaceDialog);
el.workspaceClose.addEventListener("click", () => el.workspaceDialog.close());
el.workspaceAll.addEventListener("click", () => {
  el.workspaceDialog.close();
  setWorkspace(null);
  showHome();
});
el.workspaceAdd.addEventListener("click", () => {
  el.workspaceDialog.close();
  openFolderDialog({ start: state.workspace?.path || state.workspaces?.cwd || "", onPick: (path) => openWorkspace(path) });
});
el.agentsOpen.addEventListener("click", () => openAgentsDialog());
el.agentMigrate.addEventListener("click", () => migrateSelectedAgentSession());
el.agentsClose.addEventListener("click", () => el.agentsDialog.close());
el.agentsDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  el.agentsDialog.close();
});
el.languageSelect?.addEventListener("change", () => changeInterfaceLanguage(el.languageSelect.value));

el.newChatClose.addEventListener("click", () => el.newChatDialog.close());
el.newChatCancel.addEventListener("click", () => el.newChatDialog.close());
el.newChatDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  el.newChatDialog.close();
});
el.newChatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  submitNewChat();
});
el.newChatBrowse.addEventListener("click", () => {
  openFolderDialog({
    start: el.newChatCwd.value.trim() || state.workspace?.path || "",
    onPick: (path) => {
      el.newChatCwd.value = path;
      renderNewChatRecents();
    },
  });
});
el.newChatCwd.addEventListener("input", renderNewChatRecents);
el.newChatProvider.addEventListener("change", () => {
  const catalog = preferences.catalog?.();
  if (catalog) {
    fillNewChatModels(catalog, "");
    fillNewChatIntensities(catalog, el.newChatIntensity.value);
    updateNewChatNote(catalog);
  }
});
el.newChatModel.addEventListener("change", () => {
  const catalog = preferences.catalog?.();
  if (catalog) {
    fillNewChatIntensities(catalog, el.newChatIntensity.value);
    updateNewChatNote(catalog);
  }
});

el.folderClose.addEventListener("click", () => el.folderDialog.close());
el.folderCancel.addEventListener("click", () => el.folderDialog.close());
el.folderUse.addEventListener("click", useCurrentFolder);
el.folderUp.addEventListener("click", () => {
  if (state.folder.parent) void loadFolder(state.folder.parent);
});
el.folderGo.addEventListener("click", () => void loadFolder(el.folderPath.value.trim()));
el.folderPath.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void loadFolder(el.folderPath.value.trim());
  }
});
el.folderMkdir.addEventListener("click", () => {
  el.folderNew.classList.remove("hidden");
  el.folderFeedback.textContent = "";
  el.folderNewName.value = "";
  el.folderNewName.focus();
});
el.folderNewCreate.addEventListener("click", () => void createFolderFromDialog());
el.folderNewCancel.addEventListener("click", () => el.folderNew.classList.add("hidden"));
el.folderNewName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void createFolderFromDialog();
  }
  if (event.key === "Escape") el.folderNew.classList.add("hidden");
});
el.folderDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  el.folderDialog.close();
});

window.addEventListener("beforeunload", closeStream);
// On the phone layout the browser's Back and Forward buttons walk the same
// levels as the header's back arrow: an open conversation returns to the list.
window.addEventListener("popstate", followViewHistory);
watchPanes();
forgetStaleConversationEntry();

initializeLanguage();
initializeProWorkspace();
initializeAgentMode();
preferences.load()
  .then(async (config) => {
    const language = config?.settings?.language;
    if (language && language !== uiLanguage()) {
      await changeInterfaceLanguage(language, { persist: false });
    }
    // The announcement stream needs the login cookie, so it opens once the
    // settings payload has loaded. A release it reports right away opens the
    // notice; one that lands while the background invitation is up waits for it
    // to close, because two modal dialogs must never stack on top of each other.
    openUpdateEvents();
    maybePromptBackground(config);
  })
  .catch(error => console.error(error));
loadSeen().then(() => loadOverview()).then(async () => {
  if (await openLinkedConversation()) return;
  // Reopen the folder the user had open last time, without stealing a click
  // that landed on a saved conversation while the overview was loading.
  if (state.workspace && !state.selection) renderWorkspaceLanding(state.workspace.path);
});
setInterval(() => loadOverview({ silent: true }), REFRESH_MS);
