import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastArtifact, FastOutput, FastSnapshot } from "./types.js";

/** Every turn has its own store; immutable versions remain available after invalidation. */
export class ArtifactStore {
  private history = new Map<string, FastArtifact[]>();
  private stable = new Map<string, { version: string; content: string }>();
  private persistenceStarted = false;
  private discarded = false;
  cacheHits = 0;
  constructor(private directory?: string) {}
  context(key: string, content: string): string {
    const version = createHash("sha256").update(content).digest("hex");
    const cached = this.stable.get(key);
    if (cached?.version === version) this.cacheHits++;
    else this.stable.set(key, { version, content });
    return version;
  }
  readContext(key: string): { version: string; content: string } | undefined {
    const value = this.stable.get(key);
    if (value) this.cacheHits++;
    return value ? { ...value } : undefined;
  }
  latest(id: string): FastArtifact | undefined {
    const item = this.history.get(id)?.at(-1);
    return item ? structuredClone(item) : undefined;
  }
  put(id: string, output: FastOutput, versions: Record<string, number | string>): FastArtifact {
    const versionsSoFar = this.history.get(id) ?? [];
    const artifact: FastArtifact = { ...structuredClone(output), task_id: id,
      version: versionsSoFar.length + 1, input_versions: { ...versions }, verification: "pending",
      created_at: new Date().toISOString() };
    versionsSoFar.push(artifact);
    this.history.set(id, versionsSoFar);
    this.persist();
    return structuredClone(artifact);
  }
  verify(id: string): void {
    const item = this.history.get(id)?.at(-1);
    if (!item || item.verification === "invalidated") throw new Error(`Cannot verify invalid artifact: ${id}`);
    item.verification = "verified";
    this.persist();
  }
  invalidate(id: string): void {
    const item = this.history.get(id)?.at(-1);
    if (item) item.verification = "invalidated";
    this.persist();
  }
  all(): FastArtifact[] { return structuredClone([...this.history.values()].flat()); }
  checkpoint(snapshot: FastSnapshot): void {
    if (!this.directory || !this.ensureDirectory()) return;
    const target = path.join(this.directory, "run.json"), temp = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 });
      fs.renameSync(temp, target);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  private persist(): void {
    if (!this.directory || !this.ensureDirectory()) return;
    const target = path.join(this.directory, "artifacts.json");
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ contexts: Object.fromEntries(this.stable), artifacts: this.all() }), { mode: 0o600 });
      fs.renameSync(temp, target);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  private ensureDirectory(): boolean {
    if (!this.directory || this.discarded) return false;
    if (this.persistenceStarted && !fs.existsSync(this.directory)) { this.discarded = true; return false; }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.persistenceStarted = true;
    return true;
  }
}
