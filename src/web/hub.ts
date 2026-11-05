/**
 * The live-session hub.
 *
 * The terminal UI is the source of truth for a conversation: while a
 * {@link ../screens/chat.js ChatScreen} is open it owns the message list, the
 * streaming buffer and the busy/paused flags. The web server, however, must be
 * able to (a) show *every* conversation live and (b) drive the running one
 * (pause, resume, send). This hub is the bridge between the two.
 *
 * A screen registers itself once it is activated and unregisters when it is
 * popped. Every time the screen changes something meaningful it calls
 * {@link LiveHub.notify}, which coalesces rapid-fire updates (one per streamed
 * token) and pushes a snapshot to any connected browser.
 */

import type { ConversationContext } from "../compact.js";
import { normalizeMode, type ApprovalMode, type Mode, type ResolvedModelSelection } from "../config.js";
import type { RiskAssessment } from "../llm/risk.js";
import type { PlanState } from "../llm/plan.js";
import type { ProFallback } from "../pro/config.js";

export type ModelChangeResult = { ok: true } | { ok: false; error: string };

/** Complete proposal shown before a human or automated approval decision. */
export interface LiveApprovalRequest {
  tool: string;
  level: "high" | "extreme";
  arguments: Record<string, unknown>;
  cwd: string;
  summary: string;
  reasons: string[];
}

export interface LiveReviewProgress {
  total: number;
  round: number;
  rounds: number;
  request?: LiveApprovalRequest;
}

export function liveApprovalDetails(
  tool: string, args: Record<string, unknown>, risk: RiskAssessment, cwd: string,
): LiveApprovalRequest {
  return { tool, level: risk.level, arguments: args, cwd, summary: risk.summary, reasons: risk.reasons };
}

/** A message as understood by the web UI. */
export type LiveWireMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "tool"; name: string; arguments: Record<string, unknown>; result: string }
  | { role: "summary"; content: string; count: number };

/** A model request that failed and is being retried. */
export interface LiveRetryNotice {
  /** The attempt about to be made (2 = the first retry). */
  attempt: number;
  /** Total attempts allowed. */
  attempts: number;
  /** How long this attempt waits before going out. */
  delayMs: number;
}

/** The small, frequently-changing part of a live session. */
export interface LiveMeta {
  /** On-disk session id, or null until the conversation is first saved. */
  sessionId: string | null;
  title: string;
  /**
   * Nothing has been said in this conversation yet. The sidebar leaves such a
   * session out of the list until it has content, so an abandoned new chat
   * never turns into a history entry.
   */
  empty?: boolean;
  provider: string;
  model: string;
  intensity: string;
  busy: boolean;
  paused: boolean;
  queued: string | null;
  compressing: boolean;
  /** A failed history write, cleared after the next successful checkpoint. */
  saveError?: string | null;
  /** A retried model request, so the browser can explain the silence. */
  retrying?: LiveRetryNotice | null;
  tokens: { prompt: number; completion: number };
  /** Tool call waiting for a human decision, or null. */
  approval?: LiveApprovalRequest | null;
  /** Reviewer count while an automated approval review is running. */
  reviewing?: LiveReviewProgress | null;
  /** What a running sub-agent is doing right now, or null when none is running. */
  subagent?: string | null;
  approvalMode?: ApprovalMode;
  pro?: {
    preset: string;
    checking: boolean;
    checkId: string;
    models: Array<{ role: string; provider: string; model: string; intensity: string; tier: string }>;
    fallbacks: ProFallback[];
    error?: string;
  };
}

/** Everything a browser needs to render a live conversation. */
export interface LiveSnapshot extends LiveMeta {
  key: string;
  cwd: string;
  messages: LiveWireMessage[];
  context?: ConversationContext | null;
  streamingContent: string | null;
  /**
   * The plan of the current turn. The terminal draws it in the info card; a
   * browser client can render the same steps from here without parsing text.
   */
  plan?: PlanState | null;
}

/** A screen that can be observed and driven through the web UI. */
export interface LiveAgent {
  /**
   * Workspace this conversation belongs to. Optional so existing embedders and
   * terminal screens keep working; a missing mode means the standard workspace.
   */
  readonly mode?: Mode;
  /** Working directory the conversation belongs to (used to group it by path). */
  liveCwd(): string;
  liveMeta(): LiveMeta;
  liveSnapshot(key: string): LiveSnapshot;
  /** Pause the in-flight turn (no-op when idle). */
  livePause(): void;
  /** Resume a paused conversation. */
  liveResume(): void;
  /** Append a user message and start (or queue) a turn. */
  liveSend(text: string): void;
  /** Answer a pending approval. Returns false when nothing was pending. */
  liveApprove?(approved: boolean): boolean;
  liveSetApprovalMode?(mode: ApprovalMode): void;
  /** Empty the conversation in place (a new chat in the same folder). */
  liveClear?(): void;
  /** Apply a server-resolved choice to future turns, while idle or paused. */
  liveConfigure?(selection: ResolvedModelSelection): ModelChangeResult;
  liveSetProPreset?(preset: string): ModelChangeResult;
  /** A terminal in another process handles these actions through its bridge. */
  remoteAction?(action: string, body: unknown): Promise<{ status: number; data: unknown }>;
}

/** Summary of a live session, as shown in the sidebar. */
export interface LiveEntrySummary extends LiveMeta {
  key: string;
  cwd: string;
}

type Listener = (snapshot: LiveSnapshot) => void;

interface Entry {
  key: string;
  agent: LiveAgent;
  cwd: string;
  mode: Mode;
  listeners: Set<Listener>;
  timer: NodeJS.Timeout | null;
  lastSent: string;
}

// Streaming emits tokens very quickly; coalescing to ~12fps keeps the browser
// smooth without serialising the whole conversation on every token.
const FLUSH_MS = 80;

class LiveHub {
  private entries = new Map<string, Entry>();
  private seq = 0;

  /** Register a screen. Returns the stable key used to address it over HTTP. */
  register(agent: LiveAgent): string {
    for (const entry of this.entries.values()) {
      if (entry.agent === agent) return entry.key;
    }
    const key = `L${++this.seq}`;
    this.entries.set(key, {
      key,
      agent,
      cwd: agent.liveCwd(),
      mode: normalizeMode(agent.mode),
      listeners: new Set(),
      timer: null,
      lastSent: "",
    });
    return key;
  }

  unregister(key: string | null): void {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(key);
  }

  /**
   * Whether a key is live. With a mode, keys from the other workspace are
   * treated as unknown: the Pro page must never reach a terminal session.
   */
  has(key: string, mode?: Mode): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry) && (!mode || entry!.mode === mode);
  }

  remoteAction(key: string): LiveAgent["remoteAction"] | null {
    const agent = this.entries.get(key)?.agent;
    return agent?.remoteAction ? agent.remoteAction.bind(agent) : null;
  }

  /** All live sessions, newest registration last. Optionally one workspace only. */
  list(mode?: Mode): LiveEntrySummary[] {
    const out: LiveEntrySummary[] = [];
    for (const entry of this.entries.values()) {
      if (mode && entry.mode !== mode) continue;
      out.push({ ...entry.agent.liveMeta(), key: entry.key, cwd: entry.cwd });
    }
    return out;
  }

  /** One-off snapshot, or null when the key is unknown. */
  snapshot(key: string): LiveSnapshot | null {
    const entry = this.entries.get(key);
    return entry ? entry.agent.liveSnapshot(key) : null;
  }

  /**
   * Subscribe to a live session. The current snapshot is delivered immediately
   * so a freshly-connected browser never has to wait for the next change.
   */
  subscribe(key: string, fn: Listener): (() => void) | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.listeners.add(fn);
    try {
      fn(entry.agent.liveSnapshot(key));
    } catch {
      // A broken listener must not break registration.
    }
    return () => {
      entry.listeners.delete(fn);
    };
  }

  /**
   * Mark a session as changed. Snapshots are only produced when somebody is
   * listening, and duplicate snapshots (e.g. a cursor blink) are dropped.
   */
  notify(key: string | null): void {
    if (!key) return;
    const entry = this.entries.get(key);
    if (!entry || entry.listeners.size === 0 || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      const live = this.entries.get(key);
      if (live) this.flush(live);
    }, FLUSH_MS);
    // Don't let a pending flush keep a shutting-down process alive.
    entry.timer.unref?.();
  }

  private flush(entry: Entry): void {
    if (entry.listeners.size === 0) return;
    let snapshot: LiveSnapshot;
    let data: string;
    try {
      snapshot = entry.agent.liveSnapshot(entry.key);
      data = JSON.stringify(snapshot);
    } catch {
      return;
    }
    if (data === entry.lastSent) return;
    entry.lastSent = data;
    for (const fn of [...entry.listeners]) {
      try {
        fn(snapshot);
      } catch {
        // Ignore a failing listener; others still get the update.
      }
    }
  }

  pause(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.agent.livePause();
    this.notify(key);
    return true;
  }

  resume(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.agent.liveResume();
    this.notify(key);
    return true;
  }

  send(key: string, text: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    entry.agent.liveSend(text);
    this.notify(key);
    return true;
  }

  approve(key: string, approved: boolean): boolean {
    const entry = this.entries.get(key);
    if (!entry || !entry.agent.liveApprove) return false;
    const handled = entry.agent.liveApprove(approved);
    this.notify(key);
    return handled;
  }

  configure(key: string, selection: ResolvedModelSelection): ModelChangeResult {
    const entry = this.entries.get(key);
    if (!entry?.agent.liveConfigure) return { ok: false, error: "this session cannot change models" };
    const result = entry.agent.liveConfigure(selection);
    if (result.ok) this.notify(key);
    return result;
  }

  setProPreset(key: string, preset: string): ModelChangeResult {
    const entry = this.entries.get(key);
    if (!entry?.agent.liveSetProPreset) return { ok: false, error: "this session cannot change Pro presets" };
    const result = entry.agent.liveSetProPreset(preset);
    if (result.ok) this.notify(key);
    return result;
  }

  setApprovalMode(key: string, mode: ApprovalMode): boolean {
    const entry = this.entries.get(key);
    if (!entry?.agent.liveSetApprovalMode) return false;
    entry.agent.liveSetApprovalMode(mode);
    this.notify(key);
    return true;
  }

  /** Empty a live conversation in place, keeping its key and working folder. */
  clear(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry?.agent.liveClear) return false;
    entry.agent.liveClear();
    this.notify(key);
    return true;
  }
}

/** Process-wide singleton shared by the TUI and the web server. */
export const hub = new LiveHub();
