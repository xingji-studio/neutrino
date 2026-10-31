import { createSettingsUI } from "./settings.js";
import { turnAnswerIndex, turnFolds, turnPreview, turnRanges } from "./turns.js";

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
  const response = await fetch(path, { ...init, credentials: "same-origin" });
  if (response.status === 401) {
    showGate();
    throw new Error("Password login required.");
  }
  return response;
}

let gateShown = false;

function showGate(message = "") {
  if (gateShown) return;
  gateShown = true;
  closeStream();
  setStatus("locked", "offline");
  document.getElementById("settings-dialog").close();

  // A modal dialog stays above streaming repaints and traps keyboard focus.
  const gate = document.createElement("dialog");
  gate.className = "gate";
  gate.setAttribute("aria-labelledby", "login-title");
  gate.innerHTML =
    '<form class="gate-card">' +
    '<h2 id="login-title">Sign in to Neutrino</h2>' +
    '<p>Enter your Web password. The default password is 114514.</p>' +
    '<label for="login-password">Password</label>' +
    '<input id="login-password" name="password" type="password" autocomplete="current-password" maxlength="256" required autofocus>' +
    '<p class="form-feedback error" role="alert"></p>' +
    '<button class="primary" type="submit">Sign in</button>' +
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

const el = {
  app: document.getElementById("app"),
  back: document.getElementById("back-to-menu"),
  sessions: document.getElementById("sessions"),
  status: document.getElementById("status"),
  refresh: document.getElementById("refresh"),
  title: document.getElementById("session-title"),
  sub: document.getElementById("session-sub"),
  controls: document.getElementById("controls"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  approval: document.getElementById("approval"),
};

const state = {
  overview: null,
  // { kind: "live", key } | { kind: "file", id } | null
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
};

const preferences = createSettingsUI({
  apiFetch,
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
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function setStatus(text, kind) {
  el.status.textContent = text;
  el.status.className = `status${kind ? ` ${kind}` : ""}`;
}

// A deliberately small markdown renderer: code fences, inline code, bold,
// italics and links. Everything else is escaped, so model output is inert.
function renderMarkdown(value) {
  const placeholders = [];
  let source = String(value ?? "");
  source = source.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    const id = `\u0000CODE${placeholders.length}\u0000`;
    placeholders.push(`<pre class="code"><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return id;
  });
  source = escapeHtml(source);
  source = source.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  source = source.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  source = source.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  source = source.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  source = source.replace(/\n/g, "<br>");
  source = source.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => placeholders[Number(index)] ?? "");
  return source;
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
  el.title.textContent = "Session ended";
  el.sub.textContent = "The terminal session was closed.";
  el.messages.innerHTML = '<div class="empty">This live session has ended.</div>';
}

// ------------------------------------------------------------------ sidebar

function renderSidebar() {
  const overview = state.overview;
  el.sessions.innerHTML = "";

  if (!overview || overview.groups.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-side";
    empty.textContent = "No conversations yet.";
    el.sessions.appendChild(empty);
    return;
  }

  for (const group of overview.groups) {
    el.sessions.appendChild(renderGroup(group));
  }
}

function renderGroup(group) {
  const wrap = document.createElement("section");
  wrap.className = "group";

  const collapsed = state.collapsed.has(group.key);
  const header = document.createElement("button");
  header.className = "group-header";
  header.innerHTML =
    `<span class="chevron">${collapsed ? "▸" : "▾"}</span>` +
    `<span class="path" title="${escapeHtml(group.cwd)}">${escapeHtml(group.cwd)}</span>` +
    `<span class="count">${group.sessions.length}</span>`;
  header.addEventListener("click", () => {
    if (state.collapsed.has(group.key)) state.collapsed.delete(group.key);
    else state.collapsed.add(group.key);
    renderSidebar();
  });
  wrap.appendChild(header);

  if (collapsed) return wrap;

  const list = document.createElement("div");
  list.className = "group-items";
  const expanded = state.expanded.has(group.key);
  const visible = expanded ? group.sessions : group.sessions.slice(0, MAX_VISIBLE);
  for (const session of visible) list.appendChild(renderSession(session));

  const hiddenCount = group.sessions.length - MAX_VISIBLE;
  if (hiddenCount > 0) {
    const more = document.createElement("button");
    more.className = "more";
    more.textContent = expanded ? "Show less" : `Show ${hiddenCount} more`;
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

function isSelected(session) {
  const selection = state.selection;
  if (!selection) return false;
  if (selection.kind === "live") return Boolean(session.liveKey) && selection.key === session.liveKey;
  return !session.liveKey && session.id === selection.id;
}

function renderSession(session) {
  const item = document.createElement("button");
  item.className = "session";
  if (isSelected(session)) item.classList.add("selected");
  if (session.live) item.classList.add("live");

  const title = session.title || "New conversation";
  item.innerHTML =
    `<div class="session-top"><span class="session-title">${escapeHtml(title)}</span>` +
    `${session.live ? '<span class="dot" title="Live"></span>' : ""}</div>` +
    `<div class="session-meta"><span class="model">${escapeHtml(session.model || "?")}</span>` +
    `<span class="time">${escapeHtml(formatTime(session.updated_at))}</span>` +
    `<span class="count">${Number(session.message_count ?? 0)} msg</span></div>`;

  item.addEventListener("click", () => {
    if (session.liveKey) selectLive(session.liveKey);
    else if (session.id) selectFile(session.id);
    else return;
    setConversationView(true);
  });
  return item;
}

// ------------------------------------------------------------------- select

// Only explicit navigation changes the mobile pane. Background refreshes and
// live-to-saved transitions must not take the user away from the menu.
function setConversationView(open) {
  el.app.classList.toggle("conversation-open", open);
  if (!window.matchMedia("(max-width: 760px)").matches) return;
  if (open) el.back.focus();
  else (el.sessions.querySelector(".session.selected") || el.refresh).focus();
}

function resetMessagePane(text) {
  el.messages.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  el.messages.appendChild(empty);
}

async function selectLive(key) {
  preferences.clear();
  closeStream();
  state.selection = { kind: "live", key };
  state.snapshot = null;
  state.lastSessionId = null;
  state.openTools.clear();
  state.openTurns.clear();
  state.openContext = null;
  renderSidebar();
  el.controls.innerHTML = "";
  el.title.textContent = "Connecting…";
  el.sub.textContent = "";
  setComposerMode("live");
  resetMessagePane("Connecting…");
  openStream(key);
}

function openStream(key) {
  closeStream();
  const source = new EventSource(`/api/live/${encodeURIComponent(key)}/stream`);
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
  });

  source.addEventListener("gone", () => {
    closeStream();
    syncSelection();
  });

  source.onopen = () => setStatus("live", "live");
  source.onerror = () => {
    // EventSource retries automatically; just surface the state.
    setStatus("reconnecting…", "offline");
  };
}

function closeStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
}

async function selectFile(id) {
  preferences.clear();
  closeStream();
  state.selection = { kind: "file", id };
  state.snapshot = null;
  state.openTools.clear();
  state.openTurns.clear();
  state.openContext = null;
  renderSidebar();
  el.controls.innerHTML = "";
  setComposerMode("resume");
  el.title.textContent = "Loading…";
  el.sub.textContent = "";
  resetMessagePane("Loading…");

  try {
    const response = await apiFetch(`/api/session/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    renderFile(data);
  } catch (error) {
    el.title.textContent = "Conversation";
    resetMessagePane(`Could not load this conversation: ${error.message}`);
  }
}

// -------------------------------------------------------------------- render

function renderFile(data) {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  el.title.textContent = firstUserMessage(messages) || "Conversation";
  el.sub.textContent = [data.cwd, data.model, data.provider].filter(Boolean).join(" · ");
  preferences.showConversation(data, `file:${data.id}`);
  renderMessageList(messages, null, { readOnly: true, context: data.context, active: false });
  renderFileControls(data);
}

/**
 * A saved transcript is read-only by nature: nothing is running on the machine.
 * Offer to pick it up in a browser-owned session, which is created on demand.
 */
function renderFileControls(data) {
  el.controls.innerHTML = "";

  const badge = document.createElement("span");
  badge.className = "badge readonly";
  badge.textContent = "read-only";
  el.controls.appendChild(badge);

  const button = document.createElement("button");
  button.className = "control primary";
  button.textContent = "✎ Continue here";
  button.title = "Resume this conversation in the browser and keep chatting";
  button.addEventListener("click", async () => {
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      await continueSession(data.id);
      el.input.focus();
    } catch (error) {
      button.disabled = false;
      button.textContent = "✎ Continue here";
      el.sub.textContent = `Could not continue this conversation: ${error.message}`;
    }
  });
  el.controls.appendChild(button);
  renderApprovalModeControl(data.approval_mode, async (mode) => {
    const key = await continueSession(data.id);
    await changeApprovalMode(key, mode);
  });
}

/** Attach to a resumed conversation, creating it server-side when needed. */
async function continueSession(id, selection = preferences.selectionForFile(id)) {
  const response = await apiFetch(`/api/session/${encodeURIComponent(id)}/continue`, {
    method: "POST",
    headers: selection ? { "Content-Type": "application/json" } : undefined,
    body: selection ? JSON.stringify({ selection }) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  await selectLive(body.key);
  return body.key;
}

function setComposerMode(mode) {
  el.composer.classList.remove("hidden");
  el.input.placeholder =
    mode === "resume"
      ? "Continue this conversation… (Enter to send)"
      : "Message the agent… (Enter to send, Shift+Enter for a new line)";
}

function hideComposer() {
  preferences.clear();
  el.composer.classList.add("hidden");
  renderApproval(null);
}

function renderApprovalDetails(request, fallbackCwd = "") {
  const details = document.createElement("div");
  details.className = "approval-details";
  const tool = document.createElement("div");
  tool.className = "approval-tool";
  tool.textContent = request.tool || "Tool call";
  details.appendChild(tool);

  const cwd = request.cwd || fallbackCwd;
  if (cwd) {
    const location = document.createElement("div");
    location.className = "approval-location";
    location.textContent = `Working directory: ${cwd}`;
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
    : callArgs ? JSON.stringify(callArgs, null, 2) : request.summary || "Command details unavailable.";
  details.appendChild(code);

  if (stated) {
    const why = document.createElement("div");
    why.className = "approval-why";
    const label = document.createElement("strong");
    label.textContent = "Why: ";
    const claim = document.createElement("span");
    claim.textContent = stated;
    why.append(label, claim);
    details.appendChild(why);
  }

  if (command !== null && Object.keys(callArgs).some(name => name !== "command")) {
    const argumentsBox = document.createElement("details");
    argumentsBox.className = "approval-arguments";
    const label = document.createElement("summary");
    label.textContent = "All arguments";
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

function renderApproval(snapshot) {
  const pending = snapshot && snapshot.approval;
  if (!pending) {
    // An automated review runs before a card exists, so without this the tab
    // just looks stuck for however long the reviewers take.
    const review = snapshot && snapshot.reviewing;
    if (review) {
      el.approval.className = "approval high";
      const head = document.createElement("div");
      head.className = "approval-head";
      const title = document.createElement("strong");
      title.textContent = "Independent review";
      const note = document.createElement("span");
      note.className = "approval-risk";
      // Delete-class calls report which of the three separate rounds is running.
      const rounds = review.rounds || 1;
      const which = rounds > 1 ? `round ${review.round || 1} of ${rounds}, ` : "";
      note.textContent = `${which}${review.total} reviewer${review.total > 1 ? "s" : ""}`;
      head.append(title, note);
      if (review.request) {
        el.approval.replaceChildren(head, renderApprovalDetails(review.request, snapshot.cwd));
      } else {
        el.approval.replaceChildren(head);
      }
      return;
    }
    el.approval.classList.add("hidden");
    el.approval.replaceChildren();
    return;
  }
  const extreme = pending.level === "extreme";
  el.approval.className = "approval " + (extreme ? "extreme" : "high");

  const head = document.createElement("div");
  head.className = "approval-head";
  const title = document.createElement("strong");
  title.textContent = "Request Approval";
  const risk = document.createElement("span");
  risk.className = "approval-risk";
  risk.textContent = extreme ? "EXTREME RISK" : "HIGH RISK";
  head.append(title, risk);

  const details = renderApprovalDetails(pending, snapshot.cwd);

  const actions = document.createElement("div");
  actions.className = "approval-actions";
  const approve = document.createElement("button");
  approve.className = "approve-btn";
  approve.textContent = "Approve";
  approve.addEventListener("click", () => decideApproval(true));
  const deny = document.createElement("button");
  deny.className = "deny-btn";
  deny.textContent = "Deny";
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
  el.title.textContent = snapshot.title || "New conversation";
  el.sub.textContent = [snapshot.cwd, snapshot.model, snapshot.provider].filter(Boolean).join(" · ");
  preferences.showConversation(snapshot, `live:${snapshot.key}`);
  renderControls(snapshot);
  renderApproval(snapshot);
  renderMessageList(snapshot.messages ?? [], snapshot.streamingContent, {
    readOnly: false,
    context: snapshot.context,
    // The turn in flight must stay readable: only a finished turn folds. A
    // paused turn is unfinished by the user's own choice, so it stays open too.
    active: Boolean(snapshot.busy || snapshot.paused),
  });
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
  const automatic = mode === "auto";
  const button = document.createElement("button");
  button.className = "control";
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", "Auto Approval");
  button.setAttribute("aria-checked", String(automatic));
  button.textContent = automatic ? "Auto Approval" : "Request Approval";
  button.title = "Switch between requesting approval and automatic review";
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await change(automatic ? "request" : "auto");
    } catch (error) {
      el.sub.textContent = `Could not change approval mode: ${error.message}`;
    } finally {
      button.disabled = false;
    }
  });
  el.controls.appendChild(button);
}

function renderControls(snapshot) {
  el.controls.innerHTML = "";
  renderApprovalModeControl(snapshot.approvalMode, mode =>
    changeApprovalMode(snapshot.key, mode));

  const badge = document.createElement("span");
  const mode = snapshot.paused ? "paused" : snapshot.busy ? "busy" : "idle";
  badge.className = `badge ${mode}`;
  // A retried request leaves the session busy but silent: name the retry so the
  // badge does not just say "working" for minutes.
  const retrying = snapshot.retrying;
  badge.textContent = snapshot.paused
    ? "paused"
    : snapshot.busy
      ? snapshot.compressing
        ? "compressing"
        : retrying
          ? `retrying ${retrying.attempt}/${retrying.attempts}`
          : "working"
      : "idle";
  el.controls.appendChild(badge);

  if (snapshot.saveError) {
    const warning = document.createElement("span");
    warning.className = "badge paused";
    warning.textContent = `History save failed: ${snapshot.saveError}`;
    el.controls.appendChild(warning);
  }

  if (snapshot.busy || snapshot.paused) {
    const button = document.createElement("button");
    button.className = "control";
    button.textContent = snapshot.paused ? "▶ Resume" : "❚❚ Pause";
    button.addEventListener("click", () => {
      postAction(snapshot.key, snapshot.paused ? "resume" : "pause");
    });
    el.controls.appendChild(button);
  }

  if (snapshot.queued) {
    const queued = document.createElement("span");
    queued.className = "queued";
    queued.title = snapshot.queued;
    queued.textContent = "queued";
    el.controls.appendChild(queued);
  }

  if (snapshot.tokens && (snapshot.tokens.prompt || snapshot.tokens.completion)) {
    const tokens = document.createElement("span");
    tokens.className = "tokens";
    tokens.textContent = `${snapshot.tokens.prompt}→${snapshot.tokens.completion} tok`;
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
    empty.textContent = options?.readOnly ? "This conversation is empty." : "Say something to get started.";
    el.messages.appendChild(empty);
    return;
  }

  const original = messages.filter(message => message.role !== "system");
  const context = options?.context;
  const end = context && Number.isInteger(context.end) && context.end > 0 &&
    context.end <= original.length && typeof context.summary === "string" && context.summary.trim()
    ? context.end : 0;
  if (end) {
    const details = document.createElement("details");
    details.className = "conversation-history";
    const summary = document.createElement("summary");
    summary.textContent = `Earlier conversation · ${end} messages`;
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "history-messages";
    details.appendChild(body);
    const populate = () => {
      if (body.childNodes.length) return;
      original.slice(0, end).forEach((message, index) => body.appendChild(renderMessage(message, index)));
    };
    details.open = state.openContext === end;
    if (details.open) populate();
    details.addEventListener("toggle", () => {
      // Detached disclosures can emit a delayed toggle during a stream repaint.
      if (!details.isConnected) return;
      state.openContext = details.open ? end : null;
      if (details.open) populate();
      else body.replaceChildren();
    });
    el.messages.appendChild(details);
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
      `<span class="tool-name">⚙ ${escapeHtml(message.name || "tool")}</span>` +
      `<span class="tool-args">${escapeHtml(truncate(safeJson(message.arguments), 120))}</span>`;
    details.appendChild(summary);

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
      `<div class="summary-label">Context summary · ${Number(message.count ?? 0)} messages</div>` +
      `<div class="body">${renderMarkdown(message.content)}</div>`;
    return article;
  }

  const who = message.role === "user" ? "You" : "Neutrino";
  article.innerHTML = `<div class="who">${who}</div><div class="body">${renderMarkdown(message.content)}</div>`;
  return article;
}

/**
 * A finished turn: its work folded behind one control line, its reply always on
 * screen below it. The folded messages are rendered on first open and dropped
 * again on close, so a long transcript costs nothing until the reader asks for
 * it. Nothing is lost either way: this is presentation only, and the saved
 * transcript always holds every message.
 */
function renderTurnFold(start, messages) {
  // The reply is never folded away, so a turn renders as a group: the fold (the
  // prompt line plus the work it hides) and, right below it, the answer itself.
  const reply = turnAnswerIndex(messages);
  const group = document.createElement("div");
  group.className = "turn-group";

  const details = document.createElement("details");
  details.className = "turn";
  details.open = state.openTurns.has(start);

  const hidden = reply < 0 ? messages.length : messages.length - 1;
  const summary = document.createElement("summary");
  const chevron = document.createElement("span");
  chevron.className = "turn-chevron";
  chevron.textContent = "▸";
  const you = document.createElement("span");
  you.className = "turn-you";
  you.textContent = `You: ${truncate(turnPreview(messages, "user"), 110)}`;
  const meta = document.createElement("span");
  meta.className = "turn-meta";
  meta.textContent = `${hidden} of ${messages.length} message${messages.length === 1 ? "" : "s"} folded`;
  // The hint cannot live in the static text: it says the opposite once open.
  const hint = document.createElement("span");
  hint.className = "turn-hint";
  meta.appendChild(hint);
  summary.appendChild(chevron);
  summary.appendChild(you);
  summary.appendChild(meta);
  details.appendChild(summary);
  group.appendChild(details);

  const syncHint = () => {
    hint.textContent = details.open ? " — click to collapse" : " — click to expand";
  };
  syncHint();

  const body = document.createElement("div");
  body.className = "turn-messages";
  details.appendChild(body);
  const populate = () => {
    if (body.childNodes.length) return;
    messages.forEach((message, offset) => {
      if (offset === reply) return; // the answer is never inside the fold
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

async function sendMessage() {
  const selection = state.selection;
  if (!selection) return;
  const text = el.input.value;
  if (!text.trim()) return;

  if (selection.kind === "live") {
    el.input.value = "";
    autosize();
    await postAction(selection.key, "message", { text });
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
    el.sub.textContent = `Could not continue this conversation: ${error.message}`;
  }
}

function autosize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

// --------------------------------------------------------------------- init

el.refresh.addEventListener("click", () => loadOverview());
el.back.addEventListener("click", () => setConversationView(false));
el.send.addEventListener("click", sendMessage);
el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

window.addEventListener("beforeunload", closeStream);

preferences.load().catch(error => console.error(error));
loadOverview();
setInterval(() => loadOverview({ silent: true }), REFRESH_MS);
