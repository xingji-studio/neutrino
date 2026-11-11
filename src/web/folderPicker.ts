/**
 * The operating system's own folder window, opened by the machine that runs the
 * console.
 *
 * A browser's folder picker only ever hands back the *contents* it was allowed
 * to read, never the absolute path, so a working directory cannot be chosen from
 * the page itself: it has to be chosen where the agent runs, which is this
 * process. Each platform draws its native window — the same dialog every other
 * application shows — and when none can be drawn (a headless server, a minimal
 * desktop without zenity or kdialog) the page keeps its own folder browser.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** What the folder window reported. Closing the window is a normal outcome. */
export type FolderPick =
  | { picked: string }
  | { cancelled: true }
  | { unavailable: string };

/** One finished dialog process. */
export interface DialogRun {
  /** Exit code, or null when the process never ran to completion. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** The executable itself does not exist here. */
  missing: boolean;
}

/**
 * Runs one dialog command. Injectable so the Windows, macOS and Linux paths can
 * be tested on any machine, without a desktop session to draw a window in.
 */
export type DialogRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<DialogRun>;

export interface FolderPickRequest {
  /** Folder the window opens in. Ignored when it is not an existing folder. */
  start?: string;
  /** Window title, already translated by the console. */
  title?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  runner?: DialogRunner;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TITLE = "Select a working directory";
/** A window nobody answers must never pin the HTTP request forever. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TITLE_LENGTH = 120;

/** Open the operating system's folder window and report what the user chose. */
export async function pickFolder(request: FolderPickRequest = {}): Promise<FolderPick> {
  const platform = request.platform ?? process.platform;
  const env: NodeJS.ProcessEnv = { ...(request.env ?? process.env) };
  const run = request.runner ?? runDialog;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = startFolder(request.start);
  const title = dialogTitle(request.title);
  // Both scripts read their inputs from the environment: a path is passed to the
  // child without quoting rules, spaces and quotes included.
  env.NEUTRINO_PICKER_START = start;
  env.NEUTRINO_PICKER_TITLE = title;

  if (platform === "win32") return pickWindows(run, env, timeoutMs);
  if (platform === "darwin") return pickMac(run, env, timeoutMs, start, title);
  if (platform === "linux") return pickLinux(run, env, timeoutMs, start, title);
  return { unavailable: `the system folder window is not available on ${platform}` };
}

// ------------------------------------------------------------------ windows

/**
 * Windows PowerShell is present on every Windows Node supports; `pwsh` is the
 * fallback for a machine where it was removed.
 */
async function pickWindows(run: DialogRunner, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<FolderPick> {
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-folder-"));
  } catch (err) {
    return { unavailable: reason(err) };
  }
  const script = path.join(dir, "folder-window.ps1");
  try {
    fs.writeFileSync(script, WINDOWS_DIALOG, "utf8");
    let missing = "";
    for (const shell of ["powershell.exe", "pwsh.exe"]) {
      const result = await run(
        shell,
        ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", script],
        env,
        timeoutMs,
      );
      if (result.missing) {
        missing = `${shell} is not installed`;
        continue;
      }
      const picked = result.stdout.trim();
      if (picked) return { picked };
      if (result.code === 0) return { cancelled: true };
      return { unavailable: lastLine(result.stderr) || `the system folder window failed (exit ${result.code})` };
    }
    return { unavailable: missing || "no PowerShell is installed" };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp folder is harmless.
    }
  }
}

// -------------------------------------------------------------------- macOS

async function pickMac(
  run: DialogRunner,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  start: string,
  title: string,
): Promise<FolderPick> {
  const result = await run("osascript", ["-e", MAC_DIALOG, title, start], env, timeoutMs);
  if (result.missing) return { unavailable: "osascript is not installed" };
  if (result.code === 0) {
    // `POSIX path of` ends a folder with a separator; the rest of the console
    // stores working directories without one.
    const picked = trimTrailingSeparator(result.stdout.trim());
    return picked ? { picked } : { cancelled: true };
  }
  // AppleScript reports a closed window as "User canceled. (-128)".
  if (/-128\b/.test(result.stderr) || /cancel/i.test(result.stderr)) return { cancelled: true };
  return { unavailable: lastLine(result.stderr) || "the system folder window failed" };
}

// -------------------------------------------------------------------- linux

async function pickLinux(
  run: DialogRunner,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  start: string,
  title: string,
): Promise<FolderPick> {
  // Both dialogs draw on a desktop session, and only a local user has one.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { unavailable: "no desktop session is available" };
  const attempts: { command: string; args: string[] }[] = [
    {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        `--title=${title}`,
        ...(start ? [`--filename=${trimTrailingSeparator(start)}${path.sep}`] : []),
      ],
    },
    { command: "kdialog", args: ["--title", title, "--getexistingdirectory", start] },
  ];
  let missing = "";
  for (const attempt of attempts) {
    const result = await run(attempt.command, attempt.args, env, timeoutMs);
    if (result.missing) {
      missing = `${attempt.command} is not installed`;
      continue;
    }
    const picked = result.stdout.trim();
    if (result.code === 0 && picked) return { picked };
    // 1 is "the user closed the window"; 5 is zenity's own timeout.
    if (result.code === 1 || result.code === 5) return { cancelled: true };
    return { unavailable: lastLine(result.stderr) || `the ${attempt.command} folder window failed (exit ${result.code})` };
  }
  return { unavailable: missing || "no folder window is installed" };
}

// ------------------------------------------------------------------- runner

const runDialog: DialogRunner = (command, args, env, timeoutMs) =>
  new Promise<DialogRun>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: reason(err), missing: isMissing(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (result: DialogRun): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr: stderr || "the folder window was left open for too long", missing: false });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (err) => finish({ code: null, stdout, stderr, missing: isMissing(err) }));
    child.on("close", (code) => finish({ code, stdout, stderr, missing: false }));
  });

// ------------------------------------------------------------------- inputs

/** An existing folder to open the window in; the home folder otherwise. */
function startFolder(raw: string | undefined): string {
  const text = String(raw ?? "").trim();
  if (text && path.isAbsolute(text)) {
    try {
      if (fs.statSync(text).isDirectory()) return text;
    } catch {
      // A folder that is gone is simply not offered as a start.
    }
  }
  return os.homedir();
}

/** The window title is console-authored text, but never trusted into a shell. */
function dialogTitle(raw: string | undefined): string {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
  return text || DEFAULT_TITLE;
}

function trimTrailingSeparator(value: string): string {
  if (!value) return "";
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed || value; // A filesystem root keeps its separator.
}

function lastLine(text: string): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------------- scripts

/**
 * C# that finds the dialog window this process just drew and raises it. It is
 * kept apart from the shell interop below because it is compiled a second time,
 * on its own, when the shell dialog itself cannot be created at all.
 */
const WINDOW_RAISER = `    private delegate bool WindowProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint attach, uint attachTo, bool join);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FlashInfo info);

    [StructLayout(LayoutKind.Sequential)]
    private struct FlashInfo
    {
        public uint Size;
        public IntPtr Window;
        public uint Flags;
        public uint Count;
        public uint Timeout;
    }

    private const int ShowRestore = 9;
    private const uint PositionNoMove = 0x0002;
    private const uint PositionNoSize = 0x0001;
    private const uint PositionNoActivate = 0x0010;
    private const uint FlashAll = 0x00000003;
    private const string DialogClass = "#32770";
    private static readonly IntPtr TopMost = new IntPtr(-1);
    private static readonly IntPtr NotTopMost = new IntPtr(-2);

    /// <summary>
    /// The dialog this process has on screen. Only the dialog class counts: the
    /// console this script runs in owns visible windows of its own, and those
    /// must never be raised in the dialog's place.
    /// </summary>
    private static IntPtr DialogWindow()
    {
        int own = Process.GetCurrentProcess().Id;
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if ((int)processId != own || !IsWindowVisible(window)) return true;
            StringBuilder name = new StringBuilder(32);
            GetClassName(window, name, name.Capacity);
            if (name.ToString() != DialogClass) return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    /// <summary>
    /// The dialog's window, once it is actually on screen; a drawer that has
    /// already finished means there is nothing left to wait for.
    /// </summary>
    private static IntPtr WaitForWindow(Thread drawer, int budgetMs)
    {
        for (int waited = 0; waited < budgetMs; waited += 50)
        {
            IntPtr found = DialogWindow();
            if (found != IntPtr.Zero) return found;
            if (drawer != null && !drawer.IsAlive) return IntPtr.Zero;
            Thread.Sleep(50);
        }
        return IntPtr.Zero;
    }

    /// <summary>
    /// The window is drawn by a process with no console window of its own, from
    /// the background: Windows leaves it behind whatever the user has in front
    /// and gives it nothing in the taskbar to be found by. Joining the
    /// foreground thread earns the right to raise it, and the topmost hop covers
    /// a foreground window this process may not touch.
    /// </summary>
    public static void Raise(IntPtr window)
    {
        ShowWindow(window, ShowRestore);
        IntPtr foreground = GetForegroundWindow();
        uint foregroundProcess = 0;
        uint foregroundThread = 0;
        if (foreground != IntPtr.Zero) foregroundThread = GetWindowThreadProcessId(foreground, out foregroundProcess);
        uint own = GetCurrentThreadId();
        bool attached = foregroundThread != 0 && foregroundThread != own && AttachThreadInput(own, foregroundThread, true);
        if (!SetForegroundWindow(window))
        {
            BringWindowToTop(window);
            SetForegroundWindow(window);
        }
        SetWindowPos(window, TopMost, 0, 0, 0, 0, PositionNoMove | PositionNoSize | PositionNoActivate);
        SetWindowPos(window, NotTopMost, 0, 0, 0, 0, PositionNoMove | PositionNoSize | PositionNoActivate);
        SetForegroundWindow(window);
        if (attached) AttachThreadInput(own, foregroundThread, false);

        // Focus cannot always move to a background process; a flash still tells
        // the user where the window is.
        FlashInfo flash = new FlashInfo();
        flash.Size = (uint)Marshal.SizeOf(typeof(FlashInfo));
        flash.Window = window;
        flash.Flags = FlashAll;
        flash.Count = 3;
        FlashWindowEx(ref flash);
    }

    /// <summary>
    /// Raises the window a blocking ShowDialog is still drawing: the wait and the
    /// raise run on a thread of their own, and a host that cannot do it keeps a
    /// dialog that is merely harder to find.
    /// </summary>
    public static void RaiseWhenShown(int budgetMs)
    {
        Thread raiser = new Thread(delegate()
        {
            IntPtr window = WaitForWindow(null, budgetMs);
            if (window == IntPtr.Zero) return;
            try { Raise(window); }
            catch (Exception) { }
        });
        raiser.IsBackground = true;
        raiser.Start();
    }
`;

/**
 * The COM interop is written out by hand because .NET Framework's own
 * `FolderBrowserDialog` is the old tree window: `IFileOpenDialog` with
 * `FOS_PICKFOLDERS` is the Explorer window Windows 10 and 11 users expect.
 * The WinForms dialog stays as a fallback for a host that refuses the interop.
 *
 * The script is kept at column 0 so the PowerShell here-strings stay intact.
 */
const WINDOWS_DIALOG = `$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class NeutrinoFolderWindow
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    // The class only answers QueryInterface for IFileOpenDialog's own iid:
    // asking for IFileDialog's iid is refused with E_NOINTERFACE on current
    // Windows builds. Every IFileDialog member comes first in this vtable, so
    // the whole dialog - Show, SetOptions, GetResult - is reachable through it,
    // and the window is the Explorer folder picker rather than the old tree.
    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filter);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int place);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
        void GetResults(out IntPtr items);
        void GetSelectedItems(out IntPtr items);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr bindContext, ref Guid handler, ref Guid interfaceId, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint form, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        [MarshalAs(UnmanagedType.LPStruct)] Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    private const uint PickFolders = 0x00000020;
    private const uint ForceFileSystem = 0x00000040;
    private const uint NoChangeDir = 0x00000008;
    private const uint FileSystemPath = 0x80058000;

${WINDOW_RAISER}
    /// <summary>The chosen folder, or null when the window was closed.</summary>
    public static string Pick(string start, string title)
    {
        string picked = null;
        Exception failure = null;
        // A dialog belongs to the thread that shows it, so it is created and
        // drawn there; this thread only has to raise the finished window.
        Thread worker = new Thread(delegate()
        {
            try { picked = Show(start, title); }
            catch (Exception error) { failure = error; }
        });
        worker.SetApartmentState(ApartmentState.STA);
        worker.IsBackground = true;
        worker.Start();

        IntPtr window = WaitForWindow(worker, 20000);
        if (window != IntPtr.Zero)
        {
            // Raising the window is a courtesy: if it cannot be done the dialog
            // is still usable, so it must never fail, or cancel, the pick.
            try { Raise(window); }
            catch (Exception) { }
        }

        worker.Join();
        if (failure != null) throw failure;
        return picked;
    }

    private static string Show(string start, string title)
    {
        IFileOpenDialog dialog = (IFileOpenDialog)new FileOpenDialog();
        uint options;
        dialog.GetOptions(out options);
        dialog.SetOptions(options | PickFolders | ForceFileSystem | NoChangeDir);
        if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
        if (!string.IsNullOrEmpty(start))
        {
            try
            {
                IShellItem folder;
                SHCreateItemFromParsingName(start, IntPtr.Zero, new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), out folder);
                dialog.SetFolder(folder);
            }
            catch (Exception)
            {
                // A start folder that no longer exists must not fail the dialog.
            }
        }
        int result = dialog.Show(IntPtr.Zero);
        if (result != 0) return null;
        IShellItem chosen;
        dialog.GetResult(out chosen);
        string path;
        chosen.GetDisplayName(FileSystemPath, out path);
        return path;
    }
}
'@

# Compiled only when the interop above is refused: it holds no COM at all, so a
# host that will not take the shell dialog can still raise the older window.
$raise = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class NeutrinoFallbackRaise
{
${WINDOW_RAISER}
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp | Out-Null
  $picked = [NeutrinoFolderWindow]::Pick($env:NEUTRINO_PICKER_START, $env:NEUTRINO_PICKER_TITLE)
  if ($picked) { [Console]::Out.Write($picked) }
} catch {
  # A locked-down host may refuse the interop; the plain WinForms dialog is the
  # same choice in an older skin and is always available.
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $window = New-Object System.Windows.Forms.FolderBrowserDialog
    if ($env:NEUTRINO_PICKER_TITLE) { $window.Description = $env:NEUTRINO_PICKER_TITLE }
    if ($env:NEUTRINO_PICKER_START) { $window.SelectedPath = $env:NEUTRINO_PICKER_START }
    # ShowDialog blocks this thread, so the window is raised from another one;
    # a host that will not compile the raiser still shows a usable window.
    try {
      Add-Type -TypeDefinition $raise -Language CSharp | Out-Null
      [NeutrinoFallbackRaise]::RaiseWhenShown(20000)
    } catch { }
    if ($window.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($window.SelectedPath) }
  } catch {
    [Console]::Error.Write($_.Exception.Message)
    exit 1
  }
}
exit 0
`;

/** `choose folder` returns a path ending in a separator; the caller strips it. */
const MAC_DIALOG = [
  "on run argv",
  "set promptText to item 1 of argv",
  "set startPath to item 2 of argv",
  'tell application "System Events" to activate',
  'if startPath is "" then',
  "set chosen to choose folder with prompt promptText",
  "else",
  "set chosen to choose folder with prompt promptText default location (POSIX file startPath)",
  "end if",
  "return POSIX path of chosen",
  "end run",
].join("\n");
