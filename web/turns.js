// Turn folding for the web UI.
//
// A conversation is a sequence of turns: each one starts at a user message and
// runs until the next one. Once the agent has finished a turn, the browser folds
// it into a single summary line so scrolling back stays manageable, while the
// complete transcript is still rendered on demand (click the summary).
//
// The thresholds mirror TURN_FOLD_MIN_BLOCKS / TURN_FOLD_MIN_CHARS in
// src/screens/chat.ts, so the terminal and the browser fold the same turns.
// Short exchanges are left open: hiding two lines behind a click helps nobody.

export const TURN_FOLD_MIN_BLOCKS = 4;
export const TURN_FOLD_MIN_CHARS = 600;

/** Split a transcript into turns: `{ start, end }` message index ranges. */
export function turnRanges(messages) {
  const turns = [];
  messages.forEach((message, index) => {
    if (message.role === "user") turns.push({ start: index, end: messages.length });
  });
  for (let i = 0; i < turns.length - 1; i++) turns[i].end = turns[i + 1].start;
  return turns;
}

/** True when folding this turn saves more room than it costs. */
export function turnFolds(messages) {
  let blocks = 0;
  let chars = 0;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    blocks++;
    chars += String(message.content ?? "").length;
  }
  return blocks >= TURN_FOLD_MIN_BLOCKS || chars >= TURN_FOLD_MIN_CHARS;
}

/**
 * The first line of the first (or, with `last`, the last) message in `role`.
 * One line only: the preview is a signpost, the full text is a click away.
 */
export function turnPreview(messages, role, last = false) {
  const ordered = last ? [...messages].reverse() : messages;
  for (const message of ordered) {
    if (message.role !== role) continue;
    const line = String(message.content ?? "")
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (line) return line;
  }
  return "";
}
