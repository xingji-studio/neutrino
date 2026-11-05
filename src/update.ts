import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { loadVersion } from "./config.js";

/** The published package whose registry version decides whether an update exists. */
export const UPDATE_PACKAGE = "@xingjisoft/neutrino";
/** What a user can run by hand when the automatic update fails. */
export const MANUAL_UPDATE_COMMAND = `npm install -g ${UPDATE_PACKAGE}`;
const LOOKUP_TIMEOUT_MS = 20_000;
const INSTALL_TIMEOUT_MS = 300_000;

export interface UpdateStatus {
  /** The version this process runs, read from its own package.json. */
  currentVersion: string;
  /** The published version; empty until a registry lookup has succeeded. */
  latestVersion: string;
  /** True only when the registry offers a strictly newer version. */
  hasUpdate: boolean;
}

export interface UpdateCheck extends UpdateStatus {
  /** Why the registry could not be read; the status then reports no update. */
  error?: string;
}

export interface UpdateInstallResult {
  /** Whether npm reported success. */
  ok: boolean;
  /** The version this run was updating to; empty when none was known. */
  version: string;
  /** Why the install failed; empty on success. */
  error?: string;
}

let published = "";
let pending: Promise<UpdateCheck> | null = null;
let installing: Promise<UpdateInstallResult> | null = null;

/**
 * The last known answer, for the terminal screen and the Web console payload.
 * Reading this never touches the network: the lookup runs once per process (see
 * checkForUpdate) and costs nothing afterwards.
 */
export function updateStatus(): UpdateStatus {
  const currentVersion = loadVersion();
  return {
    currentVersion,
    latestVersion: published,
    hasUpdate: isNewerVersion(published, currentVersion),
  };
}

/**
 * Ask npm which version is published and remember it. This never rejects: an
 * offline machine, a missing npm or a registry hiccup only means "no update to
 * announce", which is what the next start is for. Concurrent callers share the
 * one lookup, and a successful answer is kept for the rest of the process so
 * the terminal and the Web console cannot disagree.
 */
export function checkForUpdate(): Promise<UpdateCheck> {
  if (published) return Promise.resolve(updateStatus());
  pending ??= lookupLatestVersion()
    .then((version) => {
      published = version;
      return updateStatus();
    })
    .catch((error: unknown) => ({
      ...updateStatus(),
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => { pending = null; });
  return pending;
}

/**
 * Install the latest published release with npm.
 *
 * The terminal and both Web workspaces can ask for this, so requests share one
 * install instead of running npm twice over the same files. It never rejects:
 * whoever asked gets a result and, on failure, the command to run by hand.
 *
 * The version this process runs is not replaced — the running code stays on
 * disk until the user restarts — so callers must tell the user to restart.
 */
export function installUpdate(): Promise<UpdateInstallResult> {
  installing ??= runNpm(["install", "-g", UPDATE_PACKAGE], INSTALL_TIMEOUT_MS)
    .then((run) => npmResult(run, `install -g ${UPDATE_PACKAGE}`))
    .catch((error: unknown) => ({
      ok: false,
      version: updateStatus().latestVersion,
      error: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => { installing = null; });
  return installing;
}

interface NpmRun {
  /** Exit code, or null when npm was killed by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `npm view <package> version`, with a deadline so a hung npm cannot hold a start-up. */
async function lookupLatestVersion(): Promise<string> {
  const run = await runNpm(["view", UPDATE_PACKAGE, "version"], LOOKUP_TIMEOUT_MS);
  const version = firstVersionLine(run.stdout);
  if (version) return version;
  throw new Error(npmFailure(run, `view ${UPDATE_PACKAGE} version`));
}

/** Turn one finished npm run into the answer callers see. */
function npmResult(run: NpmRun, what: string): UpdateInstallResult {
  const version = updateStatus().latestVersion;
  return run.code === 0
    ? { ok: true, version }
    : { ok: false, version, error: npmFailure(run, what) };
}

/** The last line npm printed is the one that says what went wrong. */
function npmFailure(run: NpmRun, what: string): string {
  const reason = run.stderr.trim().split("\n").pop()?.trim();
  return `npm ${what} failed${run.code === null ? " (timed out)" : run.code === 0 ? "" : ` with code ${run.code}`}`
    + (reason ? `: ${reason}` : "");
}

/**
 * Run npm and collect a bounded amount of output. Rejects only when npm cannot
 * be started at all or does not finish in time; a failing npm resolves with its
 * exit code so the caller decides what it means.
 */
function runNpm(args: string[], timeoutMs: number): Promise<NpmRun> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      // On Windows npm is a .cmd shim, which Node only starts through a shell;
      // the command is built from fixed literals, so nothing needs quoting.
      const windows = process.platform === "win32";
      child = spawn(
        windows ? process.env.ComSpec || "cmd.exe" : "npm",
        windows ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args,
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
    } catch (error) {
      reject(new Error(`could not run npm: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, run?: NpmRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(run!);
    };
    const timer = setTimeout(() => {
      // Stop waiting on a hung npm: its output is discarded either way.
      child.kill();
      finish(new Error(`npm ${args.join(" ")} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    timer.unref();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 8192) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    // A missing npm is reported asynchronously; without this listener the
    // 'error' event would crash the whole process.
    child.on("error", (error) => finish(new Error(`could not run npm: ${error.message}`)));
    child.on("close", (code) => finish(null, { code, stdout, stderr }));
  });
}

/** npm prints the version alone, but warnings on stdout must not be mistaken for one. */
function firstVersionLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(value)) return value;
  }
  return "";
}

interface ParsedVersion {
  core: number[];
  /** null for a release, which sorts above every pre-release of that core. */
  prerelease: string[] | null;
}

function parseVersion(value: string): ParsedVersion | null {
  const text = value.trim().replace(/^v/i, "").split("+")[0];
  if (!text) return null;
  const dash = text.indexOf("-");
  const core = (dash === -1 ? text : text.slice(0, dash)).split(".");
  if (!core.length || core.some((part) => !/^\d+$/.test(part))) return null;
  const prerelease = dash === -1 ? null : text.slice(dash + 1).split(".");
  if (prerelease && prerelease.some((part) => part === "")) return null;
  return { core: core.map(Number), prerelease };
}

/**
 * Semantic-version order: returns 1 when `left` is newer, -1 when older and 0
 * when they are the same release. A version that cannot be parsed compares as
 * equal, so a malformed registry answer can never claim an update is due.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  const length = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < length; i++) {
    const difference = (a.core[i] ?? 0) - (b.core[i] ?? 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  // Numeric identifiers compare numerically and rank below alphanumeric ones.
  const compareIdentifiers = (one: string, other: string): number => {
    const numeric = /^\d+$/.test(one);
    const otherNumeric = /^\d+$/.test(other);
    if (numeric && otherNumeric) return Math.sign(Number(one) - Number(other));
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    return one < other ? -1 : one > other ? 1 : 0;
  };
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const one = a.prerelease[i];
    const other = b.prerelease[i];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const difference = compareIdentifiers(one, other);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Whether `candidate` is a strictly newer release than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
