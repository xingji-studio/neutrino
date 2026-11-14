import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function fileHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Optional line ranges leave the legacy whole-file response unchanged. */
export function readFileRange(file: string, args: Record<string, unknown>): string {
  const start = args.start_line ?? 1;
  const end = args.end_line;
  if (!Number.isSafeInteger(start) || Number(start) < 1 ||
      (end !== undefined && (!Number.isSafeInteger(end) || Number(end) < Number(start)))) {
    throw new Error("start_line/end_line must be positive integers with end_line >= start_line");
  }
  const bytes = fs.readFileSync(file);
  const lines = bytes.toString("utf8").split(/\r\n|\n|\r/);
  if (Number(start) > lines.length) throw new Error("start_line is beyond the end of the file");
  const stop = Math.min(end === undefined ? Number(start) + 199 : Number(end), lines.length);
  if (stop - Number(start) >= 2000) throw new Error("Read at most 2000 lines per range");
  const selected = lines.slice(Number(start) - 1, stop).map((line, i) => `${Number(start) + i}: ${line}`).join("\n");
  if (selected.length > 200_000) throw new Error("Range is too large; select a smaller range");
  return `[File ${file}; sha256=${fileHash(bytes)}; lines ${start}-${stop} of ${lines.length}]\n${selected}`;
}

/** Exact, version-bound edits: ambiguous/stale proposals never modify the file. */
export function editFile(file: string, args: Record<string, unknown>, signal?: AbortSignal): string {
  if (signal?.aborted) throw new Error("Edit cancelled");
  const expected = args.expected_sha256;
  const oldText = args.old_text;
  const newText = args.new_text;
  if (typeof expected !== "string" || !/^[a-f\d]{64}$/i.test(expected)) throw new Error("expected_sha256 is required; read the current file first");
  if (typeof oldText !== "string" || !oldText || typeof newText !== "string") throw new Error("old_text must be nonempty and new_text must be a string");
  const realFile = fs.realpathSync(file);
  const original = fs.readFileSync(realFile);
  if (fileHash(original) !== expected.toLowerCase()) throw new Error("File version changed; read it again before editing");
  const source = original.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(original)) throw new Error("edit_file supports UTF-8 text only");
  // Tool responses normalize newlines. Reconstitute uniform CRLF before an
  // exact match, preserving the untouched file and the replacement's style.
  const uniformCRLF = source.includes("\r\n") && !source.replace(/\r\n/g, "").includes("\n");
  const normalize = (text: string) => uniformCRLF ? text.replace(/\r\n|\n/g, "\r\n") : text;
  const match = normalize(oldText), replacement = normalize(newText);
  const at = source.indexOf(match);
  if (at < 0) throw new Error("old_text was not found; no edit applied");
  if (source.indexOf(match, at + 1) >= 0) throw new Error("old_text matches more than once; include unique surrounding context");
  const updated = source.slice(0, at) + replacement + source.slice(at + match.length);
  if (updated === source) return JSON.stringify({ path: file, changed: false, sha256: expected.toLowerCase() });
  const temporary = path.join(path.dirname(realFile), `.neutrino-edit-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, updated, { flag: "wx", mode: fs.statSync(realFile).mode & 0o777 });
    if (signal?.aborted) throw new Error("Edit cancelled");
    // Check again after staging, before the atomic replacement.
    if (fs.realpathSync(file) !== realFile || fileHash(fs.readFileSync(realFile)) !== expected.toLowerCase()) {
      throw new Error("File version changed while editing; no edit applied");
    }
    fs.renameSync(temporary, realFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return JSON.stringify({ path: file, changed: true, sha256: fileHash(updated) });
}
