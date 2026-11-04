import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { resolveModelSelection, type Mode } from "../config.js";
import type { TerminalBridgeInfo } from "../background.js";
import { hub, type LiveAgent, type LiveMeta, type LiveSnapshot } from "./hub.js";

interface BridgedSnapshot {
  mode: Mode;
  snapshot: LiveSnapshot;
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function authorized(req: http.IncomingMessage, token: string): boolean {
  const provided = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new Error("request too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid request");
  return value as Record<string, unknown>;
}

/** A private loopback bridge exposes only the terminal's live hub. */
export async function startTerminalBridge(): Promise<TerminalBridgeInfo & { close(): void }> {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer((req, res) => {
    void (async () => {
      if (!authorized(req, token)) { sendJson(res, 401, { error: "terminal token required" }); return; }
      if (req.method === "GET" && req.url === "/snapshots") {
        const snapshots: BridgedSnapshot[] = [];
        for (const entry of hub.list()) {
          const snapshot = hub.snapshot(entry.key);
          if (snapshot) snapshots.push({ mode: hub.has(entry.key, "pro") ? "pro" : "standard", snapshot });
        }
        sendJson(res, 200, snapshots);
        return;
      }
      if (req.method !== "POST" || req.url !== "/action") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const input = await readBody(req);
      const key = typeof input.key === "string" ? input.key : "";
      const action = input.action;
      const body = input.body && typeof input.body === "object" && !Array.isArray(input.body)
        ? input.body as Record<string, unknown> : {};
      if (!hub.has(key)) { sendJson(res, 404, { error: "unknown live session" }); return; }
      if (action === "pause") hub.pause(key);
      else if (action === "resume") hub.resume(key);
      else if (action === "message") {
        if (typeof body.text !== "string" || !body.text.trim()) throw new Error("empty message");
        hub.send(key, body.text);
      } else if (action === "approve") {
        if (!hub.approve(key, body.approved === true)) { sendJson(res, 409, { error: "no approval is pending" }); return; }
      } else if (action === "approval-mode") {
        if (body.mode !== "request" && body.mode !== "auto") throw new Error("mode must be request or auto");
        if (!hub.setApprovalMode(key, body.mode)) { sendJson(res, 409, { error: "this session cannot change approval mode" }); return; }
      } else if (action === "model") {
        const result = hub.configure(key, resolveModelSelection(body));
        if (!result.ok) { sendJson(res, 409, { error: result.error }); return; }
      } else if (action === "pro-preset") {
        if (typeof body.preset !== "string") throw new Error("invalid Pro preset");
        const result = hub.setProPreset(key, body.preset);
        if (!result.ok) { sendJson(res, 409, { error: result.error }); return; }
      } else if (action === "clear") {
        if (!hub.clear(key)) { sendJson(res, 409, { error: "this session cannot be cleared" }); return; }
      } else {
        sendJson(res, 400, { error: "this session is owned by the terminal UI" });
        return;
      }
      sendJson(res, 200, {
        ok: true, snapshot: hub.snapshot(key),
        ...(action === "pause" ? { paused: true } : action === "resume" ? { paused: false } : {}),
        ...(action === "approve" ? { approved: body.approved === true } : {}),
      });
    })().catch(error => {
      if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : "invalid request" });
      else res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not open the terminal bridge");
  return { url: `http://127.0.0.1:${address.port}`, token, close: () => { server.close(); } };
}

class RemoteTerminal implements LiveAgent {
  readonly mode: Mode;
  private current: LiveSnapshot;
  private key = "";

  constructor(private bridge: TerminalBridgeInfo, private remoteKey: string, mode: Mode, initial: LiveSnapshot) {
    this.mode = mode;
    this.current = initial;
    this.key = hub.register(this);
  }

  liveCwd(): string { return this.current.cwd; }
  liveMeta(): LiveMeta {
    const { key: _key, cwd: _cwd, messages: _messages, streamingContent: _streaming, context: _context, plan: _plan, ...meta } = this.current;
    return meta;
  }
  liveSnapshot(key: string): LiveSnapshot { return { ...this.current, key }; }
  // The public server forwards actions through remoteAction, where failures can
  // be returned to the browser rather than silently lost.
  livePause(): void {}
  liveResume(): void {}
  liveSend(_text: string): void {}

  update(snapshot: LiveSnapshot): void {
    this.current = snapshot;
    hub.notify(this.key);
  }

  async remoteAction(action: string, body: unknown): Promise<{ status: number; data: unknown }> {
    try {
      const response = await fetch(`${this.bridge.url}/action`, {
        method: "POST", headers: { Authorization: `Bearer ${this.bridge.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ key: this.remoteKey, action, body }), signal: AbortSignal.timeout(5000),
      });
      const data = await response.json() as { snapshot?: LiveSnapshot };
      if (data.snapshot) {
        this.update(data.snapshot);
        data.snapshot = this.liveSnapshot(this.key);
      }
      return { status: response.status, data };
    } catch {
      return { status: 503, data: { error: "the terminal session is unavailable" } };
    }
  }

  close(): void { hub.unregister(this.key); }
}

/** Mirror each attached terminal's live sessions into the Web service. */
export class TerminalBridges {
  private entries = new Map<number, { bridge: TerminalBridgeInfo; sessions: Map<string, RemoteTerminal>; polling: boolean; failures: number }>();
  private timer = setInterval(() => { for (const owner of this.entries.keys()) void this.poll(owner); }, 250);

  constructor() { this.timer.unref(); }

  add(owner: number, bridge: TerminalBridgeInfo): void {
    this.remove(owner);
    this.entries.set(owner, { bridge, sessions: new Map(), polling: false, failures: 0 });
    void this.poll(owner);
  }

  remove(owner: number): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    this.entries.delete(owner);
    for (const session of entry.sessions.values()) session.close();
  }

  close(): void {
    clearInterval(this.timer);
    for (const owner of this.entries.keys()) this.remove(owner);
  }

  private async poll(owner: number): Promise<void> {
    const entry = this.entries.get(owner);
    if (!entry || entry.polling) return;
    entry.polling = true;
    try {
      const response = await fetch(`${entry.bridge.url}/snapshots`, {
        headers: { Authorization: `Bearer ${entry.bridge.token}` }, signal: AbortSignal.timeout(1500),
      });
      if (!response.ok) throw new Error("terminal bridge failed");
      const snapshots = await response.json() as BridgedSnapshot[];
      if (!Array.isArray(snapshots) || this.entries.get(owner) !== entry) return;
      entry.failures = 0;
      const live = new Set<string>();
      for (const { mode, snapshot } of snapshots) {
        if (!snapshot || typeof snapshot.key !== "string" || (mode !== "standard" && mode !== "pro")) continue;
        live.add(snapshot.key);
        const session = entry.sessions.get(snapshot.key);
        if (session) session.update(snapshot);
        else entry.sessions.set(snapshot.key, new RemoteTerminal(entry.bridge, snapshot.key, mode, snapshot));
      }
      for (const [key, session] of entry.sessions) {
        if (!live.has(key)) { session.close(); entry.sessions.delete(key); }
      }
    } catch {
      // Keep snapshots over brief disconnects, but never expose a dead terminal
      // indefinitely if its process stays alive after the bridge fails.
      if (++entry.failures >= 4) {
        for (const session of entry.sessions.values()) session.close();
        entry.sessions.clear();
      }
    } finally {
      entry.polling = false;
    }
  }
}
