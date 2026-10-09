// Verify the opencode-style paste handling in InputReader:
//   * bracketed pastes (ESC[200~ ... ESC[201~) are delivered as a single
//     "paste" event with their newlines flattened to spaces, so nothing is
//     submitted by the paste itself;
//   * a manual Enter still emits a "return" key (which submits the message);
//   * a raw multi-line paste from a terminal without bracketed-paste support
//     is flattened too, while a lone trailing newline stays a Return.
import { InputReader } from "../dist/terminal/input.js";

function collect(chunks) {
  const reader = new InputReader();
  const events = [];
  reader.start((ev) => events.push(ev));
  for (const c of chunks) reader.onData(Buffer.from(c, "utf-8"));
  reader.stop();
  return events;
}

// Compact form for a key event, so assertions stay readable.
function keyName(ev) {
  return ev && ev.type === "key" ? ev.key.name : null;
}

let ok = true;
function check(label, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (!same) {
    ok = false;
    console.error(`FAIL ${label}`);
    console.error("  got     :", JSON.stringify(got));
    console.error("  expected:", JSON.stringify(want));
  }
}

// 1. Bracketed paste with LF newlines -> one paste, spaces.
check("bracketed LF", collect(["\x1b[200~hello\nworld\x1b[201~"]), [
  { type: "paste", text: "hello world" },
]);

// 2. Bracketed paste with CRLF -> single space per break.
check("bracketed CRLF", collect(["\x1b[200~a\r\nb\r\nc\x1b[201~"]), [
  { type: "paste", text: "a b c" },
]);

// 3. Bracketed paste split across several reads (markers cut mid-sequence).
check("bracketed split", collect(["\x1b[20", "0~a\r\nb\x1b[2", "01~"]), [
  { type: "paste", text: "a b" },
]);

// 4. A manual Enter is still a Return key, not a paste.
check("manual enter", collect(["\r"]), [
  { type: "key", key: { name: "return", ctrl: false, meta: false, shift: false, char: "\r", sequence: "\r" } },
]);

// 5. Typing then Enter: characters first, then Return.
const typed = collect(["hi", "\r"]);
check("typed then enter", typed.map(keyName), ["h", "i", "return"]);

// 6. Raw (un-bracketed) multi-line paste is flattened and never submits.
check("raw multiline", collect(["line1\nline2\n"]), [
  { type: "paste", text: "line1 line2 " },
]);

// 7. A lone trailing newline in raw mode is a Return, not a paste.
const trailing = collect(["hello\n"]);
check("raw single line", trailing.map(keyName), ["h", "e", "l", "l", "o", "return"]);

// 8. Repeated Enters stay Enters (an all-newline chunk is not a paste).
const repeated = collect(["\r\r"]);
check("repeated enter", repeated.map(keyName), ["return", "return"]);

// 9. Pasted text is not confused with control keys: a pasted ESC counts as text.
check("paste keeps esc", collect(["\x1b[200~a\x1bb\x1b[201~"]), [
  { type: "paste", text: "a\x1bb" },
]);

console.log(ok ? "ALL PASTE TESTS PASSED" : "TESTS FAILED");
process.exit(ok ? 0 : 1);
