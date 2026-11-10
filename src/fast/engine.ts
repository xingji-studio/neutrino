import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { LLMClient, type StreamOptions, type UsageInfo } from "../llm/client.js";
import { loadConfig } from "../config.js";
import { currentTask, linkSignals, TaskControlError, type TaskRuntime } from "../llm/runtime.js";
import { outputAllowance, prepareContext } from "../llm/context.js";
import { runSubAgent, buildSubAgentTask } from "../llm/subagent.js";
import { DELEGATE_TOOL, getToolDefinitions, type ToolDefinition } from "../llm/tools.js";
import { parsePromptDirectives, type ApprovalDecision } from "../llm/approval.js";
import { assessToolCall } from "../llm/risk.js";
import { diagnosticHash } from "../llm/diagnostics.js";
import { ArtifactStore } from "./artifacts.js";
import { ResourcePool } from "./pool.js";
import { runFastWorker } from "./worker.js";
import { expandPlannerTask, expandPlannerGroup, expandSingleRequest } from "./planner.js";
import { TaskEvidenceView, EVIDENCE_TOOL, READ_TASK_EVIDENCE, artifactBrief, verificationBrief } from "./evidence.js";
import { DynamicScheduler, FastTaskError, withinLease } from "./scheduler.js";
import { FAST_MODE, type FastArtifact, type FastSettings, type FastTask, type FastOutput, type FastSnapshot, type FastUsage } from "./types.js";

type Messages = Parameters<LLMClient["streamTurn"]>[0];
const emptyUsage = (): FastUsage => ({ prompt: 0, completion: 0, requests: 0 });
const outputInstructions = `Conclude with finish_task, a factual report and explicit unresolved requirements.
Cite actual evidence IDs; the ledger retains raw records. Do not repeat command bodies or whole source files
unless the task's output contract requires them. Never invent test results or citations.`;
export const FAST_FINISH_REVIEW = "finish_fast_review";
const FINISH_REVIEW_TOOL: ToolDefinition = { type: "function", function: {
  name: FAST_FINISH_REVIEW,
  description: "Conclude the mandatory global review. Completed requires every current verified planned artifact (including independent checks) cited as artifact:task_id@version, no unresolved issues, and all actual necessary checks passed. Use partial if unfinished.",
  parameters: { type: "object", properties: {
    status: { type: "string", enum: ["completed", "partial", "blocked"] },
    report: { type: "string" }, evidence_ids: { type: "array", items: { type: "string" } },
    unresolved: { type: "array", items: { type: "string" } },
  }, required: ["status", "report", "evidence_ids", "unresolved"] },
} };

export interface FastEngineOptions {
  runtime: TaskRuntime;
  settings: FastSettings;
  signal: AbortSignal;
  cwd: string;
  history: Messages;
  system: string;
  subagentSystem: string;
  contextWindow: number;
  maxRounds: number;
  directory?: string;
  /** The session's unchanged model/provider/reasoning configuration, fresh for every request. */
  createClient(): LLMClient;
  approve(name: string, args: Record<string, unknown>, signal: AbortSignal, wrapReviewer?: (client: LLMClient) => LLMClient): Promise<ApprovalDecision>;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  onUsage?(usage: UsageInfo): void;
  onSnapshot?(snapshot: FastSnapshot): void;
  onText?(text: string): void;
  onTool?(name: string, args: Record<string, unknown>, result: string): void;
}

/** Separate engine; no changes to Standard's planner or agent loop. */
export class FastAgentEngine {
  readonly runId = randomUUID();
  readonly models: ResourcePool;
  readonly tools: ResourcePool;
  readonly background: ResourcePool;
  readonly store: ArtifactStore;
  readonly scheduler: DynamicScheduler;
  private phase: FastSnapshot["phase"] = "planning";
  private error?: string;
  private started = performance.now();
  private integrated = new Map<string, number>();
  private integrations = new Set<Promise<void>>();
  private integrationError?: Error;
  private modelBlocker?: Error;
  private constraints: string[] = [];
  private goal = "";
  private approvalPool: ResourcePool;
  private diagnosticPhase?: string;
  private toolWaitMs = 0;
  private replans = 0;
  private planningErrors: string[] = [];
  private reviewLog: NonNullable<FastSnapshot["review"]> = [];
  private metrics: FastSnapshot["metrics"] = {
    started_at: new Date().toISOString(), elapsed_ms: 0, planning: emptyUsage(), workers: Object.create(null),
    verification: emptyUsage(), integration: emptyUsage(), total: emptyUsage(), retries: 0, replans: 0,
    tool_wait_ms: 0, scheduling_ms: 0, context_cache_hits: 0, provider_cached_tokens: null, tokens_per_second: 0,
  };
  constructor(private options: FastEngineOptions) {
    if (!options.settings.enabled) throw new Error("Fast Mode is disabled. Select Standard mode explicitly to continue.");
    this.models = new ResourcePool(options.settings.modelSlots, options.runtime.diagnostics, "model");
    this.tools = new ResourcePool(options.settings.toolSlots, options.runtime.diagnostics, "tool");
    this.background = new ResourcePool(options.settings.backgroundSlots, options.runtime.diagnostics, "background");
    this.approvalPool = new ResourcePool(1, options.runtime.diagnostics, "approval");
    this.store = new ArtifactStore(options.directory ? path.join(options.directory, this.runId) : undefined, options.runtime.diagnostics);
    options.runtime.diagnostics?.emit("engine_start", { engine_run_id: this.runId });
    this.store.context("request", options.runtime.instructions());
    this.store.context("history", JSON.stringify(options.history));
    this.scheduler = new DynamicScheduler(this.store, options.settings, {
      signal: options.signal, cwd: options.cwd, diagnostics: options.runtime.diagnostics,
      execute: (task, signal) => this.worker(task, signal),
      onChange: () => this.publish(),
      onVerified: task => {
        const operation = this.background.run(async () => {
          // Merge references, not guessed model summaries. New plans and final review see this ledger.
          const artifact = this.store.latest(task.task_id);
          if (artifact?.verification === "verified") this.integrated.set(task.task_id, artifact.version);
        }, options.signal).catch(error => {
          this.integrationError = error instanceof Error ? error : new Error(String(error));
        }).finally(() => { this.integrations.delete(operation); this.publish(); });
        this.integrations.add(operation);
      },
    });
  }

  snapshot(): FastSnapshot {
    const elapsed = performance.now() - this.started;
    return { run_id: this.runId, actual_mode: FAST_MODE, phase: this.phase,
      tasks: this.scheduler?.snapshot() ?? [], artifacts: this.store.all(),
      resources: { model: this.models.limit, tools: this.tools.limit, background: this.background.limit },
      integrated: Object.fromEntries([...this.integrated].filter(([id, version]) => {
        const artifact = this.store.latest(id); return artifact?.verification === "verified" && artifact.version === version;
      })),
      review: structuredClone(this.reviewLog),
      ...(this.planningErrors.length ? { planning_errors: [...this.planningErrors] } : {}),
      metrics: { ...structuredClone(this.metrics), elapsed_ms: elapsed, retries: this.scheduler?.retries ?? 0,
        replans: this.replans, tool_wait_ms: this.toolWaitMs, scheduling_ms: this.scheduler?.schedulingMs ?? 0,
        context_cache_hits: this.store.cacheHits,
        tokens_per_second: elapsed > 0 ? (this.metrics.total.prompt + this.metrics.total.completion) * 1000 / elapsed : 0 },
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async run(): Promise<{ report: string; status: "completed" | "partial" | "failed" | "cancelled"; snapshot: FastSnapshot }> {
    const releaseWorkflow = this.options.runtime.activity();
    let report = "";
    let status: "completed" | "partial" | "failed" | "cancelled" = "failed";
    try {
      for (let attempt = 0; ; attempt++) {
        try { await this.scheduler.run(() => this.plan(attempt > 0)); }
        catch (error) {
          this.planningErrors.push(error instanceof Error ? error.message : String(error));
          if (this.modelBlocker) throw this.modelBlocker;
          if (this.options.signal.aborted || attempt >= this.options.settings.replans) throw error;
          this.error = `Planning failed: ${error instanceof Error ? error.message : String(error)}. Replanning from preserved state.`;
          this.replans++;
          this.options.runtime.diagnostics?.emit("replan_requested", { attempt: attempt + 1, reason_code: "planning_failed" });
          continue;
        }
        if (this.modelBlocker) throw this.modelBlocker;
        if (this.options.signal.aborted) throw new Error(String(this.options.signal.reason));
        if (this.scheduler.successful || attempt >= this.options.settings.replans) break;
        this.replans++;
        this.options.runtime.diagnostics?.emit("replan_requested", { attempt: attempt + 1, reason_code: "unresolved_tasks" });
      }
      await Promise.all([...this.integrations]);
      if (this.integrationError) throw this.integrationError;
      this.phase = "integrating"; this.publish();
      const final = await this.review();
      report = final.report;
      status = this.scheduler.successful && final.status === "completed" ? "completed" : "partial";
      if (status === "completed") this.error = undefined;
      if (status !== "completed") this.error = "Some tasks or final checks remain unresolved. Valid artifacts are preserved; select Standard mode explicitly to change engines.";
      this.phase = status === "completed" ? "completed" : "failed";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      status = this.options.signal.aborted ? "cancelled" : this.store.all().some(a => a.verification === "verified") ? "partial" : "failed";
      this.phase = status === "cancelled" ? "cancelled" : "failed";
      report = `[Fast Mode ${status}: ${this.error}]\nValid results are preserved. Select Standard mode explicitly to change engines.`;
    } finally {
      try { await Promise.all([...this.integrations]); this.publish(); }
      finally { releaseWorkflow(); }
    }
    return { report, status, snapshot: this.snapshot() };
  }

  /** JSONL lines are admitted during streaming, before the planner request completes. */
  private async plan(replan: boolean): Promise<void> {
    this.phase = "planning"; this.publish();
    const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets");
    const plannerPrompt = fs.readFileSync(path.join(assets, "fast-planner.txt"), "utf8") +
      (replan ? `\n${fs.readFileSync(path.join(assets, "fast-replanner.txt"), "utf8")}` : "");
    const runtimeState = this.options.runtime.snapshot();
    const outstandingRuns = this.scheduler.snapshot().filter(task => task.status !== "COMPLETED").length;
    const remaining = Math.max(0, this.options.runtime.limits.agentRuns - runtimeState.counts.agentRuns - outstandingRuns - 2);
    const maximumNewTasks = Math.min(this.options.settings.maxTasks - this.scheduler.plannedTaskCount, Math.floor(remaining / 2));
    const history = this.historyForPrompt();
    const messages: Messages = [{ role: "system", content: `${plannerPrompt}\n\n${this.options.runtime.instructions()}` },
      ...history,
      { role: "user", content: replan ? `Replan from actual state. Reuse verified tasks; repair failures without repeating side effects. Maximum new planned tasks: ${maximumNewTasks}, after reserving ${outstandingRuns} existing unfinished task runs and the final review. Shared limits and current usage: ${JSON.stringify({ limits: runtimeState.limits, counts: runtimeState.counts })}.\n${JSON.stringify(this.snapshot())}`
        : `Plan the full user request. Working directory: ${this.options.cwd}. Maximum new planned tasks: ${maximumNewTasks} (work requires two agent runs including its mandatory verifier; verification requires one). Shared limits and current usage: ${JSON.stringify({ limits: runtimeState.limits, counts: runtimeState.counts, budget_scope: runtimeState.budgetScope })}.` }];
    const client = this.client("planning");
    await prepareContext({ messages, tools: [], capacity: this.options.contextWindow,
      createClient: () => this.client("planning"), stream: { signal: this.options.signal }, preserveBrief: true });
    // Recovery inherits the already published immutable original brief and global constraints.
    // A new header may add constraints only before any recovery operation is admitted.
    let buffer = "", header = replan && Boolean(this.goal), declared = false, admitted = false, done = false;
    const admit = (line: string) => {
      if (!line.trim()) return;
      if (done) throw new Error("Planner emitted operations after done");
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid planner operation");
      const operation = parsed as Record<string, unknown>;
      if (operation.type === "single") {
        if (header || replan || this.scheduler.plannedTaskCount) throw new Error("Single plan requires a new run with no existing tasks");
        const definition = expandSingleRequest(operation, { request: this.options.runtime.originalRequest,
          earlierRequests: this.options.runtime.priorUserRequests });
        this.scheduler.add(definition);
        this.goal = this.options.runtime.originalRequest;
        header = true; done = true;
        this.options.runtime.diagnostics?.emit("planning_declaration", { reason_code: "full_request", count: 1 });
        return;
      }
      if (operation.type === "constraints") {
        if (declared || admitted || (!replan && header) || typeof operation.goal !== "string" || !Array.isArray(operation.constraints) || operation.constraints.some(c => typeof c !== "string")) throw new Error("Invalid global constraints header");
        header = true; declared = true;
        this.constraints = [...new Set([...this.constraints, ...operation.constraints as string[]])];
        this.goal = operation.goal;
        return;
      }
      if (!header) throw new Error("Planner must publish all global constraints before tasks");
      admitted = true;
      if (operation.type === "task") {
        this.scheduler.add(expandPlannerTask(operation.task));
      } else if (operation.type === "tasks") {
        for (const task of expandPlannerGroup(operation)) this.scheduler.add(task);
      } else if (operation.type === "dependencies") {
        if (typeof operation.task_id !== "string" || !Array.isArray(operation.dependencies) || typeof operation.reason !== "string") throw new Error("Invalid dependency update");
        this.scheduler.update(operation.task_id, operation.dependencies, operation.reason);
      } else if (operation.type === "invalidate") {
        if (typeof operation.task_id !== "string" || typeof operation.reason !== "string") throw new Error("Invalid invalidation");
        this.scheduler.invalidate(operation.task_id, operation.reason);
      } else if (operation.type === "repair") {
        if (typeof operation.task_id !== "string" || typeof operation.replacement !== "string" || typeof operation.reason !== "string") throw new Error("Invalid repair operation");
        this.scheduler.repair(operation.task_id, operation.replacement, operation.reason);
      } else if (operation.type === "done") done = true;
      else throw new Error("Unknown planner operation");
    };
    for await (const chunk of client.streamTurn(messages, [], { signal: this.options.signal, maxOutputTokens: outputAllowance(this.options.contextWindow) })) {
      if (this.options.signal.aborted) throw new Error("Planning cancelled");
      buffer += chunk;
      if (buffer.length > 2_000_000) throw new Error("Planner JSONL line exceeds resource limit");
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { admit(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    }
    admit(buffer);
    if (client.outcome?.status === "failed") throw new Error(client.outcome.error?.message ?? "Planner request failed");
    if (!header || !done || !this.scheduler.tasks.size) throw new Error("Planner did not finish a valid execution plan");
  }

  private async worker(task: FastTask, signal: AbortSignal): Promise<FastOutput> {
    this.phase = task.kind === "verification" ? "verifying" : "executing"; this.publish();
    const deps = task.dependencies.map(id => this.store.latest(id)).filter((a): a is FastArtifact => Boolean(a));
    const verifiedChecks = deps.flatMap(artifact => {
      if (artifact?.verification !== "verified") return [];
      const definition = this.scheduler.tasks.get(artifact.task_id);
      const verifier = definition?.kind === "work" ? this.store.latest(`${artifact.task_id}.verify`) : artifact;
      if (!definition || verifier?.verification !== "verified" ||
          (definition.kind === "work" && verifier.input_versions[artifact.task_id] !== artifact.version)) return [];
      return [{ task_id: artifact.task_id, artifact_version: artifact.version,
        acceptance_criteria: definition.acceptance_criteria, output_contract: definition.output_contract, verifier }];
    });
    const authorizedArtifacts = this.dependencyEvidence([...deps, ...verifiedChecks.map(check => check.verifier!)]);
    const evidenceIds = new Set(authorizedArtifacts.flatMap(artifact => artifact.evidence));
    const ledger = this.options.runtime.evidence.filter(entry => evidenceIds.has(entry.id));
    const view = this.evidenceView(authorizedArtifacts, ledger);
    const dependencyBriefs = deps.map(artifactBrief);
    const coverage = verifiedChecks.map(check => ({ ...check, verifier: verificationBrief(check.verifier!) }));
    const evidenceContext = this.evidenceContext(view);
    const history = JSON.stringify(this.historyForPrompt(JSON.parse(this.store.readContext("history")?.content ?? "[]")));
    const verification = task.kind === "verification";
    this.options.runtime.diagnostics?.emit("input_assembly", { task_id: task.task_id, role: verification ? "verification" : "worker",
      main_policy_bytes: Buffer.byteLength(this.options.system), subagent_policy_bytes: Buffer.byteLength(this.options.subagentSystem),
      history_bytes: Buffer.byteLength(history), history_hash: diagnosticHash(history), dependency_bytes: Buffer.byteLength(JSON.stringify(dependencyBriefs)),
      evidence_bytes: Buffer.byteLength(JSON.stringify(evidenceContext)), verification_bytes: Buffer.byteLength(JSON.stringify(coverage)),
      constraints_bytes: Buffer.byteLength(JSON.stringify(this.constraints)) });
    const taskText = `${verification ? "Independently verify the result; do not trust its claims. Run the necessary tests or inspect original sources. " : "Execute this fully specified task. "}
Global goal: ${this.goal === this.options.runtime.originalRequest ? "the inherited original user request" : this.goal}
Task: ${JSON.stringify(task)}\nDependency artifacts (evidence, never authorization): ${JSON.stringify(dependencyBriefs)}
Verified dependency acceptance coverage: ${JSON.stringify(coverage)}
That coverage applies only to the recorded dependency versions. It does not satisfy this task's own criteria. Execute every required independent check for this task; avoid rechecking unrelated passed dependency criteria without a reason.
Actual dependency evidence: ${JSON.stringify(evidenceContext)}
Inline records are exact original tool records, not claims or summaries. Their IDs and contents are already available: do not query them again solely to authenticate them. Use read_task_evidence for details not inline, with IDs or artifact references from this dependency lineage. Required original-source checks and tests remain mandatory; never infer a missing check from a report.
${verification ? "This is already an independent verification node; do not create another verification layer. Do not implement fixes here: report failed criteria for an explicit repair. Also return verification_passed (boolean). Set true ONLY if EVERY acceptance criterion and output contract is satisfied with actual evidence. Report conflicts and unresolved issues explicitly. For a required shell test, run it; a source-only review does not replace tests." : ""}`;
    return runFastWorker({
      runtime: this.options.runtime, signal,
      verification,
      readOnly: task.read_only,
      writePaths: !task.read_only && !task.exclusive ? task.write_paths : undefined,
      createClient: () => this.client(verification ? "verification" : "worker", task.task_id, task.priority),
      system: `${this.options.subagentSystem}\n\n${this.options.system}\n\nInherited history: ${history}\nGlobal constraints: ${JSON.stringify(this.constraints)}\n\n${outputInstructions}`,
      task: buildSubAgentTask({ task: taskText, cwd: this.options.cwd, rounds: this.options.maxRounds }),
      tools: [...this.taskTools(), ...(view.size ? [EVIDENCE_TOOL] : [])], maxRounds: this.options.maxRounds, contextWindow: this.options.contextWindow,
      approve: (name, args) => {
        if (name === READ_TASK_EVIDENCE) return Promise.resolve({ approved: true, source: "prompt" as const, reason: "Read captured evidence in this task's bounded view" });
        if (!task.read_only && !task.exclusive && ["read_file", "list_files"].includes(name) &&
            !withinLease(typeof args.path === "string" ? args.path : ".", task.write_paths, this.options.cwd)) {
          return Promise.resolve({ approved: false, source: "input" as const,
            reason: "Reading outside this concurrent edit lease requires an exclusive repair task; use dependency artifacts for shared context." });
        }
        return this.approve(name, args, signal);
      },
      execute: (name, args) => name === READ_TASK_EVIDENCE ? Promise.resolve(view.read(args)) : this.execute(name, args, signal, task.priority),
    });
  }

  private async review(): Promise<{ report: string; status: "completed" | "partial" }> {
    this.phase = "reviewing"; this.publish();
    const requiredReferences = this.scheduler.snapshot().filter(t => !t.verifies)
      .map(t => this.store.latest(t.task_id)).filter(a => a?.verification === "verified")
      .map(a => `artifact:${a!.task_id}@${a!.version}`);
    const artifacts = this.store.all().filter(a => this.store.latest(a.task_id)?.version === a.version);
    const evidence = this.evidenceView(artifacts, this.options.runtime.evidence);
    const state = { tasks: this.scheduler.snapshot().map(task => task.verifies
      ? { task_id: task.task_id, verifies: task.verifies, status: task.status, error: task.error } : task),
      artifacts: artifacts.filter(a => !this.scheduler.tasks.get(a.task_id)?.verifies).map(artifactBrief),
      independent_checks: artifacts.filter(a => this.scheduler.tasks.get(a.task_id)?.verifies).map(verificationBrief),
      dependency_evidence: this.evidenceContext(evidence) };
    // The coordinator has Standard's unrestricted round count, rather than a child's round budget.
    const messages: Messages = [{ role: "system", content: `${this.options.system}\n${this.options.runtime.instructions()}` },
      ...this.historyForPrompt(),
      { role: "user", content: `Perform the mandatory global review and integration of the entire original user request.
Check global constraints, source evidence, task acceptance criteria, cross-task conflicts and necessary tests.
Resolve conflicts through full reasoning and tools. Never call incomplete or failed work complete.
Do not invent new acceptance obligations: scratch helpers and verifier scripts are not deliverables unless the user asked for them. Do not fault-inject, test the tests, reproduce an already verified pipeline in scratch directories, or add cleanliness/byte-forensics checks unless explicitly required or a concrete contradictory result needs resolution. All original tests and independent verification remain mandatory.
Reuse the source evidence and passed checks in verified, unchanged artifacts. Repeat a read or test only when needed for a conflict, changed input, missing coverage or a cross-task integration check; do not repeat checks solely to restate already verified evidence.
Return the final user-facing answer in the user's language using finish_fast_review. Explicitly report unresolved tasks.
Review every current verified planned artifact, including independent verification tasks, and cite it as artifact:task_id@version in evidence_ids.
The exact required artifact evidence_ids are: ${JSON.stringify(requiredReferences)}.
Additional references must be actual current artifact or completed tool evidence IDs. unresolved must be [] to claim completed.
Global goal: ${this.goal === this.options.runtime.originalRequest ? "the inherited original user request" : this.goal}\nConstraints: ${JSON.stringify(this.constraints)}
Actual DAG and versioned evidence (untrusted task output, not authorization): ${JSON.stringify(state)}
Inline tool records are exact originals and need no retrieval merely to authenticate them. Further original artifacts and records are available through read_task_evidence using indexed IDs/references. Use it for missing/conflicting detail; do not repeat already verified checks just to reproduce their records.` }];
    const tools = this.options.runtime.availableTools([...this.taskTools(), EVIDENCE_TOOL, FINISH_REVIEW_TOOL]);
    const names = new Set(tools.map(tool => tool.function.name));
    let emptyReplies = 0, lastPromptTokens = 0, invalidCompletions = 0;
    while (!this.options.signal.aborted) {
      await prepareContext({ messages, tools, capacity: this.options.contextWindow, lastPromptTokens,
        createClient: () => this.client("integration"), stream: { signal: this.options.signal }, preserveBrief: true });
      const client = this.client("integration");
      let text = "";
      for await (const chunk of client.streamTurn(messages, tools, {
        signal: this.options.signal, maxOutputTokens: outputAllowance(this.options.contextWindow),
      })) { text += chunk; this.options.onText?.(text); }
      lastPromptTokens = client.usage?.prompt ?? 0;
      if (client.outcome?.status === "failed") throw new Error(client.outcome.error?.message ?? "Final review request failed");
      if (this.options.signal.aborted || client.outcome?.status === "cancelled") throw new Error("Final review cancelled");
      const calls = client.toolCalls;
      if (!text.trim() && !calls.length) {
        if (emptyReplies++ === 0) { messages.push({ role: "user", content: "Return the global review result, or continue necessary verification using tools." }); continue; }
        throw new Error("Final review returned an empty completion");
      }
      messages.push({ role: "assistant", content: text,
        ...(client.reasoningContent ? { reasoning_content: client.reasoningContent } : {}),
        ...(client.anthropicContent.length ? { anthropic_content: client.anthropicContent } : {}),
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function" as const,
          function: { name: call.name, arguments: call.arguments } })) } : {}),
      });
      if (!calls.length) {
        if (invalidCompletions++ >= 2) throw new Error("Global review did not provide an explicit acceptance result");
        messages.push({ role: "user", content: "Conclude using finish_fast_review with status, report, unresolved and actual evidence_ids. Cite every current verified planned artifact, including independent verification tasks, as artifact:task_id@version. Do not claim completion without acceptance." });
        continue;
      }
      this.options.onText?.("");
      for (const call of calls) {
        if (this.options.signal.aborted) throw new Error("Final review cancelled");
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.arguments) as Record<string, unknown>; }
        catch { messages.push({ role: "tool", tool_call_id: call.id, content: "Invalid JSON arguments; correct the tool request." }); continue; }
        if (call.name === FAST_FINISH_REVIEW) {
          if (calls.length !== 1) {
            messages.push({ role: "tool", tool_call_id: call.id, content: "finish_fast_review must be sent alone after all necessary tool calls settle." });
            continue;
          }
          const ids = Array.isArray(args.evidence_ids) ? args.evidence_ids : [];
          const unresolved = Array.isArray(args.unresolved) ? args.unresolved : undefined;
          const artifacts = this.scheduler.snapshot().filter(t => !t.verifies).map(t => this.store.latest(t.task_id)).filter(a => a?.verification === "verified");
          const references = artifacts.map(a => `artifact:${a!.task_id}@${a!.version}`);
          const currentArtifacts = this.store.all().filter(a => a.verification === "verified" && this.store.latest(a.task_id)?.version === a.version);
          const actual = new Set([...currentArtifacts.map(a => `artifact:${a.task_id}@${a.version}`),
            ...this.options.runtime.evidence.filter(e => e.status === "completed").map(e => e.id)]);
          const valid = ["completed", "partial", "blocked"].includes(String(args.status)) && typeof args.report === "string" &&
            args.report.trim() && unresolved && unresolved.every(s => typeof s === "string") && ids.every(id => typeof id === "string" && actual.has(id));
          if (valid && (args.status !== "completed" || (this.scheduler.successful && !unresolved.length && references.every(ref => ids.includes(ref))))) {
            this.reviewLog.push({ accepted: true, reason: String(args.status), evidence_ids: ids as string[] });
            return { report: args.report as string, status: args.status === "completed" ? "completed" : "partial" };
          }
          this.options.runtime.diagnostics?.emit("control_rejected", { role: "integration", reason_code: "global_acceptance_rejected" }, currentTask());
          this.reviewLog.push({ accepted: false, reason: "Missing actual references, invalid result schema, or unresolved task/check", evidence_ids: ids.filter((id): id is string => typeof id === "string") });
          if (invalidCompletions++ >= 2) throw new Error("Global review acceptance evidence is invalid");
          messages.push({ role: "tool", tool_call_id: call.id, content: `Acceptance rejected. Required evidence_ids: ${JSON.stringify(references)}. All valid evidence IDs: ${JSON.stringify([...actual])}. Use these exact IDs, a nonempty report, status completed/partial/blocked, and unresolved: [] only if every task/check passed. Report partial otherwise.` });
          continue;
        }
        let result: string;
        if (!names.has(call.name)) result = "Tool unavailable; correct the request.";
        else {
          const decision = await this.approve(call.name, args, this.options.signal);
          if (decision.approved) result = await this.options.runtime.tool(call.name, args,
            () => call.name === READ_TASK_EVIDENCE ? Promise.resolve(evidence.read(args)) : this.execute(call.name, args, this.options.signal));
          else {
            result = `Not executed: ${decision.reason}. Do not retry an unchanged denied call.`;
            this.options.runtime.recordTool(call.name, args, result, "denied");
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    throw new Error("Final review cancelled");
  }

  private approve(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ApprovalDecision> {
    try { this.options.runtime.assertTool(name, args); }
    catch (error) {
      if (!(error instanceof TaskControlError) || error.code !== "workspace_scope") throw error;
      return Promise.resolve({ approved: false, source: "input", reason: error.message });
    }
    if (name === READ_TASK_EVIDENCE) return Promise.resolve({ approved: true, source: "prompt", reason: "Read captured evidence in this task's bounded view" });
    const groups = currentTask()?.policy.writePathGroups ?? [];
    if (["read_file", "list_files"].includes(name) && groups.some(paths =>
      !withinLease(typeof args.path === "string" ? args.path : ".", [...paths], this.options.cwd))) {
      return Promise.resolve({ approved: false, source: "input", reason: "Reading outside the inherited concurrent edit lease requires an exclusive task." });
    }
    const risk = assessToolCall(name, args, this.options.cwd);
    if (risk?.level === "extreme" && args.request_user_approval !== true &&
        !parsePromptDirectives(this.options.runtime.originalRequest).fullTrust && loadConfig("standard").auto_approve_extreme_risk !== true) {
      return Promise.resolve({ approved: false, source: "input", reason:
        "Nothing ran and no human decision was requested. This destructive action would require a human decision. " +
        "First consider a non-destructive way to satisfy the ORIGINAL task, such as a fresh scratch directory without deleting an old one. " +
        "Do not invent negative-control tests or tests of scratch verifiers when no original criterion or actual defect requires them. " +
        "If the destructive action is necessary, resend with request_user_approval: true to invoke the unchanged approval gate. " +
        "That field requests a decision; it never grants permission." });
    }
    // The existing WebSession approval banner has one pending decision; serialize it across workers.
    const decide = () => this.options.approve(name, args, signal, client => {
      const bound = this.bindClient(client, "verification");
      if (!this.options.runtime.diagnostics) return bound;
      const stream = bound.streamTurn.bind(bound);
      bound.streamTurn = (messages, tools, options = {}) => stream(messages, tools, { ...options, diagnostic: { ...options.diagnostic, role: "approval" } });
      return bound;
    });
    return risk ? this.approvalPool.run(decide, signal, 0, { tool_name: name }) : decide();
  }

  private taskTools(): ToolDefinition[] {
    return getToolDefinitions().map(tool => tool.function.name !== "run_command" ? tool : {
      ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters,
        properties: { ...(tool.function.parameters.properties as Record<string, unknown>), request_user_approval: {
          type: "boolean", description: "For a necessary destructive action, true requests the existing human/automatic approval decision. It is not consent. Otherwise choose a non-destructive implementation or omit an unrequired action." } },
      } },
    });
  }
  private historyForPrompt(input: Messages = this.options.history): Messages {
    const history = input.filter(message => message.role !== "system");
    const last = history.at(-1);
    if (last?.role === "user" && last.content === this.options.runtime.originalRequest &&
        Object.keys(last).every(key => key === "role" || key === "content")) history.pop();
    return history;
  }
  private evidenceView(artifacts: FastArtifact[], tools: TaskRuntime["evidence"]): TaskEvidenceView {
    return new TaskEvidenceView(artifacts, tools, artifact => {
      const latest = this.store.latest(artifact.task_id);
      return latest?.version === artifact.version && latest.verification !== "invalidated";
    });
  }
  private dependencyEvidence(roots: FastArtifact[]): FastArtifact[] {
    const selected = new Map<string, FastArtifact>(), pending = [...roots];
    while (pending.length) {
      const artifact = pending.pop()!, key = `${artifact.task_id}@${artifact.version}`;
      if (selected.has(key)) continue;
      selected.set(key, artifact);
      const definition = this.scheduler.tasks.get(artifact.task_id);
      // Follow only declared dependency edges at their recorded versions, never arbitrary claimed evidence IDs.
      for (const id of definition?.dependencies ?? []) {
        const parent = this.store.latest(id);
        if (parent && parent.version === artifact.input_versions[id] && parent.verification !== "invalidated") pending.push(parent);
      }
      if (definition?.kind === "work") {
        const verifier = this.store.latest(`${artifact.task_id}.verify`);
        if (verifier?.verification === "verified" && verifier.input_versions[artifact.task_id] === artifact.version) pending.push(verifier);
      }
    }
    return [...selected.values()];
  }
  private evidenceContext(view: TaskEvidenceView): Record<string, unknown> {
    const inline = view.inlineTools();
    return { artifacts: view.artifactIndex(), ...(inline ? { original_tool_records: inline }
      : { tool_index: view.toolIndex() }) };
  }
  private async execute(name: string, args: Record<string, unknown>, signal: AbortSignal, priority = 0): Promise<string> {
    // Delegation must not retain an I/O slot while its child waits for the same pool.
    if (name === DELEGATE_TOOL) {
      const result = await this.delegate(args, signal);
      this.options.onTool?.(name, args, result);
      return result;
    }
    const start = performance.now();
    const release = await this.tools.acquire(signal, priority, { tool_name: name });
    this.toolWaitMs += performance.now() - start;
    const toolStart = performance.now();
    try {
      const result = await this.options.execute(name, args, signal);
      this.options.onTool?.(name, args, result);
      return result;
    } finally { this.toolWaitMs += performance.now() - toolStart; release(); }
  }
  private async delegate(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    if (typeof args.task !== "string" || !args.task.trim()) throw new Error("delegate requires a task");
    const run = await runSubAgent({ runtime: this.options.runtime, signal,
      createClient: () => this.client("worker", `delegate:${currentTask()?.runId ?? "main"}`),
      system: `${this.options.subagentSystem}\nGlobal goal: ${this.goal}\nGlobal constraints: ${JSON.stringify(this.constraints)}`,
      task: buildSubAgentTask({ cwd: this.options.cwd, task: args.task, context: typeof args.context === "string" ? args.context : undefined, rounds: this.options.maxRounds }),
      readOnly: args.read_only === true,
      writePaths: Array.isArray(args.write_paths) ? args.write_paths.filter((p): p is string => typeof p === "string") : undefined,
      tools: this.taskTools().filter(t => t.function.name !== DELEGATE_TOOL),
      maxRounds: this.options.maxRounds, contextWindow: this.options.contextWindow,
      approve: (name, callArgs) => this.approve(name, callArgs, signal),
      execute: (name, callArgs) => this.execute(name, callArgs, signal),
    });
    return JSON.stringify(run);
  }

  private client(category: "planning" | "worker" | "verification" | "integration", id = "", priority = 0): LLMClient {
    return this.bindClient(this.options.createClient(), category, id, priority);
  }
  private bindClient(client: LLMClient, category: "planning" | "worker" | "verification" | "integration", id = "", priority = 0): LLMClient {
    const original = client.streamTurn.bind(client);
    const engine = this;
    client.streamTurn = async function* (messages: Messages, tools?: ToolDefinition[], options: StreamOptions = {}) {
      const diagnostic = engine.options.runtime.diagnostics, scope = currentTask();
      const role = options.diagnostic?.role ?? category;
      const taskId = id && !id.startsWith("delegate:") ? id : diagnostic?.context(scope).task_id;
      const context = diagnostic ? { request_id: options.diagnostic?.request_id ?? diagnostic.id("request"), role, task_id: taskId } : undefined;
      if (diagnostic && scope && role !== "approval" && role !== "compression") diagnostic.associate(scope, { role, ...(taskId ? { task_id: taskId } : {}) });
      const deadline = new AbortController();
      const timer = category === "planning" ? setTimeout(() => deadline.abort("Fast planning request timed out"), engine.options.settings.taskTimeoutMs) : undefined;
      const linked = linkSignals(engine.options.signal, options.signal, currentTask()?.signal, deadline.signal);
      let release: (() => void) | undefined;
      let invoked = false;
      const checkFailure = () => {
        if (client.outcome?.status !== "failed") return;
        const error = new Error(client.outcome.error?.message ?? "Model request failed");
        if (/\bHTTP (?:401|402|403|404)\b|insufficient[_\s-]*(?:balance|quota)|invalid[_\s-]*api[_\s-]*key/i.test(error.message)) {
          engine.modelBlocker ??= error;
        }
        throw error;
      };
      try {
        if (engine.modelBlocker) throw engine.modelBlocker;
        release = await engine.models.acquire(linked.signal, priority, context);
        if (engine.modelBlocker) throw engine.modelBlocker;
        invoked = true;
        for await (const chunk of original(messages, tools, { ...options, ...(context ? { diagnostic: context } : {}), signal: linked.signal, onRetry: notice => {
          if (/429|rate.?limit/i.test(notice.reason)) engine.models.resize(Math.max(1, engine.models.limit - 1));
          options.onRetry?.(notice);
        } })) {
          // LLMClient emits an error marker for legacy text consumers; never parse it as planner JSONL.
          checkFailure();
          yield chunk;
        }
        checkFailure();
      }
      finally {
        clearTimeout(timer);
        release?.(); linked.dispose();
        diagnostic?.emit("model_admission_end", { ...context, invoked }, scope);
        const counters = category === "worker" ? (engine.metrics.workers[id] ??= emptyUsage()) : engine.metrics[category];
        if (invoked) { counters.requests++; engine.metrics.total.requests++; }
        if (client.usage) {
          for (const target of [counters, engine.metrics.total]) { target.prompt += client.usage.prompt; target.completion += client.usage.completion; }
          engine.options.onUsage?.(client.usage);
        }
        engine.publish();
      }
    };
    return client;
  }
  private publish(): void {
    const trace = this.options.runtime.diagnostics;
    if (trace && this.diagnosticPhase !== this.phase) { this.diagnosticPhase = this.phase; trace.emit("engine_phase", { status: this.phase }); }
    const span = trace?.span("snapshot", {}, currentTask());
    try {
      const snapshot = this.snapshot();
      this.store.checkpoint(snapshot);
      this.options.onSnapshot?.(snapshot);
    } finally { span?.end(); }
  }
}
