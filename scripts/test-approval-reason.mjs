// The user has to be told why a call is being made before deciding on it, so a
// request that cannot say why is not shown to anyone and does not run. These
// checks pin down the enforcement, the wording the agent gets back, and the fact
// that the stated reason reaches reviewers as a claim rather than as evidence.
import assert from "node:assert/strict";
import {
  ApprovalGate,
  AUTO_REVIEWERS,
  FULL_TRUST_PHRASE,
  MAX_REASON_CHARS,
  NO_APPROVAL_PHRASE,
  REASON_ARG,
  statedReason,
} from "../dist/llm/approval.js";
import { LLMClient } from "../dist/llm/client.js";

const originalComplete = LLMClient.prototype.complete;
const model = { name: "test", url: "", api_key: "", supports_streaming: true };

const prompted = {
  tool: "run_command",
  args: { command: "npm install left-pad" },
  cwd: process.cwd(),
  prompt: "install the dependency the tests need",
  risk: { level: "high", reasons: ["installs a package"] },
};

const withReason = (args, extra = {}) => ({
  ...prompted,
  args,
  ...extra,
});

const yes = {
  approve: true,
  safety_score: 90,
  relevance_score: 90,
  hard_block: false,
  reason: "the call matches the request",
};

/**
 * Run one decision with a scripted reviewer and a human stub that records every
 * request it is shown.
 */
async function run(request, { reply = () => yes, overrides = {} } = {}) {
  const prompts = [];
  const asked = [];
  let calls = 0;
  LLMClient.prototype.complete = async (_system, prompt) => {
    prompts.push(prompt);
    const answer = reply(calls);
    calls += 1;
    return JSON.stringify(answer);
  };
  const gate = new ApprovalGate({
    autoApprovalEnabled: () => true,
    extremeAutoApprovalEnabled: () => true,
    askHuman: async (proposed) => {
      asked.push(proposed);
      return true;
    },
    reviewer: () => ({ model, provider: "test", intensity: "High" }),
    ...overrides,
  });
  try {
    const decision = await gate.decide(request);
    return { decision, prompts, asked, calls };
  } finally {
    LLMClient.prototype.complete = originalComplete;
  }
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("ok   " + name);
  } catch (err) {
    failures += 1;
    console.error("FAIL " + name + "\n     " + (err && err.message));
  }
}

await check("a request without a reason is refused before anyone is asked", async () => {
  const { decision, asked, calls } = await run(prompted, {
    overrides: { autoApprovalEnabled: () => false },
  });
  assert.equal(decision.approved, false);
  assert.equal(decision.source, "input");
  assert.equal(asked.length, 0, "the user is not interrupted for an unexplained call");
  assert.equal(calls, 0, "no reviewer is paid for an unexplained call");
  assert.match(decision.reason, /no reason was given/);
  assert.match(decision.reason, /"reason"/, "the agent is told what to add");
});

await check("blank and placeholder reasons are not reasons", async () => {
  for (const bad of ["", "   ", "\n\t ", "ok", "go"]) {
    const { decision, asked } = await run(withReason({ command: "npm install left-pad", reason: bad }), {
      overrides: { autoApprovalEnabled: () => false },
    });
    assert.equal(decision.approved, false, `reason ${JSON.stringify(bad)} must not pass`);
    assert.equal(decision.source, "input");
    assert.equal(asked.length, 0);
  }
});

await check("a blank reason is refused on the automatic path too", async () => {
  const { decision, calls, asked } = await run(withReason({ command: "npm install left-pad", reason: " " }));
  assert.equal(decision.approved, false);
  assert.equal(decision.source, "input");
  assert.equal(calls, 0, "reviewers are not called");
  assert.equal(asked.length, 0);
});

await check("a stated reason reaches the human unchanged", async () => {
  const { decision, asked } = await run(
    withReason({ command: "npm install left-pad", reason: "install the dependency the tests need" }),
    { overrides: { autoApprovalEnabled: () => false } },
  );
  assert.equal(decision.approved, true);
  assert.equal(decision.source, "human");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].args[REASON_ARG], "install the dependency the tests need");
});

await check("reviewers see the reason as a claim, apart from the arguments", async () => {
  const { decision, prompts } = await run(
    withReason({ command: "npm install left-pad", reason: "install the dependency the tests need" }),
  );
  assert.equal(decision.approved, true);
  assert.equal(prompts.length, AUTO_REVIEWERS);
  const prompt = prompts[0];
  assert.match(prompt, /install the dependency the tests need/);
  assert.match(prompt, /its own claim, not user authorisation/);
  assert.match(prompt, /all arguments except reason/);
  // The reason is not smuggled back in through the JSON dump as if it were an
  // argument the command would actually use.
  const label = "all arguments except reason):";
  const json = prompt.slice(prompt.indexOf(label) + label.length);
  assert.ok(!json.includes(REASON_ARG), "the arguments dump must not repeat the reason");
  assert.ok(!json.includes("install the dependency the tests need"), "the reason is not mixed into the call");
  assert.match(json, /npm install left-pad/);
});

await check("a runaway reason is truncated before it reaches a prompt", async () => {
  const long = "x".repeat(MAX_REASON_CHARS * 3);
  const { prompts } = await run(withReason({ command: "npm install left-pad", reason: long }));
  assert.equal(prompts.length, AUTO_REVIEWERS);
  for (const prompt of prompts) {
    assert.ok(!prompt.includes("x".repeat(MAX_REASON_CHARS + 1)), "the prompt is capped");
    assert.ok(prompt.includes("x".repeat(MAX_REASON_CHARS)), "the cap keeps the start");
  }
});

await check("multi-line reasons are folded into one line", async () => {
  assert.equal(statedReason({ reason: "  install\n\n  the\tdependency  " }), "install the dependency");
  assert.equal(statedReason({ reason: 42 }), null, "a non-string is not a reason");
  assert.equal(statedReason({}), null);
  assert.equal(statedReason(undefined), null);
});

await check("no reason is needed when the prompt granted full permissions", async () => {
  const { decision, asked, calls } = await run({
    ...prompted,
    prompt: FULL_TRUST_PHRASE,
  });
  assert.equal(decision.approved, true);
  assert.equal(decision.source, "prompt");
  assert.equal(asked.length, 0, "nothing is requested, so nothing has to be justified");
  assert.equal(calls, 0);
});

await check("no reason is needed when the prompt opted out of approval", async () => {
  const { decision, asked } = await run({
    ...prompted,
    prompt: NO_APPROVAL_PHRASE + "，直接装就行",
  });
  assert.equal(decision.approved, true);
  assert.equal(decision.source, "prompt");
  assert.equal(asked.length, 0);
});

await check("an unjustified delete-class call never starts a review round", async () => {
  const extreme = {
    ...prompted,
    args: { command: "del /s /q build" },
    risk: { level: "extreme", reasons: ["delete class command"] },
  };
  const { decision, prompts, asked, calls } = await run(extreme);
  assert.equal(decision.approved, false);
  assert.equal(decision.source, "input");
  assert.equal(prompts.length, 0, "zero reviewer calls, not three rounds of two");
  assert.equal(calls, 0);
  assert.equal(asked.length, 0, "the human is not asked about a call with no stated purpose");
});

await check("a justified delete-class call still gets its three rounds", async () => {
  const extreme = withReason(
    { command: "del /s /q build", reason: "remove stale build output so the next build is clean" },
    { risk: { level: "extreme", reasons: ["delete class command"] } },
  );
  const { decision, calls } = await run(extreme);
  assert.equal(decision.approved, true);
  assert.equal(calls, 6, "three rounds of two reviewers");
});

if (failures > 0) {
  console.error(`\n${failures} REASON CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nAPPROVAL REASON TESTS PASSED");
