// Quick verification of InputReader mouse parsing (SGR mode).
//
// SGR button codes: low 2 bits = button (0 left, 1 middle, 2 right, 3 none),
// bit 5 (32) = motion, bit 6 (64) = wheel; a trailing "M" is a press/motion and
// "m" is a release. Motion with the left button held (a drag) is therefore 32,
// while plain hover (no button) is 35.
import { InputReader } from "../dist/terminal/input.js";

const reader = new InputReader();
const events = [];
reader.start((ev) => {
  events.push(ev);
});

// feed raw sequences like a terminal would
const seqs = [
  "\x1b[<0;5;3M", // left press at (4,2)
  "\x1b[<1;10;20M", // middle press at (9,19)
  "\x1b[<2;3;4M", // right press at (2,3)
  "\x1b[<0;6;3m", // left release at (5,2)
  "\x1b[<35;8;9M", // hover move at (7,8)  (motion + no button)
  "\x1b[<32;8;9M", // drag move at (7,8)   (motion + left button)
  "\x1b[<64;5;3M", // wheel up at (4,2)
  "\x1b[<65;5;3M", // wheel down at (4,2)
  "\x1b[A", // key: up
  "\r", // key: return
];

for (const s of seqs) {
  reader.onData(Buffer.from(s, "utf-8"));
}

const expected = [
  { type: "mouse", event: { type: "click", x: 4, y: 2, button: 0 } },
  { type: "mouse", event: { type: "click", x: 9, y: 19, button: 1 } },
  { type: "mouse", event: { type: "click", x: 2, y: 3, button: 2 } },
  { type: "mouse", event: { type: "release", x: 5, y: 2, button: 0 } },
  { type: "mouse", event: { type: "move", x: 7, y: 8, drag: false } },
  { type: "mouse", event: { type: "move", x: 7, y: 8, drag: true } },
  { type: "mouse", event: { type: "wheel", dir: -1, x: 4, y: 2 } },
  { type: "mouse", event: { type: "wheel", dir: 1, x: 4, y: 2 } },
  { type: "key", key: { name: "up", ctrl: false, meta: false, shift: false, char: "\x1b[A", sequence: "\x1b[A" } },
  { type: "key", key: { name: "return", ctrl: false, meta: false, shift: false, char: "\r", sequence: "\r" } },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let ok = true;
for (let i = 0; i < expected.length; i++) {
  if (!same(events[i], expected[i])) {
    ok = false;
    console.error(`MISMATCH at ${i}`);
    console.error("  got     :", JSON.stringify(events[i]));
    console.error("  expected:", JSON.stringify(expected[i]));
  }
}
if (events.length !== expected.length) {
  ok = false;
  console.error(`Event count mismatch: got ${events.length}, expected ${expected.length}`);
}
console.log(ok ? "ALL MOUSE PARSE TESTS PASSED" : "TESTS FAILED");
reader.stop();
process.exit(ok ? 0 : 1);
