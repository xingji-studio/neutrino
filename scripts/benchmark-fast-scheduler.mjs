// Measures scheduling only. No model is called and no synthetic token counts are reported.
import fs from "node:fs";
import { fastDataOutput } from "./fast-data-paths.mjs";
import { performance } from "node:perf_hooks";
import { DynamicScheduler, FastTaskError } from "../dist/fast/scheduler.js";
import { ArtifactStore } from "../dist/fast/artifacts.js";
import { fastSettings } from "../dist/fast/types.js";
const scenarios = [
  { name: "multi_source_retrieval", dependencies: [[], [], [], []] },
  { name: "multi_dimension_comparison", dependencies: [[], [], [], [], ["t0", "t1", "t2", "t3"]] },
  { name: "complex_logic", dependencies: [[], [], ["t0"], ["t1"], ["t2", "t3"]] },
  { name: "multi_module_code", dependencies: [[], [], [], [], ["t0", "t1", "t2", "t3"]] },
  { name: "multi_agent_collaboration", dependencies: [[], [], [], [], ["t0", "t1"], ["t2", "t3"]] },
  { name: "long_tool_sequence", dependencies: [[], ["t0"], [], ["t2"], [], ["t4"]] },
  { name: "iterative_correction", dependencies: [[], [], [], [], ["t0", "t1", "t2", "t3"]], retry: true },
  { name: "strong_sequential_dependencies", dependencies: [[], ["t0"], ["t1"], ["t2"], ["t3"]] },
];
const sampleAt = process.argv.indexOf("--samples");
const samples = Number((sampleAt >= 0 ? process.argv[sampleAt + 1] : process.argv[2]?.startsWith("--") ? undefined : process.argv[2]) || 7);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("samples must be a positive integer");
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)];
async function run(scenario, concurrency) {
  const started = performance.now(); let toolWait = 0, completed = 0;
  const dag = new DynamicScheduler(new ArtifactStore(), { ...fastSettings({}), workerSlots: concurrency, retries: 1 }, {
    cwd: process.cwd(), execute: async task => {
      const start = performance.now();
      await new Promise(resolve => setTimeout(resolve, task.kind === "work" ? 24 : 8));
      toolWait += performance.now() - start;
      if (scenario.retry && task.task_id === "t0" && task.attempts === 1) throw new FastTaskError("Controlled transient failure");
      completed++;
      return { result: task.task_id, conclusions: [], evidence: ["controlled fixture"], assumptions: [], unresolved: [],
        side_effects: false, verification_passed: true };
    },
  });
  await dag.run(async scheduler => {
    for (const [i, dependencies] of scenario.dependencies.entries()) scheduler.add({
      task_id: `t${i}`, task_goal: `Controlled ${scenario.name} task ${i}`, dependencies, required_context: [], input_versions: {},
      acceptance_criteria: ["Produce the fixture result"], output_contract: "Fixture output", priority: 0, estimated_duration: 24,
      read_only: true, write_paths: [], exclusive: false,
    });
  });
  return { elapsed_ms: performance.now() - started, tool_wait_ms: toolWait, scheduling_ms: dag.schedulingMs,
    retries: dag.retries, success: dag.successful, correct: completed === scenario.dependencies.length * 2,
    tokens: null, tokens_per_second: null };
}
const report = { kind: "controlled_scheduler_only", samples_per_mode: samples, model: null,
  note: "Real elapsed time of deterministic asynchronous fixtures. This is NOT a Standard vs Fast model benchmark; token usage and model quality are untested here.", scenarios: [] };
for (const scenario of scenarios) {
  const modes = { serial: [], concurrent: [] };
  for (let i = 0; i < samples; i++) {
    const order = i % 2 ? [["concurrent", 4], ["serial", 1]] : [["serial", 1], ["concurrent", 4]];
    for (const [name, slots] of order) modes[name].push(await run(scenario, slots));
  }
  const summary = values => ({ mean_ms: values.reduce((sum, value) => sum + value.elapsed_ms, 0) / values.length,
    median_ms: quantile(values.map(v => v.elapsed_ms), 0.5), p95_ms: quantile(values.map(v => v.elapsed_ms), 0.95),
    success_rate: values.filter(v => v.success).length / values.length,
    fixture_correct_rate: values.filter(v => v.correct).length / values.length,
    mean_tool_wait_ms: values.reduce((sum, value) => sum + value.tool_wait_ms, 0) / values.length,
    mean_scheduling_ms: values.reduce((sum, value) => sum + value.scheduling_ms, 0) / values.length,
    retries: values.reduce((sum, value) => sum + value.retries, 0), tokens: null, tokens_per_second: null });
  const serial = summary(modes.serial), concurrent = summary(modes.concurrent);
  report.scenarios.push({ name: scenario.name, serial, concurrent, time_saved_fraction: 1 - concurrent.mean_ms / serial.mean_ms, samples: modes });
  console.log(`${scenario.name}: serial=${serial.mean_ms.toFixed(1)}ms concurrent=${concurrent.mean_ms.toFixed(1)}ms saved=${((1 - concurrent.mean_ms / serial.mean_ms) * 100).toFixed(1)}% (scheduler fixture only)`);
}
fs.writeFileSync(fastDataOutput("fast-scheduling-benchmark.json"), JSON.stringify(report, null, 2) + "\n");
