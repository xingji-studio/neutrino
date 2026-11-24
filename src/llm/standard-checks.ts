import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileHash } from "./editing.js";
import type { TaskRuntime, ToolEvidence } from "./runtime.js";
import type { ToolDefinition } from "./tools.js";

export const STANDARD_CHECK_TOOLS = new Set(["create_check_workspace", "run_task_check"]);
export const STANDARD_CHECK_DEFINITIONS: ToolDefinition[] = [
  { type: "function", function: { name: "create_check_workspace", description: "Create a unique empty test workspace inside the actual project. project_root explicitly selects an existing project directory; otherwise use the last observed project manifest's directory or the session directory. The actual destination passes the normal write approval and scope checks. Reuse its ID for checks; retain fixtures for audit. A directory permission error is an environment issue, not a failed implementation check.", parameters: {
    type: "object", properties: { label: { type: "string" }, project_root: { type: "string" }, reason: { type: "string" } }, required: ["reason"],
  } } },
  { type: "function", function: { name: "run_task_check", description: "Run a check in a previously created workspace. input_paths are project files already read/written with file tools, including the implementation under test. Runtime records their actual before/after hashes and the workspace's immutable input snapshot. This is declared dependency evidence, not proof of semantic coverage. Batch related assertions/input variations into one checker. Use reuse:true for ordinary repeated regressions only with the identical command, implementation, complete fixture snapshot and environment. New variants are not automatically independent reruns. Set independent:true only when a fresh execution is actually required; it always bypasses reuse. Cached aliases never satisfy a required independent execution.", parameters: {
    type: "object", properties: { workspace_id: { type: "string" }, command: { type: "string" },
      input_paths: { type: "array", items: { type: "string" }, minItems: 1 },
      reuse: { type: "boolean" }, independent: { type: "boolean" }, reason: { type: "string" },
    }, required: ["workspace_id", "command", "input_paths", "reason"],
  } } },
];

interface SnapshotFile { sha256: string; bytes: number; text?: string }
export interface CheckSnapshot { digest: string; files: Record<string, SnapshotFile> }
export interface RecordedCheck {
  id: string; evidenceId?: string; workspaceId: string; command: string;
  inputs: Map<string, string>; snapshot: CheckSnapshot; passed: boolean; inputsStable: boolean;
  result: string; environmentHash: string; independent: boolean;
}

/** Runtime-owned workspaces and immutable test inputs. No shell command is assumed to have complete dependencies. */
export class StandardChecks {
  private workspaces = new Map<string, { directory: string; label: string }>();
  private records = new Map<string, RecordedCheck>();
  private evidence = new Map<string, RecordedCheck>();
  private prepared = new Map<string, { id: string; root: string; requestedRoot: string; directory: string }>();
  constructor(private runtime: TaskRuntime, private authorizedFile: (raw: string) => string | undefined,
    private projectRoot: () => string = () => runtime.cwd) {}

  private prepare(args: Record<string, unknown>) {
    const key = JSON.stringify(args);
    const prior = this.prepared.get(key);
    if (prior) return prior;
    if (args.project_root !== undefined && (typeof args.project_root !== "string" || !args.project_root.trim())) throw new Error("project_root must be an existing project directory");
    const requestedRoot = path.resolve(this.runtime.cwd, typeof args.project_root === "string" ? args.project_root : this.projectRoot());
    const root = fs.realpathSync(requestedRoot);
    if (!fs.statSync(root).isDirectory()) throw new Error("project_root must be an existing project directory");
    const id = randomUUID(), directory = path.join(root, `.neutrino-check-${id}`);
    const prepared = { id, root, requestedRoot, directory };
    if (this.prepared.size >= 16) this.prepared.delete(this.prepared.keys().next().value!);
    this.prepared.set(key, prepared);
    return prepared;
  }

  create(args: Record<string, unknown>): string {
    this.runtime.check();
    const { id, root, requestedRoot, directory } = this.prepare(args);
    this.prepared.delete(JSON.stringify(args));
    if (fs.realpathSync(requestedRoot) !== root) throw new Error("Check project directory changed after approval; request a new workspace");
    this.runtime.assertTool("write_file", { path: directory });
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if (["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error(`Check workspace directory is not writable: ${root}. Select the intended authorized project with create_check_workspace.project_root; no implementation check ran.`, { cause: error });
      }
      throw error;
    }
    const workspace = { directory, label: String(args.label ?? "check").slice(0, 120) };
    this.workspaces.set(id, workspace);
    this.runtime.note("standard_check_workspace", { id, ...workspace });
    return JSON.stringify({ workspace_id: id, path: directory, project_root: root, label: workspace.label, retained_for_audit: true });
  }

  workspaceApprovalArguments(args: Record<string, unknown>): Record<string, unknown> {
    try { return { ...args, path: this.prepare(args).directory }; }
    catch { return { ...args, path: path.resolve(this.runtime.cwd, typeof args.project_root === "string" ? args.project_root : this.projectRoot()) }; }
  }

  approvalArguments(args: Record<string, unknown>): Record<string, unknown> {
    const workspace = this.workspaces.get(String(args.workspace_id ?? ""));
    if (!workspace || typeof args.command !== "string") return args;
    const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
    return { ...args, command: `cd ${quote(workspace.directory)} && ${args.command}` };
  }
  private snapshot(directory: string): CheckSnapshot {
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("Check workspace changed or resolves through a symlink");
    const files: Record<string, SnapshotFile> = Object.create(null);
    let bytes = 0, count = 0;
    const visit = (folder: string): void => {
      this.runtime.check();
      for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const target = path.join(folder, entry.name);
        if (entry.isSymbolicLink()) throw new Error("Check input snapshots cannot follow symlinks");
        if (entry.isDirectory()) { visit(target); continue; }
        if (!entry.isFile()) throw new Error("Check snapshots support regular files only");
        if (++count > 512) throw new Error("Check workspace exceeds the 512-file snapshot limit");
        const before = fs.lstatSync(target);
        if (bytes + before.size > 4_000_000) throw new Error("Check input snapshot exceeds 4 MB; use a smaller fixture");
        const content = fs.readFileSync(target);
        if (fs.realpathSync(target) !== target || fs.lstatSync(target).ino !== before.ino) throw new Error("Check input changed while snapshotting");
        bytes += content.length;
        const text = content.toString("utf8");
        files[path.relative(directory, target)] = { sha256: fileHash(content), bytes: content.length,
          ...(Buffer.from(text).equals(content) ? { text } : {}) };
      }
    };
    visit(directory);
    const digest = fileHash(JSON.stringify(Object.entries(files).map(([name, file]) => [name, file.sha256])));
    return { digest, files };
  }

  private inputs(raw: unknown): Map<string, string> {
    if (!Array.isArray(raw) || !raw.length || raw.length > 64 || raw.some(v => typeof v !== "string")) throw new Error("Supply 1-64 previously observed input_paths");
    const inputs = new Map<string, string>();
    for (const value of raw) {
      const file = this.authorizedFile(value);
      if (!file) throw new Error(`Check input must first be observed through an authorized file tool: ${value}`);
      this.runtime.assertTool("read_file", { path: file });
      inputs.set(file, fileHash(fs.readFileSync(file)));
    }
    return inputs;
  }
  private environment(): string {
    return fileHash(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
      env: Object.fromEntries(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))) }));
  }
  private current(inputs: Map<string, string>): boolean {
    return [...inputs].every(([file, hash]) => { try { return fs.realpathSync(file) === file && fs.lstatSync(file).isFile() && fileHash(fs.readFileSync(file)) === hash; } catch { return false; } });
  }

  async run(args: Record<string, unknown>, execute: (command: string, cwd: string) => Promise<string>): Promise<string> {
    this.runtime.check();
    const workspaceId = String(args.workspace_id ?? "");
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error("Unknown check workspace; create a unique workspace first");
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) throw new Error("A concrete check command is required");
    // Keep existing command and restricted-write policies authoritative.
    this.runtime.assertTool("run_command", this.approvalArguments(args));
    const inputs = this.inputs(args.input_paths);
    const snapshot = this.snapshot(workspace.directory);
    const environmentHash = this.environment();
    const prior = [...this.records.values()].reverse().find(r => r.passed && r.inputsStable && r.evidenceId &&
      r.workspaceId === workspaceId && r.command === command && r.environmentHash === environmentHash && r.snapshot.digest === snapshot.digest &&
      JSON.stringify([...r.inputs]) === JSON.stringify([...inputs]) && this.current(r.inputs));
    if (args.reuse === true && args.independent !== true && prior) {
      return JSON.stringify({ reused: true, check_id: prior.id, original_evidence_id: prior.evidenceId,
        result: prior.result, dependency_status: "declared_snapshot; semantic coverage still requires independent review" });
    }
    const id = randomUUID();
    // Full immutable fixture text remains in the journal, not in every model prompt.
    this.runtime.note("standard_check_snapshot", { id, workspaceId, inputs: Object.fromEntries(inputs), snapshot });
    const result = await execute(command, workspace.directory);
    let scopeStable = false;
    try {
      const after = this.snapshot(workspace.directory);
      scopeStable = Object.entries(snapshot.files).every(([name, file]) => after.files[name]?.sha256 === file.sha256);
    } catch { /* Mutated/escaped/oversized test inputs are not passing proof. */ }
    const inputsStable = this.current(inputs) && scopeStable && environmentHash === this.environment();
    const passed = inputsStable && !this.runtime.signal.aborted && !/^\[Error:|^Error:|\[exit code: (?!0\])/m.test(result);
    const record: RecordedCheck = { id, workspaceId, command, inputs, snapshot, passed, inputsStable, result,
      environmentHash, independent: args.independent === true };
    this.records.set(id, record);
    const body = JSON.stringify({ check_id: id, passed, inputs_stable: inputsStable, snapshot_id: id,
      declared_dependencies: Object.fromEntries(inputs), dependency_status: "declared_snapshot; external/dynamic dependencies are not automatically established",
      result });
    return passed ? body : `[Error: Check failed or its implementation inputs changed]\n${body}`;
  }

  observe(entry: ToolEvidence): void {
    if (entry.name !== "run_task_check") return;
    try {
      const start = entry.result.indexOf("{");
      const value = JSON.parse(entry.result.slice(start));
      const record = this.records.get(value.check_id);
      if (!record) return;
      if (!value.reused) record.evidenceId = entry.id;
      this.evidence.set(entry.id, record);
    } catch { /* Failed/unknown records never become check proof. */ }
  }
  proof(id: string): { current: boolean; record: RecordedCheck } | undefined {
    const record = this.evidence.get(id);
    if (!record) return;
    return { current: record.passed && record.inputsStable && record.environmentHash === this.environment() && this.current(record.inputs), record };
  }
  describe(id: string): unknown {
    const proof = this.proof(id);
    const invocation = proof && /^(?:node|bun|python(?:3)?)\s+(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s|$)/.exec(proof.record.command);
    const script = invocation && (invocation[1] ?? invocation[2] ?? invocation[3]);
    const workspace = proof && this.workspaces.get(proof.record.workspaceId);
    const relativeScript = script && workspace ? path.relative(workspace.directory, path.resolve(workspace.directory, script)) : undefined;
    const source = relativeScript && !relativeScript.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeScript)
      ? proof?.record.snapshot.files[relativeScript] : undefined;
    return proof ? { checker_source: source?.text !== undefined && source.text.length <= 8000
        ? { path: relativeScript, text: source.text, sha256: source.sha256, complete: true } : null,
      check_id: proof.record.id, original_evidence_id: proof.record.evidenceId, current: proof.current,
      scope: proof.record.workspaceId, environment_sha256: proof.record.environmentHash, inputs: Object.fromEntries(proof.record.inputs), snapshot_id: proof.record.id,
      command: proof.record.command, dependencies_complete: false, independent_execution_requested: proof.record.independent,
      note: "Runtime-captured declared inputs and immutable fixture snapshot. Review command/code for omitted dependencies and semantic coverage; aliases of one evidence ID are not independent executions." } : undefined;
  }
  readSnapshot(args: Record<string, unknown>): string {
    const record = this.records.get(String(args.check_id ?? ""));
    if (!record) return "[Error: unknown check snapshot]";
    const name = typeof args.path === "string" ? args.path : undefined;
    if (!name) return JSON.stringify({ check_id: record.id, files: Object.entries(record.snapshot.files).map(([path, f]) => ({ path, sha256: f.sha256, bytes: f.bytes })) });
    const file = Object.hasOwn(record.snapshot.files, name) ? record.snapshot.files[name] : undefined;
    if (!file || file.text === undefined) return "[Error: unknown or non-text snapshot file]";
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || Number(offset) < 0) return "[Error: invalid snapshot offset]";
    return JSON.stringify({ check_id: record.id, path: name, sha256: file.sha256, total_characters: file.text.length,
      content: file.text.slice(Number(offset), Number(offset) + 12_000), next_offset: Number(offset) + 12_000 < file.text.length ? Number(offset) + 12_000 : null });
  }
}
