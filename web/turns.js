// Turn folding for the web UI.
//
// A conversation is a sequence of turns: each one starts at a user message and
// runs until the next one. Once the agent has finished a turn, the browser folds
// away the work it took — the prompt body, the thinking and the tool calls — and
// keeps the final reply on screen, so a finished exchange always ends on its
// answer. The complete round is still one click away.
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

/** Index of the turn's reply — its last assistant message (-1 when it has none). */
export function turnAnswerIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return i;
  }
  return -1;
}

/**
 * True when folding the work behind this turn saves more room than it costs.
 * The reply is never folded away, so it is not counted: a long answer on its own
 * must never collapse the turn that carries it.
 */
export function turnFolds(messages) {
  const reply = turnAnswerIndex(messages);
  let blocks = 0;
  let chars = 0;
  messages.forEach((message, index) => {
    if (index === reply) return;
    if (message.role !== "user" && message.role !== "assistant") return;
    blocks++;
    chars += String(message.content ?? "").length;
  });
  return blocks >= TURN_FOLD_MIN_BLOCKS || chars >= TURN_FOLD_MIN_CHARS;
}

/**
 * The first line of the first message in `role`. One line only: the header is a
 * signpost, and the full text is one click away.
 */
export function turnPreview(messages, role) {
  for (const message of messages) {
    if (message.role !== role) continue;
    const line = String(message.content ?? "")
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0);
    if (line) return line;
  }
  return "";
}
