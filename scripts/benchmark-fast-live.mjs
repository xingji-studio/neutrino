// Actual end-to-end Standard vs Fast Agent Engine benchmark, using an explicitly chosen existing catalogue.
// Credentials are read in memory, never printed or included in the report. No user project files are modified.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createHash, randomUUID } from "node:crypto";
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import ts from "typescript";
const argument = name => { const at = process.argv.indexOf(name); return at >= 0 ? process.argv[at + 1] : undefined; };
const sourceHome = argument("--home") || os.homedir();
const repetitions = Number(argument("--runs") || 1);
const requestedTimeout = Number(argument("--timeout-ms") || 30 * 60_000);
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || !Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1) throw new Error("runs and timeout-ms must be positive integers");
const filter = argument("--cases")?.split(",");
const baseline = argument("--reuse-standard") ? JSON.parse(fs.readFileSync(path.resolve(argument("--reuse-standard")), "utf8")) : null;
const target = path.resolve(argument("--output") || "docs/fast-live-benchmark.json");
const approvalDirectory = argument("--approval-dir") ? path.resolve(argument("--approval-dir")) : null;
if (approvalDirectory) fs.mkdirSync(approvalDirectory, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-live-"));
const originalHomedir = os.homedir;
const priorEnvironment = { NEUTRINO_HOME: process.env.NEUTRINO_HOME, NEUTRINO_PLUGIN_HOME: process.env.NEUTRINO_PLUGIN_HOME };
const originalDispatcher = getGlobalDispatcher();
const proxy = process.env.NEUTRINO_BENCHMARK_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));
const report = { kind: "live_model_end_to_end", state: "running", repetitions, source: "existing selected model", model: null,
  note: "Identical model, intensity, fixture requirements and verification for both modes. Correctness uses exact fixture oracles; broader answer quality requires human review. One sample does not establish population P95.",
  scenarios: [], untested: ["Human-reviewed open-ended answer quality", "Provider cache billing (not exposed by current client)"] };
report.benchmark_id = randomUUID();
report.engine_sha256 = createHash("sha256").update(["engine", "scheduler", "worker", "pool", "artifacts", "types"]
  .map(name => fs.readFileSync(new URL(`../dist/fast/${name}.js`, import.meta.url), "utf8")).join("\n")).digest("hex");
let originalStream, originalTool, TaskRuntime, LLMClient, sessions = [];
let interrupted = false;
const stop = () => { interrupted = true; for (const session of sessions) session.livePause(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
const cases = [
  { name: "multi_source_retrieval", files: { "a.txt": "Alpha population: 12\n", "b.txt": "Beta population: 18\n", "c.txt": "Gamma population: 30\n" },
    prompt: "Read all three original sources a.txt, b.txt and c.txt. Cross-check each population and calculate their sum. Write answer.json with the numeric key total. Cite the three source paths in your final answer.", expected: { total: 60 } },
  { name: "multi_dimension_comparison", files: { "products.json": JSON.stringify([{ name: "A", cost: 10, latency: 7 }, { name: "B", cost: 13, latency: 4 }, { name: "C", cost: 9, latency: 8 }]) },
    prompt: "Compare every product in products.json by cost, latency, and score=cost+2*latency. Independently verify each score. Write answer.json containing scores (an object keyed by product name) and winner (the lowest-score product name).", expected: { scores: { A: 24, B: 21, C: 25 }, winner: "B" } },
  { name: "complex_logic", files: { "constraints.txt": "Integers a,b,c are positive, a<b<c, a+b+c=12, a*b=8. Find the unique solution.\n" },
    prompt: "Read constraints.txt. Derive the unique solution and verify uniqueness by enumerating all positive integer triples satisfying every constraint. Write answer.json with numeric keys a, b, c and solutions (the count of valid triples).", expected: { a: 2, b: 4, c: 6, solutions: 1 } },
  { name: "multi_module_code", files: { "package.json": "{\"type\":\"module\"}", "test.mjs": "import assert from 'node:assert/strict'; import {tax} from './tax.mjs'; import {shipping} from './shipping.mjs'; assert.equal(tax(100),20); assert.equal(shipping(2),7); assert.equal(tax(0),0); assert.equal(shipping(0),3); console.log('PASS');" },
    prompt: "Implement tax.mjs exporting tax(amount)=amount*0.2 and shipping.mjs exporting shipping(weight)=3+2*weight. Run node test.mjs and ensure all tests pass. Write answer.json with numeric keys tax100 and shipping2 from the implemented functions. Keep the two modules independent.", expected: { tax100: 20, shipping2: 7 }, command: "test.mjs" },
  { name: "multi_agent_collaboration", files: { "east.txt": "East: 3, 5, 7\n", "west.txt": "West: 2, 4, 6\n" },
    prompt: "Use at least two independent sub-agents or scheduled Agent workers to inspect east.txt and west.txt separately. Verify the reports against both original files, integrate them, and write answer.json containing east and west (their sums) and combined (the overall sum).", expected: { east: 15, west: 12, combined: 27 } },
  { name: "long_tool_sequence", files: { "input.json": "[1,2,3,4,5]" },
    prompt: "Read input.json, write doubled.json containing the doubled values, read that saved file and write evens.json with values greater than 5, then read evens.json and write answer.json with values (that saved array) and sum. Verify every saved intermediate file and the final sum.", expected: { values: [6, 8, 10], sum: 24 } },
  { name: "iterative_correction", files: { "package.json": "{\"type\":\"module\"}", "math.mjs": "export const sum = xs => xs.reduce((a,b)=>a-b,0); export const mean = xs => sum(xs)/(xs.length+1);", "test.mjs": "import assert from 'node:assert/strict'; import {sum,mean} from './math.mjs'; assert.equal(sum([2,4,6]),12); assert.equal(mean([2,4,6]),4); assert.equal(sum([]),0); console.log('PASS');" },
    prompt: "Run node test.mjs to observe the real initial failure. Diagnose and fix all math.mjs bugs without modifying tests. Rerun the tests until every assertion passes. Write answer.json with sum and mean for [2,4,6] from the implemented functions.", expected: { sum: 12, mean: 4 }, command: "test.mjs" },
  { name: "strong_sequential_dependencies", files: { "seed.txt": "3" },
    prompt: "Execute this strict file pipeline in order: read seed.txt, add 2 and write stage1.txt; read stage1.txt, square its value and write stage2.txt; read stage2.txt, subtract 4 and write stage3.txt; read and verify every stage, then write answer.json containing the numeric keys stage1, stage2 and stage3 from the saved files. Never calculate a downstream stage before its required file exists.", expected: { stage1: 5, stage2: 25, stage3: 21 } },
];
const regions = ["north", "south", "east", "west"];
const parallelData = Object.fromEntries(regions.map((region, index) => [region,
  Array.from({ length: 10 }, (_, row) => ({ id: row + 1, units: ((index + 3) * (row + 1)) % 17 + 1, weight: row % 3 + 1 }))]));
const expectedRegions = Object.fromEntries(regions.map(region => [region, { count: parallelData[region].length,
  units: parallelData[region].reduce((sum, row) => sum + row.units, 0),
  weighted: parallelData[region].reduce((sum, row) => sum + row.units * row.weight, 0) }]));
cases.push({ name: "parallel_analysis", minimumInspectors: 4,
  files: Object.fromEntries(regions.map(region => [`${region}.json`, JSON.stringify(parallelData[region])])),
  prompt: "Use at least four independent read-only Agent inspectors, one for each of north.json, south.json, east.json and west.json. Each inspector must read only its own source using read_file/list_files (no shell or edits), report its count, sum of units, and sum of units*weight with original evidence. Inspectors may reason about these values; the coordinator must independently recompute ALL four original datasets with Node and verify the inspectors' results before integration. Write answer.json with regions (an object keyed by north/south/east/west; each entry has count, units, weighted), grand_units, and grand_weighted. Do not build a reusable framework or test unrelated inputs; verify all requested values and source completeness.",
  common: "Work only inside this fixture. Read-only inspectors must preserve their restricted scope; the coordinator must use Node for deterministic global verification and output. Preserve all original requirements. Do not access credentials or external services from tools.",
  expected: { regions: expectedRegions, grand_units: regions.reduce((sum, name) => sum + expectedRegions[name].units, 0),
    grand_weighted: regions.reduce((sum, name) => sum + expectedRegions[name].weighted, 0) } });
const persist = () => { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(report, null, 2) + "\n"); };
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
  ({ TaskRuntime } = await import("../dist/llm/runtime.js"));
  const { createWebSession } = await import("../dist/web/session.js");
  const { spawnSync } = await import("node:child_process");
  config.saveModels({ providers: [{ name: provider.name, models: [model] }] });
  const intensity = config.intensityForModel(model, sourceConfig.selected_intensity, sourceConfig.default_intensity);
  config.saveConfig({ ...config.DEFAULT_CONFIG, selected_provider: provider.name, selected_model: model.name, selected_intensity: intensity,
    default_intensity: intensity, plan_first: true, task_budget_scope: "task", task_timeout_ms: requestedTimeout,
    model_context_windows: sourceConfig.model_context_windows ?? {}, fast_mode_enabled: true });
  report.model = { provider: provider.name, name: model.name, intensity, available_inference_slots: 4 };
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
  const connectivityStarted = performance.now();
  const probe = new LLMClient(model, provider.name, intensity);
  const probeSignal = AbortSignal.timeout(30_000);
  for await (const ignored of probe.streamTurn([{ role: "user", content: "Reply OK to confirm this configured model is reachable." }], [], {
    signal: probeSignal, retry: { attempts: 1 }, maxOutputTokens: 16384,
  })) { /* Connectivity output is intentionally not copied into the benchmark. */ }
  report.connectivity = { elapsed_ms: performance.now() - connectivityStarted, status: probe.outcome?.status ?? "unknown",
    input_tokens: probe.usage?.prompt ?? null, output_tokens: probe.usage?.completion ?? null };
  if (probe.outcome?.status !== "completed" || !probe.usage) throw new Error("Model unavailable: configured API did not return a successful response and usage within the connectivity check. All live cases remain untested.");
  let retryCount = 0, toolWait = 0, actualUsage = { prompt: 0, completion: 0, missing: 0 };
  originalTool = TaskRuntime.prototype.tool;
  TaskRuntime.prototype.tool = async function (name, args, callback) {
    const start = performance.now();
    try { return await originalTool.call(this, name, args, callback); }
    finally { if (!["delegate", "call_pro_agent"].includes(name)) toolWait += performance.now() - start; }
  };
  originalStream = LLMClient.prototype.streamTurn;
  LLMClient.prototype.streamTurn = async function* (messages, tools, options = {}) {
    try { yield* originalStream.call(this, messages, tools, { ...options, onRetry: notice => { retryCount++; options.onRetry?.(notice); } }); }
    finally {
      if (this.usage) { actualUsage.prompt += this.usage.prompt; actualUsage.completion += this.usage.completion; }
      else actualUsage.missing++;
    }
  };
  for (const scenario of cases.filter(c => !filter || filter.includes(c.name))) {
    const row = { name: scenario.name, samples: { standard: [], fast_dag: [] } }; report.scenarios.push(row);
    for (let run = 0; run < repetitions; run++) {
      for (const mode of run % 2 ? ["fast_dag", "standard"] : ["standard", "fast_dag"]) {
        const prior = mode === "standard" ? baseline?.scenarios.find(row => row.name === scenario.name)?.samples.standard[run] : null;
        if (prior?.success && prior.fixture_correct && prior.elapsed_ms < baseline.conditions.task_timeout_ms) {
          row.samples.standard.push({ ...structuredClone(prior), reused_from: path.basename(argument("--reuse-standard")) });
          console.log(`${scenario.name} standard: reused validated baseline ${(prior.elapsed_ms / 1000).toFixed(1)}s tokens=${prior.tokens}`);
          persist(); continue;
        }
        const cwd = path.join(fixture, scenario.name, mode, String(run)); fs.mkdirSync(cwd, { recursive: true });
        for (const [name, content] of Object.entries(scenario.files)) fs.writeFileSync(path.join(cwd, name), content);
        const session = createWebSession(cwd, { provider: provider.name, model, intensity }, "auto", "standard", undefined, mode);
        sessions.push(session); session.start(); retryCount = 0; toolWait = 0; actualUsage = { prompt: 0, completion: 0, missing: 0 };
        let pending = null, approvalWait = 0, blockedOnApproval = false;
        const approvals = [];
        const started = performance.now();
        session.liveSend(scenario.prompt + "\n" + (scenario.common || "Work only inside this temporary fixture. Preserve all task requirements and perform the required verification. Use node (not Python) for computations and tests. Do not access credentials or external services from tools."));
        while (session.liveMeta().busy) {
          if (interrupted) throw new Error("Live benchmark interrupted; remaining cases are untested");
          const approval = session.liveMeta().approval;
          if (approval) {
            if (!approvalDirectory) { blockedOnApproval = true; session.livePause(); break; }
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
        await session.taskRuntime?.drain();
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
            ? (snapshot.fast?.tasks.filter(task => task.kind === "work" && task.read_only).length ?? 0) +
              (session.taskRuntime?.evidence.filter(e => e.name === "delegate" && e.status === "completed").length ?? 0)
            : snapshot.task?.counts.agentRuns ?? 0;
          correct &&= inspectors >= scenario.minimumInspectors;
        }
        const sample = { elapsed_ms: elapsed, approval_wait_ms: approvalWait, execution_ms: elapsed - approvalWait, approval_events: approvals,
          blocked_on_approval: blockedOnApproval, tokens: actualUsage.prompt + actualUsage.completion, input_tokens: actualUsage.prompt,
          output_tokens: actualUsage.completion, missing_usage_requests: actualUsage.missing,
          tokens_per_second: (actualUsage.prompt + actualUsage.completion) * 1000 / elapsed,
          success: snapshot.task?.state === "completed" && (mode !== "fast_dag" || snapshot.fast?.phase === "completed"),
          fixture_correct: correct, retries: retryCount + (snapshot.fast?.metrics.retries ?? 0), tool_wait_ms: toolWait,
          scheduling_ms: snapshot.fast?.metrics.scheduling_ms ?? null, model_requests: snapshot.task?.counts.modelRequests ?? null,
          agent_runs: snapshot.task?.counts.agentRuns ?? null, tool_calls: snapshot.task?.counts.toolCalls ?? null,
          ...(snapshot.fast ? { fast_tasks: snapshot.fast.tasks.map(t => ({ task_id: t.task_id, status: t.status, error: t.error })),
            review: snapshot.fast.review, fast_metrics: structuredClone(snapshot.fast.metrics) } : {}),
          ...(snapshot.fast?.error ? { fast_error: snapshot.fast.error.replaceAll(model.api_key, "[redacted]") } : {}) };
        row.samples[mode].push(sample); session.dispose();
        console.log(`${scenario.name} ${mode}: ${(elapsed / 1000).toFixed(1)}s tokens=${sample.tokens} success=${sample.success} fixture_correct=${correct}`);
        persist();
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
  report.untested.push(...cases.filter(c => !report.scenarios.some(s => s.name === c.name && s.standard && s.fast_dag)).map(c => c.name));
  // Report only controlled or filesystem error messages. Provider response text is not copied here.
  report.error = error.code || (String(error.message).startsWith("Model unavailable") ? error.message : "Live benchmark could not complete; inspect local configuration and connectivity.");
  process.exitCode = 1;
} finally {
  if (originalStream && LLMClient) LLMClient.prototype.streamTurn = originalStream;
  if (originalTool && TaskRuntime) TaskRuntime.prototype.tool = originalTool;
  await Promise.all(sessions.map(async session => { session.dispose(); await session.taskRuntime?.drain(); }));
  process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
  os.homedir = originalHomedir; fs.rmSync(fixture, { recursive: true, force: true }); persist();
  setGlobalDispatcher(originalDispatcher);
  for (const [key, value] of Object.entries(priorEnvironment)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}
