// Neutrino web UI — a dependency-free single page app.
//
// It talks to four endpoints:
//   GET  /api/overview                      every saved conversation grouped by cwd
//   GET  /api/session/:id                   one saved transcript
//   GET  /api/live/:key/stream              SSE stream of a running conversation
//   POST /api/live/:key/{pause|resume|message}
//
// The sidebar is refreshed on a timer; the open live conversation is pushed
// over SSE so tokens appear as they are generated.

const MAX_VISIBLE = 5;
const REFRESH_MS = 4000;

// -------------------------------------------------------------------- access
//
// The server may require a token. It arrives once in the URL printed by the
// terminal (`?t=…`) and is then kept in localStorage, because typing a
// 32-character secret on a phone is not something anyone should have to do.
// It is stripped from the address bar so that reloading, bookmarking or
// sharing a screenshot cannot leak it.
const TOKEN_KEY = "neutrino.token";

const token = (() => {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("t") || params.get("token");
  if (fromUrl) {
    params.delete("t");
    params.delete("token");
    const query = params.toString();
    try {
      history.replaceState(null, "", location.pathname + (query ? `?${query}` : "") + location.hash);
    } catch {
      // Cosmetic only — a browser that refuses this still works.
    }
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // Storage may be blocked; the token is still in memory for this page.
    }
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
})();

/** Append the token to a URL, for the cases where a header is impossible. */
function withToken(path) {
  if (!token) return path;
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(token)}`;
}

/**
 * fetch() that authenticates.
 *
 * EventSource cannot set headers, so the SSE stream gets the token in its query
 * string; everything else uses a header so it stays out of logs.
 */
async function apiFetch(path, init = {}) {
  const headers = new Headers(init.headers || undefined);
  if (token) headers.set("X-Neutrino-Token", token);
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    showGate();
    throw new Error("HTTP 401 (access token required)");
  }
  return response;
}

let gateShown = false;

/** Ask for the token instead of leaving a blank page behind a 401. */
function showGate() {
  if (gateShown) return;
  gateShown = true;
  closeStream();
  setStatus("locked", "offline");

  const gate = document.createElement("div");
  gate.className = "gate";
  gate.innerHTML =
    '<form class="gate-card">' +
    "<h2>Access token required</h2>" +
    "<p>Open the URL printed by the terminal — it ends in <code>?t=…</code> — or paste the token below.</p>" +
    '<input type="password" autocomplete="off" spellcheck="false" placeholder="access token">' +
    '<button class="primary" type="submit">Unlock</button>' +
    "</form>";

  gate.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = gate.querySelector("input").value.trim();
    if (!value) return;
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      // Nothing we can do; the reload will simply ask again.
    }
    location.reload();
  });

  document.body.appendChild(gate);
  gate.querySelector("input").focus();
}

const el = {
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
};

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
    state.overview = await response.json();
    setStatus(state.selection?.kind === "live" ? "live" : "online", state.selection?.kind === "live" ? "live" : "online");
    renderSidebar();
    syncSelection();
  } catch (error) {
    setStatus("offline", "offline");
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
  });
  return item;
}

// ------------------------------------------------------------------- select

function resetMessagePane(text) {
  el.messages.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = text;
  el.messages.appendChild(empty);
}

async function selectLive(key) {
  closeStream();
  state.selection = { kind: "live", key };
  state.snapshot = null;
  state.lastSessionId = null;
  state.openTools.clear();
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
  const source = new EventSource(withToken(`/api/live/${encodeURIComponent(key)}/stream`));
  state.eventSource = source;

  source.addEventListener("snapshot", (event) => {
    let snapshot;
    try {
      snapshot = JSON.parse(event.data);
    } catch {
      return;
    }
    state.snapshot = snapshot;
    if (snapshot.sessionId) state.lastSessionId = snapshot.sessionId;
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
  closeStream();
  state.selection = { kind: "file", id };
  state.snapshot = null;
  state.openTools.clear();
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
  renderMessageList(messages, null, { readOnly: true });
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
}

/** Attach to a resumed conversation, creating it server-side when needed. */
async function continueSession(id) {
  const response = await apiFetch(`/api/session/${encodeURIComponent(id)}/continue`, {
    method: "POST",
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
  hideComposer();
  renderApproval(null);
}

function renderApproval(snapshot) {
  const pending = snapshot && snapshot.approval;
  if (!pending) {
    // An automated review runs before a card exists, so without this the tab
    // just looks stuck for however long the reviewers take.
    const reviewers = snapshot && snapshot.reviewing;
    if (reviewers) {
      el.approval.className = "approval high";
      const head = document.createElement("div");
      head.className = "approval-head";
      const title = document.createElement("strong");
      title.textContent = "Independent review";
      const note = document.createElement("span");
      note.className = "approval-risk";
      note.textContent = `${reviewers} reviewer${reviewers > 1 ? "s" : ""}`;
      head.append(title, note);
      el.approval.replaceChildren(head);
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

  const tool = document.createElement("div");
  tool.className = "approval-tool";
  tool.textContent = pending.tool;

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

  el.approval.replaceChildren(head, tool, actions);
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
  renderControls(snapshot);
  renderApproval(snapshot);
  renderMessageList(snapshot.messages ?? [], snapshot.streamingContent, { readOnly: false });
}

function renderControls(snapshot) {
  el.controls.innerHTML = "";

  const badge = document.createElement("span");
  const mode = snapshot.paused ? "paused" : snapshot.busy ? "busy" : "idle";
  badge.className = `badge ${mode}`;
  badge.textContent = snapshot.paused
    ? "paused"
    : snapshot.busy
      ? snapshot.compressing
        ? "compressing"
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

  messages.forEach((message, index) => {
    el.messages.appendChild(renderMessage(message, index));
  });

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
el.send.addEventListener("click", sendMessage);
el.input.addEventListener("input", autosize);
el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

window.addEventListener("beforeunload", closeStream);

loadOverview();
setInterval(() => loadOverview({ silent: true }), REFRESH_MS);
