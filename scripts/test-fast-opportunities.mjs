import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSample, reportedRequestTokens, requestReferenceProbe, resolveSavedFile,
  runAnalysis, standaloneListTurns, unionMs } from "./analyze-fast-opportunities.mjs";

// Timing conclusions must survive overlapping reviewers, clipped phases and disjoint work.
assert.equal(unionMs([[10, 20], [0, 5], [3, 12], [20, 22], [11, 15]]), 22);
assert.equal(unionMs([[0, 10], [5, 15], [20, 30]], 7, 25), 13);
assert.equal(unionMs([[3, 2], [NaN, 9], [1, Infinity], [4, 4]]), 0);
assert.equal(unionMs([[1, 2]], 4, 3), 0);

const request = (scope, index, start, end) => ({ scope_run_id: scope, id: scope + index,
  task_id: scope, role: "worker", start_ms: start, end_ms: end });
const tool = (id, scope, start, name, file, status = "completed") => ({ id,
  scope_run_id: scope, start_ms: start, name, arguments: { path: file }, status });
const requests = [request("a", 1, 0, 3), request("b", 1, 1, 4), request("a", 2, 4, 8),
  request("b", 2, 5, 7), request("a", 3, 9, 11), request("b", 3, 8, 10)];
const tools = [tool("a-list", "a", 3.2, "list_files", "."), tool("a-read", "a", 8.5, "read_file", "north.json"),
  tool("b-list", "b", 4.2, "list_files", "."), tool("b-read", "b", 7.5, "read_file", "west.json")];
const sources = new Set(["north.json", "west.json"]);
const found = standaloneListTurns(requests, tools, sources);
assert.deepEqual(found.map(turn => turn.request_id), ["a1", "b1"]);
assert.equal(unionMs(found.map(turn => turn.interval)), 4);
assert.equal(found.reduce((total, turn) => total + turn.request_ms, 0), 6);
assert.deepEqual(found[0].listing_evidence_ids, ["a-list"]);
assert.deepEqual(found[1].read_evidence_ids, ["b-read"]);
assert.equal(standaloneListTurns(requests, tools.map(item => ({ ...item, status: "denied" })), sources).length, 0);
assert.equal(standaloneListTurns(requests, tools, new Set(["other.json"])).length, 0);
assert.equal(standaloneListTurns(requests.filter(item => item.scope_run_id === "a"), tools.filter(item => item.scope_run_id === "b"), sources).length, 0);
assert.equal(standaloneListTurns(requests, [...tools, tool("batched", "a", 3.5, "read_file", "north.json")], sources).length, 1,
  "an already batched list/read reply is not a standalone listing round");
assert.equal(standaloneListTurns(requests, tools.map(item => item.id === "a-list" ? { ...item, start_ms: 6 } : item), sources).length, 1,
  "a tool starting inside a model stream is not attributed to an earlier reply");

const attempts = [{ request_id: "r", input_tokens: 10, output_tokens: 2 },
  { request_id: "other", input_tokens: 100, output_tokens: 9 }, { request_id: "r", input_tokens: 7, output_tokens: 3 }];
assert.equal(reportedRequestTokens(attempts, "r"), 22, "all retries count toward usage");
assert.equal(reportedRequestTokens([...attempts, { request_id: "r", output_tokens: 1 }], "r"), null);
assert.equal(reportedRequestTokens(attempts, "missing"), null);

const original = '核验源文件\n保留 "quotes", \\slashes and literal {$ref:runtime.original_request}.';
const criteria = [original, "independent criterion", original + " "];
const preserved = structuredClone(criteria);
const probe = requestReferenceProbe(original, { acceptance_criteria: criteria });
assert.equal(probe.exact_round_trip, true);
assert.ok(probe.fragment_saved_bytes > 0);
assert.deepEqual(criteria, preserved, "non-matching and whitespace-different criteria are never rewritten");

// Reject incomplete logs and contradictory usage before reporting a timing conclusion.
const metadata = [
  ["run_start", 0, {}],
  ["model_stream_start", 1, { request_id: "r" }],
  ["provider_dispatch", 1.1, { request_id: "r", attempt_id: "attempt" }],
  ["provider_attempt_end", 3, { attempt_id: "attempt", input_tokens: 5, output_tokens: 3, cached_input_tokens: 2 }],
  ["model_stream_end", 3.1, { request_id: "r", status: "completed" }],
  ["run_end", 4, { status: "completed" }],
  ["trace_summary", 5, { dropped_events: 0, io_errors: 0 }],
].map(([event, at_ms, data], index) => ({ event, at_ms, data, seq: index + 1,
  trace_id: "fixture", scope_run_id: "scope", role: "worker", task_id: "main" }));
const sample = { tokens: 8, elapsed_ms: 4, round: 1, fast_tasks: [] }, evidence = { scopes: [], tools: [] };
assert.equal(analyzeSample(sample, metadata, evidence).input_cache_fraction, 0.4);
assert.throws(() => analyzeSample({ ...sample, tokens: 9 }, metadata, evidence), /usage/);
const missingUsage = structuredClone(metadata);
delete missingUsage.find(event => event.event === "provider_attempt_end").data.input_tokens;
assert.throws(() => analyzeSample(sample, missingUsage, evidence), /usage is missing/);
assert.throws(() => analyzeSample(sample, metadata.filter(event => event.event !== "model_stream_end"), evidence), /missing_events|unbalanced/);
const empty = runAnalysis({ scenarios: [] }, () => assert.fail("No logs should load"), () => assert.fail("No tools should load"));
assert.equal(empty.dag_summary.serial_tail_fraction_min, null);
assert.equal(empty.dag_summary.wall_ms_median, null);
const skipped = runAnalysis({ scenarios: [{ name: "parallel_analysis", samples: { fast_dag: [{ success: false }] } }] },
  () => assert.fail("Failed samples must not be attributed as success"), () => assert.fail("No tools should load"));
assert.equal(skipped.samples.length, 0);

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-opportunities-"));
try {
  fs.mkdirSync(path.join(fixture, "docs", "traces"), { recursive: true });
  const record = path.join(fixture, "docs", "traces", "record.jsonl");
  fs.writeFileSync(record, "{}\n");
  assert.equal(resolveSavedFile("Z:\\old-checkout\\docs\\traces\\record.jsonl", fixture), record);
  assert.throws(() => resolveSavedFile("/nonexistent-without-docs/record.jsonl", fixture), /Cannot locate/);
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

// Reconstruct every saved successful trial, with networking disabled, without replaying any tool.
const savedFetch = globalThis.fetch;
globalThis.fetch = () => assert.fail("Offline analysis must not call a provider");
try {
  const raw = JSON.parse(fs.readFileSync("docs/fast-efficiency-v3-benchmark.json", "utf8"));
  const report = runAnalysis(raw,
    item => fs.readFileSync(resolveSavedFile(item.trace_file, process.cwd()), "utf8").trim().split("\n").map(line => JSON.parse(line)),
    item => JSON.parse(fs.readFileSync(resolveSavedFile(path.join(item.artifacts.directory, "tool-evidence.json"), process.cwd()), "utf8")));
  assert.equal(report.samples.length, 12);
  assert.equal(report.dag_summary.samples, 3);
  assert.equal(report.dag_summary.standalone_listing_turns, 7);
  assert.deepEqual(report.dag_summary.listing_rounds_by_trial.map(item => item.count), [2, 2, 3]);
  assert.equal(report.dag_summary.listing_rounds_by_trial.reduce((total, item) => total + item.reported_tokens, 0), 29390);
  assert.equal(report.samples.filter(item => item.request_reference_probe?.exact_round_trip).length, 9);
  for (const item of report.samples.filter(item => item.serial_tail)) {
    const tail = item.serial_tail;
    assert.ok(tail.wall_fraction > 0.59 && tail.wall_fraction < 0.70);
    assert.ok(tail.transition_ms >= 0 && tail.transition_ms < 20);
    assert.ok(tail.approval_model_union_ms < tail.tail_ms);
    assert.ok(item.input_cache_fraction > 0 && item.input_cache_fraction <= 1);
  }
  assert.equal(report.provider_calls, 0);
  const captured = raw.scenarios[0].samples.fast_dag[0];
  const capturedEvents = fs.readFileSync(resolveSavedFile(captured.trace_file, process.cwd()), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const capturedEvidence = JSON.parse(fs.readFileSync(resolveSavedFile(path.join(captured.artifacts.directory, "tool-evidence.json"), process.cwd()), "utf8"));
  capturedEvidence.tools.find(item => capturedEvents.some(event => event.event === "tool_started" && event.data.tool_id === item.id)).runId = "wrong-scope";
  assert.throws(() => analyzeSample(captured, capturedEvents, capturedEvidence), /same scope/);
  console.log("PASS offline opportunities: overlap/clipping, scope-safe list/read detection, retries and unknown usage, literal request preservation, invalid trace rejection, portable paths; 12 saved Fast trials reproduced");
} finally {
  globalThis.fetch = savedFetch;
}
