import { createBrowserCodeTool, type JsonSchemaExecutableToolDescriptors } from "@cloudflare/codemode/browser";
import ts from "typescript";
import { getToolDefinitions, type ToolDefinition } from "./tools.js";
import { LocalCodeExecutor } from "./codeExecutor.js";
import type { PlanState } from "./plan.js";

export const CODE_TOOL = "execute_ts";
export class ProgramToolDenied extends Error {}
interface ProgramOptions {
  signal?: AbortSignal;
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  onPlan(plan: PlanState): void;
  onStep(index: number, status: "active" | "done"): void;
}

function descriptors(call: ProgramOptions["call"], step: ProgramOptions["onStep"]): JsonSchemaExecutableToolDescriptors {
  const tools: JsonSchemaExecutableToolDescriptors = {};
  for (const definition of getToolDefinitions()) {
    const { name, description, parameters } = definition.function;
    tools[name] = {
      description, inputSchema: parameters, outputSchema: { type: "string" },
      // Approval is inside the callback. SDK needsApproval would exclude tools
      // entirely rather than use Neutrino's per-call, argument-aware gate.
      execute: async args => {
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`${name} needs an argument object`);
        const properties = parameters.properties as Record<string, { type?: string }>;
        for (const required of parameters.required as string[] ?? []) {
          if (typeof args[required] !== properties[required]?.type || (typeof args[required] === "string" && !(args[required] as string).trim())) {
            throw new Error(`${name}: invalid or missing ${required}`);
          }
        }
        if (typeof args.reason !== "string" || !args.reason.trim()) throw new Error(`${name} needs an honest reason`);
        return call(name, args);
      },
    };
  }
  for (const [name, status] of [["set_step", "active"], ["complete_step", "done"]] as const) {
    tools[name] = {
      description: `${status === "active" ? "Start" : "Complete after verification"} a zero-based step of this execution's plan.`,
      inputSchema: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] },
      outputSchema: { type: "string" },
      execute: async args => { step(Number(args.index), status); return "Progress recorded"; },
    };
  }
  return tools;
}

const DESCRIPTION = `Plan-Then-Code: execute a TypeScript async arrow function to compose multiple tool operations.
Supply a short plan before the code. All external work uses codemode tools below;
each actual call must include a reason and passes the normal approval gate.
Use codemode.set_step({index}) and codemode.complete_step({index}) for progress.
Imports, process, require, direct network and host filesystem APIs are unavailable.
Keep intermediate data local and return only necessary evidence. console output is bounded.
Tool RPCs are serialized; Promise.all preserves correctness but does not parallelize side effects.
On error, inspect completed calls before continuing; never blindly repeat writes or commands.
Available typed API:
{{types}}`;

let definition: ToolDefinition | undefined;
export function getCodeToolDefinition(): ToolDefinition {
  if (definition) return definition;
  const descriptor = createBrowserCodeTool({
    tools: descriptors(async () => "", () => {}),
    executor: new LocalCodeExecutor(), description: DESCRIPTION,
  });
  return definition = {
    type: "function",
    function: {
      name: CODE_TOOL, description: descriptor.description,
      parameters: {
        type: "object",
        properties: {
          plan: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "Short ordered steps, written before the code." },
          code: { type: "string", description: "An async TypeScript arrow function: async () => { ...; return evidence; }" },
          reason: { type: "string", description: "An honest sentence explaining why this execution is needed." },
        },
        required: ["plan", "code", "reason"],
      },
    },
  };
}

/** Only the program's return, bounded logs and completion ledger enter LLM context. */
export async function executeCodeProgram(args: Record<string, unknown>, options: ProgramOptions): Promise<string> {
  const completed: Array<{ tool: string; target?: string }> = [];
  const controller = new AbortController();
  const inFlight = new Set<Promise<string>>();
  const abort = () => controller.abort(options.signal?.reason ?? "Execution cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let plan: PlanState | undefined;
  try {
    if (typeof args.code !== "string" || !args.code.trim() || args.code.length > 200_000) throw new Error("code must contain at most 200000 characters");
    if (typeof args.reason !== "string" || !args.reason.trim()) throw new Error("execute_ts needs an honest reason");
    if (!Array.isArray(args.plan) || args.plan.length < 1 || args.plan.length > 10 || args.plan.some(s => typeof s !== "string" || !s.trim() || s.length > 160)) {
      throw new Error("plan must contain 1–10 short nonempty steps (160 characters each)");
    }
    if (controller.signal.aborted) throw new Error("Execution cancelled");
    plan = { goal: args.reason, steps: args.plan.map(title => ({ title: title.trim(), status: "pending" })) };
    options.onPlan(plan);
    options.onStep(0, "active");
    const source = args.code.trim().replace(/^```(?:typescript|ts|javascript|js)?\s*\n([\s\S]*?)\n```$/i, "$1");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: "agent-program.ts", reportDiagnostics: true,
    });
    const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(errors.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    const tool = createBrowserCodeTool({
      executor: new LocalCodeExecutor(controller.signal), description: DESCRIPTION,
      tools: descriptors(async (name, callArgs) => {
        if (controller.signal.aborted) throw new Error("Execution cancelled");
        try {
          const operation = options.call(name, callArgs, controller.signal);
          inFlight.add(operation);
          let value: string;
          try { value = await operation; } finally { inFlight.delete(operation); }
          const target = typeof callArgs.path === "string" ? callArgs.path : typeof callArgs.command === "string" ? callArgs.command.slice(0, 200) : undefined;
          completed.push({ tool: name, ...(target ? { target } : {}) });
          return value;
        } catch (error) {
          // Once denied, even code that catches the exception cannot issue a
          // different tool call to work around the verdict.
          if (error instanceof ProgramToolDenied) controller.abort(error.message);
          throw error;
        }
      }, (index, status) => {
        if (!Number.isInteger(index) || index < 0 || index >= plan!.steps.length) throw new Error("Invalid plan step index");
        options.onStep(index, status);
      }),
    });
    const output = await tool.execute({ code: compiled.outputText });
    if (plan.steps.length === 1) options.onStep(0, "done");
    if (plan.steps.some(s => s.status !== "done")) plan.stopped = true;
    return boundedJson({ ok: true, ...output, completed });
  } catch (error) {
    controller.abort(error instanceof Error ? error.message : String(error));
    await Promise.allSettled([...inFlight]);
    if (plan) {
      for (const step of plan.steps) if (step.status === "active") step.status = "failed";
      plan.stopped = true;
    }
    return boundedJson({ ok: false, error: error instanceof Error ? error.message : String(error), completed,
      instruction: "Inspect the completed-call ledger and saved tool results. Do not replay completed side effects. Respect any approval denial." });
  } finally { options.signal?.removeEventListener("abort", abort); }
}

function boundedJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) => typeof v === "bigint" ? String(v) : v);
  return text.length > 16_000 ? `${text.slice(0, 16_000)}\n[Program result truncated; return a smaller summary.]` : text;
}
