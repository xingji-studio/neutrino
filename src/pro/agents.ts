import { LLMClient, type UsageInfo } from "../llm/client.js";
import type { ApprovalDecision } from "../llm/approval.js";
import type { RetryNotice } from "../llm/retry.js";
import { buildSubAgentTask, formatSubAgentResult, runSubAgent } from "../llm/subagent.js";
import { DELEGATE_TOOL, getSubAgentToolDefinitions, type ToolDefinition } from "../llm/tools.js";
import { ACTIVE_PRO_ROLES, PRO_ROLES, loadProPrompt, type ProResolvedModel, type ProRole } from "./config.js";

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
  private readonly options: ProAgentTeamOptions;
  private readonly maxDepth: number;

  constructor(options: ProAgentTeamOptions) {
    this.options = options;
    this.maxDepth = Number.isSafeInteger(options.maxDepth) && options.maxDepth > 0 ? options.maxDepth : 10;
  }

  client(role: ProRole): LLMClient {
    const selection = this.options.models[role];
    if (!selection) throw new Error(`Pro agent ${role} is unavailable`);
    return new LLMClient(selection.model, selection.provider, selection.intensity, { professional: true });
  }

  async call(role: ProRole, task: string, context = "", depth = 1, readOnly = false): Promise<string> {
    if (!PRO_ROLES.includes(role)) return "[Error: unknown Pro agent role]";
    if (role === "genimage_model") return "[Error: image generation is reserved and is not enabled]";
    if (this.options.cancelled()) return "[Pro agent stopped: the turn was paused or replaced.]";
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > this.maxDepth) {
      return `[Error: Pro agent recursion limit (${this.maxDepth}) reached. Complete the work without further delegation.]`;
    }
    if (typeof task !== "string" || !task.trim()) return "[Error: a Pro agent needs a nonempty task]";
    const selection = this.options.models[role];
    if (!selection) return `[Error: Pro agent ${role} is unavailable]`;
    // Reviewers are always read-only, including when consulted as specialists.
    const onlyRead = readOnly || role === "confirm_model";
    const tools = getProToolDefinitions().filter((tool) => !onlyRead ||
      ["read_file", "list_files", PRO_AGENT_TOOL].includes(tool.function.name));
    const names = new Set(tools.map((tool) => tool.function.name));
    const label = `${role} · ${selection.model.name} · ${depth}/${this.maxDepth}`;
    try {
      const result = await runSubAgent({
        createClient: () => this.client(role),
        system: `${loadProPrompt(role)}\n\nDelegation depth: ${depth}/${this.maxDepth}. ` +
          (onlyRead ? "This consultation is read-only. Do not modify files or execute commands, including through another agent." :
            "Use the shared approval gate for every tool call. Return a self-contained report with changes, evidence and unresolved work."),
        task: buildSubAgentTask({ task, context, cwd: this.options.cwd }),
        tools,
        contextWindow: selection.context_window,
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
            const report = await this.call(nextRole, nextTask, nextContext, depth + 1, onlyRead);
            this.options.onProgress?.(label);
            return report;
          }
          if (!names.has(name)) return "[Error: tool is unavailable to this Pro agent]";
          return this.options.execute(name, args);
        },
        cancelled: this.options.cancelled,
        onUsage: this.options.onUsage,
        onRetry: this.options.onRetry,
        onProgress: (activity) => this.options.onProgress?.(`${label} · ${activity}`),
      });
      return formatSubAgentResult(result);
    } finally {
      this.options.onProgress?.(null);
    }
  }
}
