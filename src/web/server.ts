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
  deleteSession, listSessions, loadConfig, normalizeApprovalMode, resolveModelSelection, saveConfig, sessionDir,
  type ApprovalMode, type Mode, type ModelSelection, type ResolvedModelSelection, type SessionData, type SessionMeta,
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
  /**
   * Re-bind the same port on another interface. Live connections (a streaming
   * turn, the tab asking for the change) stay open; resolves once the new
   * socket is listening and rejects if it could not be bound.
   */
  setHost(host: string): Promise<void>;
  close(): Promise<void>;
}

/** Bind addresses that mean "every interface" rather than one host. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", ""]);

/** The two interfaces the Web access switch moves between. */
const LOOPBACK_HOST = "127.0.0.1";
const WILDCARD_HOST = "0.0.0.0";

/** True when `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (WILDCARD_HOSTS.has(h)) return false;
  return h === "localhost" || h === "::1" || h.startsWith("127.");
}

/** True when `host` listens on every interface, i.e. what --lan selects. */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host.trim().toLowerCase().replace(/^\[|\]$/g, ""));
}

/**
 * The interface a fresh listener uses when the command line did not pick one.
 * The saved Web access switch behaves exactly like `--lan`.
 */
function defaultWebHost(): string {
  return loadConfig().web_lan === true ? WILDCARD_HOST : LOOPBACK_HOST;
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

/**
 * The listening socket as the settings page sees it. A settings save can move
 * it between loopback and every interface without restarting the process.
 */
interface WebBinding {
  host: string;
  port: number;
  setHost(host: string): Promise<void>;
}

/**
 * Settings plus the live socket. The `web_lan` switch reports and changes what
 * is listening right now, so a run started with --lan shows as on even though
 * nothing was saved yet.
 */
function settingsPayload(mode: Mode, binding: WebBinding) {
  const payload = getWebSettings(mode);
  const lan = isWildcardHost(binding.host);
  const { urls } = webUrls(binding.host, binding.port);
  return {
    ...payload,
    settings: {
      ...payload.settings,
      web_lan: lan,
      web_host: binding.host,
      // Addresses another device can open; empty unless every interface is bound.
      web_urls: lan ? urls.filter((url) => !url.includes("//127.0.0.1:")) : [],
    },
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

function loadSessionSafe(id: string, mode: Mode = "standard"): SessionData | null {
  if (!isSafeSessionId(id)) return null;
  const dir = sessionDir(mode);
  const filePath = path.join(dir, `${id}.json`);
  if (path.dirname(filePath) !== dir) return null;
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
function recentWorkspacePaths(mode: Mode = "standard"): string[] {
  const config = loadConfig(mode);
  const stored = Array.isArray(config.web_workspaces)
    ? (config.web_workspaces as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    : [];
  const saved = listSessions(mode).map((session) => session.cwd).filter(Boolean);
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

function workspaceList(mode: Mode = "standard") {
  const sessions = listSessions(mode);
  return recentWorkspacePaths(mode).map((dir) => {
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
function recordWorkspace(dir: string, mode: Mode = "standard"): void {
  try {
    const config = loadConfig(mode);
    const stored = Array.isArray(config.web_workspaces)
      ? (config.web_workspaces as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    config.web_workspaces = [dir, ...stored.filter((entry) => !sameCwd(entry, dir))]
      .slice(0, MAX_RECENT_WORKSPACES);
    saveConfig(config, mode);
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

/** Build the sidebar payload: the selected workspace's sessions grouped by directory. */
function buildOverview(mode: Mode = "standard"): Overview {
  const sessions = listSessions(mode);
  const lives = hub.list(mode);

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
  mode: Mode,
  pathname: string,
  binding: WebBinding,
): Promise<boolean> {
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
      sendJson(res, 200, settingsPayload(mode, binding));
    } else if (req.method === "POST") {
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: "cross-origin request rejected" });
        return true;
      }
      const wasLan = loadConfig(mode).web_lan === true;
      try {
        const body = await readJsonBody(req);
        updateWebSettings(body, mode);
        // `web_lan` is both a saved preference and a live switch: apply it to
        // the socket now so the console starts or stops answering on the LAN
        // without a restart. Other settings never move the listener, and an
        // explicit --host still decides the interface until this is changed.
        const patch = (body as { settings?: Record<string, unknown> } | null)?.settings;
        const desired = patch && Object.prototype.hasOwnProperty.call(patch, "web_lan")
          ? patch.web_lan === true
          : isWildcardHost(binding.host);
        if (desired !== isWildcardHost(binding.host)) {
          await binding.setHost(desired ? WILDCARD_HOST : LOOPBACK_HOST);
        }
        if ((body as { settings?: { web_password?: unknown } }).settings?.web_password !== undefined) {
          auth.remember(res);
        }
        sendJson(res, 200, settingsPayload(mode, binding));
      } catch (err) {
        // A switch that could not bind must not pretend the socket moved:
        // restore the saved preference so the file matches what is running.
        if ((loadConfig(mode).web_lan === true) !== wasLan) {
          try {
            const config = loadConfig(mode);
            config.web_lan = wasLan;
            saveConfig(config, mode);
          } catch {
            // Reporting the original failure matters more than the rollback.
          }
        }
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
    sendJson(res, 200, { ok: true, live: hub.list(mode).length });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/overview") {
    sendJson(res, 200, buildOverview(mode));
    return true;
  }

  if (req.method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, { sessions: listSessions(mode) });
    return true;
  }

  if (pathname === "/api/workspaces") {
    if (req.method === "GET") {
      sendJson(res, 200, {
        cwd: process.cwd(),
        home: os.homedir(),
        workspaces: workspaceList(mode),
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
        recordWorkspace(dir, mode);
        sendJson(res, 200, { ok: true, path: dir, workspaces: workspaceList(mode) });
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
        ? getWebSettings(mode).selection
        : input.selection;
      const selection = resolveModelSelection(requested, false);
      let approvalMode: ApprovalMode | undefined;
      if (input.approval_mode !== undefined) {
        if (input.approval_mode !== "request" && input.approval_mode !== "auto") {
          throw new ApiError(400, "invalid approval mode", "invalid approval mode");
        }
        approvalMode = normalizeApprovalMode(input.approval_mode);
      }
      const session = createWebSession(cwd, selection, approvalMode, mode);
      const key = session.start();
      webSessions.set(key, session);
      recordWorkspace(cwd, mode);
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
    if (hub.list(mode).some((entry) => entry.sessionId === id)) {
      sendJson(res, 409, { error: "cannot delete a running conversation" });
      return true;
    }
    if (!deleteSession(id, mode)) {
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
    const data = loadSessionSafe(id, mode);
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
    const existing = hub.list(mode).find((entry) => entry.sessionId === id);
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

    const data = loadSessionSafe(id, mode);
    if (!data) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }

    const requested: ModelSelection | undefined = selection ? {
      provider: selection.provider, model: selection.model.name, intensity: selection.intensity,
    } : undefined;
    const outcome = resumeSession(data, requested, mode);
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
    const key = decodeURIComponent(streamMatch[1]);
    // A Pro tab must never observe (or be handed) a session from the other
    // workspace just because it guessed the key.
    if (!hub.has(key, mode)) {
      sendJson(res, 404, { error: "unknown live session" });
      return true;
    }
    streamLive(key, req, res);
    return true;
  }

  const liveMatch = /^\/api\/live\/([^/]+)(?:\/(pause|resume|message|approve|close|model|approval-mode|clear))?$/.exec(pathname);
  if (liveMatch) {
    const key = decodeURIComponent(liveMatch[1]);
    const action = liveMatch[2];

    if (req.method === "GET" && !action) {
      const snapshot = hub.has(key, mode) ? hub.snapshot(key) : null;
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
      if (!hub.has(key, mode)) {
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
  binding: WebBinding,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }

  // The Pro workspace is the same single-page app at /pro, talking to an
  // isolated API under /pro/api. Static assets stay at the root (the app uses
  // root-absolute URLs), so only the page route and the API prefix are special.
  const pathname = url.pathname;
  if (pathname === "/pro" || pathname === "/pro/") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendText(res, 405, "Method not allowed");
      return;
    }
    if (pathname === "/pro/") {
      // Canonical URL without the trailing slash keeps relative links rooted.
      res.writeHead(308, { Location: `/pro${url.search}` });
      res.end();
      return;
    }
    serveStatic(res, "/index.html");
    return;
  }

  let mode: Mode = "standard";
  let apiPathname = pathname;
  if (pathname.startsWith("/pro/api/")) {
    mode = "pro";
    apiPathname = pathname.slice("/pro".length);
  }

  if (await handleApi(req, res, url, auth, mode, apiPathname, binding)) return;
  if (mode === "pro") {
    // Nothing else lives under /pro but the page and its API.
    sendText(res, 404, "Not found");
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  serveStatic(res, pathname);
}

/** Start the web UI. Resolves once the socket is actually listening. */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const auth = new WebAuth(options.auth !== false);
  // An explicit --host/--lan wins for this run; otherwise the saved Web access
  // switch is applied exactly as if `--lan` had been passed.
  let host = options.host?.trim() || defaultWebHost();
  let port = options.port;
  let closed = false;

  // The settings page reads and changes this binding while the process runs.
  const binding: WebBinding = {
    host,
    port,
    setHost: (next) => rebind(next),
  };

  const server = http.createServer((req, res) => {
    handleRequest(req, res, auth, binding).catch((err) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
      } else {
        res.end();
      }
    });
  });

  /** Wait for the socket to actually listen, or for it to fail. */
  const listen = (onHost: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, onHost);
    });

  /** A just-closed port can need a moment to reappear: retry only that race. */
  async function listenRetry(onHost: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await listen(onHost);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt >= 20) throw err;
        await new Promise((done) => setTimeout(done, 10));
      }
    }
  }

  const syncAddress = (): void => {
    const address = webUrls(host, port);
    binding.host = host;
    binding.port = port;
    handle.host = host;
    handle.port = port;
    handle.url = address.url;
    handle.urls = address.urls;
  };

  // Two tabs saving at once must not interleave close/listen on one socket.
  let switches: Promise<void> = Promise.resolve();
  function rebind(next: string): Promise<void> {
    const target = next.trim() || LOOPBACK_HOST;
    const task = switches.then(async () => {
      if (closed) throw new Error("the Web console is shutting down");
      if (target === host && server.listening) return;
      // `close` ends acceptance, not the connections already accepted. The
      // listener is released immediately, which is all the switch needs, so a
      // streaming turn and the tab that asked for the change stay connected.
      if (server.listening) server.close();
      try {
        await listenRetry(target);
      } catch (err) {
        // Put the console back where it was rather than leaving it dark.
        if (!closed) {
          try {
            await listenRetry(host);
          } catch {
            // The settings response still reports the original failure.
          }
        }
        throw err;
      }
      // A concurrent shutdown wins: never resurrect a console being closed.
      if (closed) {
        server.close();
        throw new Error("the Web Console is shutting down");
      }
      host = target;
      syncAddress();
    });
    switches = task.catch(() => undefined);
    return task;
  }

  const handle: WebServerHandle = {
    host,
    port,
    authRequired: auth.enabled,
    url: "",
    urls: [],
    setHost: (next) => rebind(next),
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        for (const key of [...webSessions.keys()]) closeWebSession(key);
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      }),
  };

  await listenRetry(host);
  // Port 0 means "let the OS pick": remember the real one for every URL.
  const address = server.address();
  port = typeof address === "object" && address ? address.port : options.port;
  syncAddress();

  // Once listening, the server must tolerate connection-level failures
  // (resets, EMFILE, half-open sockets) without the process dying: an 'error'
  // event with no listener is fatal in Node.
  server.on("error", (err: Error) => {
    writeCrashLog("web server", err);
  });
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
  });

  return handle;
}
