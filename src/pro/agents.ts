import { LLMClient, type UsageInfo } from "../llm/client.js";
import type { ApprovalDecision } from "../llm/approval.js";
import type { RetryNotice } from "../llm/retry.js";
import { buildSubAgentTask, formatSubAgentResult, runSubAgent, subAgentRounds, type SubAgentRun } from "../llm/subagent.js";
import { DELEGATE_TOOL, getSubAgentToolDefinitions, type ToolDefinition } from "../llm/tools.js";
import { loadConfig } from "../config.js";
import { ACTIVE_PRO_ROLES, PRO_ROLES, loadProPrompt, type ProResolvedModel, type ProRole } from "./config.js";
import { currentTask, TaskRuntime, TaskControlError, taskLimits } from "../llm/runtime.js";

export const PRO_AGENT_TOOL = "call_pro_agent";

const CALL_AGENT: ToolDefinition = {
  type: "function",
  function: {
    name: PRO_AGENT_TOOL,
    description: "Ask a specialist agent to perform a self-contained task in its own context, using the same working directory and approval gate. " +
      "Use thinking_model for reasoning, front_output_model for UI, backend_output_model for other code, modeling_model for modeling, " +
      "plan_model for planning, confirm_model for read-only review, or main_model for coordination. Specialists can call other specialists within the configured recursion depth.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: [...ACTIVE_PRO_ROLES] },
        task: { type: "string", description: "Complete task, expected deliverables and acceptance criteria." },
        context: { type: "string", description: "Relevant evidence, constraints and decisions; the agent cannot see the parent's conversation." },
        read_only: { type: "boolean", description: "Restrict this task and all descendants to read-only tools." },
        write_paths: { type: "array", items: { type: "string" }, description: "Optional allowed write paths. Descendants can only narrow this scope; arbitrary shell commands are unavailable under a path restriction." },
        reason: { type: "string", description: "Why this specialist is needed for the user's request." },
      },
      required: ["role", "task", "reason"],
    },
  },
};

/** All Pro agents can call the same specialists; the runtime enforces depth. */
export function getProToolDefinitions(): ToolDefinition[] {
  return [...getSubAgentToolDefinitions(), CALL_AGENT];
}

export interface ProAgentTeamOptions {
  runtime?: TaskRuntime;
  request?: string;
  models: Partial<Record<ProRole, ProResolvedModel>>;
  maxDepth: number;
  cwd: string;
  approve(name: string, args: Record<string, unknown>): Promise<ApprovalDecision>;
  execute(name: string, args: Record<string, unknown>): Promise<string>;
  cancelled(): boolean;
  onProgress?(label: string | null): void;
  onUsage?(usage: UsageInfo): void;
  onRetry?(notice: RetryNotice): void;
}

/** A resolved model team belongs to one task; substitutions never touch disk. */
export class ProAgentTeam {
  readonly runtime: TaskRuntime;
  private readonly options: ProAgentTeamOptions;
  private readonly maxDepth: number;

  constructor(options: ProAgentTeamOptions) {
    this.options = options;
    this.runtime = options.runtime ?? currentTask()?.runtime ?? new TaskRuntime({ request: options.request ?? "", cwd: options.cwd, limits: taskLimits(loadConfig("pro")) });
    this.maxDepth = Number.isSafeInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : 10;
  }

  client(role: ProRole): LLMClient {
    const selection = this.options.models[role];
    if (!selection) throw new Error(`Pro agent ${role} is unavailable`);
    return new LLMClient(selection.model, selection.provider, selection.intensity, { professional: true });
  }

  async call(role: ProRole, task: string, context = "", depth = 1, readOnly = false, writePaths?: readonly string[]): Promise<string> {
    return formatSubAgentResult(await this.callResult(role, task, context, depth, readOnly, writePaths));
  }

  contextWindow(role: ProRole): number {
    const selection = this.options.models[role];
    const overrides = loadConfig("pro").model_context_windows as Record<string, unknown> | undefined;
    const value = selection && overrides?.[`${selection.provider}/${selection.model.name}`];
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : selection?.context_window ?? 1_000_000;
  }

  async callResult(role: ProRole, task: string, context = "", depth = 1, readOnly = false, writePaths?: readonly string[]): Promise<SubAgentRun> {
    const failure = (code: string, message: string): SubAgentRun => {
      const result: SubAgentRun = { runId: currentTask()?.runId ?? this.runtime.rootRunId,
        status: code === "cancelled" ? "cancelled" : code.endsWith("_budget") ? "blocked" : "failed", report: "", evidenceIds: [], artifacts: [], blockers: [],
        error: { code, message }, aborted: code === "cancelled", exhausted: false, rounds: 0, calls: 0 };
      this.runtime.recordResult(result);
      return result;
    };
    if (!PRO_ROLES.includes(role)) return failure("unknown_role", "unknown Pro agent role");
    if (role === "genimage_model") return failure("reserved", "image generation is reserved and is not enabled");
    if (this.options.cancelled() || this.runtime.signal.aborted) return failure("cancelled", "the turn was paused or replaced");
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > this.maxDepth) {
      return failure("recursion_limit", `Pro agent recursion limit (${this.maxDepth}) reached. Complete the work without further delegation.`);
    }
    if (typeof task !== "string" || !task.trim()) return failure("invalid_task", "a Pro agent needs a nonempty task");
    const selection = this.options.models[role];
    if (!selection) return failure("unavailable", `Pro agent ${role} is unavailable`);
    // Reviewers are always read-only, including when consulted as specialists.
    const parent = currentTask()?.runtime === this.runtime ? currentTask()! : this.runtime.root;
    const onlyRead = readOnly || role === "confirm_model" || parent.policy.readOnly;
    const tools = getProToolDefinitions().filter((tool) => !onlyRead ||
      ["read_file", "list_files", "web_search", PRO_AGENT_TOOL].includes(tool.function.name));
    const names = new Set(tools.map((tool) => tool.function.name));
    const label = `${role} · ${selection.model.name} · ${depth}/${this.maxDepth}`;
    try {
      const maxRounds = subAgentRounds(loadConfig("pro").subagent_max_rounds);
      return await this.runtime.child(role, task, async scope => runSubAgent({
        runtime: this.runtime, scope,
        createClient: () => this.client(role),
        system: `${loadProPrompt(role)}\n\nDelegation depth: ${depth}/${this.maxDepth}. ` +
          (onlyRead ? "This consultation is read-only. Do not modify files or execute commands, including through another agent." :
            "Use the shared approval gate for every tool call. Return a self-contained report with changes, evidence and unresolved work."),
        task: buildSubAgentTask({ task, context, cwd: this.options.cwd, rounds: maxRounds }),
        tools,
        contextWindow: this.contextWindow(role),
        maxRounds,
        approve: (name, args) => {
          if (!names.has(name) && name !== DELEGATE_TOOL) return Promise.resolve({
            approved: false, source: "input", reason: "This tool is not available to this Pro agent",
          });
          return this.options.approve(name, args);
        },
        execute: async (name, args) => {
          if (name === PRO_AGENT_TOOL || name === DELEGATE_TOOL) {
            const nextRole = typeof args.role === "string" ? args.role as ProRole : "backend_output_model";
            const nextTask = typeof args.task === "string" ? args.task : "";
            const nextContext = typeof args.context === "string" ? args.context : "";
            const report = await this.call(nextRole, nextTask, nextContext, depth + 1, onlyRead || args.read_only === true,
              Array.isArray(args.write_paths) ? args.write_paths.filter((p): p is string => typeof p === "string") : undefined);
            if (!this.options.cancelled() && !this.runtime.signal.aborted) this.options.onProgress?.(label);
            return report;
          }
          if (!names.has(name)) return "[Error: tool is unavailable to this Pro agent]";
          return this.options.execute(name, args);
        },
        cancelled: this.options.cancelled,
        onUsage: this.options.onUsage,
        onRetry: this.options.onRetry,
        onProgress: (activity) => this.options.onProgress?.(`${label} · ${activity}`),
      }), { readOnly: onlyRead, writePaths });
    } catch (error) {
      return failure(error instanceof TaskControlError ? error.code : "agent_error", error instanceof Error ? error.message : String(error));
    } finally {
      if (!this.options.cancelled() && !this.runtime.signal.aborted) this.options.onProgress?.(null);
    }
  }
}
