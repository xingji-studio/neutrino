import { handlePlugins } from "./plugins.js";
import { startLocalApi, type LocalApiHandle } from "./localApi.js";
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
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  deleteSession, listSessions, loadConfig, normalizeApprovalMode, isAgentMode, resolveModelSelection, saveConfig, sessionDir,
  type ApprovalMode, type AgentMode, type Mode, type ModelSelection, type ResolvedModelSelection, type SessionData, type SessionMeta,
} from "../config.js";
import { getWebSettings, updateWebSettings } from "./settings.js";
import { fastSettings } from "../fast/types.js";
import { isSeenIdentity, loadSeen, updateSeen, SEEN_LIMIT } from "./clientState.js";
import { WebAuth } from "./auth.js";
import { normalizeCwd, sameCwd } from "../cwd.js";
import { hub, type LiveEntrySummary, type LiveSnapshot } from "./hub.js";
import { writeCrashLog } from "../terminal/restore.js";
import { createWebSession, proInitialSelection, resumeSession, WebSession } from "./session.js";
import { defaultProPreset, ensureProModels, requireProPreset } from "../pro/config.js";
import { listAgentSessions, loadAgentMessages, loadAgentSession, safeAgentSessionId, type AgentId } from "../agents.js";
import { migrateAgentSession, SessionMigrationError } from "../migration.js";
import { runningBackground, type BackgroundStatus, type BackgroundUpdate } from "../background.js";
import { MANUAL_UPDATE_COMMAND, checkForUpdate, installUpdate, updateStatus, type UpdateStatus } from "../update.js";
import { subscribeUpdateAnnouncements } from "../updateWatch.js";

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
  /**
   * Offer the background-residency prompt to the first browser that opens this
   * console. Only a console started by the terminal UI sets this.
   */
  backgroundPrompt?: boolean;
  /**
   * Present only in the detached background service: the token that authorizes
   * `/api/background/{ping,stop}` and the callback that shuts the process down.
   */
  backgroundService?: {
    token: string;
    onStop: () => void;
    status?: () => BackgroundStatus;
    configure?: (update: BackgroundUpdate) => BackgroundStatus;
  };
  /** Keep service discovery in sync after a live LAN switch. */
  onAddressChange?: () => void;
  /** Local API port. Zero selects an available port. */
  apiPort?: number;
  /** Publish connection information in the user data directory. */
  publishApi?: boolean;
  /** Run only the local API, with no Web listener. */
  apiOnly?: boolean;
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
  /** Local API connection information; token must be kept private. */
  api?: { url: string; token: string };
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
  /** One-time background-residency prompt, consumed by the first browser. */
  prompt: { pending: boolean };
  /** Management token of the detached service, or absent in a terminal run. */
  service?: WebServerOptions["backgroundService"];
  updateSettings(body: unknown, mode: Mode): Promise<void>;
}

/**
 * Settings plus the live socket. The `web_lan` switch reports and changes what
 * is listening right now, so a run started with --lan shows as on even though
 * nothing was saved yet.
 */
function validTerminalBridge(bridge: unknown, ownerPid: unknown): boolean {
  if (!bridge || typeof bridge !== "object" || Array.isArray(bridge) || typeof ownerPid !== "number") return false;
  const info = bridge as { url?: unknown; token?: unknown };
  if (typeof info.url !== "string" || typeof info.token !== "string" || !/^[a-f0-9]{64}$/.test(info.token)) return false;
  try {
    const url = new URL(info.url);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && Boolean(url.port)
      && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function settingsPayload(mode: Mode, binding: WebBinding) {
  const payload = getWebSettings(mode);
  const lan = isWildcardHost(binding.host);
  const { urls } = webUrls(binding.host, binding.port);
  const background = binding.service?.status?.() ?? runningBackground();
  return {
    ...payload,
    settings: {
      ...payload.settings,
      web_lan: lan,
      web_host: binding.host,
      // Addresses another device can open; empty unless every interface is bound.
      web_urls: lan ? urls.filter((url) => !url.includes("//127.0.0.1:")) : [],
      // The background service is a process, not a workspace: both pages report
      // the same state. The prompt is never shown once the setting is on.
      background: background?.pid === process.pid ? background.resident : payload.settings.background,
      background_running: background?.resident === true,
      background_url: background?.url ?? "",
      background_prompt: binding.prompt.pending && payload.settings.background !== true,
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
  fast_mode_enabled: boolean;
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
  // not landed) still deserve a spot at the top of their directory group. A
  // conversation nobody has said anything in yet is not history: it stays out
  // of the list (but in `live`, so the browser keeps its stream) until it has
  // content.
  for (const live of lives) {
    if (live.sessionId && seen.has(live.sessionId)) continue;
    if (live.empty) continue;
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
    fast_mode_enabled: fastSettings(loadConfig("standard")).enabled,
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

/** Constant-time comparison of the service's management token. */
function hasServiceToken(req: http.IncomingMessage, token: string): boolean {
  const header = String(req.headers.authorization ?? "");
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
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
  // Send an immutable snapshot: the length and body must agree even while
  // the development checkout changes or a filesystem stream adapter retries.
  fs.readFile(filePath, (err, contents) => {
    if (err) {
      sendText(res, 404, "Not found");
      return;
    }
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": contents.length,
      "Cache-Control": "no-cache",
    });
    res.end(contents);
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

/**
 * The windows watching for update announcements. The console owns one of these
 * so closing it can end those streams: a browser reconnects an EventSource by
 * itself, so an open tab would otherwise keep `close` waiting for a socket that
 * will never go quiet on its own.
 */
function createUpdateStreams() {
  const open = new Set<http.ServerResponse>();
  return {
    add(res: http.ServerResponse): void {
      open.add(res);
    },
    remove(res: http.ServerResponse): void {
      open.delete(res);
    },
    closeAll(): void {
      for (const res of [...open]) {
        open.delete(res);
        try { res.end(); } catch { /* the window is already gone */ }
      }
    },
  };
}

type UpdateStreams = ReturnType<typeof createUpdateStreams>;

/**
 * The periodic check's findings, as an event stream. A window that opens after
 * a release was already found still has to learn about it, so the answer this
 * process holds goes out first: the same status /api/settings hands the
 * first-open dialog, with the same fields the manual check returns.
 *
 * Both workspaces read it. An update belongs to the process, not to a
 * conversation, so a Pro tab and a standard tab are told about the same release.
 */
function streamUpdateEvents(req: http.IncomingMessage, res: http.ServerResponse, streams: UpdateStreams): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Same guard as streamLive: a browser that closed or reloaded the tab leaves
  // a socket writes fail on, and an unhandled 'error' event would stop the process.
  const write = (chunk: string): boolean => {
    if (res.destroyed || res.writableEnded) return false;
    try {
      res.write(chunk);
      return true;
    } catch {
      return false;
    }
  };

  const send = (status: UpdateStatus, error = ""): void => {
    write(`event: update\ndata: ${JSON.stringify({
      has_update: status.hasUpdate,
      current_version: status.currentVersion,
      latest_version: status.latestVersion,
      error,
    })}\n\n`);
  };

  write("retry: 2000\n\n");
  send(updateStatus());

  streams.add(res);
  const unsubscribe = subscribeUpdateAnnouncements((check) => send(check, check.error ?? ""));
  const keepAlive = setInterval(() => {
    if (!write(": ping\n\n")) cleanup();
  }, 25_000);
  keepAlive.unref?.();

  function cleanup(): void {
    clearInterval(keepAlive);
    unsubscribe();
    streams.remove(res);
  }
  req.on("close", cleanup);
  req.on("error", cleanup);
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
  updates: UpdateStreams,
): Promise<boolean> {
  if (!pathname.startsWith("/api/")) return false;

  // The Pro presets are not bundled either: the first Pro request makes sure they
  // are on disk. When the download fails the route below reports the missing file.
  if (mode === "pro") await ensureProModels().catch(() => undefined);

  if (req.method === "OPTIONS") {
    // Same-origin only: no CORS headers, so cross-site preflights are rejected.
    // Answered before the login check because it reveals nothing.
    res.writeHead(204, { Allow: "GET, POST, OPTIONS" });
    res.end();
    return true;
  }

  // Management endpoints of the detached service. They are called by the CLI
  // and the tray icon, which have the token from ~/.neutrino/background.json
  // but not necessarily a browser login cookie.
  if (["/api/background/ping", "/api/background/stop", "/api/background/configure"].includes(pathname)) {
    if (req.method !== "GET" && req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (!binding.service) {
      sendJson(res, 404, { error: "this console is not running in the background" });
      return true;
    }
    if (!hasServiceToken(req, binding.service.token)) {
      sendJson(res, 401, { error: "background service token required" });
      return true;
    }
    if (pathname.endsWith("/ping")) {
      sendJson(res, 200, { ok: true, pid: process.pid, url: webUrls(binding.host, binding.port).url });
      return true;
    }
    if (pathname.endsWith("/configure")) {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "method not allowed" });
        return true;
      }
      if (!binding.service.configure) {
        sendJson(res, 409, { error: "Restart the console to update background residency." });
        return true;
      }
      try {
        const body = await readJsonBody(req, 4096) as BackgroundUpdate;
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).some(key => key !== "resident" && key !== "ownerPid" && key !== "bridge")
          || (body.resident !== undefined && typeof body.resident !== "boolean")
          || (body.ownerPid !== undefined && (!Number.isSafeInteger(body.ownerPid) || body.ownerPid <= 0))
          || (body.bridge !== undefined && !validTerminalBridge(body.bridge, body.ownerPid))) {
          throw new Error("invalid background settings");
        }
        const updated = binding.service.configure(body);
        if (updated.resident) binding.prompt.pending = false;
        sendJson(res, 200, updated);
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid background settings" });
      }
      return true;
    }
    sendJson(res, 200, { ok: true, stopping: true });
    // Let the response reach the caller before the socket closes.
    setImmediate(() => binding.service?.onStop());
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

  if (await handlePlugins(req,res,url,pathname,mode,{
    sameOrigin:isSameOrigin(req),read:()=>readJsonBody(req),json:(status,value)=>sendJson(res,status,value),
  })) return true;

  // The first browser to see the background-residency prompt consumes it for
  // this console run, whether it accepted or dismissed it.
  if (pathname === "/api/background/dismiss") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
    } else if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
    } else {
      binding.prompt.pending = false;
      sendJson(res, 200, { ok: true });
    }
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
      try {
        const body = await readJsonBody(req);
        await binding.updateSettings(body, mode);
        if ((body as { settings?: { web_password?: unknown } }).settings?.web_password !== undefined) {
          auth.remember(res);
        }
        sendJson(res, 200, settingsPayload(mode, binding));
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

  // The 30-minute background check announces a release here, so a window that
  // stays open learns about it without reloading. Both workspaces open it.
  if (req.method === "GET" && pathname === "/api/update/events") {
    streamUpdateEvents(req, res, updates);
    return true;
  }

  // The settings page's "Check for updates" button. Start-up reads the registry
  // once and the Web console is served from that answer, so a manual check has
  // to ask again; otherwise the button would keep showing whatever was true
  // when the process started. Like the install below it runs npm on this
  // machine, so it sits behind the login cookie and the same-origin check.
  //
  // The answer is a status, not an HTTP failure: an unreachable registry leaves
  // `error` set on a 200 response, which is what the browser shows next to the
  // button. A failure also changes nothing — the last good answer stays.
  if (pathname === "/api/update/check") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
      return true;
    }
    const check = await checkForUpdate({ refresh: true });
    sendJson(res, 200, {
      has_update: check.hasUpdate,
      current_version: check.currentVersion,
      latest_version: check.latestVersion,
      error: check.error ?? "",
    });
    return true;
  }

  // The update prompt's confirm button: npm runs on this machine, so the route
  // sits behind the login cookie and the same-origin check like every other
  // mutation, and only a release the registry announced can be installed.
  if (pathname === "/api/update") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
      return true;
    }
    if (!updateStatus().hasUpdate) {
      sendJson(res, 409, { error: "No newer version is published." });
      return true;
    }
    // Never rejects: a failure comes back as a result, carrying the command the
    // browser shows so the user can finish the update by hand.
    const result = await installUpdate();
    sendJson(res, result.ok ? 200 : 500, {
      ok: result.ok,
      version: result.version,
      error: result.error ?? "",
      command: MANUAL_UPDATE_COMMAND,
    });
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

  // The sidebar's blue dot is the browser's own memory of what it has read. It
  // belongs to the console rather than to a conversation, so it is stored in
  // ~/.neutrino/web.json (see clientState.ts) and never in the config or the
  // transcript. Each workspace keeps its own record.
  if (pathname === "/api/seen") {
    if (req.method === "GET") {
      sendJson(res, 200, { seen: loadSeen(mode) });
      return true;
    }
    if (req.method === "POST") {
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { error: "cross-origin request rejected" });
        return true;
      }
      try {
        const body = await readJsonBody(req, 64 * 1024);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          throw new ApiError(400, "invalid request", "invalid request");
        }
        const input = body as { identities?: unknown; seen?: unknown };
        if (Object.keys(body).some((key) => key !== "identities" && key !== "seen")) {
          throw new ApiError(400, "unknown field", "unknown field");
        }
        const identities = input.identities;
        if (!Array.isArray(identities) || identities.length === 0 || identities.length > SEEN_LIMIT) {
          throw new ApiError(400, `identities must be a list of 1 to ${SEEN_LIMIT}`, "invalid identities");
        }
        if (!identities.every(isSeenIdentity)) {
          throw new ApiError(400, "invalid conversation id", "invalid conversation id");
        }
        if (typeof input.seen !== "boolean") {
          throw new ApiError(400, "seen must be a boolean", "seen must be a boolean");
        }
        sendJson(res, 200, { ok: true, seen: updateSeen(mode, identities, input.seen) });
      } catch (err) {
        // A rejected body is the caller's fault; a file that cannot be written
        // is ours, and must not read as a malformed request.
        sendJson(res, err instanceof ApiError ? err.status : 500, {
          error: err instanceof Error ? err.message : "invalid request",
        });
      }
      return true;
    }
    sendJson(res, 405, { error: "method not allowed" });
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
      const preset = mode === "pro" ? requireProPreset(input.pro_preset ?? defaultProPreset()) : undefined;
      const selection = mode === "pro" ? proInitialSelection(preset) : resolveModelSelection(requested, false);
      let approvalMode: ApprovalMode | undefined;
      if (input.approval_mode !== undefined) {
        if (input.approval_mode !== "request" && input.approval_mode !== "auto") {
          throw new ApiError(400, "invalid approval mode", "invalid approval mode");
        }
        approvalMode = normalizeApprovalMode(input.approval_mode);
      }
      if (input.agent_mode !== undefined && (!isAgentMode(input.agent_mode) || (mode === "pro" && input.agent_mode !== "standard"))) {
        throw new ApiError(400, "invalid agent mode", "invalid agent mode");
      }
      const session = createWebSession(cwd, selection, approvalMode, mode, preset, input.agent_mode as AgentMode | undefined);
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

  // History recorded by other agents (Claude Code, Codex, OpenCode).
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
    const cwd = url.searchParams.get("cwd");
    if (cwd) {
      const source = loadAgentSession(agent, id, cwd);
      if (!source) {
        sendJson(res, 404, { error: "session not found in this working directory" });
        return true;
      }
      sendJson(res, 200, { ...source, agent });
    } else {
      sendJson(res, 200, { agent, id, messages: loadAgentMessages(agent, id) });
    }
    return true;
  }

  const migrateMatch = /^\/api\/agents\/([^/]+)\/sessions\/([^/]+)\/migrate$/.exec(pathname);
  if (migrateMatch) {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    }
    if (!isSameOrigin(req)) {
      sendJson(res, 403, { error: "cross-origin request rejected" });
      return true;
    }
    const agent = decodeURIComponent(migrateMatch[1]);
    const id = decodeURIComponent(migrateMatch[2]);
    if (!isAgentId(agent) || !safeAgentSessionId(id)) {
      sendJson(res, 400, { error: !isAgentId(agent) ? "unknown agent" : "invalid session id" });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid JSON body");
      const input = body as Record<string, unknown>;
      const cwd = existingDirectory(input.cwd ?? process.cwd());
      const preset = mode === "pro" ? requireProPreset(input.pro_preset ?? defaultProPreset()) : undefined;
      const selection = mode === "pro" ? proInitialSelection(preset)
        : resolveModelSelection(input.selection ?? getWebSettings(mode).selection, false);
      const migrated = migrateAgentSession(agent, id, cwd, {
        provider: selection.provider, model: selection.model.name, intensity: selection.intensity,
      }, mode, preset);
      const session = new WebSession(migrated, selection.model, mode);
      const key = session.start();
      webSessions.set(key, session);
      sendJson(res, 201, { ok: true, id: migrated.id, key, cwd, snapshot: hub.snapshot(key) });
    } catch (err) {
      if (err instanceof SessionMigrationError) sendJson(res, err.status, { error: err.message });
      else sendApiError(res, err);
    }
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
    let preset: string | undefined;
    let agentMode: AgentMode | undefined;
    try {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid JSON body");
      const requested = (body as { selection?: unknown }).selection;
      if (requested !== undefined && mode !== "pro") selection = resolveModelSelection(requested);
      const requestedPreset = (body as { pro_preset?: unknown }).pro_preset;
      if (requestedPreset !== undefined && mode === "pro") preset = requireProPreset(requestedPreset);
      const requestedMode = (body as { agent_mode?: unknown }).agent_mode;
      if (requestedMode !== undefined) {
        if (!isAgentMode(requestedMode) || (mode === "pro" && requestedMode !== "standard")) throw new Error("invalid agent mode");
        agentMode = requestedMode;
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid model selection" });
      return true;
    }

    // Already running (TUI or another tab)? Attach instead of duplicating.
    const existing = hub.list(mode).find((entry) => entry.sessionId === id);
    if (existing) {
      const remote = hub.remoteAction(existing.key);
      if (agentMode !== undefined && mode !== "pro") {
        if (remote) {
          const result = await remote("agent-mode", { mode: agentMode });
          if (result.status !== 200) { sendJson(res, result.status, result.data); return true; }
        } else {
          const changed = hub.setAgentMode(existing.key, agentMode);
          if (!changed.ok) { sendJson(res, 409, { error: changed.error }); return true; }
        }
      }
      if (remote && preset !== undefined) {
        const result = await remote("pro-preset", { preset });
        if (result.status !== 200) { sendJson(res, result.status, result.data); return true; }
      } else if (remote && selection) {
        const result = await remote("model", { provider: selection.provider, model: selection.model.name, intensity: selection.intensity });
        if (result.status !== 200) { sendJson(res, result.status, result.data); return true; }
      }
      if (!remote && preset !== undefined) {
        const changed = hub.setProPreset(existing.key, preset);
        if (!changed.ok) { sendJson(res, 409, { error: changed.error }); return true; }
      }
      if (!remote && selection) {
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
    if (preset !== undefined) data.pro_preset = preset;
    if (agentMode !== undefined) data.agent_mode = agentMode;

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

  const liveMatch = /^\/api\/live\/([^/]+)(?:\/(pause|resume|message|approve|close|model|pro-preset|approval-mode|agent-mode|clear))?$/.exec(pathname);
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
      const remote = hub.remoteAction(key);
      if (remote) {
        if (action === "close") {
          sendJson(res, 400, { error: "this session is owned by the terminal UI" });
          return true;
        }
        try {
          const body = ["approve", "approval-mode", "agent-mode", "message", "model", "pro-preset"].includes(action)
            ? await readJsonBody(req) : {};
          const result = await remote(action, body);
          sendJson(res, result.status, result.data);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
        }
        return true;
      }
      if (action === "pro-preset") {
        if (mode !== "pro") { sendJson(res, 404, { error: "Pro presets are only available in Pro mode" }); return true; }
        try {
          const body = await readJsonBody(req);
          const preset = requireProPreset((body as { preset?: unknown } | null)?.preset);
          const changed = hub.setProPreset(key, preset);
          if (!changed.ok) sendJson(res, 409, { error: changed.error });
          else sendJson(res, 200, { ok: true, snapshot: hub.snapshot(key) });
        } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid Pro preset" }); }
        return true;
      }
      if (action === "agent-mode") {
        try {
          const body = await readJsonBody(req);
          const value = (body as { mode?: unknown } | null)?.mode;
          if (!isAgentMode(value) || mode === "pro") { sendJson(res, 400, { error: "invalid agent mode" }); return true; }
          const changed = hub.setAgentMode(key, value);
          if (!changed.ok) sendJson(res, 409, { error: changed.error });
          else sendJson(res, 200, { ok: true, snapshot: hub.snapshot(key) });
        } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid agent mode" }); }
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
      const agentMode = (body as { agent_mode?: unknown })?.agent_mode;
      if (agentMode !== undefined && (!isAgentMode(agentMode) || mode === "pro")) {
        sendJson(res, 400, { error: "invalid agent mode" }); return true;
      }
      const sent = hub.sendConfigured(key, text, agentMode as AgentMode | undefined);
      if (!sent.ok) { sendJson(res, 409, { error: sent.error }); return true; }
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
  updates: UpdateStreams,
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

  if (await handleApi(req, res, url, auth, mode, apiPathname, binding, updates)) return;
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
    prompt: { pending: options.backgroundPrompt === true },
    service: options.backgroundService,
    updateSettings: (body, mode) => updateSettings(body, mode),
  };

  // Every window watching for an update belongs to this console, not the module,
  // so a second embedded server (a test, an embedding) keeps its own set.
  const updates = createUpdateStreams();
  let localApi: LocalApiHandle | null = null;

  const server = http.createServer((req, res) => {
    handleRequest(req, res, auth, binding, updates).catch((err) => {
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
    options.onAddressChange?.();
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

  // Serialize saves from both workspaces so a failed switch cannot roll back
  // another tab's successful change.
  let settingsChanges: Promise<void> = Promise.resolve();
  function updateSettings(body: unknown, mode: Mode): Promise<void> {
    const task = settingsChanges.then(async () => {
      const previous = loadConfig(mode);
      const wasHost = binding.host;
      try {
        updateWebSettings(body, mode);
        const patch = (body as { settings?: Record<string, unknown> } | null)?.settings;
        const desiredHost = patch && Object.prototype.hasOwnProperty.call(patch, "web_lan")
          ? patch.web_lan === true ? WILDCARD_HOST : LOOPBACK_HOST
          : binding.host;
        if (desiredHost !== binding.host) await binding.setHost(desiredHost);
        if (patch && Object.prototype.hasOwnProperty.call(patch, "background")) {
          if (!binding.service?.configure) {
            throw new Error("Background residency could not be applied. Restart the console and try again.");
          }
          binding.service.configure({ resident: patch.background === true });
          if (patch.background === true) binding.prompt.pending = false;
        }
      } catch (error) {
        // A failed lifetime or address change must not look saved or active.
        if (binding.host !== wasHost) {
          try { await binding.setHost(wasHost); } catch { /* Report the original failure. */ }
        }
        const config = loadConfig(mode);
        config.web_lan = previous.web_lan;
        config.background = previous.background;
        try { saveConfig(config, mode); } catch { /* Report the original failure. */ }
        throw error;
      }
    });
    settingsChanges = task.catch(() => undefined);
    return task;
  }

  const handle: WebServerHandle = {
    host,
    port,
    authRequired: auth.enabled,
    url: "",
    urls: [],
    setHost: (next) => rebind(next),
    close: async () => {
      await localApi?.close();
      localApi = null;
      await new Promise<void>((resolve) => {
        closed = true;
        // These streams never end on their own, so they are closed explicitly;
        // otherwise server.close() would wait for a window that stays open.
        updates.closeAll();
        for (const key of [...webSessions.keys()]) closeWebSession(key);
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    },
  };

  if (!options.apiOnly) await listenRetry(host);
  // Port 0 means "let the OS pick": remember the real one for every URL.
  const address = server.address();
  port = typeof address === "object" && address ? address.port : options.port;
  syncAddress();

  try {
    const rawPort = process.env.NEUTRINO_API_PORT;
    const apiPort = options.apiPort ?? (rawPort === undefined ? (options.port === 0 && !options.apiOnly ? 0 : 8766) : Number(rawPort));
    if (!Number.isSafeInteger(apiPort) || apiPort < 0 || apiPort > 65535 || (rawPort !== undefined && !/^\d+$/.test(rawPort))) {
      throw new Error("NEUTRINO_API_PORT must be an integer between 0 and 65535");
    }
    const localAuth = new WebAuth(false);
    localApi = await startLocalApi(apiPort, async (req, res, url, mode, pathname) => {
      if (!await handleApi(req, res, url, localAuth, mode, pathname, binding, updates)) {
        sendJson(res, 404, { error: "not found" });
      }
    }, options.publishApi ?? options.port !== 0);
    handle.api = { url: localApi.url, token: localApi.token };
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }

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
