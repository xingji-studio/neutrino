// Plan/UI fixtures supply an explicit abstract completion. Actual filesystem,
// proof freshness, denial and provider accounting are tested in test-standard-quality.
export function isStandardFixtureReview(messages) {
  return messages[0]?.content?.includes("independent completion reviewer for Standard");
}
export function standardFixtureFinish(messages, tools, report) {
  if (!tools?.some(t => t.function.name === "finish_standard_task")) return;
  const system = messages[0]?.content ?? "";
  if (!system.includes("Completion checkpoint initially required: true") &&
      !messages.some(m => m.role === "user" && m.content?.includes("Completion is not recorded"))) return;
  const line = system.split("\n").find(s => s.startsWith("Acceptance inventory ("));
  if (!line) throw new Error("Completion fixture missing original requirement inventory");
  const requirements = JSON.parse(line.slice(line.indexOf(": ") + 2));
  const evidence = [...new Set(messages.filter(m => m.role === "tool").flatMap(m =>
    [...String(m.content).matchAll(/\[Task evidence: ([^;]+); status=completed\]/g)].map(x => x[1])))];
  return { id: "fixture-completion", name: "finish_standard_task", arguments: JSON.stringify({
    status: "completed", report, artifact_paths: [], unresolved: [], reason: "Complete the scripted abstract deliverable",
    checks: requirements.map(r => ({ requirement_id: r.id, detail: report, evidence_ids: evidence })),
  }) };
}
export const standardFixtureAssessment = JSON.stringify({ accepted: true, unresolved: [], reason: "The scripted abstract deliverable covers the requested plan step" });
