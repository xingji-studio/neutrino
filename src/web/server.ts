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
 * interface is an explicit opt-in, and doing so requires an access token.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_DIR, listSessions, type SessionData, type SessionMeta } from "../config.js";
import { normalizeCwd } from "../cwd.js";
import { hub, type LiveEntrySummary, type LiveSnapshot } from "./hub.js";
import { writeCrashLog } from "../terminal/restore.js";
import { resumeSession, type WebSession } from "./session.js";

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
  /**
   * Shared secret every `/api/*` request must present.
   *
   * `undefined` means "decide for me": a loopback bind needs no secret, while a
   * bind that other machines can reach gets a random one — this API can drive an
   * agent with shell access, so it must never be open by accident. `null`
   * disables authentication outright, for a network you fully trust.
   */
  token?: string | null;
}

export interface WebServerHandle {
  /** Loopback URL. Always usable from this machine. */
  url: string;
  /** Every URL a client can open, with the token attached when one is needed. */
  urls: string[];
  port: number;
  host: string;
  /** Secret required on `/api/*`, or `null` when the API is open. */
  token: string | null;
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

/**
 * Decide whether this server needs a token.
 *
 * An explicit string is honoured, `null` turns authentication off, and
 * `undefined` generates a random secret for anything reachable from elsewhere.
 */
export function resolveWebToken(host: string, requested?: string | null): string | null {
  if (requested === null) return null;
  if (typeof requested === "string" && requested.trim()) return requested.trim();
  if (isLoopbackHost(host)) return null;
  return crypto.randomBytes(24).toString("base64url");
}

/** Build the list of addresses worth showing to the operator. */
export function webUrls(host: string, port: number, token: string | null): { url: string; urls: string[] } {
  const normalized = host.trim() || "127.0.0.1";
  const wildcard = WILDCARD_HOSTS.has(normalized.toLowerCase());
  const suffix = token ? `/?t=${encodeURIComponent(token)}` : "/";

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
    urls: hosts.map((h) => `http://${h}:${port}${suffix}`),
  };
}

/**
 * Everything about who can reach the server and what they must present.
 * Exported so the policy can be tested without binding a socket.
 */
export function describeWebAccess(options: WebServerOptions): {
  token: string | null;
  url: string;
  urls: string[];
} {
  const host = options.host?.trim() || "127.0.0.1";
  const token = resolveWebToken(host, options.token);
  return { token, ...webUrls(host, options.port, token) };
}

/**
 * Pull the caller's token out of a request.
 *
 * `EventSource` cannot set headers, so the SSE stream carries it in the query
 * string; everything else uses a header.
 */
function tokenFromRequest(req: http.IncomingMessage, url: URL): string | null {
  const header = req.headers["x-neutrino-token"];
  if (typeof header === "string" && header.trim()) return header.trim();

  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match) return match[1].trim();
  }

  const query = url.searchParams.get("t") ?? url.searchParams.get("token");
  return query && query.trim() ? query.trim() : null;
}

/** Constant-time token comparison. */
function tokenMatches(expected: string, provided: string | null): boolean {
  if (!provided) return false;
  // Hash first: timingSafeEqual requires equal lengths, and a wrong-length guess
  // should not be distinguishable from a wrong guess of the right length.
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
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
      title: live.title || "New conversation",
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
  token: string | null,
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/")) return false;

  if (req.method === "OPTIONS") {
    // Same-origin only: no CORS headers, so cross-site preflights are rejected.
    // Answered before the token check because it reveals nothing.
    res.writeHead(204, { Allow: "GET, POST, OPTIONS" });
    res.end();
    return true;
  }

  // Everything below reads every saved conversation and can drive an agent that
  // runs shell commands, so a server another machine can reach demands proof
  // that the caller was handed the token.
  if (token && !tokenMatches(token, tokenFromRequest(req, url))) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="neutrino"');
    sendJson(res, 401, {
      error: "unauthorized",
      hint: "open the URL printed by the terminal (it carries ?t=<token>), or send an X-Neutrino-Token header",
    });
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

    // Already running (TUI or another tab)? Attach instead of duplicating.
    const existing = hub.list().find((entry) => entry.sessionId === id);
    if (existing) {
      sendJson(res, 200, { key: existing.key, attached: true });
      return true;
    }

    const data = loadSessionSafe(id);
    if (!data) {
      sendJson(res, 404, { error: "session not found" });
      return true;
    }

    const outcome = resumeSession(data);
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

  const liveMatch = /^\/api\/live\/([^/]+)(?:\/(pause|resume|message|approve|close))?$/.exec(pathname);
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
  token: string | null,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", "http://localhost");
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }

  if (await handleApi(req, res, url, token)) return;

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method not allowed");
    return;
  }
  serveStatic(res, url.pathname);
}

/** Start the web UI. Resolves once the socket is actually listening. */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const host = options.host ?? "127.0.0.1";
  // Resolved before the socket is up so the request handler can capture it; the
  // random token must not be regenerated once the real port is known.
  const token = resolveWebToken(host, options.token);

  const server = http.createServer((req, res) => {
    handleRequest(req, res, token).catch((err) => {
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
    token,
    ...webUrls(host, port, token),
    close: () =>
      new Promise<void>((resolve) => {
        for (const key of [...webSessions.keys()]) closeWebSession(key);
        server.close(() => resolve());
      }),
  };
}
