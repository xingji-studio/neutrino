// Offline diagnostics: exercise the real engine, tools and approval gate with scripted model replies.
// Provider latency, provider token counts and answer quality are deliberately NOT measured here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { performance } from "node:perf_hooks";

const argument = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const outputPath = path.resolve(argument("--output") || "docs/fast-diagnostics.json");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-diagnostics-"));
const previous = { home: os.homedir, fetch: globalThis.fetch,
  environment: { NEUTRINO_HOME: process.env.NEUTRINO_HOME, NEUTRINO_PLUGIN_HOME: process.env.NEUTRINO_PLUGIN_HOME } };
os.homedir = () => fixture;
process.env.NEUTRINO_HOME = path.join(fixture, ".neutrino");
process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error("Network is disabled in offline Fast diagnostics"); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = n => Math.round(n * 1000) / 1000;
const occurrences = (text, value) => value ? text.split(value).length - 1 : 0;
const terminal = new Set(["COMPLETED", "FAILED", "BLOCKED", "INVALIDATED"]);
const report = { kind: "offline_fast_diagnostics", created_at: new Date().toISOString(),
  interpretation: "Historical provider usage is real. Reproductions use scripted replies, actual local tools and the original approval gate; their wall times and estimated input tokens are not model-performance measurements.",
  network_calls: 0, provider_tokens: null, profiles: [] };
try {
  const { FastAgentEngine } = await import("../dist/fast/engine.js");
  const { TaskRuntime, currentTask } = await import("../dist/llm/runtime.js");
  const { LLMClient } = await import("../dist/llm/client.js");
  const { ApprovalGate } = await import("../dist/llm/approval.js");
  const { assessToolCall } = await import("../dist/llm/risk.js");
  const { executeTool } = await import("../dist/llm/tools.js");
  const { estimateTokens } = await import("../dist/llm/context.js");
  const { fastSettings } = await import("../dist/fast/types.js");
  const { loadAgentPrompt, loadSubAgentPrompt } = await import("../dist/config.js");
  report.engine_sha256 = createHash("sha256").update(["engine", "scheduler", "worker", "pool", "artifacts", "types"]
    .map(name => fs.readFileSync(new URL(`../dist/fast/${name}.js`, import.meta.url), "utf8")).join("\n")).digest("hex");
  const live = JSON.parse(fs.readFileSync(new URL("../docs/fast-live-benchmark.json", import.meta.url), "utf8"));
  const measured = JSON.parse(fs.readFileSync(new URL("../docs/fast-live-metrics.json", import.meta.url), "utf8"));
  assert.equal(live.benchmark_id, measured.benchmark_id);
  const valid = live.scenarios.filter(row => row.valid_successful_comparison);
  const sum = (items, key) => items.reduce((total, item) => total + item[key], 0);
  const samples = mode => valid.flatMap(row => row.samples[mode]);
  const roles = Object.fromEntries(["planning", "workers", "verification_including_approval", "integration"]
    .map(key => [key, { input_tokens: 0, output_tokens: 0, requests: 0 }]));
  for (const row of valid) for (let i = 0; i < row.samples.fast_dag.length; i++) {
    const metrics = measured.samples[`${row.name}:${i}`].metrics;
    assert.equal(metrics.total.prompt + metrics.total.completion, row.samples.fast_dag[i].tokens);
    for (const [role, usage] of Object.entries(metrics)) {
      const target = roles[role === "verification" ? "verification_including_approval" : role];
      if (!target) continue;
      for (const value of role === "workers" ? Object.values(usage) : [usage]) {
        target.input_tokens += value.prompt; target.output_tokens += value.completion; target.requests += value.requests;
      }
    }
  }
  report.historical = { benchmark_id: live.benchmark_id, engine_sha256: live.engine_sha256,
    valid_comparisons: valid.length, repetitions: live.repetitions, roles,
    approval_local_verification_split: null,
    missing_measurements: ["Historical per-request timing", "Historical actual model concurrency", "Historical workspace/approval queue durations", "Historical separate approval usage", "Provider cache billing"],
    modes: Object.fromEntries(["standard", "fast_dag"].map(mode => [mode, {
      elapsed_ms: sum(samples(mode), "elapsed_ms"), execution_without_human_approval_ms: sum(samples(mode), "execution_ms"),
      input_tokens: sum(samples(mode), "input_tokens"), output_tokens: sum(samples(mode), "output_tokens"),
      total_tokens: sum(samples(mode), "tokens"), model_requests: sum(samples(mode), "model_requests"),
      tool_calls: sum(samples(mode), "tool_calls"), tool_cumulative_ms: sum(samples(mode), "tool_wait_ms"),
      human_approval_wait_ms: sum(samples(mode), "approval_wait_ms"),
    }])) };

  const mainPrompt = loadAgentPrompt("fast_dag"), subagentPrompt = loadSubAgentPrompt();
  const model = { name: "offline-scripted-model", url: "https://offline.invalid/v1", api_key: "offline-fixture", intensity: ["High"], supports_streaming: true };
  const scenarios = [
    { name: "read_batch", batch: true }, { name: "read_split" },
    { name: "read_batch_history", batch: true, historyChars: 20_000 }, { name: "read_split_history", historyChars: 20_000 },
    { name: "reviewed_reads", reviewed: true }, { name: "shell_split", shell: true }, { name: "scoped_edits", edit: true },
  ];
  for (const scenario of scenarios) {
    const root = path.join(fixture, scenario.name), cwd = path.join(root, "workspace"); fs.mkdirSync(cwd, { recursive: true });
    const values = [11, 23, 37];
    for (let i = 0; i < values.length; i++) {
      fs.writeFileSync(path.join(scenario.reviewed ? root : cwd, `source${i}.txt`), `VALUE:${values[i]}\n`);
      fs.mkdirSync(path.join(cwd, `module${i}`), { recursive: true });
    }
    fs.writeFileSync(path.join(cwd, "inspect.cjs"), "process.stdout.write(require('node:fs').readFileSync(process.argv[2], 'utf8'));\n");
    const request = "OFFLINE_REQUEST_SENTINEL: inspect all three fixture values, independently verify every source, and globally review their combined result.";
    const runtime = new TaskRuntime({ request, cwd, budgetScope: "task" });
    const definitions = (scenario.batch ? ["all"] : ["a", "b", "c"]).map((id, i) => ({
      task_id: id, task_goal: scenario.edit ? `Write VALUE:${values[i]} to module${i}/output.txt; verification reads that same file.` : `Inspect ${scenario.batch ? "all three sources" : `source ${i}`}.`,
      dependencies: [], required_context: ["request", "history"], input_versions: {},
      acceptance_criteria: ["Preserve all original constraints", "Independently read every assigned output/source and check its exact fixture value"],
      output_contract: "Report actual values and original tool evidence", priority: 0, estimated_duration: 1,
      read_only: !scenario.shell && !scenario.edit, exclusive: Boolean(scenario.shell),
      write_paths: scenario.edit ? [`module${i}`] : [],
    }));
    const began = performance.now(), at = () => round(performance.now() - began);
    const trace = [], requests = [], intervals = [], blocks = new Map(), activeTasks = new Map();
    const poolWaits = { model: [], tools: [], approval: [] };
    let modelActive = 0, modelPeak = 0, workerPeak = 0, approvalActive = 0, approvalPeak = 0, persistenceMs = 0, persistenceCalls = 0;
    let firstEditDone; const firstEditFinished = new Promise(resolve => { firstEditDone = resolve; });
    let engine;
    const createClient = () => {
      const client = new LLMClient(model, "Offline", "High");
      client.streamTurn = async function* (messages, tools = []) {
        const system = messages[0]?.content ?? "";
        const definitionText = messages.find(m => m.role === "user" && m.content?.includes("\nTask: "))?.content.match(/\nTask: (\{[^\n]*\})/)[1];
        const definition = definitionText ? JSON.parse(definitionText) : null;
        const role = system.includes("You are the independent approval reviewer") ? "approval"
          : system.startsWith("You plan tasks") ? "planning" : definition?.kind === "verification" ? "verification"
          : definition ? "worker" : messages.some(m => m.content?.includes("Perform the mandatory global review")) ? "integration" : "unknown";
        assert.notEqual(role, "unknown", "every scripted request must have a recognized role; network fallback is forbidden");
        const record = { id: requests.length + 1, role, task_id: definition?.task_id ?? null, run_id: currentTask()?.runId,
          started_ms: at(), ended_ms: null, system_chars: system.length, payload_bytes: Buffer.byteLength(JSON.stringify({ messages, tools })),
          estimated_input_tokens: estimateTokens({ messages, tools }),
          main_policy_plain_copies: occurrences(system, mainPrompt),
          main_policy_json_copies: occurrences(system, JSON.stringify(mainPrompt).slice(1, -1)),
          original_request_occurrences: occurrences(JSON.stringify(messages), "OFFLINE_REQUEST_SENTINEL") };
        requests.push(record); trace.push({ event: "model_start", at_ms: record.started_ms, request: record.id, role, task_id: record.task_id });
        modelActive++; modelPeak = Math.max(modelPeak, modelActive);
        this.toolCalls = []; this.usage = null; this.outcome = { status: "completed" };
        try {
          if (scenario.edit && role === "worker" && definition.task_id !== "a") await firstEditFinished;
          await sleep(5); // Scripted delay ONLY, not a simulation of any provider's performance.
          if (role === "planning") {
            yield JSON.stringify({ type: "constraints", goal: request, constraints: ["Verify every assigned value independently", "Use actual local fixture evidence"] }) + "\n";
            for (const task of definitions) { yield JSON.stringify({ type: "task", task }) + "\n"; await sleep(1); }
            yield JSON.stringify({ type: "done" }) + "\n";
          } else if (role === "approval") {
            yield JSON.stringify({ approve: true, safety_score: 100, relevance_score: 100, hard_block: false, obvious_mismatch: false, mismatch_evidence: "", reason: "Owned temporary fixture only; no external access or credentials" });
          } else if (role === "integration") {
            const artifacts = definitions.map(t => engine.store.latest(t.task_id));
            if (!artifacts.every(a => a?.verification === "verified")) {
              this.toolCalls = [{ id: "review-partial", name: "finish_fast_review", arguments: JSON.stringify({ status: "partial", report: "A diagnostic fixture task failed; inspect its recorded tool evidence", unresolved: ["Incomplete fixture task"], evidence_ids: [] }) }];
              yield "Review partial fixture"; return;
            }
            assert.deepEqual(artifacts.flatMap(a => JSON.parse(a.result).values), values);
            this.toolCalls = [{ id: "review", name: "finish_fast_review", arguments: JSON.stringify({ status: "completed", report: "All three actual values independently verified", unresolved: [], evidence_ids: artifacts.map(a => `artifact:${a.task_id}@${a.version}`) }) }];
            yield "Review complete";
          } else {
            const sourceId = definition.verifies ?? definition.task_id;
            const indexes = scenario.batch ? [0, 1, 2] : [definitions.findIndex(t => t.task_id === sourceId)];
            const toolMessages = messages.filter(m => m.role === "tool");
            if (!toolMessages.length) {
              this.toolCalls = indexes.map(i => {
                const editing = scenario.edit && role === "worker";
                const name = editing ? "write_file" : scenario.shell ? "run_command" : "read_file";
                const args = editing ? { path: `module${i}/output.txt`, content: `VALUE:${values[i]}\n`, reason: "Write the assigned owned fixture output" }
                  : scenario.shell ? { command: `node inspect.cjs source${i}.txt`, reason: "Run the owned fixture inspector on its assigned input" }
                  : { path: scenario.edit ? `module${i}/output.txt` : `${scenario.reviewed ? "../" : ""}source${i}.txt`, reason: "Independently inspect the assigned owned fixture value" };
                return { id: `tool-${i}`, name, arguments: JSON.stringify(args) };
              });
              yield "Inspect assigned fixture";
            } else {
              const actual = scenario.edit && role === "worker" ? indexes.map(i => values[i])
                : toolMessages.map(m => Number(m.content.match(/VALUE:(\d+)/)?.[1]));
              assert.deepEqual(actual, indexes.map(i => values[i]), "fixture values must be read from actual tool output");
              this.toolCalls = [{ id: "finished", name: "finish_task", arguments: JSON.stringify({ status: "completed", report: JSON.stringify({ values: actual }), conclusions: [], evidence: [], assumptions: [], unresolved: [], ...(role === "verification" ? { verification_passed: true } : {}) }) }];
              yield "Assigned values verified";
            }
          }
        } finally {
          record.ended_ms = at(); modelActive--;
          trace.push({ event: "model_end", at_ms: record.ended_ms, request: record.id, role, task_id: record.task_id });
        }
      };
      return client;
    };
    const history = [{ role: "system", content: `${mainPrompt}\n\n${runtime.instructions()}` },
      ...(scenario.historyChars ? [{ role: "assistant", content: "Stable historical fixture context. ".repeat(700).slice(0, scenario.historyChars) }] : []),
      { role: "user", content: request }];
    engine = new FastAgentEngine({ runtime, signal: runtime.signal, cwd, history, system: mainPrompt, subagentSystem: subagentPrompt,
      settings: { ...fastSettings({}), modelSlots: 4, workerSlots: 8, retries: 0, replans: 0 },
      maxRounds: 16, contextWindow: 128_000, directory: path.join(root, "persisted"), createClient,
      approve: async (name, args, signal, wrapReviewer) => {
        const risk = assessToolCall(name, args, cwd);
        if (!risk) return { approved: true, source: "prompt", reason: "Routine owned fixture call" };
        approvalActive++; approvalPeak = Math.max(approvalPeak, approvalActive);
        trace.push({ event: "approval_start", at_ms: at(), tool: name });
        try {
          const gate = new ApprovalGate({ askHuman: async () => { throw new Error("Offline fixture must not request human approval"); },
            autoApprovalEnabled: () => true, extremeAutoApprovalEnabled: () => false,
            reviewer: () => ({ model, provider: "Offline", intensity: "High" }),
            createReviewerClient: () => wrapReviewer(createClient()), cancelled: () => signal.aborted });
          return await gate.decide({ tool: name, args, cwd, prompt: request, priorUserRequests: [], context: "Owned diagnostic fixture", risk });
        } finally { approvalActive--; trace.push({ event: "approval_end", at_ms: at(), tool: name }); }
      },
      execute: (name, args, signal) => executeTool(name, args, cwd, signal),
      onSnapshot: snapshot => {
        for (const task of snapshot.tasks) {
          const executing = task.kind === "work" ? task.status === "RUNNING" : task.status === "VERIFYING";
          if (executing && !activeTasks.has(task.task_id)) {
            const interval = { task_id: task.task_id, kind: task.kind, read_only: task.read_only, exclusive: task.exclusive, write_paths: task.write_paths, start_ms: at(), end_ms: null };
            activeTasks.set(task.task_id, interval); intervals.push(interval);
          } else if (!executing && activeTasks.has(task.task_id)) {
            activeTasks.get(task.task_id).end_ms = at(); activeTasks.delete(task.task_id);
          }
          if (scenario.edit && task.task_id === "a" && task.status === "VERIFYING") firstEditDone();
        }
        workerPeak = Math.max(workerPeak, [...activeTasks.values()].filter(t => t.kind === "work").length);
      },
    });
    // Instance-only probes leave production source and persisted historic measurements unchanged.
    for (const [name, pool] of [["model", engine.models], ["tools", engine.tools], ["approval", engine.approvalPool]]) {
      const acquire = pool.acquire.bind(pool);
      pool.acquire = async (...args) => { const queued = performance.now(); const release = await acquire(...args); poolWaits[name].push(performance.now() - queued); return release; };
    }
    const conflicts = engine.scheduler.conflicts.bind(engine.scheduler);
    engine.scheduler.conflicts = (a, b) => {
      const blocked = conflicts(a, b);
      if (blocked) {
        const key = `${a.task_id}|${b.task_id}`;
        if (!blocks.has(key)) blocks.set(key, { task_id: a.task_id, blocked_by: b.task_id, first_seen_ms: at(), blocker_exclusive: b.exclusive, waiting_exclusive: a.exclusive });
      }
      return blocked;
    };
    const checkpoint = engine.store.checkpoint.bind(engine.store);
    engine.store.checkpoint = snapshot => { const started = performance.now(); try { return checkpoint(snapshot); } finally { persistenceCalls++; persistenceMs += performance.now() - started; } };
    const result = await runtime.run(() => engine.run()); runtime.finish(result.status);
    if (result.status !== "completed") console.error(JSON.stringify({ profile: scenario.name, tasks: result.snapshot.tasks.map(t => ({ id: t.task_id, status: t.status, error: t.error })), tool_results: runtime.evidence.map(e => ({ name: e.name, status: e.status, result: e.result.slice(0, 1000) })) }, null, 2));
    assert.equal(result.status, "completed", `${scenario.name}: ${result.snapshot.error}`);
    assert.ok(result.snapshot.tasks.every(t => terminal.has(t.status)));
    const roleCounts = Object.fromEntries(["planning", "worker", "verification", "approval", "integration"].map(role => [role, requests.filter(r => r.role === role).length]));
    const rolesByRun = new Map(requests.filter(r => ["worker", "verification"].includes(r.role)).map(r => [r.run_id, r.role]));
    const independentChecks = runtime.evidence.filter(e => rolesByRun.get(e.runId) === "verification" && e.status === "completed");
    const toolCounts = Object.fromEntries(["read_file", "write_file", "run_command"].map(name => [name, runtime.evidence.filter(e => e.name === name && e.status === "completed").length]));
    assert.equal(independentChecks.length, 3, "every profile independently checks all three assigned inputs/outputs");
    if (!scenario.edit && !scenario.shell) assert.equal(toolCounts.read_file, 6, "batched and split plans perform the same six actual source reads");
    const firstWorker = requests.find(r => r.role === "worker");
    const profile = { name: scenario.name, status: result.status, model_source: "scripted_offline", provider_tokens: null,
      scripted_round_delay_ms: 5, elapsed_ms: at(), requests: requests.length, role_counts: roleCounts,
      completed_tool_counts: toolCounts, independent_verification_tool_calls: independentChecks.length,
      max_model_inflight: modelPeak, max_work_tasks_active: workerPeak, max_approval_decisions_active: approvalPeak,
      input_payload_bytes_cumulative: sum(requests, "payload_bytes"), estimated_input_tokens_cumulative: sum(requests, "estimated_input_tokens"),
      first_worker_main_policy_copies: firstWorker.main_policy_plain_copies + firstWorker.main_policy_json_copies,
      legacy_verification_counter: result.snapshot.metrics.verification.requests,
      role_counter_reconciles: result.snapshot.metrics.verification.requests === roleCounts.verification + roleCounts.approval,
      local_cache_hits: result.snapshot.metrics.context_cache_hits,
      root_abort_listeners_after_finish: getEventListeners(runtime.signal, "abort").length,
      queue_wait_ms_cumulative: Object.fromEntries(Object.entries(poolWaits).map(([key, value]) => [key, round(value.reduce((a, b) => a + b, 0))])),
      checkpoint: { calls: persistenceCalls, cumulative_ms: round(persistenceMs) },
      workspace_blocks: [...blocks.values()], task_intervals: intervals, model_requests: requests, events: trace };
    assert.equal(profile.first_worker_main_policy_copies, 2, "main policy appears directly and again inside inherited history");
    assert.equal(profile.role_counter_reconciles, true);
    assert.equal(profile.root_abort_listeners_after_finish, 0, "concurrent signal fan-out must be cleaned up after the run");
    if (scenario.reviewed) { assert.equal(roleCounts.approval, 12); assert.equal(approvalPeak, 1); }
    if (scenario.shell) { assert.equal(workerPeak, 1); assert.equal(roleCounts.approval, 0); }
    if (scenario.edit) assert.ok(profile.workspace_blocks.some(b => b.task_id === "a.verify" && ["b", "c"].includes(b.blocked_by) && b.waiting_exclusive));
    report.profiles.push(profile);
    console.log(`${scenario.name}: scripted_requests=${profile.requests}, work_peak=${workerPeak}, actual_reviews=${roleCounts.approval}, main_policy_copies=${profile.first_worker_main_policy_copies}`);
  }
  const profile = name => report.profiles.find(p => p.name === name);
  assert.equal(profile("read_batch").requests, 6); assert.equal(profile("read_split").requests, 14);
  assert.ok(profile("read_split").max_work_tasks_active > 1);
  assert.ok(profile("read_split_history").input_payload_bytes_cumulative > profile("read_split").input_payload_bytes_cumulative);
  report.findings = {
    one_vs_three_work_nodes: { identical_source_reads_and_independent_checks: true, batched_scripted_requests: 6, split_scripted_requests: 14 },
    duplicate_main_policy: true, scoped_verifier_waits_for_unrelated_writer: true,
    shell_task_lease_serializes_model_work: true, automatic_approval_decisions_serialized: true,
    legacy_verification_metrics_include_approval: true,
    historical_wait_attribution_possible: false,
  };
  assert.equal(networkAttempts, 0, "offline diagnostics must not even attempt a network request");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true }); fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${outputPath}; no provider requests were made.`);
} finally {
  os.homedir = previous.home; globalThis.fetch = previous.fetch;
  for (const [key, value] of Object.entries(previous.environment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(fixture, { recursive: true, force: true });
}
