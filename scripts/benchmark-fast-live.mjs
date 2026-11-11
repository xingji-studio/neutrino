// Actual end-to-end Standard vs Fast Agent Engine benchmark, using an explicitly chosen existing catalogue.
// Credentials are read in memory, never printed or included in the report. No user project files are modified.
import fs from "node:fs";
import { fastDataOutput } from "./fast-data-paths.mjs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import ts from "typescript";
import { analyzeTimeline } from "./fast-timeline-analysis.mjs";
import { fastLiveCases } from "./fast-live-cases.mjs";
const argument = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const sourceHome = argument("--home") || os.homedir();
const repetitions = Number(argument("--runs") || 1);
const requestedTimeout = Number(argument("--timeout-ms") || 30 * 60_000);
const campaignTokenCap = argument("--token-cap") ? Number(argument("--token-cap")) : Infinity;
if (campaignTokenCap !== Infinity && (!Number.isSafeInteger(campaignTokenCap) || campaignTokenCap < 1)) throw new Error("token-cap must be a positive integer");
const traceDirectory = argument("--trace-dir") ? path.resolve(argument("--trace-dir")) : null;
const campaignUsage = { settled_tokens_including_unknown_reservations: 0, held_tokens: 0, stopped: false, requests_rejected_before_dispatch: 0 };
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || !Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1) throw new Error("runs and timeout-ms must be positive integers");
const filter = argument("--cases")?.split(",");
const baseline = argument("--reuse-standard") ? JSON.parse(fs.readFileSync(path.resolve(argument("--reuse-standard")), "utf8")) : null;
const target = path.resolve(argument("--output") || fastDataOutput("fast-live-benchmark.json"));
const artifactDirectory = argument("--artifact-dir") ? path.resolve(argument("--artifact-dir")) : null;
const approvalDirectory = argument("--approval-dir") ? path.resolve(argument("--approval-dir")) : null;
if (approvalDirectory) fs.mkdirSync(approvalDirectory, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-live-"));
const originalHomedir = os.homedir;
const priorEnvironment = { NEUTRINO_HOME: process.env.NEUTRINO_HOME, NEUTRINO_PLUGIN_HOME: process.env.NEUTRINO_PLUGIN_HOME, NEUTRINO_DIAGNOSTICS_DIR: process.env.NEUTRINO_DIAGNOSTICS_DIR };
const originalDispatcher = getGlobalDispatcher();
const proxy = process.env.NEUTRINO_BENCHMARK_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
const report = { kind: "live_model_end_to_end", state: "running", repetitions, source: "existing selected model", model: null,
  note: "Identical model, intensity, fixture requirements and verification for both modes. Correctness uses exact fixture oracles; broader answer quality requires human review. One sample does not establish population P95.",
  scenarios: [], untested: ["Human-reviewed open-ended answer quality", "Provider cache billing (not exposed by current client)"] };
report.benchmark_id = randomUUID();
report.engine_sha256 = createHash("sha256").update(["engine", "scheduler", "worker", "pool", "artifacts", "types", "planner"]
  .map(name => fs.readFileSync(new URL(`../dist/fast/${name}.js`, import.meta.url), "utf8")).join("\n")).digest("hex");
let originalStream, originalTool, originalRequest, originalFinish, TaskRuntime, TaskControlError, currentTask, LLMClient, sessions = [];
const finishedTurns = new WeakMap();
const sampledRuntimes = [];
const sampleScopes = new WeakMap();
report.execution_order = [];
const awaitTurnFinish = runtime => {
  if (!runtime) return Promise.resolve();
  let completion = finishedTurns.get(runtime);
  if (!completion) { let resolve; const promise = new Promise(done => { resolve = done; }); completion = { promise, resolve }; finishedTurns.set(runtime, completion); }
  return completion.promise;
};
let interrupted = false;
const stop = () => { interrupted = true; for (const session of sessions) session.livePause(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const cases = fastLiveCases();
const revisionFiles = ["dist/fast/engine.js", "dist/fast/planner.js", "dist/fast/evidence.js", "dist/fast/scheduler.js", "dist/fast/worker.js", "dist/fast/pool.js", "dist/fast/artifacts.js", "dist/fast/types.js", "dist/llm/client.js", "dist/llm/runtime.js", "dist/llm/workspace.js", "dist/llm/tools.js", "dist/llm/approval.js", "dist/llm/risk.js", "dist/web/session.js", "assets/fast-planner.txt", "assets/fast-replanner.txt", "assets/prompt.txt", "assets/planner.txt", "assets/subagent.txt", "scripts/benchmark-fast-live.mjs", "scripts/fast-live-cases.mjs", "scripts/fast-data-paths.mjs"];
const revision = () => Object.fromEntries(revisionFiles.map(name => [name, createHash("sha256").update(fs.readFileSync(new URL(`../${name}`, import.meta.url))).digest("hex")]));
report.revision_sha256 = revision();
const assertRevision = () => { if (JSON.stringify(revision()) !== JSON.stringify(report.revision_sha256)) throw new Error("Benchmark runtime revision changed during the campaign"); };
report.requested_cases = cases.filter(c => !filter || filter.includes(c.name)).map(c => c.name);
const persist = () => { report.campaign_token_cap = Number.isFinite(campaignTokenCap) ? campaignTokenCap : null; report.campaign_usage = { ...campaignUsage }; fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n"); };
try {
  const catalogue = JSON.parse(fs.readFileSync(path.join(sourceHome, ".neutrino", "model.json"), "utf8"));
  const sourceConfig = JSON.parse(fs.readFileSync(path.join(sourceHome, ".neutrino", "config.json"), "utf8"));
  const provider = catalogue.providers.find(p => p.name === sourceConfig.selected_provider);
  const model = provider?.models.find(m => m.name === sourceConfig.selected_model);
  if (!model?.api_key?.trim()) throw new Error("The selected runtime model has no configured API key");
  os.homedir = () => fixture;
  process.env.NEUTRINO_HOME = path.join(fixture, ".neutrino"); process.env.NEUTRINO_PLUGIN_HOME = path.join(fixture, "plugins");
  const config = await import("../dist/config.js");
  ({ LLMClient } = await import("../dist/llm/client.js"));
  ({ TaskRuntime, TaskControlError, currentTask } = await import("../dist/llm/runtime.js"));
  if (traceDirectory) process.env.NEUTRINO_DIAGNOSTICS_DIR = traceDirectory;
  originalFinish = TaskRuntime.prototype.finish;
  TaskRuntime.prototype.finish = function(status) {
    const value = originalFinish.call(this, status);
    let completion = finishedTurns.get(this);
    if (!completion) { completion = { promise: Promise.resolve(), resolve: () => {} }; finishedTurns.set(this, completion); }
    completion.resolve(); return value;
  };
  const { createWebSession } = await import("../dist/web/session.js");
  const { spawnSync } = await import("node:child_process");
  config.saveModels({ providers: [{ name: provider.name, models: [model] }] });
  const intensity = config.intensityForModel(model, sourceConfig.selected_intensity, sourceConfig.default_intensity);
  config.saveConfig({ ...config.DEFAULT_CONFIG, selected_provider: provider.name, selected_model: model.name, selected_intensity: intensity,
    default_intensity: intensity, plan_first: true, task_budget_scope: "task", task_timeout_ms: requestedTimeout,
    model_context_windows: sourceConfig.model_context_windows ?? {}, fast_mode_enabled: true });
  report.model = { provider: provider.name, name: model.name, intensity, available_inference_slots: 4 };
  if ((argument("--expect-provider") && argument("--expect-provider") !== provider.name) ||
      (argument("--expect-model") && argument("--expect-model") !== model.name) ||
      (argument("--expect-intensity") && argument("--expect-intensity") !== intensity)) {
    throw new TaskControlError("diagnostic_model_mismatch", "Configured model/intensity differs from the diagnostic baseline");
  }
  if (baseline) {
    const proof = baseline.baseline_validation;
    if (!proof || baseline.model.provider !== provider.name || baseline.model.name !== model.name || baseline.model.intensity !== intensity) throw new Error("Standard baseline model/configuration mismatch");
    const fixedCases = cases.filter(scenario => proof.fixture_names.includes(scenario.name));
    const hash = value => createHash("sha256").update(value).digest("hex");
    if (hash(JSON.stringify(fixedCases)) !== proof.fixture_sha256) throw new Error("Standard baseline fixture mismatch");
    const modules = new Set();
    const dist = new URL("../dist/", import.meta.url);
    const visit = file => {
      if (modules.has(file) || file.startsWith("fast/")) return;
      modules.add(file);
      const source = fs.readFileSync(new URL(file, dist), "utf8");
      for (const spec of ts.preProcessFile(source, true, true).importedFiles) if (spec.fileName.startsWith(".")) {
        const relative = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec.fileName));
        if (relative.startsWith("../")) throw new Error("Unexpected dependency outside dist");
        if (fs.existsSync(new URL(relative, dist))) visit(relative);
      }
    };
    for (const file of ["web/session.js", "llm/client.js", "llm/runtime.js", "config.js"]) visit(file);
    const assets = ["prompt.txt", "planner.txt", "step.txt", "subagent.txt"];
    const runtimeHash = hash([...modules].sort().map(file => file + "\n" + fs.readFileSync(new URL(file, dist), "utf8")).join("\n") +
      assets.map(file => fs.readFileSync(new URL(`../assets/${file}`, import.meta.url), "utf8")).join("\n"));
    if (runtimeHash !== proof.standard_runtime_sha256) throw new Error("Standard baseline runtime changed");
    report.standard_baseline = { source: path.basename(argument("--reuse-standard")), validation: proof,
      note: "Reuse only completed successful Standard samples from identical fixtures, model/intensity, and unchanged runtime. Earlier timeout was not binding for these completed samples." };
  }
  report.conditions = { task_timeout_ms: requestedTimeout, budget_scope: "task", model_slots: 4,
    agent_runs: config.DEFAULT_CONFIG.task_max_agents, model_requests: config.DEFAULT_CONFIG.task_max_requests,
    tool_calls: config.DEFAULT_CONFIG.task_max_tools, tokens: config.DEFAULT_CONFIG.task_max_tokens };
  if (campaignTokenCap < 17_000) { campaignUsage.stopped = true; throw new TaskControlError("diagnostic_campaign_cap", "Diagnostic cap cannot reserve the unchanged connectivity request budget"); }
  const connectivityStarted = performance.now();
  const probe = new LLMClient(model, provider.name, intensity);
  const probeSignal = AbortSignal.timeout(30_000);
  for await (const ignored of probe.streamTurn([{ role: "user", content: "Reply OK to confirm this configured model is reachable." }], [], {
    signal: probeSignal, retry: { attempts: 1 }, maxOutputTokens: 16384,
  })) { /* Connectivity output is intentionally not copied into the benchmark. */ }
  report.connectivity = { elapsed_ms: performance.now() - connectivityStarted, status: probe.outcome?.status ?? "unknown",
    input_tokens: probe.usage?.prompt ?? null, output_tokens: probe.usage?.completion ?? null,
    http_status: Number(probe.outcome?.error?.message.match(/HTTP (\d+)/)?.[1]) || null,
    error_kind: /insufficient.?balance/i.test(probe.outcome?.error?.message || "") ? "insufficient_balance" : null };
  campaignUsage.settled_tokens_including_unknown_reservations += probe.usage?.total ?? 17_000;
  originalRequest = TaskRuntime.prototype.request;
  TaskRuntime.prototype.request = function(inputTokens, outputTokens, final) {
    const reservation = Math.max(1, Math.ceil(inputTokens)) + Math.max(1, Math.ceil(outputTokens));
    if (campaignUsage.settled_tokens_including_unknown_reservations + campaignUsage.held_tokens + reservation > campaignTokenCap) {
      campaignUsage.stopped = true; campaignUsage.requests_rejected_before_dispatch++;
      throw new TaskControlError("diagnostic_campaign_cap", "Diagnostic campaign Token cap reached before another provider attempt");
    }
    const original = originalRequest.call(this, inputTokens, outputTokens, final);
    campaignUsage.held_tokens += reservation; let settled = false;
    return { settle(used) {
      if (settled) return; settled = true;
      campaignUsage.held_tokens -= reservation;
      campaignUsage.settled_tokens_including_unknown_reservations += Math.max(0, Math.ceil(used));
      original.settle(used);
    } };
  };
  if (probe.outcome?.status !== "completed" || !probe.usage) throw new Error("Model unavailable: configured API did not return a successful response and usage within the connectivity check. All live cases remain untested.");
  let retryCount = 0, toolWait = 0, actualUsage = { prompt: 0, completion: 0, missing: 0, notDispatched: 0 };
  originalTool = TaskRuntime.prototype.tool;
  TaskRuntime.prototype.tool = async function (name, args, callback) {
    const start = performance.now();
    try { return await originalTool.call(this, name, args, callback); }
    finally { if (!["delegate", "call_pro_agent"].includes(name)) toolWait += performance.now() - start; }
  };
  originalStream = LLMClient.prototype.streamTurn;
  LLMClient.prototype.streamTurn = async function* (messages, tools, options = {}) {
    const scope = currentTask();
    if (artifactDirectory && scope) {
      let scopes = sampleScopes.get(scope.runtime);
      if (!scopes) { scopes = new Map(); sampleScopes.set(scope.runtime, scopes); }
      const context = scope.runtime.diagnostics?.context(scope);
      scopes.set(scope.runId, { run_id: scope.runId, parent_run_id: scope.parentRunId, role: scope.role,
        diagnostic_role: context?.role, task_id: context?.task_id, read_only: scope.policy.readOnly, workspace_only: scope.runtime.workspaceOnly });
    }
    try { yield* originalStream.call(this, messages, tools, { ...options, onRetry: notice => { retryCount++; options.onRetry?.(notice); } }); }
    finally {
      if (this.usage) { actualUsage.prompt += this.usage.prompt; actualUsage.completion += this.usage.completion; }
      else if (this.outcome?.error?.code === "diagnostic_campaign_cap") actualUsage.notDispatched++;
      else actualUsage.missing++;
    }
  };
  for (const [scenarioIndex, scenario] of cases.filter(c => !filter || filter.includes(c.name)).entries()) {
    const row = { name: scenario.name, samples: { standard: [], fast_dag: [] } }; report.scenarios.push(row);
    for (let run = 0; run < repetitions; run++) {
      for (const mode of (run + scenarioIndex) % 2 ? ["fast_dag", "standard"] : ["standard", "fast_dag"]) {
        const prior = mode === "standard" ? baseline?.scenarios.find(row => row.name === scenario.name)?.samples.standard[run] : null;
        if (prior?.success && prior.fixture_correct && prior.elapsed_ms < baseline.conditions.task_timeout_ms) {
          row.samples.standard.push({ ...structuredClone(prior), reused_from: path.basename(argument("--reuse-standard")) });
          console.log(`${scenario.name} standard: reused validated baseline ${(prior.elapsed_ms / 1000).toFixed(1)}s tokens=${prior.tokens}`);
          persist(); continue;
        }
        assertRevision();
        const cwd = path.join(fixture, scenario.name, mode, String(run)); fs.mkdirSync(cwd, { recursive: true });
        for (const [name, content] of Object.entries(scenario.files)) fs.writeFileSync(path.join(cwd, name), content);
        const session = createWebSession(cwd, { provider: provider.name, model, intensity }, "auto", "standard", undefined, mode);
        sessions.push(session); session.start(); retryCount = 0; toolWait = 0; actualUsage = { prompt: 0, completion: 0, missing: 0, notDispatched: 0 };
        let pending = null, approvalWait = 0, blockedOnApproval = false, blockedApproval = null;
        const approvals = [];
        const order = { scenario: scenario.name, round: run + 1, mode, started_at_utc: new Date().toISOString(), status: "running" };
        report.execution_order.push(order); persist();
        const started = performance.now();
        session.liveSend(scenario.prompt + "\n" + (scenario.common || "Work only inside this temporary fixture. Preserve all task requirements and perform the required verification. Use node (not Python) for computations and tests. Do not access credentials or external services from tools."));
        const sampleRuntime = session.taskRuntime;
        if (sampleRuntime) sampledRuntimes.push(sampleRuntime);
        const turnFinished = awaitTurnFinish(sampleRuntime);
        while (session.liveMeta().busy) {
          if (interrupted) throw new Error("Live benchmark interrupted; remaining cases are untested");
          if (campaignUsage.stopped) { session.livePause(); break; }
          const approval = session.liveMeta().approval;
          if (approval) {
            if (!approvalDirectory) { blockedOnApproval = true; blockedApproval = structuredClone(approval); session.livePause(); break; }
            if (!pending) {
              const id = `${report.benchmark_id}-${scenario.name}-${mode}-${run}-${approvals.length}`;
              pending = { id, started: performance.now(), response: path.join(approvalDirectory, `${id}.response.json`) };
              fs.writeFileSync(path.join(approvalDirectory, `${id}.request.json`), JSON.stringify({ id, cwd, approval }, null, 2));
              console.log(`APPROVAL_REQUIRED ${id}`);
            }
            if (fs.existsSync(pending.response)) {
              const response = JSON.parse(fs.readFileSync(pending.response, "utf8"));
              if (typeof response.approved !== "boolean") throw new Error("Invalid benchmark approval response");
              const wait = performance.now() - pending.started; approvalWait += wait;
              approvals.push({ id: pending.id, approved: response.approved, wait_ms: wait });
              session.liveApprove(response.approved); pending = null;
            }
          }
          if (performance.now() - started > requestedTimeout + 60_000) { session.livePause(); break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const drainStarted = performance.now();
        await turnFinished;
        await sampleRuntime?.drain();
        const diagnosticDrainMs = performance.now() - drainStarted;
        if (interrupted) throw new Error("Live benchmark interrupted; remaining cases are untested");
        const elapsed = performance.now() - started, snapshot = session.liveSnapshot("benchmark");
        const canonical = value => value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
          : Array.isArray(value) ? value.map(canonical) : value;
        let correct = false;
        try {
          const actual = canonical(JSON.parse(fs.readFileSync(path.join(cwd, "answer.json"), "utf8")));
          correct = JSON.stringify(actual) === JSON.stringify(canonical(scenario.expected));
        } catch {}
        if (scenario.command) {
          correct &&= fs.readFileSync(path.join(cwd, scenario.command), "utf8") === scenario.files[scenario.command];
          correct &&= spawnSync(process.execPath, [scenario.command], { cwd, timeout: 10_000 }).status === 0;
        }
        if (scenario.minimumInspectors) {
          const inspectors = mode === "fast_dag"
            ? (snapshot.fast?.tasks.filter(task => !task.verifies && task.read_only).length ?? 0) +
              (session.taskRuntime?.evidence.filter(e => e.name === "delegate" && e.status === "completed").length ?? 0)
            : snapshot.task?.counts.agentRuns ?? 0;
          correct &&= inspectors >= scenario.minimumInspectors;
        }
        const sample = { round: run + 1, elapsed_ms: elapsed, approval_wait_ms: approvalWait, execution_ms: elapsed - approvalWait, approval_events: approvals,
          blocked_on_approval: blockedOnApproval, ...(blockedApproval ? { blocked_approval: JSON.parse(JSON.stringify(blockedApproval).replaceAll(model.api_key, "[redacted]")) } : {}), tokens: actualUsage.prompt + actualUsage.completion, input_tokens: actualUsage.prompt,
          output_tokens: actualUsage.completion, missing_usage_requests: actualUsage.missing, requests_blocked_before_dispatch: actualUsage.notDispatched, diagnostic_drain_ms: diagnosticDrainMs,
          tokens_per_second: (actualUsage.prompt + actualUsage.completion) * 1000 / elapsed,
          success: snapshot.task?.state === "completed" && (mode !== "fast_dag" || snapshot.fast?.phase === "completed"),
          fixture_correct: correct, retries: retryCount + (snapshot.fast?.metrics.retries ?? 0), tool_wait_ms: toolWait,
          scheduling_ms: snapshot.fast?.metrics.scheduling_ms ?? null, model_requests: snapshot.task?.counts.modelRequests ?? null,
          agent_runs: snapshot.task?.counts.agentRuns ?? null, tool_calls: snapshot.task?.counts.toolCalls ?? null,
          ...(session.taskRuntime?.diagnostics ? { trace_file: session.taskRuntime.diagnostics.file,
            trace_analysis: analyzeTimeline(fs.readFileSync(session.taskRuntime.diagnostics.file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))) } : {}),
          ...(snapshot.fast ? { fast_tasks: snapshot.fast.tasks.map(t => ({ task_id: t.task_id, kind: t.kind, verifies: t.verifies, dependencies: t.dependencies, read_only: t.read_only, exclusive: t.exclusive, write_paths: t.write_paths, acceptance_criteria: t.acceptance_criteria, output_contract: t.output_contract, status: t.status, error: t.error })),
            review: snapshot.fast.review, fast_metrics: structuredClone(snapshot.fast.metrics),
            ...(snapshot.fast.planning_errors?.length ? { fast_planning_errors: snapshot.fast.planning_errors.map(error => error.replaceAll(model.api_key, "[redacted]")) } : {}) } : {}),
          ...(snapshot.fast?.error ? { fast_error: snapshot.fast.error.replaceAll(model.api_key, "[redacted]") } : {}) };
        if (artifactDirectory) {
          const directory = path.join(artifactDirectory, report.benchmark_id, scenario.name, mode, String(run));
          fs.mkdirSync(directory, { recursive: true });
          const files = [];
          // Export only named fixture inputs/outputs, never the temporary model catalogue or session config.
          for (const name of [...new Set([...Object.keys(scenario.files), ...(scenario.outputs ?? ["answer.json"])])]) {
            const source = path.join(cwd, name);
            if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) continue;
            const content = fs.readFileSync(source);
            if (content.includes(Buffer.from(model.api_key))) throw new Error("Refusing to export a credential in a fixture artifact");
            const destination = path.join(directory, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, content);
            files.push({ name, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") });
          }
          const answer = [...snapshot.messages].reverse().find(message => message.role === "assistant")?.content ?? "";
          fs.writeFileSync(path.join(directory, "final-answer.md"), String(answer).replaceAll(model.api_key, "[redacted]") + "\n");
          const evidence = { original_cwd: cwd, root_run_id: sampleRuntime?.rootRunId,
            scopes: [...(sampleScopes.get(sampleRuntime)?.values() ?? [])], tools: sampleRuntime?.evidence ?? [] };
          const evidenceBody = JSON.stringify(evidence, null, 2).replaceAll(model.api_key, "[redacted]") + "\n";
          fs.writeFileSync(path.join(directory, "tool-evidence.json"), evidenceBody);
          sample.artifacts = { directory, files, final_answer: "final-answer.md", tool_evidence: "tool-evidence.json" };
          if (snapshot.fast) {
            const body = JSON.stringify({ engine_run_id: snapshot.fast.run_id, artifacts: snapshot.fast.artifacts }, null, 2).replaceAll(model.api_key, "[redacted]") + "\n";
            fs.writeFileSync(path.join(directory, "agent-artifacts.json"), body);
            sample.artifacts.agent_artifacts = "agent-artifacts.json";
          }
        }
        order.status = "finished"; order.success = sample.success;
        row.samples[mode].push(sample); session.dispose();
        console.log(`${scenario.name} [${run + 1}/${repetitions}] ${mode}: ${(elapsed / 1000).toFixed(1)}s tokens=${sample.tokens} success=${sample.success} fixture_correct=${correct}`);
        persist();
        if (campaignUsage.stopped) throw new TaskControlError("diagnostic_campaign_cap", "Diagnostic campaign cap stopped further execution");
        if (sample.tokens === 0 && !sample.success) throw new Error("Model unavailable: first real request produced no usage. Remaining live cases were not run.");
      }
    }
    const summarize = values => {
      const sorted = values.map(v => v.elapsed_ms).sort((a, b) => a - b), count = values.length;
      return { samples: count, mean_ms: sorted.reduce((a, b) => a + b, 0) / count,
        median_ms: count % 2 ? sorted[Math.floor(count / 2)] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2,
        p95_ms: count >= 20 ? sorted[Math.ceil(count * 0.95) - 1] : null,
        mean_tokens: values.reduce((sum, v) => sum + v.tokens, 0) / count,
        success_rate: values.filter(v => v.success).length / count,
        fixture_correct_rate: values.filter(v => v.fixture_correct).length / count,
        tokens_per_second: values.reduce((sum, v) => sum + v.tokens, 0) * 1000 / values.reduce((sum, v) => sum + v.elapsed_ms, 0) };
    };
    row.standard = summarize(row.samples.standard); row.fast_dag = summarize(row.samples.fast_dag);
    row.valid_successful_comparison = [...row.samples.standard, ...row.samples.fast_dag].every(s => s.success && s.fixture_correct && !s.blocked_on_approval);
    row.time_saved_fraction = row.valid_successful_comparison ? 1 - row.fast_dag.mean_ms / row.standard.mean_ms : null;
    row.token_change_fraction = row.fast_dag.mean_tokens / row.standard.mean_tokens - 1;
    row.throughput_change_fraction = row.fast_dag.tokens_per_second / row.standard.tokens_per_second - 1;
    persist();
  }
  report.state = "completed";
} catch (error) {
  report.state = "incomplete";
  report.untested.push(...cases.filter(c => report.requested_cases.includes(c.name) && !report.scenarios.some(s => s.name === c.name && s.standard && s.fast_dag)).map(c => c.name));
  // Report only controlled or filesystem error messages. Provider response text is not copied here.
  report.error = error.code || (String(error.message).startsWith("Model unavailable") ? error.message : "Live benchmark could not complete; inspect local configuration and connectivity.");
  if (report.connectivity?.http_status === 402) report.external_blocker = { code: "HTTP 402", reason: report.connectivity.error_kind || "provider_account_error" };
  process.exitCode = 1;
} finally {
  for (const session of sessions) session.dispose();
  await Promise.all(sampledRuntimes.map(async runtime => { await awaitTurnFinish(runtime); await runtime.drain(); }));
  if (originalStream && LLMClient) LLMClient.prototype.streamTurn = originalStream;
  if (originalTool && TaskRuntime) TaskRuntime.prototype.tool = originalTool;
  if (originalRequest && TaskRuntime) TaskRuntime.prototype.request = originalRequest;
  if (originalFinish && TaskRuntime) TaskRuntime.prototype.finish = originalFinish;
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  os.homedir = originalHomedir; fs.rmSync(fixture, { recursive: true, force: true }); persist();
  setGlobalDispatcher(originalDispatcher);
  for (const [key, value] of Object.entries(priorEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
