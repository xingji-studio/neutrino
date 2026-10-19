/**
 * Helpers for compressing a long conversation so it fits back inside the
 * model's context window.
 *
 * Everything here is pure: deciding *what* to summarise, and flattening that
 * part into a plain transcript. The actual "ask the model to summarise" step
 * lives in `LLMClient.summarize`, so this module stays trivially unit-testable.
 */

export interface CompactMessage {
  role: string;
  content?: string;
  /** Tool name, when `role` is "tool". */
  name?: string;
}

/** A model-only summary of a prefix of the complete, non-system transcript. */
export interface ConversationContext {
  /** Number of original messages covered by the summary (exclusive boundary). */
  end: number;
  summary: string;
}

/** Ignore stale/corrupt metadata rather than hiding any original messages. */
export function normalizeContext(value: unknown, messageCount: number): ConversationContext | null {
  if (!value || typeof value !== "object") return null;
  const context = value as Partial<ConversationContext>;
  if (typeof context.end !== "number" || !Number.isInteger(context.end) ||
      context.end <= 0 || context.end > messageCount ||
      typeof context.summary !== "string" || !context.summary.trim()) return null;
  return { end: context.end, summary: context.summary };
}

/** Derive a bounded model history while leaving the complete transcript intact. */
export function modelHistory<T extends CompactMessage>(
  messages: T[],
  context: ConversationContext | null,
): Array<T | { role: "summary"; content: string }> {
  const original = messages.filter((message) => message.role !== "system");
  const valid = normalizeContext(context, original.length);
  return valid
    ? [{ role: "summary", content: valid.summary }, ...original.slice(valid.end)]
    : original;
}

export interface CompactionPlan<T> {
  /** Older messages that should be summarised away. */
  head: T[];
  /** Recent messages kept verbatim. */
  tail: T[];
}

/** How many trailing messages are always kept verbatim when compressing. */
export const COMPACT_KEEP = 4;

/** Per-message character budget fed to the summariser, to bound its own input. */
export const COMPACT_MAX_CHARS_PER_MESSAGE = 4000;

/**
 * Split `messages` into an older prefix to summarise and a recent suffix to
 * keep. The kept suffix never begins with a bare tool result — that would be an
 * orphan without the assistant tool-call that produced it — so such messages
 * are folded into the prefix instead.
 *
 * Returns null when there is nothing worth compressing (the conversation is
 * already short enough).
 */
export function planCompaction<T extends CompactMessage>(
  messages: T[],
  keep: number = COMPACT_KEEP,
): CompactionPlan<T> | null {
  if (keep < 1) keep = 1;
  const head: T[] = [];
  const tail: T[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (tail.length < keep) tail.unshift(messages[i]);
    else head.push(messages[i]);
  }
  head.reverse();

  // Never open the kept suffix with an orphan tool result.
  while (tail.length > 1 && tail[0].role === "tool") {
    head.push(tail.shift() as T);
  }

  if (head.length === 0 || tail.length === 0) return null;
  return { head, tail };
}

/**
 * Flatten messages into a plain transcript for the summariser, clipping each
 * message so a single huge tool result cannot dominate the summary request.
 */
export function transcriptFor(
  messages: CompactMessage[],
  maxCharsPerMessage: number = COMPACT_MAX_CHARS_PER_MESSAGE,
): string {
  const clip = (s: string): string => {
    const t = s.replace(/\r\n?/g, "\n").trim();
    return t.length > maxCharsPerMessage ? t.slice(0, maxCharsPerMessage) + "\n…[truncated]" : t;
  };
  const parts: string[] = [];
  for (const m of messages) {
    const body = clip(m.content ?? "");
    if (m.role === "tool") {
      parts.push(`TOOL ${m.name ?? ""} RESULT:\n${body}`);
    } else if (m.role === "assistant") {
      parts.push(`ASSISTANT:\n${body}`);
    } else if (m.role === "user") {
      parts.push(`USER:\n${body}`);
    } else {
      parts.push(`${m.role.toUpperCase()}:\n${body}`);
    }
  }
  return parts.join("\n\n");
}
