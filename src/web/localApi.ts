import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AGENT_MODES, NEUTRINO_DIR, type Mode } from "../config.js";
import { getWebSettings } from "./settings.js";
import { hub, type LiveSnapshot } from "./hub.js";

export interface LocalApiHandle {
  url: string;
  token: string;
  close(): Promise<void>;
}
type Route = (req: http.IncomingMessage, res: http.ServerResponse, url: URL, mode: Mode, pathname: string) => Promise<void>;
type Event = { id: string; name: string; data: unknown; bytes: number };
type Watch = { events: Event[]; bytes: number; clients: Set<http.ServerResponse>; unsubscribe: () => void; last: LiveSnapshot | null; touched: number };

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 1024 * 1024) throw new Error("request too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid JSON body");
  return value as Record<string, unknown>;
}

/** A separate, authenticated listener: Web can bind to LAN without exposing this API. */
export async function startLocalApi(port: number, route: Route, publish: boolean): Promise<LocalApiHandle> {
  const token = randomBytes(32).toString("hex");
  const epoch = randomUUID(); let seq = 0;
  const watches = new Map<string, Watch>();
  const sockets = new Set<http.ServerResponse>();
  const auth = (req: http.IncomingMessage) => {
    const supplied = Buffer.from(String(req.headers.authorization ?? ""));
    const expected = Buffer.from(`Bearer ${token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const frame = (event: Event) => `id: ${event.id}\nevent: ${event.name}\ndata: ${JSON.stringify(event.data)}\n\n`;
  const send = (res: http.ServerResponse, event: Event) => {
    if (res.destroyed || res.writableEnded) return;
    // A stalled client must not accumulate an unbounded queue in memory.
    if (res.writableLength > 4 * 1024 * 1024) { res.destroy(); return; }
    res.write(frame(event));
  };
  const watch = (key: string): Watch | null => {
    const existing = watches.get(key); if (existing) return existing;
    if (!hub.snapshot(key)) return null;
    if (watches.size >= 64) {
      const idle = [...watches.entries()].filter(([, value]) => value.clients.size === 0).sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!idle) return null;
      idle[1].unsubscribe(); watches.delete(idle[0]);
    }
    const item: Watch = { events: [], bytes: 0, clients: new Set(), unsubscribe: () => {}, last: null, touched: Date.now() };
    const emit = (name: string, data: unknown) => {
      const event = { id: `${epoch}:${++seq}`, name, data, bytes: Buffer.byteLength(JSON.stringify(data)) };
      item.events.push(event); item.bytes += event.bytes;
      while (item.events.length > 1 && (item.events.length > 256 || item.bytes > 4 * 1024 * 1024)) item.bytes -= item.events.shift()!.bytes;
      for (const client of item.clients) send(client, event);
    };
    watches.set(key, item);
    const unsub = hub.subscribe(key, snapshot => {
      const previous = item.last;
      item.last = snapshot;
      emit("snapshot", snapshot);
      if (snapshot.approval?.id && snapshot.approval.id !== previous?.approval?.id) emit("approval.requested", snapshot.approval);
      if (previous?.approval?.id && previous.approval.id !== snapshot.approval?.id) emit("approval.resolved", { id: previous.approval.id });
    });
    if (!unsub) { watches.delete(key); return null; }
    item.unsubscribe = unsub;
    return item;
  };
  const sweeper = setInterval(() => {
    for (const [key, item] of watches) {
      if (!item.clients.size && (!hub.has(key) || Date.now() - item.touched > 10 * 60_000)) {
        item.unsubscribe(); watches.delete(key);
      }
    }
  }, 60_000); sweeper.unref();
  const statusFile = path.join(NEUTRINO_DIR, "api.json");
  let actualPort = port;
  const server = http.createServer((req, res) => {
    void (async () => {
      // A browser-originated request must never be able to drive the agent, even
      // if it can reach loopback. Do not trust forwarded addresses or Host.
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${actualPort}`) { json(res, 403, { error: "local API requires a loopback Host and no Origin" }); return; }
      if (!auth(req)) { json(res, 401, { error: "Bearer token required" }); return; }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
      const match = /^\/api\/v1\/(.*)$/.exec(url.pathname);
      if (!match) { json(res, 404, { error: "not found" }); return; }
      let name = match[1]; let mode: Mode = "standard";
      if (name.startsWith("pro/")) { mode = "pro"; name = name.slice(4); }
      if (req.method === "GET" && name === "health") { json(res, 200, { ok: true, version: 1 }); return; }
      if (req.method === "GET" && name === "capabilities") { json(res, 200, { version: 1, workspaces: ["standard", "pro"], agent_modes: AGENT_MODES, streaming: "sse-snapshots", approval_ids: true }); return; }
      if (req.method === "GET" && name === "models") {
        const settings = getWebSettings(mode);
        json(res, 200, { providers: settings.providers, intensities: settings.intensities, ...(mode === "pro" ? { pro: settings.pro } : {}) }); return;
      }
      const approval = /^live\/([^/]+)\/approvals\/([^/]+)$/.exec(name);
      if (approval && req.method === "POST") {
        const key = decodeURIComponent(approval[1]), id = decodeURIComponent(approval[2]);
        if (!hub.has(key, mode)) { json(res, 404, { error: "unknown live session" }); return; }
        const input = await body(req);
        if (typeof input.approved !== "boolean") { json(res, 400, { error: "approved must be a boolean" }); return; }
        const remote = hub.remoteAction(key);
        if (remote) { const result = await remote("approve", { approved: input.approved, approval_id: id }); json(res, result.status, result.data); return; }
        if (!hub.approve(key, input.approved, id)) { json(res, 409, { error: "approval is no longer pending" }); return; }
        json(res, 200, { ok: true, approved: input.approved }); return;
      }
      const stream = /^live\/([^/]+)\/events$/.exec(name);
      if (stream && req.method === "GET") {
        const key = decodeURIComponent(stream[1]);
        if (!hub.has(key, mode)) { json(res, 404, { error: "unknown live session" }); return; }
        const item = watch(key); if (!item) { json(res, 503, { error: "too many watched sessions" }); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.write("retry: 2000\n\n");
        const cursor = String(req.headers["last-event-id"] ?? "");
        const index = cursor ? item.events.findIndex(event => event.id === cursor) : -1;
        if (cursor && index < 0) res.write(`event: reset\ndata: ${JSON.stringify({ reason: "event history unavailable" })}\n\n`);
        if (cursor && index >= 0) for (const event of item.events.slice(index + 1)) send(res, event);
        // Always provide a current snapshot, including when no event changed while disconnected.
        const current = hub.snapshot(key);
        if (current) res.write(`event: snapshot\ndata: ${JSON.stringify(current)}\n\n`);
        item.clients.add(res); item.touched = Date.now(); sockets.add(res);
        const timer = setInterval(() => {
          if (!hub.has(key, mode)) { res.write("event: gone\ndata: {}\n\n"); res.end(); return; }
          res.write(": ping\n\n");
        }, 15000); timer.unref();
        const cleanup = () => { clearInterval(timer); item.clients.delete(res); item.touched = Date.now(); sockets.delete(res); };
        req.on("close", cleanup); res.on("error", cleanup);
        return;
      }
      // The shared Web handlers are the source of truth. Explicitly exclude
      // application settings, login and service lifecycle controls.
      if (/^(settings|auth|background)(\/|$)/.test(name) || /^live\/[^/]+\/approve$/.test(name)) { json(res, 404, { error: "not found" }); return; }
      await route(req, res, url, mode, `/api/${name}`);
    })().catch(error => { if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : "invalid request" }); else res.end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("local API failed to bind"); }
  actualPort = address.port;
  const url = `http://127.0.0.1:${actualPort}/api/v1`;
  if (publish) {
    try {
      fs.mkdirSync(NEUTRINO_DIR, { recursive: true, mode: 0o700 });
      const temporary = `${statusFile}.${process.pid}.${randomBytes(6).toString("hex")}`;
      fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, url, token }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, statusFile);
    } catch (error) { clearInterval(sweeper); server.close(); throw error; }
  }
  server.on("error", () => {});
  return { url, token, close: async () => {
    clearInterval(sweeper);
    for (const item of watches.values()) item.unsubscribe();
    watches.clear(); for (const response of sockets) response.destroy(); sockets.clear();
    if (publish) {
      try { const saved = JSON.parse(fs.readFileSync(statusFile, "utf8")) as { token?: string }; if (saved.token === token) fs.unlinkSync(statusFile); } catch { /* already gone */ }
    }
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  } };
}
