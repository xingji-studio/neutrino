interface ReadPage {
  evidenceId: string; start: number; end: number; text: string;
}
interface ReadVersion {
  sha256: string; totalLines: number; pages: ReadPage[];
}
export interface CachedReviewRead { content: string; evidenceIds: string[]; eof: boolean }

/** Observations from real, approved independent reads; never new executions. */
export class StandardReadCache {
  private files = new Map<string, ReadVersion>();
  remember(file: string, sha256: string, content: string, evidenceId: string): boolean {
    const match = /^\[File [^\n]*; sha256=([a-f\d]{64}); lines (\d+)-(\d+) of (\d+)\]\n([\s\S]*)$/.exec(content);
    if (!match || match[1] !== sha256 || !evidenceId) return false;
    const start = Number(match[2]), end = Number(match[3]), totalLines = Number(match[4]);
    if (start < 1 || end < start || end > totalLines) return false;
    const rows = match[5].split("\n");
    if (rows.length !== end - start + 1 || rows.some((line, i) => !line.startsWith(`${start + i}: `))) return false;
    let version = this.files.get(file);
    if (!version || version.sha256 !== sha256 || version.totalLines !== totalLines) {
      version = { sha256, totalLines, pages: [] }; this.files.set(file, version);
    }
    version.pages.push({ evidenceId, start, end, text: match[5] });
    return true;
  }
  read(file: string, sha256: string, start: number, end: number): CachedReviewRead | undefined {
    const version = this.files.get(file);
    if (!version || version.sha256 !== sha256) return;
    const lines = new Map<number, { text: string; evidenceId: string }>();
    for (const page of version.pages) page.text.split("\n").forEach((text, i) => lines.set(page.start + i, { text, evidenceId: page.evidenceId }));
    const stop = Math.min(end, version.totalLines), ids = new Set<string>(), selected: string[] = [];
    if (start > version.totalLines) {
      // EOF only answers a redundant request after this entire version was read.
      for (let i = 1; i <= version.totalLines; i++) {
        const row = lines.get(i); if (!row) return; ids.add(row.evidenceId);
      }
      return { content: JSON.stringify({ source: "independent_read_cache", file, sha256, total_lines: version.totalLines,
        eof: true, content: "Requested range is beyond EOF. This complete file version was previously read; use the original evidence to inspect any omitted details.",
        original_evidence_ids: [...ids] }), evidenceIds: [...ids], eof: true };
    }
    for (let i = start; i <= stop; i++) {
      const row = lines.get(i); if (!row) return;
      selected.push(row.text); ids.add(row.evidenceId);
    }
    let content = JSON.stringify({ source: "independent_read_cache", file, sha256, lines: [start, stop], total_lines: version.totalLines,
      content: selected.join("\n"), original_evidence_ids: [...ids], note: "Reused observation; no new read or independent check was executed." });
    if (content.length > 12_000) {
      let excerpt = content.slice(0, 5000);
      const page = () => JSON.stringify({ source: "independent_read_cache", file, sha256, original_evidence_ids: [...ids],
        excerpt, truncated: true, full_record_tool: "read_task_evidence", note: "Page through the original evidence IDs for any omitted details; no new independent execution." });
      content = page();
      while (content.length > 12_000 && excerpt.length) { excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2)); content = page(); }
    }
    return { content, evidenceIds: [...ids], eof: false };
  }
  index(current: (file: string) => string | null): unknown[] {
    return [...this.files].filter(([file, version]) => current(file) === version.sha256).map(([file, version]) => ({
      file, sha256: version.sha256, total_lines: version.totalLines,
      ranges: version.pages.map(page => ({ start: page.start, end: page.end, evidence_id: page.evidenceId })),
    }));
  }
}
