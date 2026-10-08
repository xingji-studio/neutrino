// Regression tests for terminal rendering. The diff renderer only repaints rows
// whose contents changed, so any cell it *fails* to write leaves a stale glyph
// from the previous frame on screen — the "residual line" bug. These tests push
// frames through the real Renderer into a small emulator and assert the screen
// always matches the intended Buffer.
//
//   1. Fuzz: random buffers with CJK/emoji, styles and shrinking lines.
//   2. ChatScreen: a real conversation that grows, shrinks, streams and types.
import { Buffer } from "../dist/terminal/buffer.js";
import { Renderer } from "../dist/terminal/renderer.js";
import { C } from "../dist/colors.js";
import { ChatScreen } from "../dist/screens/chat.js";
import { Term } from "./emu.mjs";

let failures = 0;
function fail(msg) {
  failures++;
  console.log("FAIL " + msg);
}

function rowText(cells) {
  return cells.map((c) => c.ch).filter((c) => c !== "").join("");
}

function checkFrame(term, buf, label, w, h) {
  for (let y = 0; y < h; y++) {
    const want = rowText(buf.cells[y]).trimEnd();
    const got = term.rowText(y).trimEnd();
    if (want !== got) {
      fail(`${label}: row ${y}\n  want |${want}|\n  got  |${got}|`);
      return;
    }
  }
  if (term.scrolled) {
    fail(`${label}: terminal scrolled`);
    term.scrolled = false;
  }
}

// ---------------------------------------------------------------------------
// 1. Fuzz the renderer
// ---------------------------------------------------------------------------
function fuzz(w, h, iters) {
  const CHARS = "abcdefghij klmnopQRSTUVWXYZ0123456789 中文测试代码·─│┌┐└┘⚙ⓘ✅❌";
  const rnd = (n) => Math.floor(Math.random() * n);
  const term = new Term(w, h);
  const r = new Renderer();
  r.out = { write: (s) => term.feed(s) };

  for (let it = 0; it < iters; it++) {
    const buf = new Buffer(w, h);
    const rows = 1 + rnd(h);
    for (let k = 0; k < rows; k++) {
      const y = rnd(h);
      const len = rnd(w + 4);
      let s = "";
      for (let i = 0; i < len; i++) s += CHARS[rnd(CHARS.length)];
      buf.writeText(rnd(w), y, s, {
        fg: [rnd(256), rnd(256), rnd(256)],
        bg: Math.random() < 0.5 ? C.highlightBg : undefined,
        bold: Math.random() < 0.2,
      });
    }
    r.render(buf);
    checkFrame(term, buf, `fuzz#${it}`, w, h);
  }
  console.log(`ok   fuzz ${w}x${h} (${iters} frames)`);
}

// ---------------------------------------------------------------------------
// 2. Real ChatScreen frames
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

const CJK =
  "中文测试内容渲染残留检测，这是一段较长的中文文本来测试换行与截断行为。";
const MIX = "code 代码 mixed 混合 text ✅ emoji ⚙ icon — dash";

function chatRender(w, h) {
  const term = new Term(w, h);
  const renderer = new Renderer();
  renderer.out = { write: (s) => term.feed(s) };

  const app = stubApp(w, h);
  const screen = new ChatScreen("");
  screen.app = app;
  const buf = new Buffer(w, h);
  screen.messages = [
    { role: "system", content: "Model: DeepSeek/deepseek-chat | Intensity: High" },
  ];

  const step = (label) => {
    screen.render(buf);
    renderer.render(buf);
    checkFrame(term, buf, label, w, h);
  };

  // streaming a CJK-heavy answer while the cursor blinks
  for (let n = 1; n <= 40; n++) {
    screen.streamingContent = CJK.repeat(2).slice(0, n * 3);
    app.state.cursorOn = n % 2 === 0;
    step(`stream#${n}`);
  }
  // a completed answer, then the user typing / deleting CJK + mixed text
  screen.streamingContent = null;
  screen.messages.push({ role: "assistant", content: CJK + "\n\n" + MIX });
  const samples = ["", "a", "ab", CJK, CJK + MIX, MIX, "中", "中文", "中", ""];
  for (let i = 0; i < samples.length; i++) {
    screen.inputValue = samples[i];
    screen.cursor = samples[i].length;
    step(`input#${i}`);
  }
  // a very long (wide) model name in the header, plus the info overlay
  app.state.selectedModelName = "超长模型名称" + CJK;
  screen.showInfo = true;
  step("header+info");
  screen.showInfo = false;
  step("info-closed");

  console.log(`ok   chat ${w}x${h}`);
}

// ---------------------------------------------------------------------------
for (const [w, h] of [
  [80, 24],
  [100, 30],
  [46, 14],
  [40, 10],
  [120, 40],
]) {
  fuzz(w, h, 600);
  chatRender(w, h);
}

console.log(failures === 0 ? "\nRENDER TESTS PASSED" : `\n${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
