// Safety decides; ordinary relevance concerns must not veto a safe proposal.
// No tool or provider is invoked: verify the routing, aggregation and boundaries.
import assert from "node:assert/strict";
import { ApprovalGate } from "../dist/llm/approval.js";
import { LLMClient } from "../dist/llm/client.js";

const originalComplete = LLMClient.prototype.complete;
const model = { name: "test", url: "", api_key: "", supports_streaming: true };
const request = {
  tool: "run_command",
  args: { command: "npm install test-dependency", reason: "install the dependency needed by the change" },
  cwd: process.cwd(), prompt: "install the dependencies and run the tests",
  risk: { level: "high", reasons: ["package installation"] },
};
const assessment = (safety, relevance, extra = {}) => ({
  approve: true, safety_score: safety, relevance_score: relevance,
  hard_block: false, reason: "bounded step supporting the task", ...extra,
});
function gate(extra = {}) {
  return new ApprovalGate({
    autoApprovalEnabled: () => true,
    extremeAutoApprovalEnabled: () => true,
    askHuman: async () => { throw new Error("automatic review should handle this call"); },
    reviewer: () => ({ model, provider: "test", intensity: "High" }),
    ...extra,
  });
}
async function decide(replies, proposed = request) {
  let calls = 0;
  LLMClient.prototype.complete = async () => {
    const reply = replies[calls++];
    if (reply instanceof Error) throw reply;
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  const decision = await gate().decide(proposed);
  assert.equal(calls, 2, "every proposed call must get exactly two reviews");
  assert.equal(decision.votes.length, 2);
  return decision;
}

try {
  for (const [level, rounds] of [["high", 1], ["extreme", 3]]) {
    const seen = [];
    const progress = [];
    LLMClient.prototype.complete = async (system, prompt) => {
      seen.push({ system, prompt });
      return JSON.stringify(assessment(60, 80));
    };
    const decision = await gate({
      onReview: info => progress.push(info ? `${info.round}/${info.rounds}/${info.total}` : null),
    }).decide({ ...request, risk: { ...request.risk, level } });
    const reviews = 2 * rounds;
    assert.equal(decision.approved, true, "manageable risk and a supporting purpose should pass");
    assert.equal(decision.assessment.combined, 60);
    assert.equal(seen.length, reviews, `${level} risk needs ${reviews} reviews`);
    assert.equal(decision.votes.length, reviews);
    assert.match(seen[0].prompt, /Review 1 — safety emphasis/);
    if (rounds === 1) {
      assert.match(seen[1].prompt, /Review 2 — practical-risk emphasis/);
    } else {
      // Each round rotates the angles, so three rounds are not three copies.
      assert.match(seen[2].prompt, /Review 2 — practical-risk emphasis/);
      assert.match(seen[4].prompt, /Review 3 — blast-radius emphasis/);
      assert.match(seen[2].prompt, /round 2 of 3/);
      assert.match(seen[4].prompt, /round 3 of 3/);
      assert.deepEqual([...new Set(decision.votes.map(vote => vote.round))], [1, 2, 3]);
    }
    assert.ok(seen.every(({ system }) => system.includes("not an automatic denial")));
    assert.ok(seen.every(({ system }) => system.includes("ZERO weight and no ordinary minimum")));
    assert.ok(seen.every(({ system }) => system.includes("must NEVER lower")));
    assert.ok(seen.every(({ system }) => system.includes("Both reviewers must independently identify")));
    const expected = Array.from({ length: rounds }, (_, i) => `${i + 1}/${rounds}/2`);
    assert.deepEqual(progress, [...expected, null]);
  }

  const mixed = await decide([
    assessment(50, 70, { approve: false, reason: "minor uncertainty" }),
    assessment(90, 90),
  ]);
  assert.equal(mixed.approved, true, "one cautious recommendation is not a veto");
  assert.deepEqual(mixed.assessment, { safety: 70, relevance: 80, combined: 70 });
  assert.match(mixed.reason, /safety 70.0\/100 \(threshold 60\)/);
  assert.equal((await decide([
    assessment(60, 80, { approve: false }), assessment(60, 80, { approve: false }),
  ])).approved, true, "safety drives the decision despite conservative recommendations");

  assert.equal((await decide([assessment(65, 65), assessment(65, 65)])).approved, true);
  assert.equal((await decide([assessment(60, 0), assessment(60, 0)])).approved, true);
  assert.equal((await decide([assessment(59, 100), assessment(59, 100)])).approved, false);
  assert.equal((await decide([assessment(49, 100), assessment(49, 100)])).approved, false,
    "strong relevance cannot compensate for substantial safety uncertainty");
  for (const relevance of [0, 1, 5, 20, 49, 50, 80, 100]) {
    const safe = await decide([
      assessment(60, relevance, { approve: false, reason: "not requested; the purpose is unclear" }),
      assessment(60, relevance, { approve: false, reason: "an unnecessary diagnostic step" }),
    ]);
    assert.equal(safe.approved, true, `safe calls must pass even at relevance ${relevance}`);
    assert.equal(safe.assessment.combined, 60, "task relevance has zero numerical weight");
  }

  const mismatch = assessment(95, 0, {
    approve: false, obvious_mismatch: true,
    mismatch_evidence: "The user asked to inspect the local README, but the proposal creates an unrelated paid cloud resource.",
  });
  const unmistakable = await decide([mismatch, { ...mismatch, relevance_score: 5 }]);
  assert.equal(unmistakable.approved, false, "two evidenced assessments may veto an extreme mismatch");
  assert.match(unmistakable.reason, /extreme task mismatch confirmed by both reviewers/);
  assert.match(unmistakable.reason, /mismatch evidence:/);
  for (const uncertain of [
    assessment(95, 0), // Low relevance is not a mismatch finding.
    { ...mismatch, obvious_mismatch: false },
    { ...mismatch, relevance_score: 6 }, // The exception is deliberately narrow.
    { ...mismatch, mismatch_evidence: "" },
    { ...mismatch, mismatch_evidence: "   " },
    { ...mismatch, obvious_mismatch: "true" },
  ]) {
    assert.equal((await decide([mismatch, uncertain])).approved, true,
      "one suspicion, modest mismatch, or missing evidence cannot veto a safe call");
  }

  const blocked = await decide([
    assessment(100, 100), assessment(100, 100, { hard_block: true, reason: "violates the user's explicit no-network instruction" }),
  ]);
  assert.equal(blocked.approved, false);
  assert.match(blocked.reason, /hard block/);

  for (const invalid of [
    "not a verdict", new Error("provider unavailable"),
    assessment("80", 80), assessment(101, 80), assessment(80, -1),
    { approve: true, safety_score: 80, reason: "partial assessment" },
    assessment(80, 80, { hard_block: "false" }),
  ]) {
    const failed = await decide([assessment(100, 100), invalid]);
    assert.equal(failed.approved, false, "an invalid or failed review cannot be outweighed");
    assert.equal(failed.votes[1].failed, true);
    assert.match(failed.reason, /review failed/);
  }
  assert.equal((await decide([
    { approve: true, reason: "legacy reply" }, { approve: true, reason: "legacy reply" },
  ])).approved, true, "existing boolean reviewer replies remain supported");
  assert.equal((await decide([
    { approve: true, reason: "legacy reply" }, { approve: false, reason: "legacy denial" },
  ])).approved, false, "a legacy denial has no graded evidence to relax");

  // A single timeout must still block, even when the other assessment is perfect.
  let calls = 0;
  LLMClient.prototype.complete = async () => ++calls === 1
    ? JSON.stringify(assessment(100, 100)) : new Promise(() => {});
  const keepAlive = setInterval(() => {}, 100);
  try {
    const timedOut = await gate({ reviewTimeoutMs: () => 20 }).decide(request);
    assert.equal(calls, 2);
    assert.equal(timedOut.approved, false);
    assert.equal(timedOut.votes[1].failed, true);
  } finally {
    clearInterval(keepAlive);
  }

  // Review separate calls independently, without leaking one review's result
  // to its counterpart, and keep every segment of a long shell command visible.
  const seen = [];
  LLMClient.prototype.complete = async (_system, prompt) => {
    seen.push(prompt);
    return JSON.stringify(assessment(80, 80, { reason: "PRIVATE VERDICT NOT TO BE SHARED" }));
  };
  const firstCommand = "echo FIRST_PROPOSAL";
  const secondCommand = "echo SECOND_PROPOSAL " + "x".repeat(5000) + " & echo FINAL_SEGMENT";
  const reviewer = gate();
  await reviewer.decide({
    ...request,
    args: { command: firstCommand, reason: "run the first proposed command" },
  });
  await reviewer.decide({
    ...request,
    args: { command: secondCommand, reason: "run the second proposed command" },
  });
  assert.equal(seen.length, 4);
  assert.ok(seen.slice(0, 2).every(prompt => prompt.includes(firstCommand) && !prompt.includes("SECOND_PROPOSAL")));
  assert.ok(seen.slice(2).every(prompt => prompt.includes(secondCommand) && !prompt.includes("FIRST_PROPOSAL")));
  assert.ok(seen.every(prompt => !prompt.includes("PRIVATE VERDICT NOT TO BE SHARED")));
  console.log("APPROVAL DOUBLE REVIEW TESTS PASSED");
} finally {
  LLMClient.prototype.complete = originalComplete;
}
