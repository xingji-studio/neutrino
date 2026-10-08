// Verify mouse-selection highlight painting and text extraction.
import { Buffer } from "../dist/terminal/buffer.js";
import { applySelection, selectionText } from "../dist/selection.js";
import { C } from "../dist/colors.js";

const SEL = C.selection.join(",");
const isSel = (c) => c.style.bg && c.style.bg.join(",") === SEL;

let ok = true;
const check = (label, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    ok = false;
    console.error(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
};

const marks = (buf) =>
  buf.cells.map((row) => row.map((c) => (isSel(c) ? "S" : ".")).join("")).join("\n");

// 1. Multi-line selection: first line from the anchor to its end, last line up
//    to the cursor, intermediate lines only as far as their content.
{
  const buf = new Buffer(20, 3);
  buf.writeText(0, 0, "Hello world", {});
  buf.writeText(0, 1, "second line here", {});
  const sel = { anchor: { x: 3, y: 0 }, cursor: { x: 5, y: 1 } };
  check("multi-line text", selectionText(buf, sel), "lo world\nsecond");
  applySelection(buf, sel);
  check(
    "multi-line highlight",
    marks(buf),
    ["...SSSSSSSS.........", "SSSSSS..............", "...................."].join("\n"),
  );
}

// 2. Single-line selection.
{
  const buf = new Buffer(24, 1);
  buf.writeText(0, 0, "const answer = 42;", {});
  const sel = { anchor: { x: 6, y: 0 }, cursor: { x: 11, y: 0 } };
  check("single-line text", selectionText(buf, sel), "answer");
}

// 3. Reversed drag (bottom-right to top-left) is normalised.
{
  const buf = new Buffer(20, 2);
  buf.writeText(0, 0, "abc", {});
  buf.writeText(0, 1, "def", {});
  const sel = { anchor: { x: 2, y: 1 }, cursor: { x: 1, y: 0 } };
  check("reversed text", selectionText(buf, sel), "bc\ndef");
}

// 4. Wide (CJK) glyphs survive a round-trip; continuation cells are skipped.
{
  const buf = new Buffer(20, 1);
  buf.writeText(0, 0, "你好，世界！", {});
  const sel = { anchor: { x: 0, y: 0 }, cursor: { x: 19, y: 0 } };
  check("cjk text", selectionText(buf, sel), "你好，世界！");
}

// 5. Blank rows at the edges of a selection are trimmed.
{
  const buf = new Buffer(10, 4);
  buf.writeText(0, 1, "keep", {});
  const sel = { anchor: { x: 0, y: 0 }, cursor: { x: 9, y: 3 } };
  check("edge-trimmed text", selectionText(buf, sel), "keep");
}

console.log(ok ? "ALL SELECTION TESTS PASSED" : "TESTS FAILED");
process.exit(ok ? 0 : 1);
