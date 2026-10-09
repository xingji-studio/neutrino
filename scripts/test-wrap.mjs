// Regression tests for text wrapping (src/ui.ts wrapText) and for how tool
// output is drawn in the chat log.
//
// Tool output (shell results, directory trees, code) relies on indentation and
// runs of spaces for alignment. wrapText used to split each line on " " and
// rejoin with a single space, which discarded leading indentation and
// collapsed repeated spaces to one. These tests pin the preserving behaviour.
import { wrapText } from "../dist/ui.js";
import { Buffer } from "../dist/terminal/buffer.js";
import { ChatScreen } from "../dist/screens/chat.js";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) fail(`${name}\n  want ${w}\n  got  ${g}`);
  else console.log(`ok   ${name}`);
}

// ---------------------------------------------------------------------------
// wrapText unit tests
// ---------------------------------------------------------------------------

// 1. Leading indentation survives (the reported bug: tree/code output flattened).
eq("leading indent", wrapText("    foo bar", 80), ["    foo bar"]);
eq(
  "nested tree lines",
  wrapText("src/\n    terminal/\n        input.ts", 80),
  ["src/", "    terminal/", "        input.ts"],
);

// 2. Runs of interior spaces are not collapsed (column alignment).
eq("interior spaces", wrapText("a    b\tc", 80), ["a    b  c"]);

// 3. Non-indented text behaves as before.
eq("simple words", wrapText("hello world", 80), ["hello world"]);
eq("empty lines kept", wrapText("a\n\nb", 80), ["a", "", "b"]);

// 4. Wrapping keeps the hanging indent, with no trailing blanks on a break.
eq(
  "wrap keeps indent",
  wrapText("    one two three four", 12),
  ["    one two", "    three", "    four"],
);

// 5. A word wider than the remaining budget is hard-wrapped by columns.
eq("long word chunked", wrapText("    abcdefghij", 10), ["    abcdef", "    ghij"]);

// 6. Wrapped lines never exceed the requested width.
for (const line of wrapText("        alpha beta gamma delta epsilon", 16)) {
  if (line.length > 16) fail(`overflow: |${line}| (${line.length})`);
}

// ---------------------------------------------------------------------------
// Integration: tool output keeps its indentation in the rendered chat log
// ---------------------------------------------------------------------------
function stubApp(w, h) {
  return {
    width: w,
    height: h,
    state: {
      selectedProvider: "DeepSeek",
      selectedModelName: "deepseek-chat",
      selectedModelUrl: "",
      selectedModelApiKey: "",
      selectedModelStreaming: true,
      selectedIntensity: "High",
      isThinking: false,
      blinkOn: false,
      cursorOn: true,
      selection: null,
    },
    render() {},
    popScreen() {},
    openModelConfig() {},
  };
}

const app = stubApp(80, 24);
const screen = new ChatScreen("");
screen.app = app;
screen.messages = [
  { role: "system", content: "Model: DeepSeek/deepseek-chat | Intensity: High" },
  {
    role: "tool",
    name: "shell",
    arguments: { command: "ls -R" },
    result: "src/\n    terminal/\n        input.ts",
  },
];
const buf = new Buffer(80, 24);
screen.render(buf);
const rows = buf.cells.map((cells) => cells.map((c) => c.ch).join("").trimEnd());

// The log starts at column 2, so a 4-space indent shows up as 6 leading blanks.
const termRow = rows.find((r) => r.includes("terminal/"));
if (!termRow) fail("tool output: 'terminal/' line not found");
else eq("tool output indentation", termRow, "      terminal/");

const inputRow = rows.find((r) => r.includes("input.ts"));
if (!inputRow) fail("tool output: 'input.ts' line not found");
else eq("tool output nested indentation", inputRow, "          input.ts");

console.log(failures === 0 ? "\nWRAP TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
