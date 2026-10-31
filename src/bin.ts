#!/usr/bin/env node
import process from "node:process";
import { App } from "./app.js";
import { loadConfig } from "./config.js";
import { installCrashGuard } from "./terminal/restore.js";
import { startWebServer, type WebServerHandle } from "./web/server.js";

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

Options:
  -p, --port <port>   Web UI port. Default: ${DEFAULT_WEB_PORT}
      --host <host>   Interface to bind. Default: 127.0.0.1
      --lan           Short for --host ${WILDCARD_HOST}: reachable from other
                      devices on your LAN or VPN.
      --no-web        Do not start the web UI with the terminal UI.
      --no-auth       Serve without password login.
      --web-port <n>  Deprecated alias for --port while the TUI runs.
  -h, --help          Show this help.

Environment:
  NEUTRINO_WEB_PORT   Same as --port in either mode.
  NEUTRINO_WEB_HOST   Same as --host.

The web UI starts by default alongside the terminal UI on loopback. Turn it
off for one run with --no-web, or permanently in Settings → Web console. It can
read every saved conversation and drive an agent with shell access, so it binds
to loopback unless you ask for --host/--lan. Log in with the permanent password
(default: 114514). Change it in Settings. --no-auth disables password login.
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

interface Options {
  mode: "tui" | "web";
  port: number | null;
  host?: string;
  lan: boolean;
  noWeb: boolean;
  noAuth: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "tui", port: null, lan: false, noWeb: false, noAuth: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "web") {
      options.mode = "web";
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

let options: Options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`neutrino: ${err instanceof Error ? err.message : String(err)}\n`);
  process.stderr.write("Run 'neutrino --help' for usage.\n");
  process.exit(2);
}

// Installed before either mode starts: a crash must leave a usable terminal
// (TUI) and a log line (both), never a shell flooded with mouse reports.
installCrashGuard();

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
} else {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write("neutrino requires an interactive terminal.\n");
    process.stderr.write("To serve the web UI without a terminal, run 'neutrino web --port <port>'.\n");
    process.exit(1);
  }

  const app = new App();
  const webPort = options.port ?? portFromEnv ?? DEFAULT_WEB_PORT;
  // Remember where the UI should live even when it is off right now, so the
  // Settings toggle can mount it without restarting the terminal.
  app.configureWeb(webPort, host, auth);

  // Explicit web settings win over the saved preference; otherwise the web UI
  // is part of a normal launch unless the user turned it off in Settings.
  const requested = options.port !== null || options.host !== undefined || options.lan
    || options.noAuth || portFromEnv !== null || Boolean(process.env.NEUTRINO_WEB_HOST);
  const enabledByDefault = loadConfig().web_console !== false;
  if (!options.noWeb && (requested || enabledByDefault)) {
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
  await app.start();
}
