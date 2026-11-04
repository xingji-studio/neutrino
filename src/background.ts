/**
 * Background residency.
 *
 * A background Neutrino is the ordinary Web console running in a detached
 * process, with no terminal attached. Conversations started from the browser
 * are owned by that process, so closing the CLI (or the terminal window) cannot
 * interrupt them. The terminal UI keeps its own conversations; they are local
 * to the terminal and always end with it.
 *
 * The service is discovered through a small status file under `~/.neutrino`
 * (`background.json`). It carries the process id, the address it bound and a
 * random management token; the token protects the stop/ping endpoints from
 * other local processes. The file is short-lived and removed on every clean
 * shutdown, so a stale file is detected by checking the pid.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { NEUTRINO_DIR } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BACKGROUND_STATUS_FILE = path.join(NEUTRINO_DIR, "background.json");
export const BACKGROUND_LOG_FILE = path.join(NEUTRINO_DIR, "background.log");

const START_TIMEOUT_MS = 12_000;
const STOP_TIMEOUT_MS = 5_000;
const LOG_LIMIT_BYTES = 256 * 1024;

export interface BackgroundStatus {
  pid: number;
  port: number;
  host: string;
  /** Loopback address the console can be opened at. No trailing slash. */
  url: string;
  /** Whether the console asks for the Web password. */
  auth_required: boolean;
  /** Secret that authorizes the stop/ping endpoints. */
  token: string;
  started_at: string;
}

export interface StartBackgroundOptions {
  /** Requested port, or null to use the saved/default one. */
  port: number | null;
  /** Requested interface; omitted means the saved Web-access setting. */
  host?: string;
  /** Whether the service requires the Web password. */
  auth: boolean;
  /** Windows tray icon. Off for tests and headless deployments. */
  tray?: boolean;
}

export type StartBackgroundResult =
  | { ok: true; status: BackgroundStatus; started: boolean }
  | { ok: false; error: string };

export type StopBackgroundResult =
  | { ok: true; stopped: boolean }
  | { ok: false; stopped: boolean; error: string };

function ensureDir(): void {
  fs.mkdirSync(NEUTRINO_DIR, { recursive: true });
}

/** True for a positive, ordinary process id. */
function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Validate a status file (or an HTTP response) before trusting it. */
export function parseBackgroundStatus(value: unknown): BackgroundStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (!isPid(data.pid)) return null;
  if (typeof data.port !== "number" || !Number.isSafeInteger(data.port) || data.port < 1 || data.port > 65535) return null;
  if (typeof data.host !== "string" || data.host.trim() === "") return null;
  if (typeof data.url !== "string" || !/^https?:\/\//i.test(data.url)) return null;
  if (data.auth_required !== undefined && typeof data.auth_required !== "boolean") return null;
  if (typeof data.token !== "string" || data.token.length < 16) return null;
  if (typeof data.started_at !== "string" || data.started_at === "") return null;
  return {
    pid: data.pid,
    port: data.port,
    host: data.host,
    url: data.url.replace(/\/+$/, ""),
    // A status written by an older build predates the flag; the console asked
    // for a password then, which is still the safe reading.
    auth_required: data.auth_required !== false,
    token: data.token,
    started_at: data.started_at,
  };
}

/** The saved status, including a stale file from a process that no longer runs. */
export function readBackgroundStatus(): BackgroundStatus | null {
  try {
    return parseBackgroundStatus(JSON.parse(fs.readFileSync(BACKGROUND_STATUS_FILE, "utf-8")));
  } catch {
    return null;
  }
}

/** Whether `pid` is a live process. Permission errors still mean "alive". */
export function isProcessAlive(pid: number): boolean {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The running background service, or null when there is none. */
export function runningBackground(): BackgroundStatus | null {
  const status = readBackgroundStatus();
  if (!status) return null;
  if (isProcessAlive(status.pid)) return status;
  clearBackgroundStatus(status.pid);
  return null;
}

/** Write the status file atomically so another process never reads half of it. */
export function writeBackgroundStatus(status: BackgroundStatus): void {
  ensureDir();
  const temp = `${BACKGROUND_STATUS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(status, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temp, BACKGROUND_STATUS_FILE);
}

/**
 * Remove the status file. With `pid`, only remove it when it still belongs to
 * that process, so one service can never delete another's registration.
 */
export function clearBackgroundStatus(pid?: number): void {
  try {
    if (pid !== undefined) {
      const current = readBackgroundStatus();
      if (current && current.pid !== pid) return;
    }
    fs.rmSync(BACKGROUND_STATUS_FILE, { force: true });
  } catch {
    // A status file we cannot remove is retried by the next liveness check.
  }
}

/** Append a diagnostic line, rotating the file instead of letting it grow. */
export function backgroundLog(message: string): void {
  try {
    ensureDir();
    const line = `[${new Date().toISOString()}] ${message}\n`;
    try {
      if (fs.statSync(BACKGROUND_LOG_FILE).size > LOG_LIMIT_BYTES) {
        fs.writeFileSync(BACKGROUND_LOG_FILE, line, "utf-8");
        return;
      }
    } catch {
      // No log yet.
    }
    fs.appendFileSync(BACKGROUND_LOG_FILE, line, "utf-8");
  } catch {
    // Diagnostics must never break the service.
  }
}

/** The last few log lines, for a failed start message. */
export function backgroundLogTail(lines = 6): string {
  try {
    return fs.readFileSync(BACKGROUND_LOG_FILE, "utf-8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Can a client connect to the listening socket yet? */
function canConnect(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const target = host === "0.0.0.0" || host === "" ? "127.0.0.1"
      : host === "::" || host === "[::]" ? "::1"
        : host;
    const socket = net.connect({ port, host: target });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** The CLI entry point, used by the detached child. */
function cliEntry(): string {
  // Always the built CLI next to this module. `process.argv[1]` belongs to the
  // caller (a test, the terminal UI, a wrapper) and must not be re-executed.
  const bundled = path.join(__dirname, "bin.js");
  if (fs.existsSync(bundled)) return bundled;
  const entry = process.argv[1];
  if (entry && fs.existsSync(entry)) return path.resolve(entry);
  return bundled;
}

/**
 * Start the detached console, or reuse the one already running.
 *
 * The child writes the same status file we poll here, so "the address is
 * reachable" and "the file names this exact process" both have to hold before
 * the start counts as successful. The random token in the env is what proves
 * the file was written by *our* child rather than an older instance.
 */
export async function startBackgroundService(options: StartBackgroundOptions): Promise<StartBackgroundResult> {
  const existing = runningBackground();
  if (existing) return { ok: true, status: existing, started: false };
  clearBackgroundStatus();
  const token = randomBytes(32).toString("hex");
  const port = options.port ?? 8765;

  const args = [cliEntry(), "background", "run", "--port", String(port)];
  if (options.host) args.push("--host", options.host);
  if (!options.auth) args.push("--no-auth");
  if (options.tray === false) args.push("--no-tray");

  let child;
  try {
    child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, NEUTRINO_BACKGROUND_TOKEN: token },
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  child.once("error", (error) => backgroundLog(`spawn failed: ${error.message}`));
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const tail = backgroundLogTail();
      return {
        ok: false,
        error: `the background service exited with code ${child.exitCode}${tail ? `: ${tail}` : ""}`,
      };
    }
    const status = readBackgroundStatus();
    if (status && status.token === token && isProcessAlive(status.pid) && await canConnect(status.port, status.host)) {
      return { ok: true, status, started: true };
    }
    await sleep(100);
  }
  // Don't leave a half-started service behind; it has no registration yet.
  if (child.pid && isProcessAlive(child.pid)) {
    try { process.kill(child.pid, "SIGTERM"); } catch { /* Already gone. */ }
  }
  const tail = backgroundLogTail();
  return {
    ok: false,
    error: `the background service did not become reachable${tail ? `: ${tail}` : `; see ${BACKGROUND_LOG_FILE}`}`,
  };
}

/** Stop the detached service, politely first and by signal if it is stuck. */
export async function stopBackgroundService(): Promise<StopBackgroundResult> {
  const status = runningBackground();
  if (!status) {
    clearBackgroundStatus();
    return { ok: true, stopped: false };
  }
  let requested = false;
  try {
    const response = await fetch(`${status.url}/api/background/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${status.token}` },
      signal: AbortSignal.timeout(2500),
    });
    requested = response.ok;
  } catch {
    // The process may already be gone, or its socket may be wedged.
  }
  if (!requested) {
    try { process.kill(status.pid, "SIGTERM"); } catch { /* Already gone. */ }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && isProcessAlive(status.pid)) await sleep(100);
  if (isProcessAlive(status.pid)) {
    try { process.kill(status.pid, "SIGKILL"); } catch { /* Already gone. */ }
    const hardDeadline = Date.now() + 1500;
    while (Date.now() < hardDeadline && isProcessAlive(status.pid)) await sleep(100);
  }
  const alive = isProcessAlive(status.pid);
  if (!alive) clearBackgroundStatus(status.pid);
  return alive
    ? { ok: false, stopped: false, error: `background service ${status.pid} did not stop` }
    : { ok: true, stopped: true };
}
