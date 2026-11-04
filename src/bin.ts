#!/usr/bin/env node
import process from "node:process";
import { randomBytes } from "node:crypto";
import { App } from "./app.js";
import { loadConfig } from "./config.js";
import { installCrashGuard } from "./terminal/restore.js";
import { startWebServer, webUrls, type WebServerHandle } from "./web/server.js";
import {
  backgroundLog, clearBackgroundStatus, runningBackground, startBackgroundService, stopBackgroundService,
  writeBackgroundStatus, type BackgroundStatus,
} from "./background.js";
import { startBackgroundTray } from "./tray.js";
import { openInBrowser } from "./browser.js";

const DEFAULT_WEB_PORT = 8765;
/** Binding here makes the UI reachable from every interface. */
const WILDCARD_HOST = "0.0.0.0";

function parsePort(raw: string | undefined): number {
  if (!raw) throw new Error("missing port number");
  if (!/^\d+$/.test(raw)) throw new Error(`invalid port "${raw}"`);
  const port = Number(raw);
  if (port < 0 || port > 65535) throw new Error(`port out of range: ${raw}`);
  return port;
}

function envPort(): number | null {
  const raw = process.env.NEUTRINO_WEB_PORT;
  if (!raw) return null;
  try {
    return parsePort(raw);
  } catch {
    return null;
  }
}

function printHelp(): void {
  process.stdout.write(
    `Neutrino

Usage:
  neutrino                     Start the terminal UI (with the web UI).
  neutrino --lan               Start both, reachable from other devices.
  neutrino web [--port <port>] Start only the web UI (serves saved history).
  neutrino background start    Run the web UI in the background; conversations
                               started there survive the terminal/CLI exiting.
  neutrino background stop     Stop the background service.
  neutrino background status   Show whether it is running and where.
  neutrino background open     Open its console in the default browser.

Options:
  -p, --port <port>   Web UI port. Default: ${DEFAULT_WEB_PORT}
      --host <host>   Interface to bind. Default: 127.0.0.1
      --lan           Short for --host ${WILDCARD_HOST}: reachable from other
                      devices on your LAN or VPN.
      --no-web        Do not start the web UI with the terminal UI.
      --no-auth       Serve without password login.
      --no-tray       Do not show the Windows notification-area icon of the
                      background service.
      --web-port <n>  Deprecated alias for --port while the TUI runs.
  -h, --help          Show this help.

Environment:
  NEUTRINO_WEB_PORT   Same as --port in either mode.
  NEUTRINO_WEB_HOST   Same as --host.
  NEUTRINO_NO_TRAY    Set to 1 to keep the background service out of the
                      Windows notification area.

The web UI starts by default alongside the terminal UI on loopback. Turn it
off for one run with --no-web, or permanently in Settings → Web console. It can
read every saved conversation and drive an agent with shell access, so it binds
to loopback unless you ask for --host/--lan. The same LAN access can be switched
on, and off, in the browser's Settings → Web access; the choice is saved for the
next launch, while --host/--lan win for the current one. Log in with the
permanent password (default: 114514). Change it in Settings. --no-auth disables
password login.

Background residency is off by default. Turn it on in Settings → Background
(shared by the regular and Pro workspaces); the next CLI launch then starts the
console as a detached process, and this terminal only prints its address. The
background service keeps running when this terminal closes, so tasks started
from the browser are not interrupted. Stop it with 'neutrino background stop',
the tray icon, or Settings → Web console in the terminal.
`,
  );
}

/** Read the value that follows a flag, so `--host` alone is an error. */
function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing value for ${flag}`);
  }
  return value;
}

type BackgroundAction = "run" | "start" | "stop" | "status" | "open";

interface Options {
  mode: "tui" | "web" | "background";
  /** Only meaningful in `background` mode. */
  backgroundAction: BackgroundAction | null;
  port: number | null;
  host?: string;
  lan: boolean;
  noWeb: boolean;
  noAuth: boolean;
  noTray: boolean;
}

const BACKGROUND_ACTIONS = new Set<BackgroundAction>(["run", "start", "stop", "status", "open"]);

function parseArgs(argv: string[]): Options {
  const options: Options = {
    mode: "tui", backgroundAction: null, port: null, lan: false, noWeb: false, noAuth: false, noTray: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "web") {
      options.mode = "web";
    } else if (arg === "background") {
      options.mode = "background";
      options.backgroundAction = "status";
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        if (!BACKGROUND_ACTIONS.has(next as BackgroundAction)) {
          throw new Error(`unknown background action "${next}"`);
        }
        options.backgroundAction = next as BackgroundAction;
        i += 1;
      }
    } else if (arg === "--port" || arg === "-p") {
      options.port = parsePort(argv[++i]);
    } else if (arg.startsWith("--port=")) {
      options.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--web-port") {
      options.port = parsePort(argv[++i]);
    } else if (arg.startsWith("--web-port=")) {
      options.port = parsePort(arg.slice("--web-port=".length));
    } else if (arg === "--host") {
      options.host = requireValue(argv, ++i, "--host");
    } else if (arg.startsWith("--host=")) {
      options.host = arg.slice("--host=".length);
    } else if (arg === "--lan") {
      options.lan = true;
    } else if (arg === "--no-web") {
      options.noWeb = true;
    } else if (arg === "--no-auth") {
      options.noAuth = true;
    } else if (arg === "--no-tray") {
      options.noTray = true;
    } else if (arg === "--start") {
      options.mode = "background";
      options.backgroundAction = "start";
    } else if (arg === "--stop") {
      options.mode = "background";
      options.backgroundAction = "stop";
    } else if (arg === "--status") {
      options.mode = "background";
      options.backgroundAction = "status";
    } else if (arg === "--open") {
      options.mode = "background";
      options.backgroundAction = "open";
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  if (options.lan && options.host) {
    throw new Error("use either --lan or --host, not both");
  }
  if (options.noWeb && options.mode === "web") {
    throw new Error("--no-web cannot be used with the 'web' command");
  }
  if (options.noWeb && options.mode === "background") {
    throw new Error("--no-web cannot be used with the 'background' command");
  }
  if (options.noWeb && (options.port !== null || options.host !== undefined || options.lan)) {
    throw new Error("use either --no-web or web UI options, not both");
  }
  return options;
}

/** Print every address a client can open, plus what it takes to open one. */
function reportAccess(handle: WebServerHandle): void {
  process.stdout.write(`Neutrino web UI listening on ${handle.host}:${handle.port}\n`);
  const multiple = handle.urls.length > 1;
  process.stdout.write(multiple ? "Open the address that matches your device:\n" : "Open:\n");
  for (const url of handle.urls) process.stdout.write(`  ${url}\n`);
  const wildcard = handle.host === "0.0.0.0" || handle.host === "::";
  if (wildcard && !handle.urls.some((url) => !url.includes("//127.0.0.1:"))) {
    // Bound to every interface, yet nothing outside this machine is reachable:
    // usually Wi-Fi is off, the VPN is down, or the only adapters left are
    // virtual ones we deliberately hide.
    process.stdout.write(
      "note: no reachable network address found, so only this machine can connect.\n",
    );
  }
  if (handle.authRequired) {
    process.stdout.write("Sign in with your permanent Web password (default: 114514). Change it in Settings.\n");
  } else {
    process.stdout.write("Password login is disabled.\n");
  }
}

/** Print where an already-running detached console can be opened. */
function reportBackgroundAccess(status: BackgroundStatus, started: boolean): void {
  process.stdout.write(
    `Neutrino background Web console ${started ? "started" : "already running"} `
      + `(pid ${status.pid}) on ${status.host}:${status.port}\n`,
  );
  const { urls } = webUrls(status.host, status.port);
  const multiple = urls.length > 1;
  process.stdout.write(multiple ? "Open the address that matches your device:\n" : "Open:\n");
  for (const url of urls) process.stdout.write(`  ${url}\n`);
  if (status.auth_required) {
    process.stdout.write("Sign in with your permanent Web password (default: 114514).\n");
  } else {
    process.stdout.write("Password login is disabled.\n");
  }
  if (started) {
    process.stdout.write(
      "It keeps running after this terminal exits. Stop it with 'neutrino background stop'"
        + (process.platform === "win32" ? " or the tray icon" : "") + ".\n",
    );
  }
}

/**
 * The detached service itself (`neutrino background run`).
 *
 * It owns the Web console and every browser conversation for as long as the
 * machine's user session keeps it alive. The token written into the status
 * file is the only way another local process can ask it to stop.
 */
async function runBackgroundService(host: string | undefined, auth: boolean): Promise<void> {
  installCrashGuard({ surviveHangup: true });
  const port = options.port ?? portFromEnv ?? DEFAULT_WEB_PORT;
  const token = String(process.env.NEUTRINO_BACKGROUND_TOKEN ?? "").trim()
    || randomBytes(32).toString("hex");
  let handle: WebServerHandle | null = null;
  let stopping = false;

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    backgroundLog(`stopping pid=${process.pid}`);
    clearBackgroundStatus(process.pid);
    const finish = (): void => process.exit(0);
    if (handle) handle.close().finally(finish).catch(finish);
    else finish();
    // Never hang on a wedged socket while shutting down.
    setTimeout(finish, 3000).unref?.();
  };

  try {
    handle = await startWebServer({
      port,
      host,
      auth,
      backgroundPrompt: false,
      backgroundService: { token, onStop: shutdown },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    backgroundLog(`failed to start pid=${process.pid}: ${detail}`);
    process.stderr.write(`neutrino: failed to start the background Web console: ${detail}\n`);
    process.exit(1);
    return;
  }

  const status: BackgroundStatus = {
    pid: process.pid,
    port: handle.port,
    host: handle.host,
    url: handle.url,
    auth_required: auth,
    token,
    started_at: new Date().toISOString(),
  };
  try {
    writeBackgroundStatus(status);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    backgroundLog(`failed to write status pid=${process.pid}: ${detail}`);
    process.stderr.write(`neutrino: could not record the background service: ${detail}\n`);
    await handle.close();
    process.exit(1);
    return;
  }
  backgroundLog(`started pid=${process.pid} on ${handle.url}`);
  reportAccess(handle);
  process.stdout.write("Background service is running. Press Ctrl+C or use 'neutrino background stop'.\n");
  if (!options.noTray) {
    startBackgroundTray({
      url: handle.url,
      stopUrl: `${handle.url}/api/background/stop`,
      token,
      pid: process.pid,
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Detached processes normally have no controlling terminal, but keep the
  // service alive if a POSIX shell still forwards its hangup.
  if (process.platform !== "win32") process.on("SIGHUP", shutdown);
}

function printBackgroundStatus(): void {
  const status = runningBackground();
  if (!status) {
    process.stdout.write("No background service is running.\n");
    process.stdout.write("Start one with 'neutrino background start'.\n");
    return;
  }
  process.stdout.write(`Neutrino background service: running (pid ${status.pid})\n`);
  process.stdout.write(`Started: ${status.started_at}\n`);
  process.stdout.write(`Address: ${status.url}\n`);
  const { urls } = webUrls(status.host, status.port);
  for (const url of urls) {
    if (url.replace(/\/$/, "") !== status.url) process.stdout.write(`Also: ${url}\n`);
  }
}


let options: Options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`neutrino: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stderr.write("Run 'neutrino --help' for usage.\n");
  process.exit(2);
}

// Installed before either mode starts: a crash must leave a usable terminal
// (TUI) and a log line (both), never a shell flooded with mouse reports. A
// detached service keeps its own SIGHUP handler so closing the terminal cannot
// take it down.
installCrashGuard({ surviveHangup: options.mode === "background" });

const host = options.lan ? WILDCARD_HOST : options.host || process.env.NEUTRINO_WEB_HOST || undefined;
const auth = !options.noAuth;
const portFromEnv = envPort();

if (options.mode === "web") {
  // Headless: serve the saved history (and any live sessions in this process,
  // which for a standalone server is none).
  const port = options.port ?? portFromEnv ?? DEFAULT_WEB_PORT;
  try {
    const handle = await startWebServer({ port, host, auth });
    reportAccess(handle);
    process.stdout.write("Serving saved conversations. Press Ctrl+C to stop.\n");
    const shutdown = () => {
      handle.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    process.stderr.write(`neutrino: failed to start web server: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
} else if (options.mode === "background") {
  const action = options.backgroundAction ?? "status";
  if (action === "run") {
    // The detached child. It does not own a terminal, so its stdio is ignored
    // by the parent and every diagnostic goes to background.log.
    await runBackgroundService(host, auth);
  } else if (action === "start") {
    const result = await startBackgroundService({
      port: options.port ?? portFromEnv ?? DEFAULT_WEB_PORT,
      host,
      auth,
      tray: !options.noTray,
    });
    if (!result.ok) {
      process.stderr.write(`neutrino: ${result.error}\n`);
      process.exit(1);
    }
    reportBackgroundAccess(result.status, result.started);
    process.exitCode = 0;
  } else if (action === "stop") {
    const result = await stopBackgroundService();
    if (!result.ok) {
      process.stderr.write(`neutrino: ${result.error}\n`);
      process.exit(1);
    }
    process.stdout.write(result.stopped ? "Background service stopped.\n" : "No background service is running.\n");
    process.exitCode = 0;
  } else if (action === "open") {
    let status = runningBackground();
    if (!status) {
      const started = await startBackgroundService({
        port: options.port ?? portFromEnv ?? DEFAULT_WEB_PORT,
        host,
        auth,
        tray: !options.noTray,
      });
      if (!started.ok) {
        process.stderr.write(`neutrino: ${started.error}\n`);
        process.exit(1);
      }
      status = started.status;
      reportBackgroundAccess(status, started.started);
    }
    openInBrowser(status.url);
    process.stdout.write(`Opening ${status.url}\n`);
    process.exitCode = 0;
  } else {
    printBackgroundStatus();
    process.exitCode = 0;
  }
} else {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("neutrino requires an interactive terminal.\n");
    process.stderr.write("To serve the web UI without a terminal, run 'neutrino web --port <port>'.\n");
    process.exit(1);
  }

  const app = new App();
  const webPort = options.port ?? portFromEnv ?? DEFAULT_WEB_PORT;
  const saved = loadConfig();
  const backgroundEnabled = saved.background === true;
  // Remember where the UI should live even when it is off right now, so the
  // Settings toggle can mount it without restarting the terminal. A console
  // that runs in-process offers the background-residency prompt; a detached one
  // is already in the background and never does.
  app.configureWeb(webPort, host, auth, !backgroundEnabled);

  // Explicit web settings win over the saved preference; otherwise the web UI
  // is part of a normal launch unless the user turned it off in Settings.
  const requested = options.port !== null || options.host !== undefined || options.lan
    || options.noAuth || portFromEnv !== null || Boolean(process.env.NEUTRINO_WEB_HOST);
  const enabledByDefault = saved.web_console !== false;
  if (!options.noWeb && (requested || enabledByDefault)) {
    let attached = false;
    const existing = runningBackground();
    if (existing) {
      // Never start a second listener on the same port: if a background
      // service is already up, use it instead (even when the saved setting was
      // turned off after that process started).
      if (options.port !== null && existing.port !== webPort) {
        process.stderr.write(
          `note: a background Web console is already running on port ${existing.port}; --port was not applied.\n`,
        );
      }
      app.attachBackground(existing);
      reportBackgroundAccess(existing, false);
      attached = true;
    } else if (backgroundEnabled) {
      const started = await startBackgroundService({
        port: webPort,
        host,
        auth,
        tray: !options.noTray,
      });
      if (started.ok) {
        app.attachBackground(started.status);
        reportBackgroundAccess(started.status, started.started);
        attached = true;
      } else {
        // A failed detached start must not take the terminal down: fall back to
        // the in-process console, exactly as if the setting were off.
        process.stderr.write(`neutrino: background Web console not started: ${started.error}\n`);
      }
    }
    if (!attached) {
      try {
        const handle = await app.enableWeb(webPort, host, auth);
        reportAccess(handle);
      } catch (err) {
        // A console that cannot bind (usually a second instance on 8765) must
        // never take the terminal down with it.
        const detail = err instanceof Error ? err.message : String(err);
        process.stderr.write(`neutrino: web UI not started: ${detail}\n`);
        process.stderr.write("The terminal UI will keep running. Pass --port <port> to use another port, or --no-web to skip the web UI.\n");
      }
    }
  }
  await app.start();
}
