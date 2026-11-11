import fs from "node:fs";
import path from "node:path";
import type { ToolEvidence } from "../llm/runtime.js";
import type { FastArtifact, FastTask } from "./types.js";

export const MAX_PREFETCH_SOURCE_BYTES = 8_192;
export const MAX_PREFETCH_SOURCE_FILES = 4;

/** Select fresh reads, never cached results. Only a runtime-owned, exact parent scope is eligible. */
export function verificationSourceReads(task: FastTask, parent: FastArtifact | undefined, definition: FastTask | undefined,
  evidence: readonly ToolEvidence[], cwd: string): Record<string, unknown>[] {
  if (task.kind !== "verification" || !task.read_only || !task.verifies || task.dependencies.length !== 1 ||
      task.dependencies[0] !== task.verifies || parent?.task_id !== task.verifies || !parent.source_run_id ||
      task.input_versions[parent.task_id] !== parent.version || parent.verification === "invalidated" || parent.side_effects ||
      definition?.kind !== "work" || !definition.read_only) return [];
  const own = evidence.filter(entry => entry.runId === parent.source_run_id);
  if (!own.length || own.some(entry => entry.status !== "completed" || !["read_file", "list_files"].includes(entry.name) ||
      !parent.evidence.includes(entry.id))) return [];
  const selected = new Map<string, Record<string, unknown>>();
  let bytes = 0;
  const inside = (target: string, base: string) => {
    const relative = path.relative(base, target);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  try {
    const base = path.resolve(cwd), realBase = fs.realpathSync(base);
    for (const entry of own.filter(item => item.name === "read_file")) {
      const args = entry.arguments;
      if (typeof args.path !== "string" || !args.path || Object.keys(args).some(key =>
          !["path", "reason", "request_user_approval"].includes(key))) return [];
      const target = path.resolve(base, args.path);
      if (!inside(target, base)) return [];
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      const real = fs.realpathSync(target);
      if (!inside(real, realBase)) return [];
      if (selected.has(real)) continue;
      bytes += stat.size;
      if (selected.size >= MAX_PREFETCH_SOURCE_FILES || bytes > MAX_PREFETCH_SOURCE_BYTES) return [];
      selected.set(real, { ...structuredClone(args),
        reason: `Fresh independent verification read of the original source for ${task.verifies}; all original checks still apply.` });
    }
  } catch { return []; }
  return [...selected.values()];
}
