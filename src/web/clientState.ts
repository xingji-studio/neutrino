/**
 * State the browser console keeps about itself.
 *
 * The sidebar's blue dot asks for attention once: it marks a conversation that
 * finished after the reader last opened it. Remembering that answer is neither a
 * conversation setting (config.json is read by the terminal UI on every tool
 * call) nor part of a transcript, so the console owns a file of its own:
 *
 *   ~/.neutrino/web.json
 *   { "seen": { "standard": ["id:2025-01-02T03-04-05-678Z", "live:L3"], "pro": [] } }
 *
 * Both workspaces keep their own record, because each has its own sidebar. The
 * file is a convenience: a missing, unreadable or hand-mangled one costs a dot,
 * never a request.
 */
import fs from "node:fs";
import path from "node:path";
import { NEUTRINO_DIR, ensureDirs, type Mode } from "../config.js";

export const WEB_STATE_FILE = path.join(NEUTRINO_DIR, "web.json");

/**
 * Identities are `id:<session id>` for a conversation with history and
 * `live:<key>` for one that has nothing saved yet (see `sessionIdentity` in
 * web/app.js). Anything else is refused, so a crafted request body cannot grow
 * the file without bound.
 */
const IDENTITY_RE = /^(?:id|live):[A-Za-z0-9._-]{1,200}$/;

/** How many finished conversations one workspace remembers, newest last. */
export const SEEN_LIMIT = 300;

/** Whether a value from a request is an identity this file can hold. */
export function isSeenIdentity(value: unknown): value is string {
  return typeof value === "string" && IDENTITY_RE.test(value);
}

/** The whole file, never throwing: an unreadable record simply holds nothing. */
function readState(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(WEB_STATE_FILE, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** The `seen` map of the file, or an empty one when it is missing or malformed. */
function seenState(state: Record<string, unknown>): Record<string, unknown> {
  const seen = state.seen;
  return seen && typeof seen === "object" && !Array.isArray(seen)
    ? seen as Record<string, unknown>
    : {};
}

/** Identities of one workspace, oldest first, with unusable entries dropped. */
function workspaceSeen(state: Record<string, unknown>, mode: Mode): string[] {
  const list = seenState(state)[mode];
  if (!Array.isArray(list)) return [];
  return list.filter(isSeenIdentity).slice(-SEEN_LIMIT);
}

/** The conversations this workspace has already shown the reader, oldest first. */
export function loadSeen(mode: Mode = "standard"): string[] {
  return workspaceSeen(readState(), mode);
}

/**
 * Record (`seen: true`) or forget (`seen: false`) the given conversations and
 * write the file back. Returns the workspace's new record.
 *
 * Identities that are not valid are ignored rather than rejected: the route
 * already validated them, so this is only a guard on what reaches the disk.
 */
export function updateSeen(mode: Mode, identities: string[], seen: boolean): string[] {
  const wanted = new Set(identities.filter(isSeenIdentity));
  if (wanted.size === 0) return loadSeen(mode);

  const state = readState();
  // A recorded conversation moves to the end, so trimming keeps the newest.
  const kept = workspaceSeen(state, mode).filter((identity) => !wanted.has(identity));
  // Trim after the merge: recording a new conversation can push the oldest out.
  const next = (seen ? [...kept, ...wanted] : kept).slice(-SEEN_LIMIT);

  ensureDirs();
  fs.writeFileSync(
    WEB_STATE_FILE,
    JSON.stringify({ ...state, seen: { ...seenState(state), [mode]: next } }, null, 2),
    "utf-8",
  );
  return next;
}
