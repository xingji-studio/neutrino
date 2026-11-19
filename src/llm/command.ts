import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT = 20_000;
const commands = new Map<string, ManagedCommand>();
export interface ManagedCommand {
  id: string;
  owner: string;
  done: Promise<string>;
  stop(reason?: string): void;
  output(): string;
  running: boolean;
}

/** Foreground and explicit background commands share the same process owner. */
export function startCommand(command: string, cwd: string, signal: AbortSignal, options: {
  owner?: string; timeoutMs?: number; background?: boolean; onCleanupTimeout?: () => void;
} = {}): ManagedCommand {
  if (!command.trim()) throw new Error("empty command");
  if (signal.aborted) throw new Error("command cancelled");
  const id = randomUUID();
  let child: ChildProcess;
  if (process.platform === "win32") {
    const helper = fileURLToPath(new URL("../../assets/windows-command.ps1", import.meta.url));
    const payload = Buffer.from(JSON.stringify({ command, cwd })).toString("base64");
    child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Payload", payload],
      { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    child = spawn(command, { cwd, shell: true, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  }
  let stdout = "", stderr = "", stopped = "";
  let exitCode: number | null = null;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (result: string) => void;
  const done = new Promise<string>(finish => { resolve = finish; });
  const output = () => {
    const ending = stopped ? `[Error: ${stopped}]` : !managed.running && exitCode !== 0 ? `[exit code: ${exitCode ?? "unknown"}]` : "";
    const body = [stdout, stderr ? `[stderr]\n${stderr}` : ""].filter(Boolean).join("\n").trim();
    return body.slice(0, MAX_OUTPUT - (ending ? ending.length + 1 : 0)) + (ending ? `\n${ending}` : body ? "" : "(no output)");
  };
  const managed: ManagedCommand = { id, owner: options.owner ?? "", done, running: true, output,
    stop(reason = "command cancelled") {
      if (!managed.running) return;
      stopped ||= reason;
      try {
        if (process.platform === "win32") child.kill(); // supervisor owns KILL_ON_JOB_CLOSE
        else if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
          }
        }
      } catch { /* Keep ownership and report unconfirmed termination below. */ }
      cleanupTimer ??= setTimeout(() => { if (managed.running) options.onCleanupTimeout?.(); }, 5000);
      cleanupTimer.unref();
    },
  };
  const abort = () => managed.stop();
  signal.addEventListener("abort", abort, { once: true });
  const timeout = options.background && options.timeoutMs === undefined ? undefined
    : setTimeout(() => managed.stop("command timed out"), options.timeoutMs ?? 120_000);
  const collect = (chunk: Buffer, error: boolean) => {
    if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    if (options.background) {
      stdout = stdout.slice(-MAX_OUTPUT / 2); stderr = stderr.slice(-MAX_OUTPUT / 2);
      return;
    }
    if (stdout.length + stderr.length > MAX_OUTPUT * 4) {
      stdout = stdout.slice(0, MAX_OUTPUT * 2); stderr = stderr.slice(0, MAX_OUTPUT * 2);
      managed.stop("command output exceeded limit");
    }
  };
  child.stdout!.on("data", data => collect(data, false));
  child.stderr!.on("data", data => collect(data, true));
  child.on("error", error => { stderr += error.message; stopped ||= "command could not start"; });
  child.on("exit", code => { exitCode = code; });
  child.on("close", code => {
    exitCode = code; managed.running = false;
    clearTimeout(timeout); clearTimeout(cleanupTimer); signal.removeEventListener("abort", abort);
    resolve(output());
    if (!options.background) commands.delete(id);
  });
  if (options.background) commands.set(id, managed);
  if (signal.aborted) abort();
  return managed;
}

export async function controlCommand(id: string, owner: string, stop: boolean): Promise<string> {
  const command = commands.get(id);
  if (!command || command.owner !== owner) return "[Error: unknown command in this task scope]";
  if (stop) { command.stop(); await command.done; commands.delete(id); }
  return JSON.stringify({ command_id: id, running: command.running, output: command.output() });
}

export function forgetCommand(id: string): void { commands.delete(id); }
