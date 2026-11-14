// Run the production WebSession inside an official benchmark task container.
// The host adapter supplies credentials outside the task workspace. Never archive that input.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const input = JSON.parse(fs.readFileSync("/opt/neutrino/runtime-input.json", "utf8"));
const { model, provider, intensity, agent_mode: mode, token_cap: cap, timeout_ms: timeout } = input;
if (provider !== "DeepSeek" || model.name !== "deepseek-flash" || intensity !== "Max") throw new Error("Benchmark model mismatch");
if (!["standard", "fast_dag"].includes(mode) || !Number.isSafeInteger(cap) || cap < 1) throw new Error("Invalid benchmark limits");
const directory = "/logs/agent";
const home = "/tmp/neutrino-official-home";
fs.mkdirSync(directory, { recursive: true });
os.homedir = () => home;
process.env.NEUTRINO_HOME = path.join(home, ".neutrino");
process.env.NEUTRINO_PLUGIN_HOME = path.join(home, "plugins");
process.env.NEUTRINO_DIAGNOSTICS_DIR = path.join(directory, "traces");
const config = await import("../dist/config.js");
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { LLMClient } = await import("../dist/llm/client.js");
const { createWebSession } = await import("../dist/web/session.js");
config.saveModels({ providers: [{ name: provider, models: [model] }] });
config.saveConfig({ ...config.DEFAULT_CONFIG, selected_provider: provider, selected_model: model.name,
  selected_intensity: intensity, default_intensity: intensity, plan_first: true, fast_mode_enabled: true,
  task_budget_scope: "task", task_timeout_ms: timeout, task_max_tokens: cap,
  task_max_requests: 500, task_max_tools: 2000, subagent_max_rounds: 500,
  model_context_windows: input.model_context_windows ?? {} });

const redact = value => JSON.stringify(value, null, 2).replaceAll(model.api_key, "[redacted]");
const write = (name, value) => fs.writeFileSync(path.join(directory, name), redact(value) + "\n");
const usage = { input_tokens: 0, output_tokens: 0, missing_usage_turns: 0, retries: 0 };
const providerBudget = () => {
  try { return JSON.parse(fs.readFileSync(path.join(directory, "provider-usage.json"), "utf8")); }
  catch { return null; }
};
const originalStream = LLMClient.prototype.streamTurn;
LLMClient.prototype.streamTurn = async function* (messages, tools, options = {}) {
  try { yield* originalStream.call(this, messages, tools, { ...options,
    onRetry: notice => { usage.retries++; options.onRetry?.(notice); } }); }
  finally {
    if (this.usage) { usage.input_tokens += this.usage.prompt; usage.output_tokens += this.usage.completion; }
    else if (this.outcome?.error?.code !== "diagnostic_campaign_cap") usage.missing_usage_turns++;
    write("neutrino-usage.json", usage);
  }
};
let finished;
const completion = new Promise(resolve => { finished = resolve; });
const originalFinish = TaskRuntime.prototype.finish;
TaskRuntime.prototype.finish = function (status) {
  const result = originalFinish.call(this, status); finished(); return result;
};
const revisionFiles = ["dist/fast/engine.js", "dist/fast/planner.js", "dist/fast/worker.js",
  "dist/fast/scheduler.js", "dist/fast/evidence.js", "dist/fast/context.js", "dist/llm/client.js",
  "dist/llm/runtime.js", "dist/llm/tools.js", "dist/llm/approval.js", "dist/web/session.js",
  "assets/prompt.txt", "assets/planner.txt", "assets/fast-planner.txt", "assets/fast-replanner.txt", "assets/subagent.txt"];
const revisions = Object.fromEntries(revisionFiles.map(file => [file,
  createHash("sha256").update(fs.readFileSync(new URL(`../${file}`, import.meta.url))).digest("hex")]));
const conditions = { provider, model: model.name, intensity, agent_mode: mode, token_cap: cap,
  timeout_ms: timeout, task_limits: { agents: config.DEFAULT_CONFIG.task_max_agents,
    requests: 500, tools: 2000, subagent_rounds: 500,
    tokens: cap }, revision_sha256: revisions, actual_api_effort: "max", output_ceiling: 16384 };
write("neutrino-conditions.json", conditions);
if (process.argv.includes("--dry-run")) { console.log("Neutrino production runtime/configuration loaded; no model request dispatched."); process.exit(0); }

const session = createWebSession(process.cwd(), { provider, model, intensity }, "auto", "standard", undefined, mode);
const interrupted = () => session.livePause();
process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
const approvals = [];
let pending = null, approvalWait = 0, error = null;
const started = performance.now();
try {
  session.start();
  // Preserve the official instruction verbatim, including commit and artifact requirements.
  session.liveSend(fs.readFileSync("/opt/neutrino/instruction.txt", "utf8"));
  while (session.liveMeta().busy) {
    if (providerBudget()?.stopped || performance.now() - started > timeout) { session.livePause(); break; }
    const approval = session.liveMeta().approval;
    if (approval && (!pending || pending.id !== approval.id)) {
      pending = { id: approval.id, started: performance.now() };
      write(`approval-${approval.id}.request.json`, approval);
    }
    if (pending) {
      const response = path.join(directory, `approval-${pending.id}.response.json`);
      if (fs.existsSync(response)) {
        const decision = JSON.parse(fs.readFileSync(response, "utf8"));
        if (typeof decision.approved !== "boolean") throw new Error("Invalid benchmark approval decision");
        const waited = performance.now() - pending.started; approvalWait += waited;
        approvals.push({ id: pending.id, approved: decision.approved, wait_ms: waited });
        session.liveApprove(decision.approved, pending.id); pending = null;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (session.taskRuntime) { await completion; await session.taskRuntime.drain(); }
} catch (caught) { error = caught.code || caught.message; session.livePause(); }
finally {
  const elapsed = performance.now() - started;
  const snapshot = session.liveMeta();
  const observed = providerBudget();
  write("neutrino-result.json", { ...conditions, ...usage, tokens: usage.input_tokens + usage.output_tokens,
    protected_tokens: observed?.spent_protected ?? snapshot.task?.counts.tokens ?? 0, held_tokens: observed?.held_tokens ?? null,
    elapsed_ms: elapsed, approval_wait_ms: approvalWait, execution_ms: elapsed - approvalWait,
    approvals, pending_approval: pending?.id ?? null, cap_reached: Boolean(observed?.stopped || snapshot.task?.budgetStop), error,
    usage_complete: observed?.held_tokens === 0 && observed?.unknown_requests === 0,
    task: snapshot.task, fast: snapshot.fast });
  write("neutrino-messages.json", session.messages);
  session.dispose();
  process.removeListener("SIGINT", interrupted); process.removeListener("SIGTERM", interrupted);
  // Runtime catalogues contain secrets; benchmark logs contain only redacted evidence.
  fs.rmSync(home, { recursive: true, force: true });
}
console.log("Neutrino task stopped. Official verifier determines correctness; inspect neutrino-result.json for usage and limits.");
