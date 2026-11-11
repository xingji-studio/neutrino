// Analyze saved live calls only. No model requests, tool replay or runtime policy changes.
import fs from "node:fs";
import { fastDataInput, fastDataOutput, fastDataRoot } from "./fast-data-paths.mjs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { analyzeTimeline } from "./fast-timeline-analysis.mjs";
import { fastLiveCases } from "./fast-live-cases.mjs";

const sum = values => values.reduce((total, value) => total + value, 0);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const hash = value => createHash("sha256").update(value).digest("hex");
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length ? (sorted[middle] + sorted[Math.ceil(sorted.length / 2) - 1]) / 2 : null;
};

// Parallel intervals overlap: cumulative request time is not wall time or a savings estimate.
export function unionMs(intervals, left = -Infinity, right = Infinity) {
  const sorted = intervals.map(([start, end]) => [Math.max(start, left), Math.min(end, right)])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0, previousEnd = -Infinity;
  for (const [start, end] of sorted) {
    total += Math.max(0, end - Math.max(start, previousEnd));
    previousEnd = Math.max(previousEnd, end);
  }
  return total;
}

export function standaloneListTurns(requests, tools, sourceNames) {
  const byScope = new Map();
  for (const request of requests) {
    if (!byScope.has(request.scope_run_id)) byScope.set(request.scope_run_id, []);
    byScope.get(request.scope_run_id).push({ ...request, tools: [] });
  }
  for (const group of byScope.values()) group.sort((a, b) => a.start_ms - b.start_ms);
  for (const tool of tools) {
    const group = byScope.get(tool.scope_run_id);
    if (!group) continue;
    // Workers execute a reply's tools after its stream ends, before the next request starts.
    const index = group.findLastIndex(request => request.end_ms <= tool.start_ms);
    if (index >= 0 && (!group[index + 1] || tool.start_ms < group[index + 1].start_ms)) {
      group[index].tools.push(tool);
    }
  }
  const candidates = [];
  for (const [scope, group] of byScope) {
    const [first, second] = group;
    if (!second || !first.tools.length || !first.tools.every(tool => tool.name === "list_files" && tool.status === "completed")) continue;
    const reads = second.tools.filter(tool => tool.name === "read_file" && tool.status === "completed" &&
      sourceNames.has(path.basename(String(tool.arguments.path))));
    if (!reads.length) continue;
    candidates.push({ scope_run_id: scope, request_id: first.id, task_id: first.task_id, role: first.role,
      request_ms: first.end_ms - first.start_ms, interval: [first.start_ms, first.end_ms],
      source_paths: [...new Set(reads.map(tool => tool.arguments.path))],
      listing_evidence_ids: first.tools.map(tool => tool.id), read_evidence_ids: reads.map(tool => tool.id) });
  }
  return candidates;
}

export function reportedRequestTokens(attempts, requestId) {
  const selected = attempts.filter(attempt => attempt.request_id === requestId);
  // A missing usage record is unknown, not zero. Retries belong to the same logical request.
  return selected.length && selected.every(attempt => attempt.input_tokens != null && attempt.output_tokens != null)
    ? sum(selected.map(attempt => attempt.input_tokens + attempt.output_tokens)) : null;
}

export function requestReferenceProbe(request, task) {
  // Reconstruct the single-task goal/criteria fragment; this is not a captured provider payload.
  const before = { task_goal: request, acceptance_criteria: task.acceptance_criteria };
  const ref = { $ref: "runtime.original_request" };
  const after = { task_goal: ref, acceptance_criteria: task.acceptance_criteria.map(criterion => criterion === request ? ref : criterion) };
  const expand = value => Array.isArray(value) ? value.map(expand) : value && typeof value === "object"
    ? Object.keys(value).length === 1 && value.$ref === "runtime.original_request" ? request
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
  assert.deepEqual(expand(after), before, "Reference transport must preserve every literal criterion");
  return { fragment_before_bytes: bytes(before), fragment_after_bytes: bytes(after),
    fragment_saved_bytes: bytes(before) - bytes(after), exact_round_trip: true,
    limit: "A transport-only prototype of goal/criteria fields, with the immutable full request still presented by TaskRuntime. Resolver instructions, provider tokenization, cache behavior and model choices are not simulated." };
}

export function analyzeSample(sample, events, evidence, sourceNames = new Set(["north.json", "south.json", "east.json", "west.json"])) {
  const trace = analyzeTimeline(events);
  assert.ok(trace.valid_for_attribution, trace.issues.join(","));
  assert.ok(Object.values(trace.roles).every(role => role.missing_usage_attempts === 0),
    "Provider usage is missing; do not present a lower bound as complete consumption");
  const taskMap = new Map((sample.fast_tasks ?? []).map(task => [task.task_id, task]));
  const starts = new Map(events.filter(event => event.event === "tool_started").map(event => [event.data.tool_id, event]));
  const scopes = new Map(evidence.scopes.map(scope => [scope.run_id, scope]));
  const actualTools = evidence.tools.flatMap(tool => {
    const event = starts.get(tool.id);
    if (!event) return [];
    assert.equal(event.scope_run_id, tool.runId, "Saved tool and trace must belong to the same scope");
    return [{ ...tool, scope_run_id: event.scope_run_id, start_ms: event.at_ms }];
  });
  const childRequests = trace.requests.filter(request => ["worker", "verification"].includes(request.role) &&
    taskMap.get(request.task_id)?.read_only && scopes.get(request.scope_run_id)?.read_only);
  const listTurns = standaloneListTurns(childRequests, actualTools, sourceNames);
  for (const turn of listTurns) turn.reported_tokens = reportedRequestTokens(trace.provider_attempts, turn.request_id);
  const reportedTokens = sum(Object.values(trace.roles).map(role => role.reported_input_tokens + role.reported_output_tokens));
  assert.equal(reportedTokens, sample.tokens, "Trace usage must match the saved trial usage");
  const persistence = sum(events.filter(event => event.event === "persistence_end").map(event => event.data.duration_ms ?? 0));
  const snapshots = sum(events.filter(event => event.event === "snapshot_end").map(event => event.data.duration_ms ?? 0));
  const runPersistence = sum(events.filter(event => event.event === "persistence_end" && event.data.artifact_kind === "run")
    .map(event => event.data.duration_ms ?? 0));
  const totalInput = sum(Object.values(trace.roles).map(role => role.reported_input_tokens));
  const cacheKnown = trace.provider_attempts.every(attempt => attempt.cached_input_tokens != null);
  const coordinator = [...taskMap.values()].find(task => !task.verifies && !task.read_only && task.dependencies.length >= 4);
  let serialTail = null;
  if (coordinator) {
    const task = trace.task_intervals.find(item => item.task_id === coordinator.task_id);
    const verify = trace.task_intervals.find(item => taskMap.get(item.task_id)?.verifies === coordinator.task_id);
    const review = events.find(event => event.event === "engine_phase" && event.data.status === "reviewing");
    const start = events.find(event => event.event === "run_start"), end = events.find(event => event.event === "run_end");
    assert.ok(task && verify && review && start && end);
    assert.ok(task.end_ms <= verify.start_ms && verify.end_ms <= review.at_ms && review.at_ms <= end.at_ms);
    const approvalIntervals = trace.requests.filter(request => request.role === "approval").map(request => [request.start_ms, request.end_ms]);
    serialTail = { coordinator_task: task.task_id, parallel_prefix_ms: task.start_ms - start.at_ms,
      work_ms: task.lease_hold_ms, independent_verification_ms: verify.lease_hold_ms,
      global_review_ms: end.at_ms - review.at_ms, tail_ms: end.at_ms - task.start_ms,
      wall_fraction: (end.at_ms - task.start_ms) / trace.wall_ms,
      approval_model_union_ms: unionMs(approvalIntervals, task.start_ms, end.at_ms),
      transition_ms: end.at_ms - task.start_ms - task.lease_hold_ms - verify.lease_hold_ms - (end.at_ms - review.at_ms) };
  }
  const coordinatorTokens = Object.fromEntries(trace.task_intervals.filter(task => !taskMap.get(task.task_id)?.read_only)
    .map(task => [task.task_id, sum(trace.provider_attempts.filter(attempt => attempt.task_id === task.task_id && attempt.role !== "approval")
      .map(attempt => (attempt.input_tokens ?? 0) + (attempt.output_tokens ?? 0)))]));
  const evidenceRetrievals = actualTools.filter(tool => tool.name === "read_task_evidence" && tool.status === "completed")
    .map(tool => ({ id: tool.id, task_id: scopes.get(tool.runId)?.task_id ?? "global_review",
      ids: tool.arguments.ids, reason: tool.arguments.reason, result_bytes: Buffer.byteLength(tool.result) }));
  return { round: sample.round, elapsed_ms: sample.elapsed_ms, trace_wall_ms: trace.wall_ms, tokens: sample.tokens,
    logical_requests: sum(Object.values(trace.roles).map(role => role.logical_requests)), roles: trace.roles,
    serial_tail: serialTail, coordinator_tokens: coordinatorTokens, evidence_retrievals: evidenceRetrievals,
    persistence_ms: persistence, snapshot_ms: snapshots,
    // Run persistence is nested inside synchronous snapshot publication in the measured implementation.
    blocking_snapshot_and_store_ms: snapshots + persistence - runPersistence,
    model_queue_ms: trace.resource_waits.model?.wait_ms_cumulative ?? 0,
    standalone_list_turns: listTurns, standalone_listing_model_ms_sum: sum(listTurns.map(turn => turn.request_ms)),
    standalone_listing_model_ms_union: unionMs(listTurns.map(turn => turn.interval)),
    input_cache_fraction: cacheKnown && totalInput > 0 ? sum(trace.provider_attempts.map(attempt => attempt.cached_input_tokens)) / totalInput : null,
    validity: "Successful Fast sample; balanced trace; tool IDs and scopes matched; token sum equals saved usage." };
}

export function runAnalysis(raw, loadEvents, loadEvidence) {
  const cases = new Map(fastLiveCases().map(item => [item.name, item])), rows = [];
  for (const row of raw.scenarios) for (const sample of row.samples.fast_dag) {
    if (!sample.success) continue;
    const scenario = cases.get(row.name);
    assert.ok(scenario, "Unknown fixture " + row.name);
    const result = analyzeSample(sample, loadEvents(sample), loadEvidence(sample), new Set(Object.keys(scenario.files)));
    result.scenario = row.name;
    const task = sample.fast_tasks.find(item => !item.verifies && item.task_id === "main");
    const request = scenario.prompt + "\n" + (scenario.common || "Work only inside this temporary fixture. Preserve all task requirements and perform the required verification. Use node (not Python) for computations and tests. Do not access credentials or external services from tools.");
    if (task?.acceptance_criteria.includes(request)) result.request_reference_probe = requestReferenceProbe(request, task);
    rows.push(result);
  }
  const dag = rows.filter(row => row.serial_tail), field = name => dag.map(row => row[name]);
  const fractions = dag.map(row => row.serial_tail.wall_fraction);
  return { kind: "offline_fast_speed_opportunities", source_benchmark_id: raw.benchmark_id, source_model: raw.model,
    source_engine_sha256: raw.engine_sha256, source_revision_sha256: raw.revision_sha256,
    provider_calls: 0, production_changes: 0, generated_at_utc: new Date().toISOString(), samples: rows,
    dag_summary: { samples: dag.length, wall_ms_median: median(field("elapsed_ms")),
      serial_tail_fraction_median: median(fractions), serial_tail_fraction_min: dag.length ? Math.min(...fractions) : null,
      serial_tail_fraction_max: dag.length ? Math.max(...fractions) : null,
      work_ms_median: median(dag.map(row => row.serial_tail.work_ms)),
      verification_ms_median: median(dag.map(row => row.serial_tail.independent_verification_ms)),
      final_review_ms_median: median(dag.map(row => row.serial_tail.global_review_ms)),
      approval_union_ms_median: median(dag.map(row => row.serial_tail.approval_model_union_ms)),
      model_queue_ms_median: median(field("model_queue_ms")), persistence_ms_median: median(field("persistence_ms")),
      blocking_snapshot_store_ms_median: median(field("blocking_snapshot_and_store_ms")),
      standalone_listing_turns: sum(dag.map(row => row.standalone_list_turns.length)),
      listing_rounds_by_trial: dag.map(row => ({ round: row.round, count: row.standalone_list_turns.length,
        reported_tokens: row.standalone_list_turns.every(turn => turn.reported_tokens != null)
          ? sum(row.standalone_list_turns.map(turn => turn.reported_tokens)) : null,
        model_ms_sum: row.standalone_listing_model_ms_sum, model_ms_union: row.standalone_listing_model_ms_union })),
      cached_input_fraction_median: median(field("input_cache_fraction").filter(value => value != null)) },
    constraints: ["Keep the same model/intensity/output allowance and complete original brief.",
      "Retain all required independent checks and the mandatory global review.",
      "Retain ordinary approval votes and all extreme-risk rounds.",
      "Do not hard-cache arbitrary commands or infer current files from old artifacts."],
    limitations: ["Candidate listing turns may be batched with known-path reads; observed duration/token totals are not a causal speed or cost saving estimate.",
      "No paid A/B experiment was performed. Provider cache hits already exist and are still counted as input tokens.",
      "Phase medians come from the same three DAG samples; independent medians must not be summed into a measured run.",
      "The reference probe preserves literal field content by exact round-trip only; it does not establish model comprehension or end-to-end performance."] };
}

// Saved artifacts contain absolute capture paths. Allow analysis in another checkout.
export function resolveSavedFile(savedPath, repositoryDirectory) {
  if (fs.existsSync(savedPath)) return savedPath;
  const portable = savedPath.replaceAll("\\", "/"), marker = "/docs/", index = portable.lastIndexOf(marker);
  assert.ok(index >= 0, "Cannot locate saved record " + savedPath);
  const resolved = path.join(repositoryDirectory, portable.slice(index + 1));
  assert.ok(fs.existsSync(resolved), "Cannot locate saved record " + savedPath);
  return resolved;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (key, fallback) => { const index = process.argv.indexOf(key); return index < 0 ? fallback : process.argv[index + 1]; };
  const input = arg("--input", fastDataInput("fast-efficiency-v3-benchmark.json")), output = arg("--output", fastDataOutput("fast-speed-opportunities.json"));
  const raw = JSON.parse(fs.readFileSync(input, "utf8")), repositoryDirectory = fastDataRoot();
  for (const file of ["scripts/fast-live-cases.mjs", "scripts/benchmark-fast-live.mjs"]) {
    const captured = [path.resolve(file), path.join(fastDataRoot(), file)]
      .find(candidate => fs.existsSync(candidate) && hash(fs.readFileSync(candidate)) === raw.revision_sha256[file]);
    assert.ok(captured, "Fixture/request construction must match the saved trial; provide its archived source snapshot");
  }
  const report = runAnalysis(raw,
    sample => fs.readFileSync(resolveSavedFile(sample.trace_file, repositoryDirectory), "utf8").trim().split("\n").map(line => JSON.parse(line)),
    sample => JSON.parse(fs.readFileSync(resolveSavedFile(path.join(sample.artifacts.directory, "tool-evidence.json"), repositoryDirectory), "utf8")));
  report.analysis_revision_sha256 = Object.fromEntries(["scripts/analyze-fast-opportunities.mjs", "scripts/fast-timeline-analysis.mjs", "scripts/fast-data-paths.mjs"]
    .map(file => [file, hash(fs.readFileSync(file))]));
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ source_benchmark_id: report.source_benchmark_id, successful_samples: report.samples.length,
    dag: report.dag_summary, provider_calls: 0 }));
}
