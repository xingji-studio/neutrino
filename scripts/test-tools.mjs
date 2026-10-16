// Regression tests for collapsible tool output in the chat log:
//   * a tool block renders as "header + command" with the output hidden,
//   * clicking anywhere in the block expands it, clicking again collapses it,
//   * the search for a tool block on a row tolerates scrolling, and
//   * clicks that are not on a tool block do nothing.
import { Buffer } from "../dist/terminal/buffer.js";
import { ChatScreen } from "../dist/screens/chat.js";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

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
  };
}

function rowsOf(buf) {
  return buf.cells.map((cells) =>
    cells
      .map((c) => c.ch)
      .filter((c) => c !== "")
      .join("")
      .trimEnd(),
  );
}

function findRow(rows, needle) {
  for (let y = 0; y < rows.length; y++) if (rows[y].includes(needle)) return y;
  return -1;
}

const RESULT = "line one\nline two\nline three";

function makeScreen(messages) {
  const w = 80;
  const h = 20;
  const app = stubApp(w, h);
  const screen = new ChatScreen("");
  screen.app = app;
  screen.messages = messages;
  const buf = new Buffer(w, h);
  screen.render(buf);
  return { screen, buf, w, h, text: () => rowsOf(buf).join("\n") };
}

// ---------------------------------------------------------------------------
// 1. Collapsed by default: header + command shown, body hidden
// ---------------------------------------------------------------------------
{
  const s = makeScreen([
    { role: "system", content: "Model: DeepSeek/deepseek-chat | Intensity: High" },
    { role: "tool", name: "read_file", arguments: { path: "src/config.ts" }, result: RESULT },
  ]);
  const text = s.text();
  assert(text.includes("⚙ read_file"), "the tool header is shown");
  assert(text.includes("src/config.ts"), "the command/path is shown");
  assert(text.includes("3 lines hidden"), "the collapsed hint counts the hidden lines");
  assert(text.includes("click to expand"), "the collapsed hint says how to expand");
  assert(!text.includes("line one"), "the output body is hidden while collapsed");
}

// ---------------------------------------------------------------------------
// 2. Clicking the block expands it; clicking again collapses it
// ---------------------------------------------------------------------------
{
  const s = makeScreen([
    { role: "system", content: "Model: DeepSeek/deepseek-chat | Intensity: High" },
    { role: "tool", name: "read_file", arguments: { path: "src/config.ts" }, result: RESULT },
  ]);
  const y = findRow(rowsOf(s.buf), "read_file");
  assert(y >= 0, "the tool header row is on screen");

  s.screen.onMouse({ type: "click", x: 5, y, button: 0 });
  s.screen.render(s.buf);
  let text = s.text();
  assert(text.includes("line one"), "the output appears after expanding");
  assert(text.includes("click to collapse"), "the expanded hint offers to collapse");

  s.screen.onMouse({ type: "click", x: 5, y, button: 0 });
  s.screen.render(s.buf);
  text = s.text();
  assert(!text.includes("line one"), "the output hides again after collapsing");
}

// ---------------------------------------------------------------------------
// 3. Clicking the command row (not just the header) also toggles
// ---------------------------------------------------------------------------
{
  const s = makeScreen([
    { role: "system", content: "Model: x" },
    { role: "tool", name: "run_command", arguments: { command: "npm test" }, result: RESULT },
  ]);
  const y = findRow(rowsOf(s.buf), "npm test");
  assert(y >= 0, "the command row is on screen");
  s.screen.onMouse({ type: "click", x: 8, y, button: 0 });
  s.screen.render(s.buf);
  assert(s.text().includes("line one"), "clicking the command row expands the block");
}

// ---------------------------------------------------------------------------
// 4. A click that is not on a tool block leaves blocks untouched
// ---------------------------------------------------------------------------
{
  const s = makeScreen([
    { role: "system", content: "Model: DeepSeek/deepseek-chat | Intensity: High" },
    { role: "user", content: "hello there" },
    { role: "tool", name: "read_file", arguments: { path: "a.ts" }, result: RESULT },
  ]);
  const yHeader = findRow(rowsOf(s.buf), "read_file");
  const yUser = findRow(rowsOf(s.buf), "hello there");
  assert(yHeader >= 0 && yUser >= 0, "both rows are on screen");
  assert(yUser < yHeader, "the user line sits above the tool block");
  s.screen.onMouse({ type: "click", x: 5, y: yUser, button: 0 });
  s.screen.render(s.buf);
  assert(!s.text().includes("line one"), "clicking a normal line does not expand a tool block");
}

// ---------------------------------------------------------------------------
// 5. Two independent tool blocks toggle separately
// ---------------------------------------------------------------------------
{
  const s = makeScreen([
    { role: "system", content: "Model: x" },
    { role: "tool", name: "read_file", arguments: { path: "a.ts" }, result: "alpha body" },
    { role: "tool", name: "read_file", arguments: { path: "b.ts" }, result: "beta body" },
  ]);
  const rows = rowsOf(s.buf);
  const yA = findRow(rows, "a.ts");
  const yB = findRow(rows, "b.ts");
  assert(yA >= 0 && yB >= 0 && yA !== yB, "both blocks are on screen");

  s.screen.onMouse({ type: "click", x: 4, y: yA, button: 0 });
  s.screen.render(s.buf);
  let text = s.text();
  assert(text.includes("alpha body"), "block A expanded");
  assert(!text.includes("beta body"), "block B stays collapsed");

  // Re-find B (expanding A pushed it down) and expand it too.
  const yB2 = findRow(rowsOf(s.buf), "b.ts");
  s.screen.onMouse({ type: "click", x: 4, y: yB2, button: 0 });
  s.screen.render(s.buf);
  text = s.text();
  assert(text.includes("alpha body") && text.includes("beta body"), "both blocks can be expanded");
}

console.log(failures === 0 ? "\nTOOL-FOLD TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
