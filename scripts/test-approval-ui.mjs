// UI-level checks for the approval banner: the TUI header turns orange and the
// live hub routes approvals to the agent.
import { Buffer } from "../dist/terminal/buffer.js";
import { drawHeader } from "../dist/header.js";
import { defaultState } from "../dist/state.js";
import { C } from "../dist/colors.js";
import { hub } from "../dist/web/hub.js";

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log("FAIL " + msg);
};
const assert = (cond, msg) => {
  if (!cond) fail(msg);
};

// ---- header --------------------------------------------------------------
{
  const state = defaultState();
  const idle = new Buffer(80, 10);
  drawHeader(idle, state);
  assert(idle.cells[0][0].style.bg !== C.orange, "idle header is not orange");

  state.approval = { tool: "run_command", level: "extreme" };
  const alert = new Buffer(80, 10);
  drawHeader(alert, state);
  const row = alert.cells[0];
  const text = row.map((c) => c.ch).join("");
  assert(text.includes("Request Approval"), `header shows the request (got "${text.trim()}")`);
  assert(row[0].style.bg === C.orange, "header background is orange");
  assert(row[1].style.bg === C.orange, "orange bar spans the width");
  assert(row[79].style.bg === C.orange, "orange bar reaches the right edge");

  // Narrow terminals must not throw or overflow.
  for (const w of [24, 40, 120]) {
    const narrow = new Buffer(w, 6);
    drawHeader(narrow, state);
    assert(narrow.cells[0].length === w, `header row is ${w} wide`);
  }
}

// ---- hub routing ---------------------------------------------------------
{
  const meta = () => ({
    sessionId: "live-test",
    title: "test",
    provider: "openai",
    model: "gpt-test",
    intensity: "Medium",
    busy: true,
    paused: false,
    queued: null,
    compressing: false,
    tokens: { prompt: 0, completion: 0 },
    approval: { tool: "run_command", level: "high" },
  });
  let answered = null;
  const agent = {
    liveCwd: () => process.cwd(),
    liveMeta: meta,
    liveSnapshot: (key) => ({
      ...meta(),
      key,
      cwd: process.cwd(),
      messages: [],
      streamingContent: null,
    }),
    livePause: () => {},
    liveResume: () => {},
    liveSend: () => {},
    liveApprove: (approved) => {
      answered = approved;
      return true;
    },
  };
  const key = hub.register(agent);
  assert(hub.approve(key, true) === true, "hub forwards the approval");
  assert(answered === true, "agent received the decision");
  assert(hub.approve("missing-key", true) === false, "unknown key is rejected");
  assert(hub.approve(key, false) === true, "deny is forwarded too");
  assert(answered === false, "agent received the denial");
  hub.unregister(key);
}

console.log(failures === 0 ? "APPROVAL UI TESTS PASSED" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
