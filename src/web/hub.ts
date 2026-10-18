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

/** A message as understood by the web UI. */
export type LiveWireMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "tool"; name: string; arguments: Record<string, unknown>; result: string }
  | { role: "summary"; content: string; count: number };

/** The small, frequently-changing part of a live session. */
export interface LiveMeta {
  /** On-disk session id, or null until the conversation is first saved. */
  sessionId: string | null;
  title: string;
  provider: string;
  model: string;
  intensity: string;
  busy: boolean;
  paused: boolean;
  queued: string | null;
  compressing: boolean;
  tokens: { prompt: number; completion: number };
  /** Tool call waiting for a human decision, or null. */
  approval?: { tool: string; level: "high" | "extreme" } | null;
}

/** Everything a browser needs to render a live conversation. */
export interface LiveSnapshot extends LiveMeta {
  key: string;
  cwd: string;
  messages: LiveWireMessage[];
  streamingContent: string | null;
}

/** A screen that can be observed and driven through the web UI. */
export interface LiveAgent {
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

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** All live sessions, newest registration last. */
  list(): LiveEntrySummary[] {
    const out: LiveEntrySummary[] = [];
    for (const entry of this.entries.values()) {
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
}

/** Process-wide singleton shared by the TUI and the web server. */
export const hub = new LiveHub();
