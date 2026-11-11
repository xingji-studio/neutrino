export const FAST_MODE = "fast_dag" as const;
export type FastStatus = "PENDING" | "READY" | "RUNNING" | "VERIFYING" | "VERIFIED" |
  "FAILED" | "BLOCKED" | "INVALIDATED" | "COMPLETED";
export interface FastTask {
  task_id: string;
  task_goal: string;
  dependencies: string[];
  required_context: string[];
  input_versions: Record<string, number | string>;
  acceptance_criteria: string[];
  output_contract: string;
  priority: number;
  estimated_duration: number;
  read_only: boolean;
  /** Disjoint file trees may run concurrently; commands take an exclusive workspace lease. */
  write_paths: string[];
  exclusive: boolean;
  status: FastStatus;
  /** Planned work gets an automatic verifier; planned verification executes its checks once. */
  kind: "work" | "verification";
  /** Present only on the automatic verifier of a work task. */
  verifies?: string;
  attempts: number;
  generation: number;
  error?: string;
  needs_repair?: boolean;
  repair_from?: string;
}
export interface FastOutput {
  result: string;
  conclusions: string[];
  evidence: string[];
  assumptions: string[];
  unresolved: string[];
  /** A failed attempt which touched external state must never be retried automatically. */
  side_effects: boolean;
  verification_passed?: boolean;
  /** Runtime-owned producer scope; never accepted from model output. */
  source_run_id?: string;
}
export interface FastArtifact extends FastOutput {
  task_id: string;
  version: number;
  input_versions: Record<string, number | string>;
  verification: "pending" | "verified" | "invalidated";
  created_at: string;
}
export interface FastUsage { prompt: number; completion: number; requests: number }
export interface FastMetrics {
  started_at: string;
  elapsed_ms: number;
  planning: FastUsage;
  workers: Record<string, FastUsage>;
  verification: FastUsage;
  integration: FastUsage;
  total: FastUsage;
  retries: number;
  replans: number;
  tool_wait_ms: number;
  scheduling_ms: number;
  context_cache_hits: number;
  /** The existing provider interface does not expose reliable cache billing. */
  provider_cached_tokens: null;
  tokens_per_second: number;
}
export interface FastSnapshot {
  run_id: string;
  actual_mode: typeof FAST_MODE;
  phase: "planning" | "executing" | "verifying" | "integrating" | "reviewing" | "completed" | "failed" | "cancelling" | "cancelled";
  tasks: FastTask[];
  artifacts: FastArtifact[];
  metrics: FastMetrics;
  resources: { model: number; tools: number; background: number };
  integrated?: Record<string, number>;
  review?: Array<{ accepted: boolean; reason: string; evidence_ids: string[] }>;
  planning_errors?: string[];
  error?: string;
}
export interface FastSettings {
  enabled: boolean;
  modelSlots: number;
  toolSlots: number;
  backgroundSlots: number;
  workerSlots: number;
  taskTimeoutMs: number;
  maxTasks: number;
  retries: number;
  replans: number;
}
export function fastSettings(config: Record<string, unknown>): FastSettings {
  const limit = (key: string, fallback: number, max: number) => {
    const n = config[key];
    return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  const modelSlots = limit("fast_model_slots", 4, 16);
  return {
    enabled: process.env.NEUTRINO_FAST_MODE !== "0" && config.fast_mode_enabled !== false,
    modelSlots, toolSlots: limit("fast_tool_slots", 8, 32), backgroundSlots: limit("fast_background_slots", 2, 8),
    workerSlots: limit("fast_worker_slots", modelSlots * 2, 32),
    taskTimeoutMs: limit("fast_task_timeout_ms", 30 * 60_000, 24 * 60 * 60_000),
    maxTasks: limit("fast_max_tasks", 24, 128),
    retries: config.fast_retries === 0 ? 0 : limit("fast_retries", 1, 3),
    replans: config.fast_replans === 0 ? 0 : limit("fast_replans", 2, 4),
  };
}
export function assertFastAvailable(config: Record<string, unknown>): void {
  if (!fastSettings(config).enabled) throw new Error("Fast Mode is disabled. Select Standard mode explicitly to continue.");
}
