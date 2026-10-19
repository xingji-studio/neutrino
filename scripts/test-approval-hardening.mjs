// Guards the three ways the approval gate used to misbehave, plus the audio
// cues that now mark a finished turn and a waiting approval.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Keep the real ~/.neutrino config out of this test.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-hardening-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { parsePromptDirectives, ApprovalGate } = await import("../dist/llm/approval.js");
const { normalizeApprovalMode, saveConfig } = await import("../dist/config.js");
const { App } = await import("../dist/app.js");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("ok   " + name);
  } catch (err) {
    failed += 1;
    console.log("FAIL " + name + " -> " + err.message);
  }
}

/* --- prompt directives ---------------------------------------------------- */

await check("a trailing negation revokes the no-approval directive", () => {
  assert.equal(parsePromptDirectives("无需审批？不行，必须问我").noApproval, false);
});

await check("a plain directive still grants", () => {
  assert.equal(parsePromptDirectives("这次无需审批，直接改").noApproval, true);
});

await check("a reaffirming follow-up still grants", () => {
  assert.equal(parsePromptDirectives("无需审批，不用问我").noApproval, true);
});

await check("a negated acknowledgement is not full trust", () => {
  assert.equal(parsePromptDirectives("我已知悉风险，但不同意给予完整权限").fullTrust, false);
});

await check("acknowledged consent is still full trust", () => {
  assert.equal(parsePromptDirectives("我已知悉风险，同意给予完整权限").fullTrust, true);
});

await check("the exact full-trust sentence still works", () => {
  assert.equal(parsePromptDirectives("我已知悉风险，同意给予完整权限，无需任何审批").fullTrust, true);
});

await check("no-approval never implies delete access", () => {
  const d = parsePromptDirectives("无需审批");
  assert.equal(d.noApproval, true);
  assert.equal(d.fullTrust, false);
});

/* --- mode normalisation --------------------------------------------------- */

await check("the approval mode is case insensitive", () => {
  assert.equal(normalizeApprovalMode("Auto"), "auto");
  assert.equal(normalizeApprovalMode(" AUTO "), "auto");
  assert.equal(normalizeApprovalMode("request"), "request");
  assert.equal(normalizeApprovalMode("nonsense"), "request");
  assert.equal(normalizeApprovalMode(undefined), "request");
});

/* --- the gate fails closed, and never rejects ----------------------------- */

const request = {
  tool: "run_command",
  args: { command: "del important.txt", reason: "delete the obsolete notes file the user asked about" },
  prompt: "",
  context: "",
  risk: { level: "extreme", reasons: ["delete class command"] },
};

function makeGate(overrides) {
  return new ApprovalGate({
    autoApprovalEnabled: () => true,
    extremeAutoApprovalEnabled: () => true,
    askHuman: async () => null,
    ...overrides,
  });
}

const broken = [
  [
    "an unresolvable reviewer model becomes a denial",
    makeGate({
      reviewer: () => {
        throw new Error("config unreadable");
      },
    }),
    /review failed/,
  ],
  [
    "a throwing extreme-risk switch becomes a denial",
    makeGate({
      extremeAutoApprovalEnabled: () => {
        throw new Error("cannot read config");
      },
    }),
    /could not run/,
  ],
  [
    "a throwing human prompt becomes a denial",
    makeGate({
      autoApprovalEnabled: () => false,
      askHuman: async () => {
        throw new Error("no ui");
      },
    }),
    /could not run/,
  ],
];

for (const [name, gate, expected] of broken) {
  await check(name, async () => {
    const decision = await gate.decide(request);
    assert.equal(decision.approved, false);
    assert.match(decision.reason, expected);
  });
}

await check("a throwing progress callback does not change the verdict", async () => {
  const gate = makeGate({
    onReview: () => {
      throw new Error("renderer exploded");
    },
    reviewer: () => {
      throw new Error("nothing configured");
    },
  });
  const decision = await gate.decide(request);
  assert.equal(decision.approved, false);
});

await check("the prompt directive still clears a high-risk call", async () => {
  const gate = makeGate({
    autoApprovalEnabled: () => false,
    askHuman: async () => {
      throw new Error("should not have been asked");
    },
  });
  const decision = await gate.decide({ ...request, risk: { level: "high" }, prompt: "无需审批" });
  assert.equal(decision.approved, true);
  assert.equal(decision.source, "prompt");
});

await check("a human rejection is still a rejection", async () => {
  const gate = makeGate({ autoApprovalEnabled: () => false, askHuman: async () => false });
  const decision = await gate.decide({ ...request, risk: { level: "high" } });
  assert.equal(decision.approved, false);
  assert.equal(decision.source, "human");
});

/* --- the web settings round-trip ------------------------------------------ */

const { getWebSettings, updateWebSettings } = await import("../dist/web/settings.js");

await check("sound alerts can be turned off over the web settings API", () => {
  updateWebSettings({ settings: { sound_alerts: false } });
  assert.equal(getWebSettings().settings.sound_alerts, false);
  updateWebSettings({ settings: { sound_alerts: true } });
  assert.equal(getWebSettings().settings.sound_alerts, true);
});

await check("sound alerts rejects a non-boolean", () => {
  assert.throws(() => updateWebSettings({ settings: { sound_alerts: "loud" } }), /boolean/);
});

await check("unknown settings are still rejected", () => {
  assert.throws(() => updateWebSettings({ settings: { sound_alertz: false } }), /unknown settings field/);
});

/* --- audio cues ----------------------------------------------------------- */

function captureStdout(fn) {
  const real = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = real;
  }
  return chunks.join("");
}

function fakeApp(renderer) {
  const app = Object.create(App.prototype);
  app.renderer = renderer;
  return app;
}

const ringingRenderer = { calls: [], bell(times = 1) { this.calls.push(times); } };

await check("App.bell appends a single BEL to the stream", () => {
  const renderer = { calls: [], bell(times = 1) { this.calls.push(times); } };
  const app = fakeApp(renderer);
  saveConfig({ sound_alerts: true });
  app.bell("turn");
  assert.deepEqual(renderer.calls, [1]);
});

await check("App.bell rings twice for a waiting approval", () => {
  const renderer = { calls: [], bell(times = 1) { this.calls.push(times); } };
  const app = fakeApp(renderer);
  saveConfig({ sound_alerts: true });
  app.bell("approval");
  assert.deepEqual(renderer.calls, [2]);
});

await check("App.bell stays silent when sound_alerts is off", () => {
  ringingRenderer.calls = [];
  const app = fakeApp(ringingRenderer);
  saveConfig({ sound_alerts: false });
  app.bell("turn");
  app.bell("approval");
  assert.deepEqual(ringingRenderer.calls, []);
});

await check("sound_alerts defaults to on for existing configs", () => {
  saveConfig({ approval_mode: "auto" });
  ringingRenderer.calls = [];
  fakeApp(ringingRenderer).bell("turn");
  assert.deepEqual(ringingRenderer.calls, [1]);
});

await check("the renderer turns a bell into BEL bytes", async () => {
  const { Renderer } = await import("../dist/terminal/renderer.js");
  const renderer = new Renderer();
  const output = captureStdout(() => {
    renderer.bell(2);
  });
  assert.equal(output.split("\x07").length - 1, 2);
});
await check("a stuck mode-change prompt cannot loop forever", async () => {
  // askHuman answers null = "the mode changed" = reroute the same request.
  let prompts = 0;
  const gate = new ApprovalGate({
    autoApprovalEnabled: () => true,
    extremeAutoApprovalEnabled: () => false,
    askHuman: async () => {
      prompts += 1;
      return null;
    },
    reviewer: () => ({ model, provider: "test", intensity: "High" }),
  });
  const decision = await gate.decide(request);
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /kept changing/);
  assert.ok(prompts <= 8, `the prompt was shown ${prompts} times`);
});


console.log(`\n${passed} checks passed, ${failed} failed`);
if (failed) process.exit(1);
