import type { TaskDefinition } from "./scheduler.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid planner task object");
  return { ...value as Record<string, unknown> };
}

/** Expand transport defaults only. Permissions and acceptance must still be explicit. */
export function expandPlannerTask(value: unknown): TaskDefinition {
  const task = object(value);
  if (typeof task.task_id !== "string") throw new Error("Planner task_id must be a string");
  if ("access" in task) {
    if ("read_only" in task || "exclusive" in task) throw new Error("Do not mix planner access and legacy permission fields");
    if (typeof task.access !== "string" || !["read_only", "exclusive", "scoped"].includes(task.access)) throw new Error("Invalid planner access");
    task.read_only = task.access === "read_only";
    task.exclusive = task.access === "exclusive";
    delete task.access;
  }
  return { kind: "work", dependencies: [], required_context: ["request", "history"], input_versions: {},
    priority: 0, estimated_duration: 0, write_paths: [], ...task } as unknown as TaskDefinition;
}

/** Shared transport fields are copied into every task before the normal validator runs. */
export function expandPlannerGroup(value: unknown): TaskDefinition[] {
  const group = object(value);
  if (group.type !== "tasks" || Object.keys(group).some(key => !["type", "shared", "tasks"].includes(key)) ||
      !Array.isArray(group.tasks) || !group.tasks.length) throw new Error("Invalid planner task group");
  const shared = object(group.shared);
  if (["task_id", "verifies", "needs_repair", "repair_from"].some(key => key in shared)) throw new Error("Shared task fields cannot set identity or runtime state");
  return group.tasks.map(task => expandPlannerTask({ ...structuredClone(shared), ...object(task) }));
}

/** The full request is copied by the runtime; the planner cannot replace its acceptance criteria. */
export function expandSingleRequest(value: unknown, brief: { request: string; earlierRequests: readonly string[] }): TaskDefinition {
  const operation = object(value);
  if (operation.type !== "single" || Object.keys(operation).some(key => !["type", "task_id", "access", "write_paths"].includes(key))) {
    throw new Error("A single plan cannot override the original request or acceptance criteria");
  }
  if (!("access" in operation)) throw new Error("Single plan requires explicit access");
  if (!brief.request.trim()) throw new Error("Single plan requires the original request");
  return expandPlannerTask({ task_id: "task_id" in operation ? operation.task_id : "main", access: operation.access,
    ...(operation.write_paths !== undefined ? { write_paths: operation.write_paths } : {}),
    task_goal: brief.request,
    acceptance_criteria: [brief.request, ...(brief.earlierRequests.length
      ? [`Preserve all applicable earlier user constraints: ${JSON.stringify(brief.earlierRequests)}`] : [])],
    output_contract: "Deliver every output required by the original request, with actual evidence for all required sources and tests and no unresolved requirement.",
  });
}
