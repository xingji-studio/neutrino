// Regression tests for auto context compression:
//   * the pure compaction helpers (split / transcript),
//   * model context windows and the derived 80% threshold,
//   * the settings screen editing & persisting it, and
//   * compression shrinking model input while retaining the original history.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect ~/.neutrino to a throw-away home *before* importing anything that
// resolves it at module load, so the tests never touch real user config.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-compact-"));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { planCompaction, transcriptFor } = await import("../dist/compact.js");
const { DEFAULT_CONTEXT_WINDOW, CONTEXT_WINDOW_OPTIONS, contextWindow, contextCompressionThreshold, loadModels, saveModels, saveConfig } = await import(
  "../dist/config.js"
);
const { SettingsScreen } = await import("../dist/screens/settings.js");
const { ChatScreen } = await import("../dist/screens/chat.js");

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}
function eq(a, b, msg) {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`,
  );
}

function stubApp(w = 80, h = 24) {
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

// ---------------------------------------------------------------------------
// 1. planCompaction splits older messages off and keeps the recent ones
// ---------------------------------------------------------------------------
{
  const msgs = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `m${i}`,
  }));
  const plan = planCompaction(msgs, 4);
  assert(plan, "a 10-message history should be compactable");
  eq(plan.head.length, 6, "head should hold everything but the last 4");
  eq(plan.tail.length, 4, "tail should hold the last 4");
  eq(plan.tail.map((m) => m.content), ["m6", "m7", "m8", "m9"], "tail keeps the newest messages");
  eq(
    plan.head.map((m) => m.content),
    ["m0", "m1", "m2", "m3", "m4", "m5"],
    "head keeps chronological order",
  );
}

// Nothing to do when the history is already short.
{
  const msgs = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
  assert(planCompaction(msgs, 4) === null, "short history needs no compaction");
  assert(planCompaction([], 4) === null, "empty history needs no compaction");
}

// The kept suffix is not left starting with a bare tool result when avoidable.
{
  const msgs = [
    { role: "user", content: "u" },
    { role: "assistant", content: "a" },
    { role: "tool", content: "r1", name: "t" },
    { role: "tool", content: "r2", name: "t" },
  ];
  const plan = planCompaction(msgs, 2);
  assert(plan, "tool-tail history should still compact");
  eq(plan.tail.map((m) => m.content), ["r2"], "leading tool result folded into the head");
}

// ---------------------------------------------------------------------------
// 2. transcriptFor flattens and clips messages
// ---------------------------------------------------------------------------
{
  const t = transcriptFor([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "tool", name: "run_command", content: "out1\nout2" },
  ]);
  assert(t.includes("USER:\nhello"), "user is labelled");
  assert(t.includes("ASSISTANT:\nhi"), "assistant is labelled");
  assert(t.includes("TOOL run_command RESULT:\nout1\nout2"), "tool result is labelled with its name");
}
{
  const t = transcriptFor([{ role: "user", content: "x".repeat(500) }], 10);
  assert(t.includes("…[truncated]"), "an over-long message is marked as truncated");
  assert(t.length < 60, `truncation bounds the length (got ${t.length})`);
}

// ---------------------------------------------------------------------------
// 3. Model capacity defaults and validation
// ---------------------------------------------------------------------------
{
  eq(DEFAULT_CONTEXT_WINDOW, 1_000_000, "default model capacity is 1M tokens");
  for (const invalid of [undefined, null, 0, -1, NaN, Infinity, 1.5, "128000", Number.MAX_SAFE_INTEGER + 1]) {
    eq(contextWindow(invalid), 1_000_000, `invalid capacity ${invalid} uses 1M`);
  }
  eq(contextWindow(128000), 128000, "custom capacity is retained");
  eq(CONTEXT_WINDOW_OPTIONS, [...CONTEXT_WINDOW_OPTIONS].sort((a, b) => a - b), "options are ordered");
  const model = { name: "unregistered" };
  saveConfig({ context_compress_threshold: 32000 });
  eq(contextCompressionThreshold("unknown", model), 800000, "legacy 32K config does not override the 80% rule");
  saveConfig({ context_compress_threshold: 0 });
  eq(contextCompressionThreshold("unknown", model), 800000, "legacy off setting does not disable the 80% rule");
}

// ---------------------------------------------------------------------------
// 4. Settings edits and persists the current model's context window
// ---------------------------------------------------------------------------
{
  const screen = new SettingsScreen();
  screen.app = stubApp();
  screen.onActivate();
  const key = (name) => ({ name, ctrl: false, meta: false, shift: false, char: "", sequence: "" });
  screen.onKey(key("down"));
  screen.onKey(key("right")); // 1M -> 2M
  const models = loadModels();
  const model = models.providers[0].models.find(m => m.name === "deepseek-chat");
  eq(model.context_window, 2_000_000, "settings persists capacity for the current model");
  eq(contextCompressionThreshold("DeepSeek", model), 1_600_000, "threshold follows the saved capacity");
  model.context_window = 1_000_000;
  saveModels(models);
}

// ---------------------------------------------------------------------------
// 5. ChatScreen.autoCompress preserves history and bounds model input
// ---------------------------------------------------------------------------
function longHistory() {
  const msgs = [{ role: "system", content: "Model: DeepSeek/deepseek-chat | Intensity: High" }];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: i % 2 ? "assistant" : "user", content: `message ${i}` });
  }
  return msgs;
}

{
  // Below the threshold: nothing happens.
  const screen = new ChatScreen("");
  screen.app = stubApp();
  screen.messages = longHistory();
  screen.lastPromptTokens = 799_999;
  let calls = 0;
  screen.summarizeTranscript = async () => {
    calls++;
    return "should not be used";
  };
  await screen.autoCompress(0);
  assert(calls === 0, "no summarisation below the threshold");
  assert(!screen.messages.some((m) => m.role === "summary"), "no summary below the threshold");
}

{
  // Above the threshold: only model input uses a summary of older messages.
  const screen = new ChatScreen("");
  screen.app = stubApp();
  screen.messages = longHistory();
  screen.lastPromptTokens = 800_000; // exactly 80% of the default 1M window
  let usedTranscript = "";
  screen.summarizeTranscript = async (t) => {
    usedTranscript = t;
    return "SUMMARY TEXT";
  };
  await screen.autoCompress(0);

  assert(usedTranscript.includes("message 0"), "the summariser receives the older messages");
  const summary = screen.context;
  assert(summary, "a model context summary is created separately");
  assert(summary.summary.includes("SUMMARY TEXT"), "the model summary is kept");
  eq(summary.end, 4, "summary records the boundary in the original transcript");
  assert(screen.messages[0].role === "system", "the system message is preserved first");
  eq(screen.messages, longHistory(), "the complete history is unchanged");
  const api = screen.buildApiMessages();
  assert(api.length < screen.messages.length, "only the model input shrank");
  assert(api.some(m => m.content.includes("SUMMARY TEXT")), "the summary is sent to the model");
  assert(!api.some(m => m.content === "message 0"), "the older raw input is represented by the summary");
  eq(screen.lastPromptTokens, 0, "the token counter is reset after compression");
  // The most recent messages survive verbatim.
  assert(
    screen.messages[screen.messages.length - 1].content === "message 7",
    "the newest message is kept",
  );
}

{
  // A failed summary can bound model input without deleting the original log.
  const screen = new ChatScreen("");
  screen.app = stubApp();
  screen.messages = longHistory();
  screen.lastPromptTokens = 1_000_000;
  screen.summarizeTranscript = async () => "";
  await screen.autoCompress(0);
  assert(screen.context, "fallback context is created when the model returns nothing");
  assert(screen.context.summary.includes("preserved in history"), "the fallback explains that history is retained");
  eq(screen.messages, longHistory(), "summary failure preserves all original messages");
}

console.log(failures === 0 ? "\nCOMPACT TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
