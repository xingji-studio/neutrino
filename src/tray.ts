/**
 * Windows notification-area icon for the background Web console.
 *
 * Node cannot create a tray icon by itself, and the project deliberately has
 * no native dependencies, so a tiny Windows PowerShell process hosts a
 * `System.Windows.Forms.NotifyIcon`. It uses the same orbit badge as the
 * regular console's top-left mark. Everything is best-effort: an unavailable
 * icon must never stop the service.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BACKGROUND_LOG_FILE, backgroundLog } from "./background.js";
import { NEUTRINO_DIR } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, "..");
const ICON_FILE = path.join(PKG_ROOT, "assets", "neutrino.ico");
const TRAY_SCRIPT_FILE = path.join(NEUTRINO_DIR, "tray.ps1");

export interface TrayOptions {
  /** Console address opened by a click. */
  url: string;
  /** Management endpoint that stops the service. */
  stopUrl: string;
  /** Bearer token for `stopUrl`. */
  token: string;
  /** Process id the icon belongs to; the icon exits with it. */
  pid: number;
}

/** Quote a value as a PowerShell single-quoted literal. */
function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The icon itself. Only Windows has a notification area, and only it can run this. */
export function startBackgroundTray(options: TrayOptions): void {
  if (process.platform !== "win32") return;
  if (process.env.NEUTRINO_NO_TRAY === "1") return;
  if (!fs.existsSync(ICON_FILE)) {
    backgroundLog(`tray icon not found at ${ICON_FILE}`);
    return;
  }
  const script = `
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$iconPath = ${psString(ICON_FILE)}
$url = ${psString(options.url)}
$stopUrl = ${psString(options.stopUrl)}
$token = ${psString(options.token)}
$parent = ${options.pid}
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-Object System.Drawing.Icon($iconPath)
$notify.Text = 'Neutrino - background console'
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open Neutrino console')
$open.add_Click({ Start-Process -FilePath $url })
$stop = $menu.Items.Add('Stop background service')
$stop.add_Click({
  try {
    Invoke-RestMethod -Method Post -Uri $stopUrl -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5 | Out-Null
  } catch {
    Stop-Process -Id $parent -Force
  }
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$notify.ContextMenuStrip = $menu
$notify.add_MouseClick({ param($sender, $eventArgs) if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process -FilePath $url } })
$notify.add_DoubleClick({ Start-Process -FilePath $url })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) {
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;
  try {
    fs.mkdirSync(NEUTRINO_DIR, { recursive: true });
    fs.writeFileSync(TRAY_SCRIPT_FILE, `\ufeff${script}`, { encoding: "utf-8", mode: 0o600 });
    const logFd = fs.openSync(BACKGROUND_LOG_FILE, "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "powershell.exe",
        [
          "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
          "-File", TRAY_SCRIPT_FILE,
        ],
        // Not detached: on Windows a detached PowerShell exits before its
        // message loop starts. The icon outlives the service on its own; its
        // timer notices the parent pid disappearing and shuts it down.
        { stdio: ["ignore", "ignore", logFd], windowsHide: true },
      );
    } finally {
      fs.closeSync(logFd);
    }
    child.once("error", (error) => backgroundLog(`tray failed: ${error.message}`));
    child.once("exit", (code) => backgroundLog(`tray exited (${code ?? "signal"})`));
    child.unref();
    backgroundLog(`tray icon started (pid ${child.pid ?? "unknown"})`);
  } catch (error) {
    backgroundLog(`tray failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
