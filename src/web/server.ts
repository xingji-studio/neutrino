/**
 * A tiny, dependency-free HTTP server that exposes Neutrino to a browser.
 *
 * It has two jobs:
 *   1. Serve the static single-page app from `web/` at the repository root.
 *   2. Provide a JSON/SSE API over the on-disk history and the live hub so the
 *      page can browse every past conversation, watch the running one in real
 *      time, and drive it (pause / resume / send).
 *
 * The server binds to loopback by default: it can read your whole conversation
 * history and drive an agent with shell access, so exposing it on a public
 * interface is an explicit opt-in. The API requires a persistent password.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SESSION_DIR, deleteSession, listSessions, loadConfig, normalizeApprovalMode, resolveModelSelection,
  saveConfig, type ApprovalMode, type ModelSelection, type ResolvedModelSelection, type SessionData, type SessionMeta,
} from "../config.js";
import { getWebSettings, updateWebSettings } from "./settings.js";
import { WebAuth } from "./auth.js";
import { normalizeCwd, sameCwd } from "../cwd.js";
import { hub, type LiveEntrySummary, type LiveSnapshot } from "./hub.js";
import { writeCrashLog } from "../terminal/restore.js";
import { createWebSession, resumeSession, type WebSession } from "./session.js";
import { listAgentSessions, loadAgentMessages, type AgentId } from "../agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/web -> package root (mirrors the same trick used in config.ts).
const PKG_ROOT = path.resolve(__dirname, "..", "..");
const WEB_DIR = path.join(PKG_ROOT, "web");

/**
 * Conversations resumed from the browser only live as long as this map keeps
 * them reachable; the TUI owns its own sessions and must not be closable here.
 */
const webSessions = new Map<string, WebSession>();

function closeWebSession(key: string): boolean {
  const session = webSessions.get(key);
  if (!session) return false;
  webSessions.delete(key);
  session.dispose();
  return true;
}

export interface WebServerOptions {
  /** Port to listen on. `0` lets the OS pick a free one. */
  port: number;
  /** Interface to bind. Defaults to loopback. */
  host?: string;
  /** Require password login by default. `false` explicitly disables authentication. */
  auth?: boolean;
}

export interface WebServerHandle {
  /** Loopback URL. Always usable from this machine. */
  url: string;
  /** Addresses to open. Credentials are never included in URLs. */
  urls: string[];
  port: number;
  host: string;
  /** Whether a browser must log in before using the API. */
  authRequired: boolean;
  close(): Promise<void>;
}

/** Bind addresses that mean "every interface" rather than one host. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", ""]);

/** True when `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (WILDCARD_HOSTS.has(h)) return false;
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/**
 * Adapters that only ever talk to this machine: hypervisor host-only switches,
 * container bridges and loopback variants. Listing them would bury the address
 * the phone actually needs under three that cannot work.
 */
const VIRTUAL_ADAPTER = /vEthernet|VMware|VirtualBox|Hyper-V|Loopback|Npcap|Bluetooth|Docker/i;

/** The IPv4 addresses other devices can reach this machine on. */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      // `family` is "IPv4" in current Node and 4 in older typings.
      const family = String(entry.family);
      if (family !== "IPv4" && family !== "4") continue;
      // 169.254/16 is link-local: it only routes on the local segment, so it is
      // never the address worth telling another device to open.
      if (entry.address.startsWith("169.254.")) continue;
      if (!found.includes(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

/** Build the list of addresses worth showing to the operator. */
export function webUrls(host: string, port: number): { url: string; urls: string[] } {
  const normalized = host.trim() || "127.0.0.1";
  const wildcard = WILDCARD_HOSTS.has(normalized.toLowerCase());

  const hosts: string[] = [];
  if (isLoopbackHost(normalized)) {
    hosts.push("127.0.0.1");
  } else if (wildcard) {
    hosts.push(...lanAddresses());
    hosts.push("127.0.0.1");
  } else {
    hosts.push(normalized);
  }

  return {
    url: `http://${wildcard ? "127.0.0.1" : normalized}:${port}`,
    urls: hosts.map((h) => `http://${h}:${port}/`),
  };
}

interface OverviewSession extends SessionMeta {
  live: boolean;
  liveKey: string | null;
}

interface OverviewGroup {
  /** Canonical key used for grouping (see normalizeCwd). */
  key: string;
  /** Display form of the path (taken from the newest session). */
  cwd: string;
  updated_at: string;
  sessions: OverviewSession[];
}

interface Overview {
  groups: OverviewGroup[];
  live: LiveEntrySummary[];
  generated_at: string;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

// Session ids are ISO timestamps with `:`/`.` swapped for `-`. Anything else is
// rejected so a crafted id cannot read files outside the session directory.
const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

function isSafeSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id) && id !== "." && id !== ".." && !id.includes("..");
}

function loadSessionSafe(id: string): SessionData | null {
  if (!isSafeSessionId(id)) return null;
  const filePath = path.join(SESSION_DIR, `${id}.json`);
  if (path.dirname(filePath) !== SESSION_DIR) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionData;
  } catch {
    return null;
  }
}

// ------------------------------------------------------- working directories
//
// The browser console can open any folder on this machine, which is exactly
// what the terminal can do by being launched from that folder. Every route
// below still sits behind the login cookie: browsing the filesystem is only as
// exposed as the authenticated console itself.

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function sendApiError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof ApiError) {
    sendJson(res, error.status, { error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : "invalid request";
  sendJson(res, 400, { error: message });
}

const MAX_RECENT_WORKSPACES = 12;
const AGENT_IDS = new Set<AgentId>(["claude", "codex", "opencode"]);
const AGENT_SESSION_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

/** Expand `~` and require an absolute path; used by every folder route. */
function absolutePath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ApiError(400, "working directory is required", "working directory is required");
  }
  let value = raw.trim();
  if (value === "~") value = os.homedir();
  else if (/^~[\\/]/.test(value)) value = path.join(os.homedir(), value.slice(2));
  if (!path.isAbsolute(value)) {
    throw new ApiError(400, "working directory must be an absolute path", "working directory must be an absolute path");
  }
  return path.resolve(value);
}

function existingDirectory(raw: unknown): string {
  const dir = absolutePath(raw);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new ApiError(400, "working directory does not exist", "working directory does not exist");
  }
  if (!stat.isDirectory()) {
    throw new ApiError(400, "working directory is not a folder", "working directory is not a folder");
  }
  return dir;
}

let cachedRoots: string[] | null = null;

/** Filesystem roots worth offering as shortcuts (every existing drive on Windows). */
function filesystemRoots(): string[] {
  if (cachedRoots) return cachedRoots;
  if (process.platform !== "win32") {
    cachedRoots = ["/"];
    return cachedRoots;
  }
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (fs.statSync(root).isDirectory()) roots.push(root);
    } catch {
      // A drive letter that does not exist is simply not offered.
    }
  }
  cachedRoots = roots.length ? roots : [path.parse(process.cwd()).root];
  return cachedRoots;
}

/** One directory listing for the folder picker. Files are hidden: the picker chooses directories. */
function readFolder(raw: unknown) {
  const dir = existingDirectory(raw);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    throw new ApiError(403, "cannot read this folder", err instanceof Error ? err.message : "cannot read this folder");
  }
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: path.join(dir, entry.name),
      hidden: entry.name.startsWith("."),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const parent = path.dirname(dir);
  return {
    path: dir,
    name: path.basename(dir) || dir,
    parent: parent === dir ? null : parent,
    separator: path.sep,
    home: os.homedir(),
    cwd: process.cwd(),
    roots: filesystemRoots(),
    entries: folders,
  };
}

/** Recent working directories: explicitly opened ones first, then saved-session folders. */
function recentWorkspacePaths(): string[] {
  const config = loadConfig();
  const stored = Array.isArray(config.web_workspaces)
    ? (config.web_workspaces as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
  const saved = listSessions().map((session) => session.cwd).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...stored, ...saved, process.cwd()]) {
    const key = normalizeCwd(dir);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
    if (out.length >= MAX_RECENT_WORKSPACES) break;
  }
  return out;
}

function workspaceList() {
  const sessions = listSessions();
  return recentWorkspacePaths().map((dir) => {
    let exists = false;
    try {
      exists = fs.statSync(dir).isDirectory();
    } catch {
      // A folder that disappeared stays listed, greyed out, so it can be removed by choosing another.
    }
    return {
      path: dir,
      name: path.basename(dir) || dir,
      sessions: sessions.filter((session) => sameCwd(session.cwd, dir)).length,
      exists,
    };
  });
}

/** Best-effort persistence: failing to remember a folder must not fail the conversation. */
function recordWorkspace(dir: string): void {
  try {
    const config = loadConfig();
    const stored = Array.isArray(config.web_workspaces)
      ? (config.web_workspaces as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    config.web_workspaces = [dir, ...stored.filter((entry) => !sameCwd(entry, dir))]
      .slice(0, MAX_RECENT_WORKSPACES);
    saveConfig(config);
  } catch {
    // The picked folder still works for this conversation.
  }
}

/** Create one folder inside an existing parent. */
function createFolder(raw: unknown): string {
  const target = absolutePath(raw);
  if (target === path.parse(target).root) {
    throw new ApiError(400, "cannot create a folder here", "cannot create a folder here");
  }
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new ApiError(400, "parent folder does not exist", "parent folder does not exist");
  }
  if (fs.existsSync(target)) {
    throw new ApiError(409, "folder already exists", "folder already exists");
  }
  try {
    fs.mkdirSync(target);
  } catch (err) {
    throw new ApiError(400, "cannot create a folder here", err instanceof Error ? err.message : "cannot create a folder here");
  }
  return target;
}

function isAgentId(value: string): value is AgentId {
  return AGENT_IDS.has(value as AgentId);
}

function safeAgentSessionId(id: string): boolean {
  return AGENT_SESSION_ID_RE.test(id) && !id.includes("..") && id !== "." && id !== "..";
}

/** Build the sidebar payload: every session grouped by working directory. */
function buildOverview(): Overview {
  const sessions = listSessions();
  const lives = hub.list();

  const liveBySession = new Map<string, LiveEntrySummary>();
  for (const live of lives) {
    if (live.sessionId) liveBySession.set(live.sessionId, live);
  }

  const groups = new Map<string, OverviewGroup>();
  const seen = new Set<string>();

  for (const session of sessions) {
    const key = normalizeCwd(session.cwd) || "(unknown)";
    let group = groups.get(key);
    if (!group) {
      group = { key, cwd: session.cwd || "(unknown directory)", updated_at: session.updated_at, sessions: [] };
      groups.set(key, group);
    }
    const live = liveBySession.get(session.id);
    group.sessions.push({ ...session, live: Boolean(live), liveKey: live?.key ?? null });
    if (session.updated_at > group.updated_at) {
      group.updated_at = session.updated_at;
      group.cwd = session.cwd || group.cwd;
    }
    seen.add(session.id);
  }

  // Live conversations that have not been saved yet (or whose newest save has
  // not landed) still deserve a spot at the top of their directory group.
  for (const live of lives) {
    if (live.sessionId && seen.has(live.sessionId)) continue;
    const key = normalizeCwd(live.cwd) || "(unknown)";
    let group = groups.get(key);
    if (!group) {
      group = { key, cwd: live.cwd || "(unknown directory)", updated_at: "", sessions: [] };
      groups.set(key, group);
    }
    const now = new Date().toISOString();
    group.sessions.unshift({
      id: live.sessionId ?? `live:${live.key}`,
      created_at: now,
      updated_at: now,
      model: live.model,
      provider: live.provider,
      intensity: live.intensity,
      cwd: live.cwd,
      // An unnamed conversation keeps an empty title: the browser translates
      // its own fallback, and the terminal/server never impose one language.
      title: live.title || "",
      message_count: 0,
      live: true,
      liveKey: live.key,
    });
    if (now > group.updated_at) group.updated_at = now;
  }

  const ordered = [...groups.values()]
    .map((group) => ({
      ...group,
      // Newest conversation first; the UI reveals only the first five.
      sessions: group.sessions.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0)),
    }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));

  return {
    groups: ordered,
    live: lives,
    generated_at: new Date().toISOString(),
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage, limit = 1 << 20): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// Mutations must come from the page the server itself serves. Browsers attach
// an Origin header to POST requests, so a cross-site form/fetch cannot drive
// the running agent. Non-browser clients (curl, scripts) send no Origin.
function isSameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function serveStatic(res: http.ServerResponse, pathname: string): void {
  let rel = pathname === "/" ? "/index.html" : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  rel = rel.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_DIR, rel);
  if (filePath !== WEB_DIR && !filePath.startsWith(WEB_DIR + path.sep)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function streamLive(key: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const initial = hub.snapshot(key);
  if (!initial) {
    sendJson(res, 404, { error: "unknown live session" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering so tokens arrive as they are produced.
    "X-Accel-Buffering": "no",
  });
  // A browser tab that is closed, reloaded or suspended leaves a socket that
  // writes fail on. Every write goes through here so a dead connection can
  // never emit an 'error' event nobody listens for.
  const write = (chunk: string): boolean => {
    if (res.destroyed || res.writableEnded) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      return false;
    }
  };

  write("retry: 2000\n\n");

  const send = (snapshot: LiveSnapshot) => {
    write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  };

  const unsubscribe = hub.subscribe(key, send);
  if (!unsubscribe) {
    write("event: gone\ndata: {}\n\n");
    res.end();
    return;
  }
  // Rebound so the hoisted cleanup() below keeps the narrowed (non-null) type.
  const detach = unsubscribe;

  const keepAlive = setInterval(() => {
    if (!write(": ping\n\n")) cleanup();
  }, 25_000);
  keepAlive.unref?.();

  function cleanup(): void {
    clearInterval(keepAlive);
    detach();
  }
  req.on("close", cleanup);
  req.on("error", cleanup);
  // Without this, a client reset during a write is an uncaught 'error' event.
  res.on("error", cleanup);
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  auth: WebAuth,
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/")) return false;

  if (req.method === "OPTIONS") {
    // Same-origin only: no CORS headers, so cross-site preflights are rejected.
    // Answered before the login check because it reveals nothing.
    res.writeHead(204, { Allow: "GET, POST, OPTIONS" });
    res.end();
    return true;
  }

  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
    } else if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
    } else if (pathname.endsWith("/logout")) {
      auth.forget(res);
      sendJson(res, 200, { ok: true });
    } else {
      let body: unknown;
      try { body = await readJsonBody(req, 4096); } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return true;
      }
      if (await auth.login((body as { password?: unknown } | null)?.password)) {
        auth.remember(res);
        sendJson(res, 200, { ok: true });
      } else {
        sendJson(res, 401, { error: "Incorrect password." });
      }
    }
    return true;
  }

  if (!auth.authenticated(req)) {
    sendJson(res, 401, { error: "Password login required." });
    return true;
  }

  if (pathname === "/api/settings") {
    if (req.method === "GET") {
      sendJson(res, 200, getWebSettings());
    } else if (req.method === "POST") {
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: "cross-origin request rejected" });
        return true;
      }
      try {
        const body = await readJsonBody(req);
        updateWebSettings(body);
        if ((body as { settings?: { web_password?: unknown } }).settings?.web_password !== undefined) {
          auth.remember(res);
        }
        sendJson(res, 200, getWebSettings());
      } catch (err) {
        sendJson(res, (err as NodeJS.ErrnoException)?.code ? 500 : 400, {
          error: err instanceof Error ? err.message : "invalid settings",
        });
      }
    } else {
      sendJson(res, 405, { error: "method not allowed" });
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, live: hub.list().length });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/overview") {
    sendJson(res, 200, buildOverview());
    return true;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, { sessions: listSessions() });
    return true;
  }

  if (pathname === "/api/workspaces") {
    if (req.method === "GET") {
      sendJson(res, 200, {
        cwd: process.cwd(),
        home: os.homedir(),
        workspaces: workspaceList(),
      });
      return true;
    }
    if (req.method === "POST") {
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: "cross-origin request rejected" });
        return true;
      }
      try {
        const body = await readJsonBody(req);
        const dir = existingDirectory((body as { path?: unknown } | null)?.path);
        recordWorkspace(dir);
        sendJson(res, 200, { ok: true, path: dir, workspaces: workspaceList() });
      } catch (err) {
        sendApiError(res, err);
      }
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  if (pathname === "/api/fs") {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    try {
      sendJson(res, 200, readFolder(url.searchParams.get("path") ?? process.cwd()));
    } catch (err) {
      sendApiError(res, err);
    }
    return true;
  }

  if (pathname === "/api/fs/mkdir") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const created = createFolder((body as { path?: unknown } | null)?.path);
      sendJson(res, 200, { ok: true, path: created });
    } catch (err) {
      sendApiError(res, err);
    }
    return true;
  }

  // Start a brand-new conversation in a working directory chosen by the
  // browser. Unlike `/continue`, there is no transcript to load first.
  if (pathname === "/api/conversations") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(400, "invalid request", "invalid request");
      }
      const input = body as Record<string, unknown>;
      const cwd = existingDirectory(input.cwd ?? process.cwd());
      const requested = input.selection === undefined
        ? getWebSettings().selection
        : input.selection;
      const selection = resolveModelSelection(requested, false);
      let approvalMode: ApprovalMode | undefined;
      if (input.approval_mode !== undefined) {
        if (input.approval_mode !== "request" && input.approval_mode !== "auto") {
          throw new ApiError(400, "invalid approval mode", "invalid approval mode");
        }
        approvalMode = normalizeApprovalMode(input.approval_mode);
      }
      const session = createWebSession(cwd, selection, approvalMode);
      const key = session.start();
      webSessions.set(key, session);
      recordWorkspace(cwd);
      sendJson(res, 200, { ok: true, key, cwd, snapshot: hub.snapshot(key) });
    } catch (err) {
      sendApiError(res, err);
    }
    return true;
  }

  const deleteMatch = /^\/api\/session\/([^/]+)\/delete$/.exec(pathname);
  if (req.method === "POST" && deleteMatch) {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
      return true;
    }
    const id = decodeURIComponent(deleteMatch[1]);
    if (!isSafeSessionId(id)) {
      sendJson(res, 400, { error: "invalid session id" });
      return true;
    }
    if (hub.list().some((entry) => entry.sessionId === id)) {
      sendJson(res, 409, { error: "cannot delete a running conversation" });
      return true;
    }
    if (!deleteSession(id)) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    sendJson(res, 200, { ok: true, deleted: true });
    return true;
  }

  // Read-only history recorded by other agents (Claude Code, Codex, OpenCode).
  const agentSessionsMatch = /^\/api\/agents\/([^/]+)\/sessions$/.exec(pathname);
  if (req.method === "GET" && agentSessionsMatch) {
    const agent = decodeURIComponent(agentSessionsMatch[1]);
    if (!isAgentId(agent)) {
      sendJson(res, 400, { error: "unknown agent" });
      return true;
    }
    const cwd = url.searchParams.get("cwd") || process.cwd();
    sendJson(res, 200, { agent, cwd, sessions: listAgentSessions(agent, cwd) });
    return true;
  }

  const agentSessionMatch = /^\/api\/agents\/([^/]+)\/sessions\/([^/]+)$/.exec(pathname);
  if (req.method === "GET" && agentSessionMatch) {
    const agent = decodeURIComponent(agentSessionMatch[1]);
    const id = decodeURIComponent(agentSessionMatch[2]);
    if (!isAgentId(agent)) {
      sendJson(res, 400, { error: "unknown agent" });
      return true;
    }
    if (!safeAgentSessionId(id)) {
      sendJson(res, 400, { error: "invalid session id" });
      return true;
    }
    sendJson(res, 200, { agent, id, messages: loadAgentMessages(agent, id) });
    return true;
  }

  const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(pathname);
  if (req.method === "GET" && sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    if (!isSafeSessionId(id)) {
      sendJson(res, 400, { error: "invalid session id" });
      return true;
    }
    const data = loadSessionSafe(id);
    if (!data) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }
    sendJson(res, 200, data);
    return true;
  }

  const continueMatch = /^\/api\/session\/([^/]+)\/continue$/.exec(pathname);
  if (req.method === "POST" && continueMatch) {
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
      return true;
    }
    const id = decodeURIComponent(continueMatch[1]);
    if (!isSafeSessionId(id)) {
      sendJson(res, 400, { error: "invalid session id" });
      return true;
    }

    let selection: ResolvedModelSelection | undefined;
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid JSON body");
      const requested = (body as { selection?: unknown }).selection;
      if (requested !== undefined) selection = resolveModelSelection(requested);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid model selection" });
      return true;
    }

    // Already running (TUI or another tab)? Attach instead of duplicating.
    const existing = hub.list().find((entry) => entry.sessionId === id);
    if (existing) {
      if (selection) {
        const changed = hub.configure(existing.key, selection);
        if (!changed.ok) {
          sendJson(res, 409, { error: changed.error });
          return true;
        }
      }
      sendJson(res, 200, { key: existing.key, attached: true });
      return true;
    }

    const data = loadSessionSafe(id);
    if (!data) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }

    const requested: ModelSelection | undefined = selection ? {
      provider: selection.provider, model: selection.model.name, intensity: selection.intensity,
    } : undefined;
    const outcome = resumeSession(data, requested);
    if (!outcome.ok) {
      sendJson(res, 400, { error: outcome.error });
      return true;
    }

    const key = outcome.session.start();
    webSessions.set(key, outcome.session);
    sendJson(res, 200, { key, attached: false });
    return true;
  }

  const streamMatch = /^\/api\/live\/([^/]+)\/stream$/.exec(pathname);
  if (req.method === "GET" && streamMatch) {
    streamLive(decodeURIComponent(streamMatch[1]), req, res);
    return true;
  }

  const liveMatch = /^\/api\/live\/([^/]+)(?:\/(pause|resume|message|approve|close|model|approval-mode|clear))?$/.exec(pathname);
  if (liveMatch) {
    const key = decodeURIComponent(liveMatch[1]);
    const action = liveMatch[2];

    if (req.method === "GET" && !action) {
      const snapshot = hub.snapshot(key);
      if (!snapshot) {
        sendJson(res, 404, { error: "unknown live session" });
        return true;
      }
      sendJson(res, 200, snapshot);
      return true;
    }

    if (req.method === "POST" && action) {
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: "cross-origin request rejected" });
        return true;
      }
      if (!hub.has(key)) {
        sendJson(res, 404, { error: "unknown live session" });
        return true;
      }
      if (action === "approval-mode") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        const mode = (body as { mode?: unknown } | null)?.mode;
        if (mode !== "request" && mode !== "auto") {
          sendJson(res, 400, { error: "mode must be request or auto" });
        } else if (!hub.setApprovalMode(key, mode)) {
          sendJson(res, 409, { error: "this session cannot change approval mode" });
        } else {
          sendJson(res, 200, { ok: true, snapshot: hub.snapshot(key) });
        }
        return true;
      }
      if (action === "model") {
        let selection: ResolvedModelSelection;
        try {
          selection = resolveModelSelection(await readJsonBody(req));
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid model selection" });
          return true;
        }
        const changed = hub.configure(key, selection);
        if (!changed.ok) sendJson(res, 409, { error: changed.error });
        else sendJson(res, 200, { ok: true, snapshot: hub.snapshot(key) });
        return true;
      }
      if (action === "pause") {
        hub.pause(key);
        sendJson(res, 200, { ok: true, paused: true });
        return true;
      }
      if (action === "resume") {
        hub.resume(key);
        sendJson(res, 200, { ok: true, paused: false });
        return true;
      }
      if (action === "approve") {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return true;
        }
        const approved = (body as { approved?: unknown })?.approved === true;
        if (!hub.approve(key, approved)) {
          sendJson(res, 409, { error: "no approval is pending" });
          return true;
        }
        sendJson(res, 200, { ok: true, approved });
        return true;
      }
      if (action === "close") {
        if (!closeWebSession(key)) {
          sendJson(res, 400, { error: "this session is owned by the terminal UI" });
          return true;
        }
        sendJson(res, 200, { ok: true, closed: true });
        return true;
      }
      if (action === "clear") {
        if (!hub.clear(key)) {
          sendJson(res, 409, { error: "this session cannot be cleared" });
          return true;
        }
        sendJson(res, 200, { ok: true, snapshot: hub.snapshot(key) });
        return true;
      }
      // action === "message"
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: "invalid JSON body" });
        return true;
      }
      const text = typeof (body as { text?: unknown })?.text === "string" ? (body as { text: string }).text : "";
      if (!text.trim()) {
        sendJson(res, 400, { error: "empty message" });
        return true;
      }
      hub.send(key, text);
      sendJson(res, 200, { ok: true });
      return true;
    }

    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  sendJson(res, 404, { error: "not found" });
  return true;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  auth: WebAuth,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }

  if (await handleApi(req, res, url, auth)) return;

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  serveStatic(res, url.pathname);
}

/** Start the web UI. Resolves once the socket is actually listening. */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const auth = new WebAuth(options.auth !== false);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, auth).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      // Once listening, the server must tolerate connection-level failures
      // (resets, EMFILE, half-open sockets) without the process dying. An
      // 'error' event with no listener is fatal in Node.
      server.on("error", (err: Error) => {
        writeCrashLog("web server", err);
      });
      server.on("clientError", (_err, socket) => {
        if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
      });
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, host);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    host,
    port,
    authRequired: auth.enabled,
    ...webUrls(host, port),
    close: () =>
      new Promise<void>((resolve) => {
        for (const key of [...webSessions.keys()]) closeWebSession(key);
        server.close(() => resolve());
      }),
  };
}
