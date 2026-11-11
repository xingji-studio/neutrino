// Generated test data stays outside the source tree. Archived records are never rewritten here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function fastDataRoot() {
  const index = process.argv.indexOf("--data-dir");
  const configured = index < 0 ? process.env.NEUTRINO_FAST_DATA_DIR : process.argv[index + 1];
  if (index >= 0 && (!configured || configured.startsWith("--"))) throw new Error("--data-dir requires an archive directory");
  if (configured && process.platform !== "win32" && (/^[a-z]:[\\/]/i.test(configured) || configured.startsWith("\\\\"))) {
    throw new Error("Use Windows Node for a Windows data directory, or provide its mounted WSL path");
  }
  return path.resolve(configured || path.join(os.tmpdir(), "neutrino-fast-data"));
}

function underRoot(directory, name) {
  const file = path.resolve(directory, name), relative = path.relative(directory, file);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Use a relative filename inside the Fast data directory");
  }
  return file;
}

/** Prefer newly generated records; the original archive keeps the project-relative docs/ layout. */
export function fastDataInput(name) {
  const generated = underRoot(path.join(fastDataRoot(), "generated"), name);
  return fs.existsSync(generated) ? generated : underRoot(path.join(fastDataRoot(), "docs"), name);
}

/** Default output goes to a separate generated/ directory, never to the archived docs/ snapshot. */
export function fastDataOutput(name) {
  const file = underRoot(path.join(fastDataRoot(), "generated"), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** Resolve capture-time absolute paths without modifying hash-bound historical JSON or tool evidence. */
export function resolveFastCapture(savedPath) {
  if (fs.existsSync(savedPath)) return savedPath;
  const portable = savedPath.replaceAll("\\", "/");
  const index = portable.lastIndexOf("/docs/");
  const relative = index >= 0 ? portable.slice(index + 6) : portable.startsWith("docs/") ? portable.slice(5) : null;
  if (relative !== null) {
    const archived = underRoot(path.join(fastDataRoot(), "docs"), relative);
    if (fs.existsSync(archived)) return archived;
    const generated = underRoot(path.join(fastDataRoot(), "generated"), relative);
    if (fs.existsSync(generated)) return generated;
  }
  throw new Error("Cannot locate archived record " + savedPath + ". Set --data-dir or NEUTRINO_FAST_DATA_DIR to its archive root.");
}

export function relocateFastCaptures(raw) {
  const copy = structuredClone(raw);
  for (const row of copy.scenarios ?? []) for (const samples of Object.values(row.samples ?? {})) {
    for (const sample of samples) {
      if (sample.trace_file) sample.trace_file = resolveFastCapture(sample.trace_file);
      if (sample.artifacts?.directory) sample.artifacts.directory = resolveFastCapture(sample.artifacts.directory);
    }
  }
  return copy;
}
