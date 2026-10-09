// Regression tests for markdown parsing/rendering.
//
// The table renderer used to crash with
//   "Cannot read properties of undefined (reading '0')"
// when a body row had fewer cells than the header (ragged rows), because it
// indexed `wrapped[c]` for every column without guarding missing cells.
import { renderMarkdownText } from "../dist/markdown.js";

let failures = 0;
function check(name, md, width = 40) {
  try {
    const lines = renderMarkdownText(md, width);
    if (!lines.length) throw new Error("produced no lines");
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name} -> ${err.constructor.name}: ${err.message}`);
  }
}

// Well-formed table.
check("table: normal", "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n");

// Rows with fewer cells than the header (previously crashed).
check("table: ragged short row", "| A | B | C |\n| --- | --- | --- |\n| 1 |\n");
check("table: empty trailing cells", "| A | B | C |\n| --- | --- | --- |\n| 1 | | |\n");
check("table: border-only row", "| A | B | C |\n| --- | --- | --- |\n| |\n");
check("table: mixed widths", "| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| x |\n| y | z | w |\n| q |\n");

// Rows with more cells than the header (extra cells ignored, must not crash).
check("table: ragged long row", "| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n");

// A table squeezed into a very narrow width.
check("table: narrow width", "| A | B | C |\n| --- | --- | --- |\n| 1 |\n", 6);

console.log(failures === 0 ? "\nMARKDOWN TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
