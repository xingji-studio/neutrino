import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fastDataInput, fastDataOutput, fastDataRoot, relocateFastCaptures, resolveFastCapture } from "./fast-data-paths.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-fast-data-paths-"));
const previous = process.env.NEUTRINO_FAST_DATA_DIR, argv = [...process.argv];
try {
  process.argv.splice(2);
  process.env.NEUTRINO_FAST_DATA_DIR = root;
  fs.mkdirSync(path.join(root, "docs", "traces"), { recursive: true });
  const archived = path.join(root, "docs", "traces", "sample.jsonl");
  fs.writeFileSync(archived, "original hash-bound record\n");
  assert.equal(fastDataInput("traces/sample.jsonl"), archived);
  const generated = fastDataOutput("traces/sample.jsonl");
  assert.equal(path.relative(root, generated), path.join("generated", "traces", "sample.jsonl"));
  fs.writeFileSync(generated, "new analysis\n");
  assert.equal(fastDataInput("traces/sample.jsonl"), generated);
  assert.equal(resolveFastCapture("/old/project/docs/traces/sample.jsonl"), archived,
    "historical references keep their archived records even when a newer report has the same name");
  assert.equal(fs.readFileSync(archived, "utf8"), "original hash-bound record\n");
  fs.rmSync(generated);
  assert.equal(resolveFastCapture("Z:\\capture\\docs\\traces\\sample.jsonl"), archived);
  assert.equal(resolveFastCapture("/old/project/docs/traces/sample.jsonl"), archived);
  assert.equal(resolveFastCapture("docs/traces/sample.jsonl"), archived);
  assert.throws(() => resolveFastCapture("/outside/absent-record"), /Cannot locate archived/);
  for (const name of ["../outside", path.resolve(root, "..", "outside")]) {
    assert.throws(() => fastDataOutput(name), /relative filename/);
  }
  const raw = { scenarios: [{ samples: { fast_dag: [{ trace_file: "/old/project/docs/traces/sample.jsonl",
    artifacts: { directory: "/old/project/docs/traces" } }] } }] };
  const original = structuredClone(raw), relocated = relocateFastCaptures(raw);
  assert.deepEqual(raw, original, "capture-time records are immutable");
  assert.equal(relocated.scenarios[0].samples.fast_dag[0].trace_file, archived);
  assert.equal(relocated.scenarios[0].samples.fast_dag[0].artifacts.directory, path.join(root, "docs", "traces"));
  process.argv.push("--data-dir", path.join(root, "explicit"));
  assert.equal(fastDataRoot(), path.join(root, "explicit"), "CLI configuration overrides the environment");
  process.argv.pop();
  assert.throws(() => fastDataRoot(), /requires an archive directory/);
  if (process.platform !== "win32") {
    process.argv.push("G:\\测试数据存档\\neutrino-fast");
    assert.throws(() => fastDataRoot(), /Windows Node/, "a Windows path must not become a relative WSL directory");
  }
  console.log("PASS Fast data paths: external output, immutable archive, captured path relocation, missing data, traversal and CLI precedence");
} finally {
  process.argv.splice(0, process.argv.length, ...argv);
  if (previous === undefined) delete process.env.NEUTRINO_FAST_DATA_DIR;
  else process.env.NEUTRINO_FAST_DATA_DIR = previous;
  fs.rmSync(root, { recursive: true, force: true });
}
