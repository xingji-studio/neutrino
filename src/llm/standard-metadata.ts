import type { ToolEvidence } from "./runtime.js";

/** Normalize references, never manufacture coverage or silently discard unknown/denied proof. */
export function normalizeStandardChecks(raw: unknown[], ledger: readonly ToolEvidence[]) {
  const combined: unknown[] = [], byRequirement = new Map<string, Record<string, unknown>>();
  const excluded: Array<{ requirement_id: string; evidence_id: string; reason: string; superseded_by?: string }> = [];
  let repairs = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { combined.push(item); continue; }
    const check = item as Record<string, unknown>;
    if (typeof check.requirement_id !== "string" || typeof check.detail !== "string" || !check.detail.trim() || !Array.isArray(check.evidence_ids)) {
      combined.push(item); continue;
    }
    const prior = byRequirement.get(check.requirement_id);
    if (prior) {
      prior.detail = prior.detail === check.detail ? prior.detail : `${prior.detail}\n${check.detail}`;
      prior.evidence_ids = [...prior.evidence_ids as unknown[], ...check.evidence_ids]; repairs++;
    } else {
      const copy = { ...check, evidence_ids: [...check.evidence_ids] };
      combined.push(copy); byRequirement.set(check.requirement_id, copy);
    }
  }
  const evidence = new Map(ledger.map((entry, index) => [entry.id, { entry, index }]));
  const signature = (entry: ToolEvidence) => JSON.stringify([entry.name,
    Object.keys(entry.arguments).filter(k => k !== "reason").sort().map(k => [k, entry.arguments[k]])]);
  for (const [requirement_id, check] of byRequirement) {
    const original = check.evidence_ids as unknown[], unique = [...new Set(original)];
    repairs += original.length - unique.length;
    // Failed setup calls never prove behavior. Remove them only when actual successful proof was also supplied.
    const hasProof = unique.some(id => typeof id === "string" && evidence.get(id)?.entry.status === "completed" &&
      !["create_check_workspace", "read_task_evidence", "finish_standard_task"].includes(evidence.get(id)!.entry.name));
    check.evidence_ids = unique.filter(id => {
      const failed = typeof id === "string" ? evidence.get(id) : undefined;
      if (!failed || failed.entry.status !== "failed" || !hasProof) return true;
      const replacement = failed.entry.name !== "create_check_workspace" ? ledger.slice(failed.index + 1).find(e =>
        e.status === "completed" && signature(e) === signature(failed.entry)) : undefined;
      if (failed.entry.name !== "create_check_workspace" && !replacement) return true;
      excluded.push({ requirement_id, evidence_id: failed.entry.id,
        reason: replacement ? "A later successful execution of the same operation supersedes this failure; history remains available for audit." :
          "Workspace setup failed before any implementation check; successful implementation evidence is assessed separately.",
        ...(replacement ? { superseded_by: replacement.id } : {}) });
      repairs++;
      return false;
    });
  }
  return { checks: combined, excluded, repairs };
}
