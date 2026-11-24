import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TaskController } from "./controller.js";
import { NEUTRINO_DIR } from "../config.js";
import { TASK_SERVICE_STATUS, TASK_SERVICE_LOG, TASK_SERVICE_BUILD, type TaskServiceStatus } from "./service.js";

function log(message: string): void {
  try {
    fs.mkdirSync(NEUTRINO_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(TASK_SERVICE_LOG, `${new Date().toISOString()} pid=${process.pid} ${message}\n`, { mode: 0o600 });
  } catch { /* Store failures are also enforced by each TaskRuntime. */ }
}
const self = fileURLToPath(import.meta.url);

if (process.argv.includes("--supervise")) {
  let ownership: TaskController;
  try { ownership = new TaskController(path.join(NEUTRINO_DIR, "tasks", "supervisor"), String(process.pid), "Supervise task execution service"); }
  catch { process.exit(0); }
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  let failures: number[] = [];
  const finish = (): never => { ownership.finish("completed", "service_shutdown"); process.exit(0); };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const current = child;
    if (!current || current.exitCode !== null) return finish();
    current.send?.({ type: "shutdown" });
    setTimeout(() => { child?.kill("SIGKILL"); finish(); }, 6000).unref();
  };
  const start = () => {
    if (stopping) return;
    child = spawn(process.execPath, [self, "--serve"], {
      stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true,
      env: { ...process.env, NEUTRINO_TASK_SUPERVISOR: String(process.pid) },
    });
    child.stderr?.on("data", data => log(`worker stderr: ${String(data).slice(0, 2000)}`));
    child.on("message", message => { if ((message as { type?: string }).type === "intentional_shutdown") stopping = true; });
    let exited = false;
    const exitedOnce = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      log(`worker_exit pid=${child?.pid} code=${code} signal=${signal ?? "none"} intentional=${stopping}`);
      if (stopping) finish();
      failures = failures.filter(at => Date.now() - at < 60_000); failures.push(Date.now());
      if (failures.length > 5) {
        ownership.finish("blocked", "worker_restart_budget_exhausted");
        log("worker_restart_budget_exhausted; automatic restart stopped"); process.exit(1);
      }
      setTimeout(start, Math.min(5000, 250 * 2 ** (failures.length - 1)));
    };
    child.once("error", error => { log(`worker spawn error: ${error.message}`); exitedOnce(1, null); });
    child.once("exit", exitedOnce);
  };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  if (process.platform !== "win32") process.on("SIGHUP", () => {});
  start();
} else if (process.argv.includes("--serve")) {
  const { startWebServer, registerRecoveredSession } = await import("../web/server.js");
  const { recoverStoredTasks } = await import("./recovery.js");
  const handle = await startWebServer({ port: 0, apiPort: 0, apiOnly: true, auth: false, publishApi: false, executionService: true });
  const status: TaskServiceStatus = {
    protocol: 1, build: TASK_SERVICE_BUILD, pid: process.pid, supervisorPid: Number(process.env.NEUTRINO_TASK_SUPERVISOR),
    url: handle.api!.url, token: handle.api!.token, startedAt: new Date().toISOString(),
  };
  fs.mkdirSync(NEUTRINO_DIR, { recursive: true, mode: 0o700 });
  for (const candidate of recoverStoredTasks()) {
    log(`recovery session=${candidate.source.id} reason=${candidate.reason} auto=${candidate.autoResume}`);
    if (candidate.autoResume) registerRecoveredSession(candidate.source, candidate.mode);
  }
  const temp = `${TASK_SERVICE_STATUS}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(status), { mode: 0o600 });
  fs.renameSync(temp, TASK_SERVICE_STATUS);
  log(`worker_ready supervisor=${status.supervisorPid} build=${status.build}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.send?.({ type: "intentional_shutdown" });
    await handle.close();
    try { if (JSON.parse(fs.readFileSync(TASK_SERVICE_STATUS, "utf8")).pid === process.pid) fs.unlinkSync(TASK_SERVICE_STATUS); } catch { /* Replacement service owns its record. */ }
    process.exit(0);
  };
  process.on("message", message => { if ((message as { type?: string }).type === "shutdown") void stop(); });
  process.on("SIGTERM", () => { void stop(); }); process.on("SIGINT", () => { void stop(); });
  process.on("uncaughtException", error => { log(`uncaught_exception ${error.stack ?? error.message}`); process.exit(1); });
  process.on("unhandledRejection", error => { log(`unhandled_rejection ${String(error)}`); process.exit(1); });
  if (process.platform !== "win32") process.on("SIGHUP", () => {});
}
