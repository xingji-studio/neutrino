import { randomBytes } from "node:crypto";
import process from "node:process";
import {
  backgroundLog, clearBackgroundStatus, isProcessAlive, writeBackgroundStatus,
  type BackgroundStatus, type BackgroundUpdate,
} from "../background.js";
import { loadConfig, saveConfig } from "../config.js";
import { startBackgroundTray } from "../tray.js";
import { hub } from "./hub.js";
import { startWebServer, type WebServerHandle } from "./server.js";
import { TerminalBridges } from "./terminalBridge.js";

/** The detached process owns browser conversations for their entire lifetime. */
export async function runWebService(options: { port: number; host?: string; auth: boolean; tray: boolean }): Promise<void> {
  const token = process.env.NEUTRINO_BACKGROUND_TOKEN?.trim() || randomBytes(32).toString("hex");
  let resident = process.env.NEUTRINO_BACKGROUND_RESIDENT !== "0";
  const owner = Number(process.env.NEUTRINO_BACKGROUND_OWNER);
  let owners = new Set(Number.isSafeInteger(owner) && owner > 0 ? [owner] : []);
  const startedAt = new Date().toISOString();
  let handle: WebServerHandle | null = null;
  let tray: ReturnType<typeof startBackgroundTray> = null;
  let monitor: NodeJS.Timeout | null = null;
  let stopping = false;
  const bridges = new TerminalBridges();

  const status = (): BackgroundStatus => {
    if (!handle) throw new Error("the Web console is starting");
    return {
      pid: process.pid, port: handle.port, host: handle.host, url: handle.url,
      auth_required: options.auth, token, started_at: startedAt,
      resident, owner_pids: [...owners],
    };
  };

  const syncTray = (): void => {
    if (!resident) {
      tray?.close();
      tray = null;
    } else if (!tray && options.tray && handle) {
      tray = startBackgroundTray({ url: handle.url, stopUrl: `${handle.url}/api/background/stop`, token, pid: process.pid });
    }
  };

  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    if (monitor) clearInterval(monitor);
    tray?.close();
    bridges.close();
    backgroundLog(`stopping pid=${process.pid}`);
    clearBackgroundStatus(process.pid);
    const finish = (): never => process.exit(0);
    if (handle) handle.close().finally(finish).catch(finish);
    else finish();
    setTimeout(finish, 3000).unref();
  };

  const configure = (update: BackgroundUpdate): BackgroundStatus => {
    if (stopping) throw new Error("the Web console is shutting down");
    if (update.ownerPid !== undefined && !isProcessAlive(update.ownerPid)) {
      throw new Error("the terminal that owns this console has already exited");
    }
    const previousResident = resident;
    const previousOwners = owners;
    const config = loadConfig();
    const changed = update.resident !== undefined;
    if (changed) saveConfig({ ...config, background: update.resident });
    resident = update.resident ?? resident;
    owners = new Set(owners);
    if (update.ownerPid !== undefined) owners.add(update.ownerPid);
    try {
      writeBackgroundStatus(status());
    } catch (error) {
      resident = previousResident;
      owners = previousOwners;
      if (changed) {
        try { saveConfig(config); } catch { /* Report the original failure. */ }
      }
      throw error;
    }
    if (update.bridge && update.ownerPid) bridges.add(update.ownerPid, update.bridge);
    syncTray();
    return status();
  };

  try {
    handle = await startWebServer({
      port: options.port, host: options.host, auth: options.auth,
      backgroundPrompt: !resident && process.env.NEUTRINO_BACKGROUND_PROMPT === "1",
      backgroundService: { token, onStop: shutdown, status, configure },
      onAddressChange: () => { if (handle) writeBackgroundStatus(status()); },
    });
    writeBackgroundStatus(status());
  } catch (error) {
    backgroundLog(`failed to start pid=${process.pid}: ${error instanceof Error ? error.message : String(error)}`);
    if (handle) await handle.close();
    process.exit(1);
  }
  backgroundLog(`started pid=${process.pid} on ${handle.url} (residency ${resident ? "on" : "off"})`);
  syncTray();

  // No helper processes: polling pids must remain invisible on Windows. An
  // orphaned, non-resident console lets an in-flight browser turn finish before
  // exiting, so disabling residency also cannot throw away running work.
  monitor = setInterval(() => {
    try {
      const live = new Set([...owners].filter(isProcessAlive));
      if (live.size !== owners.size) {
        for (const owner of owners) if (!live.has(owner)) bridges.remove(owner);
        owners = live;
        writeBackgroundStatus(status());
      }
      if (!resident && owners.size === 0 && !hub.list().some(entry =>
        entry.busy || entry.paused || entry.queued || entry.compressing || entry.approval || entry.reviewing)) {
        shutdown();
      }
    } catch (error) {
      backgroundLog(`lifetime check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, 500);
  monitor.unref();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (process.platform !== "win32") process.on("SIGHUP", () => {});
}
