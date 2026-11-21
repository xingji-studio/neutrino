/** Runtime-owned review partitions. Whole source requirements are never split or omitted. */
export interface ReviewRequirement { id: string; text: string }
export interface ReviewCheck { id: string; evidence_ids: string[] }
export interface ReviewGroup { id: string; requirement_ids: string[]; evidence_ids: string[] }

/** Small reviews stay single-pass. Partition large ones by shared evidence and risk,
 * then require an additional global independent verdict over the complete request. */
export function standardReviewGroups(requirements: ReviewRequirement[], checks: ReviewCheck[], evidence: Array<{ id: string; result: string; arguments: string }>): ReviewGroup[] {
  if (requirements.length < 6 || JSON.stringify(evidence).length < 12_000) return [];
  const ids = new Map(checks.map(c => [c.id, new Set(c.evidence_ids)]));
  const risk = (text: string) => /\b(?:private|confidential|secret|leak|provenance|permission|unauthori[sz]ed|never|must not|do not)\b|隐私|保密|泄露|溯源|权限|禁止|不得/i.test(text);
  const shared = (a: string, b: string) => [...(ids.get(a) ?? [])].filter(id => ids.get(b)?.has(id)).length;
  const ordered = [...requirements].sort((a, b) => Number(risk(b.text)) - Number(risk(a.text)));
  const first = ordered.shift()!;
  const second = [...ordered].sort((a, b) => shared(first.id, a.id) - shared(first.id, b.id) || Number(risk(a.text)) - Number(risk(b.text)))[0];
  const buckets = [[first], [second]];
  for (const requirement of ordered.filter(r => r !== second)) {
    const score = (bucket: ReviewRequirement[]) => bucket.reduce((n, r) => n + shared(r.id, requirement.id), 0) / bucket.length +
      (risk(bucket[0].text) === risk(requirement.text) ? 1 : 0);
    const room = Math.ceil(requirements.length / 2);
    const selected = buckets[0].length >= room ? 1 : buckets[1].length >= room ? 0 : score(buckets[0]) >= score(buckets[1]) ? 0 : 1;
    buckets[selected].push(requirement);
  }
  return buckets.map((bucket, i) => ({ id: `group${i + 1}`, requirement_ids: bucket.map(r => r.id),
    evidence_ids: [...new Set(bucket.flatMap(r => [...(ids.get(r.id) ?? [])]))] }));
}
