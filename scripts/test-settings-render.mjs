// Smoke test: the settings screen shows the approval rows and renders at any size.
import { Buffer } from "../dist/terminal/buffer.js";
import { SettingsScreen } from "../dist/screens/settings.js";
import { defaultState } from "../dist/state.js";

const app = {
  state: defaultState(),
  model: { name: "gpt-test", url: "http://localhost", apiKey: "x", streaming: true },
  provider: "openai",
  width: 80,
  height: 24,
  popScreen() {},
  pushScreen() {},
  openModelConfig() {},
  render() {},
};

let failures = 0;
const fail = (m) => {
  failures++;
  console.log("FAIL " + m);
};

for (const [w, h] of [
  [80, 24],
  [46, 14],
  [40, 12],
  [120, 40],
]) {
  app.width = w;
  app.height = h;
  const screen = new SettingsScreen("settings");
  screen.app = app;
  screen.onActivate();
  const buf = new Buffer(w, h);
  screen.render(buf);
  const text = buf.cells.map((row) => row.map((c) => c.ch).join("")).join("\n");
  // Narrow terminals truncate labels and values; wide ones must show them.
  if (w >= 60) {
    if (!text.includes("Approval reviewer model")) fail(`missing reviewer row at ${w}x${h}`);
    if (!text.includes("Extreme-risk auto-approval")) fail(`missing extreme row at ${w}x${h}`);
    if (!text.includes("Off (human only)")) fail(`extreme switch is not off by default at ${w}x${h}`);
  } else if (!text.includes("Appr")) {
    fail(`approval rows missing entirely at ${w}x${h}`);
  }
}


// The switch has to say what it buys: three separate rounds, not three
// reviewers in one panel, because the cost is three times the latency.
for (const [w, h] of [
  [80, 24],
  [120, 40],
]) {
  app.width = w;
  app.height = h;
  const screen = new SettingsScreen("settings");
  screen.app = app;
  screen.onActivate();
  screen.extremeIdx = 1;
  const buf = new Buffer(w, h);
  screen.render(buf);
  const text = buf.cells.map((row) => row.map((c) => c.ch).join("")).join("\n");
  if (!text.includes("On (3 separate rounds)")) fail(`extreme switch value clipped at ${w}x${h}`);
}

console.log(failures === 0 ? "SETTINGS RENDER TESTS PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
