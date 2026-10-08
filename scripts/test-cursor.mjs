// Verify computeInputWindow / cursorFromColumn used for click-to-position-cursor.
import { computeInputWindow, cursorFromColumn } from "../dist/ui.js";

let ok = true;
const check = (label, got, want) => {
  if (got !== want) {
    ok = false;
    console.error(`${label}: got ${got}, want ${want}`);
  }
};

// short text, wide window -> no scroll
let win = computeInputWindow("hello", 3, 10);
check("hello startCp", win.startCp, 0);
check("hello visibleCount", win.visibleCount, 5);
check("click col0", cursorFromColumn("hello", 0, win), 0);
check("click col3", cursorFromColumn("hello", 3, win), 3);
check("click col5(end)", cursorFromColumn("hello", 5, win), 5);
check("click col100", cursorFromColumn("hello", 100, win), 5);

// long text scrolled right: 50 'a's, cursor at 49, innerW 10
win = computeInputWindow("a".repeat(50), 49, 10);
check("long startCp", win.startCp, 40);
check("long prefixW", win.prefixW, 40);
check("long visibleCount", win.visibleCount, 10);
check("long click col0", cursorFromColumn("a".repeat(50), 0, win), 40);
check("long click col7", cursorFromColumn("a".repeat(50), 7, win), 47);
check("long click col9", cursorFromColumn("a".repeat(50), 9, win), 49);

// wide chars: "你好世界" each width 2, innerW 4, cursor at 2 (= 4 cols)
// -> window scrolls one char: shows "好世", startCp=1
win = computeInputWindow("你好世界", 2, 4);
check("wide startCp", win.startCp, 1);
check("wide visibleCount", win.visibleCount, 2);
check("wide click col0", cursorFromColumn("你好世界", 0, win), 1);
check("wide click col1", cursorFromColumn("你好世界", 1, win), 1);
check("wide click col2", cursorFromColumn("你好世界", 2, win), 2);
check("wide click col3", cursorFromColumn("你好世界", 3, win), 2);

// cursor at start, window not scrolled
win = computeInputWindow("a".repeat(50), 0, 10);
check("start startCp", win.startCp, 0);
check("start click col9", cursorFromColumn("a".repeat(50), 9, win), 9);

console.log(ok ? "ALL CURSOR MAP TESTS PASSED" : "TESTS FAILED");
process.exit(ok ? 0 : 1);
