/** Protocol errors belong to the reviewer, not to the implementation under review. */
export type ReviewErrorCode = "output_limit" | "invalid_assessment" | "model_error";
export class ReviewExecutionError extends Error {
  constructor(readonly code: ReviewErrorCode, message: string) { super(message); this.name = "ReviewExecutionError"; }
}
export interface ReviewReadRequest {
  evidence_id?: string; check_id?: string; path?: string; offset?: number; start_line?: number; end_line?: number;
}
export interface ReviewVerdict {
  accepted?: boolean;
  unresolved?: string[];
  reason: string;
  read_requests?: ReviewReadRequest[];
  scope_assessments?: Array<{ check_id: string; dependencies_complete: boolean; reason: string }>;
  coverage_assessments?: Array<{ requirement_id: string; coverage_complete: boolean; evidence_ids: string[];
    reason: string; dependencies_complete?: boolean; input_paths?: string[] }>;
}
export class ReviewFinding extends Error {
  constructor(message: string, readonly requests?: ReviewReadRequest[]) { super(message); this.name = "ReviewFinding"; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty);
const integer = (value: unknown, minimum: number) => value === undefined || (Number.isSafeInteger(value) && Number(value) >= minimum);

/** Parse only a complete JSON value. Never salvage an accepted flag from truncated text. */
export function parseReviewVerdict(answer: string): ReviewVerdict {
  const invalid = () => new ReviewExecutionError("invalid_assessment", "Independent completion review returned an invalid assessment.");
  let value: unknown;
  try { value = JSON.parse(answer.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")); }
  catch { throw invalid(); }
  if (!object(value) || !nonempty(value.reason)) throw invalid();
  if (value.read_requests !== undefined) {
    if (!Array.isArray(value.read_requests) || !value.read_requests.length || value.read_requests.length > 4 || value.accepted === true ||
        value.read_requests.some(q => !object(q) || !integer(q.offset, 0) || !integer(q.start_line, 1) || !integer(q.end_line, 1) ||
          (q.evidence_id !== undefined ? !nonempty(q.evidence_id) || q.check_id !== undefined :
            q.check_id !== undefined ? !nonempty(q.check_id) || (q.path !== undefined && !nonempty(q.path)) : !nonempty(q.path)))) throw invalid();
  } else if (typeof value.accepted !== "boolean" || !strings(value.unresolved) || (value.accepted && value.unresolved.length)) throw invalid();
  if (value.scope_assessments !== undefined && (!Array.isArray(value.scope_assessments) || value.scope_assessments.some(a =>
    !object(a) || !nonempty(a.check_id) || typeof a.dependencies_complete !== "boolean" || !nonempty(a.reason)))) throw invalid();
  if (value.coverage_assessments !== undefined && (!Array.isArray(value.coverage_assessments) || value.coverage_assessments.some(a =>
    !object(a) || !nonempty(a.requirement_id) || typeof a.coverage_complete !== "boolean" || !strings(a.evidence_ids) || !nonempty(a.reason) ||
    (a.dependencies_complete !== undefined && typeof a.dependencies_complete !== "boolean") ||
    (a.input_paths !== undefined && !strings(a.input_paths))))) throw invalid();
  return value as unknown as ReviewVerdict;
}

/** A recovery changes presentation only; the full objective, evidence IDs and limits stay fixed. */
export function reviewRecoveryInstruction(code: ReviewErrorCode): string {
  return ` The previous reviewer response failed (${code}); this is a review execution error, not an implementation defect. ` +
    'Reassess the same evidence and return one complete JSON object only. Keep reason and each assessment reason to one short sentence. ' +
    'Return either {"accepted":boolean,"unresolved":[string],"reason":string,"scope_assessments":[],"coverage_assessments":[]} ' +
    'or {"read_requests":[one to four requests],"reason":string}. Preserve all necessary assessments and uncertainty. Do not restate code or the report.';
}
