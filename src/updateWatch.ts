/**
 * The periodic update check.
 *
 * A Web console can stay open for days, so the start-up lookup alone would
 * never tell its windows about a release published afterwards. This module asks
 * the registry again on a timer, in the process that serves those windows, and
 * hands a release it has not seen before to whoever is listening: the console
 * forwards it to every open browser (GET /api/update/events) and the first-open
 * dialog reads the same answer.
 */

import { checkForUpdate, updateStatus, type UpdateCheck } from "./update.js";

/** How often the background service asks the registry again. */
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

export interface UpdateWatchOptions {
  /** Overridable so a test can watch a timer; the console never changes it. */
  intervalMs?: number;
  /**
   * Called after every check, including the ones that found nothing or failed,
   * so the background log can record a change. Never allowed to stop the timer.
   */
  onCheck?: (check: UpdateCheck) => void;
}

type Listener = (check: UpdateCheck) => void;

const listeners = new Set<Listener>();
let running: (() => void) | null = null;

/**
 * Listen for a release the periodic check finds. Returns the unsubscribe
 * function.
 *
 * Only news is announced: a version this process already knows — from the
 * start-up lookup, the settings button or an earlier tick — is not sent again,
 * so the dialogs cannot reopen every half hour for a release the user has
 * already declined.
 */
export function subscribeUpdateAnnouncements(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Start asking the registry every `intervalMs` (30 minutes by default).
 *
 * Idempotent, and the returned function stops the timer and leaves the module
 * ready to start again. Checks run off the timer rather than at start-up: both
 * the console and the terminal UI already look once when they start, and a
 * second immediate lookup would only spend npm calls on the same answer.
 */
export function startUpdateWatch(options: UpdateWatchOptions = {}): () => void {
  if (running) return running;
  const timer = setInterval(() => {
    // The remembered answer is read before the lookup, because the lookup itself
    // updates it: what matters is whether this check is what discovered the
    // release.
    const known = updateStatus().latestVersion;
    // `refresh` is what makes a timer useful: without it checkForUpdate keeps
    // returning the answer this process already has and would never see a new
    // release.
    void checkForUpdate({ refresh: true }).then((check) => {
      try {
        options.onCheck?.(check);
      } catch {
        // A failing log must not stop the check that follows it.
      }
      if (!check.hasUpdate || check.latestVersion === known) return;
      for (const listener of [...listeners]) {
        try {
          listener(check);
        } catch {
          // One broken window must not starve the others.
        }
      }
    });
  }, options.intervalMs ?? UPDATE_CHECK_INTERVAL_MS);
  // A check in flight must never keep a shutting-down process alive.
  timer.unref?.();
  running = () => {
    clearInterval(timer);
    running = null;
  };
  return running;
}
