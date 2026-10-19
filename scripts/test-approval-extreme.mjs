// Delete-class commands are the only calls that repeat the whole review, so the
// property that matters is that the repetition is really independent: three
// separate rounds, judged apart, all of them required, and a denial ends it.
import assert from "node:assert/strict";
import { ApprovalGate, AUTO_REVIEWERS, EXTREME_ROUNDS } from "../dist/llm/approval.js";
import { LLMClient } from "../dist/llm/client.js";

const originalComplete = LLMClient.prototype.complete;
const model = { name: "test", url: "", api_key: "", supports_streaming: true };

const deletion = {
  tool: "run_command",
  args: { command: "del /s /q build", reason: "remove stale build output so the next build is clean" },
  cwd: process.cwd(),
  prompt: "remove the build directory so the next build is clean",
  risk: { level: "extreme", reasons: ["delete class command"] },
};

const yes = (safety, relevance) => ({
  approve: true,
  safety_score: safety,
  relevance_score: relevance,
  hard_block: false,
  reason: "bounded deletion that supports the task",
});
const no = (safety, relevance, extra = {}) => ({
  ...yes(safety, relevance),
  approve: false,
  reason: "the deletion is broader than the task needs",
  ...extra,
});

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

/**
 * Run one decision.
 *
 * `reply(call)` answers reviewer call 0, 1, 2, ... in the order they happen, so
 * a test can make a specific round disagree.
 */
async function run({ reply, request = deletion, overrides = {} }) {
  const prompts = [];
  const reviews = [];
  const asked = [];
  let calls = 0;
  LLMClient.prototype.complete = async (_system, prompt) => {
    prompts.push(prompt);
    const answer = reply(calls);
    calls += 1;
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  };
  const gate = new ApprovalGate({
    autoApprovalEnabled: () => true,
    extremeAutoApprovalEnabled: () => true,
    askHuman: async (proposed) => {
      asked.push(proposed);
      return false;
    },
    reviewer: () => ({ model, provider: "test", intensity: "High" }),
    onReview: (info) => reviews.push(info),
    ...overrides,
  });
  try {
    const decision = await gate.decide(request);
    return { decision, prompts, reviews, asked, calls };
  } finally {
    LLMClient.prototype.complete = originalComplete;
  }
}

await check("a delete-class call is reviewed three separate times", async () => {
  const { decision, reviews, asked, calls } = await run({ reply: () => yes(62, 78) });
  assert.equal(EXTREME_ROUNDS, 3);
  assert.equal(AUTO_REVIEWERS, 2);
  assert.equal(calls, 6, "three rounds of two reviewers");
  assert.equal(asked.length, 0);
  assert.equal(decision.approved, true);
  assert.equal(decision.source, "ai");
  assert.equal(decision.votes.length, 6);
  assert.deepEqual([...new Set(decision.votes.map((vote) => vote.round))], [1, 2, 3]);
  assert.match(decision.reason, /approved in 3 independent rounds/);
  assert.deepEqual(
    reviews.map((info) => (info ? `${info.round}/${info.rounds}/${info.total}` : null)),
    ["1/3/2", "2/3/2", "3/3/2", null],
  );
});

await check("every round has to clear the call on its own", async () => {
  // Rounds 1 and 2 are unanimous and confident; round 3 is not.
  const { decision, calls } = await run({ reply: (call) => (call < 4 ? yes(95, 95) : no(20, 20)) });
  assert.equal(calls, 6);
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /denied in round 3 of 3/);
});

await check("low task relevance cannot block a safe deletion in any round", async () => {
  const { decision, calls } = await run({ reply: () => no(62, 0) });
  assert.equal(calls, 6);
  assert.equal(decision.approved, true);
  assert.equal(decision.assessment.combined, 62);
});

await check("only an evidenced extreme mismatch can veto on task intent", async () => {
  const { decision, calls } = await run({
    reply: call => call < 4 ? yes(95, 0) : no(95, 0, {
      obvious_mismatch: true,
      mismatch_evidence: "The user asked to clean generated build output, but this command deletes an unrelated archive on another project.",
    }),
  });
  assert.equal(calls, 6);
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /denied in round 3 of 3/);
  assert.match(decision.reason, /extreme task mismatch confirmed by both reviewers/);
});

await check("a denying round ends the sequence immediately", async () => {
  const { decision, calls, reviews } = await run({ reply: (call) => (call < 2 ? yes(90, 90) : no(30, 30)) });
  assert.equal(calls, 4, "round 3 must not run after round 2 denied");
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /denied in round 2 of 3/);
  assert.equal(decision.source, "ai", "the decision stays with the reviewers");
  assert.deepEqual(
    reviews.map((info) => (info ? info.round : null)),
    [1, 2, null],
    "the progress indicator has to be cleared even when the sequence stops early",
  );
});

await check("a hard block in the last round still wins", async () => {
  const { decision, calls } = await run({
    reply: (call) => (call < 4 ? yes(99, 99) : no(99, 99, { hard_block: true, reason: "deletes source files" })),
  });
  assert.equal(calls, 6);
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /hard block/);
});

await check("a round that cannot answer fails the call", async () => {
  const { decision, calls } = await run({
    reply: (call) => (call === 3 ? new Error("upstream 500") : yes(90, 90)),
  });
  assert.equal(calls, 4, "the run stops at the round that failed");
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /review failed/);
});

await check("rounds never see each other's verdicts", async () => {
  const { prompts } = await run({ reply: () => yes(77, 88) });
  assert.equal(prompts.length, 6);
  assert.match(prompts[0], /independent approval round 1 of 3/);
  assert.match(prompts[2], /independent approval round 2 of 3/);
  assert.match(prompts[4], /independent approval round 3 of 3/);
  // Each round has to decide from scratch, and nothing from an earlier round
  // may leak into the later prompts.
  assert.ok(prompts.every((prompt) => /decide from scratch/.test(prompt)));
  assert.ok(
    prompts.every((prompt) => !/round \d (?:approved|denied)|earlier round approved/i.test(prompt)),
    "a later round must not be told what an earlier round concluded",
  );
  // Three rounds, three framings: the angles rotate instead of repeating.
  const angles = prompts.map((prompt) => (prompt.match(/Review (\d) —/) || [])[1]);
  assert.deepEqual(angles, ["1", "2", "2", "3", "3", "1"]);
});

await check("the switch being off leaves the decision to the human", async () => {
  const { decision, calls, asked } = await run({
    reply: () => yes(99, 99),
    overrides: { extremeAutoApprovalEnabled: () => false },
  });
  assert.equal(calls, 0, "no review without the switch");
  assert.equal(asked.length, 1);
  assert.equal(decision.approved, false);
  assert.equal(decision.source, "human");
});

await check("without Auto Approval the switch cannot approve anything", async () => {
  const { decision, calls, asked } = await run({
    reply: () => yes(99, 99),
    overrides: { autoApprovalEnabled: () => false },
  });
  assert.equal(calls, 0);
  assert.equal(asked.length, 1);
  assert.equal(decision.approved, false);
  assert.equal(decision.source, "human");
});

await check("ordinary high risk still gets one round of two", async () => {
  const { decision, calls } = await run({
    reply: () => yes(80, 80),
    request: { ...deletion, risk: { level: "high", reasons: ["recursive delete"] } },
  });
  assert.equal(calls, 2);
  assert.equal(decision.approved, true);
  assert.deepEqual([...new Set(decision.votes.map((vote) => vote.round))], [1]);
  assert.ok(!/round \d of \d/.test(decision.reason));
});

await check("turning the switch off mid-review reroutes to the human", async () => {
  let checks = 0;
  const { decision, calls, asked } = await run({
    reply: () => yes(95, 95),
    overrides: {
      // On when routing in, off by the time the rounds finish.
      extremeAutoApprovalEnabled: () => {
        checks += 1;
        return checks === 1;
      },
    },
  });
  assert.equal(calls, 6);
  assert.equal(asked.length, 1, "the human decides once the switch is gone");
  assert.equal(decision.approved, false);
  assert.equal(decision.source, "human");
});

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nEXTREME-RISK ROUND TESTS PASSED");
