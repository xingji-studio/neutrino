import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assert, defaults, ID, object, readManifest, safeFile, satisfies, validateValue } from "./validation.js";
import type { InstalledPlugin, PluginActivation, PluginRecord, Profile, PublicPlugin, JsonObject } from "./types.js";
import { unpackPlugin } from "./package.js";

interface ProfileState {
  plugins: Record<string, PluginActivation>;
  workspaces: Record<string, Record<string, PluginActivation>>;
  providers: Record<string, string>;
}
interface State { version: 1; revision: number; packages: Record<string, InstalledPlugin>; profiles: Record<Profile, ProfileState> }
export function pluginHome(): string { return process.env.NEUTRINO_PLUGIN_HOME || path.join(process.env.NEUTRINO_HOME || path.join(os.homedir(), ".neutrino"), "plugins"); }
export function safeMode(): boolean { return process.env.NEUTRINO_SAFE_MODE === "1"; }
function profileState(): ProfileState { return { plugins: {}, workspaces: {}, providers: {} }; }
function readState(): State {
  const file = path.join(pluginHome(), "state.json");
  if (!fs.existsSync(file)) return { version: 1, revision: 0, packages: {}, profiles: { standard: profileState(), pro: profileState() } };
  const s = JSON.parse(fs.readFileSync(file, "utf8")) as State;
  assert(s.version === 1 && object(s.packages) && object(s.profiles) && object(s.profiles.standard) && object(s.profiles.pro), "Invalid plugin state; use --safe-mode and restore state.json");
  return s;
}
function transaction<T>(change: (state: State) => T, expectedRevision?: number): T {
  fs.mkdirSync(pluginHome(), { recursive: true, mode: 0o700 });
  const lock = path.join(pluginHome(), ".lock");
  try { fs.mkdirSync(lock); } catch { throw new Error("Plugin state is being changed by another process; retry after it completes"); }
  const temporary = path.join(pluginHome(), `state.${randomUUID()}.tmp`);
  try {
    const state = readState();
    assert(expectedRevision === undefined || state.revision === expectedRevision, "Plugin state changed; refresh before saving");
    const result = change(state);
    // An upgrade may remove a capability's enabled dependency or change its major version.
    for(const profile of Object.values(state.profiles)) for(const values of [profile.plugins,...Object.values(profile.workspaces)]) {
      let changed=true;
      while(changed) {
        changed=false;const effective={...profile.plugins,...values};
        for(const record of Object.values(state.packages)) if(effective[record.manifest.id]?.enabled && Object.entries(record.manifest.dependencies??{}).some(([id,range])=>!state.packages[id]||!effective[id]?.enabled||!satisfies(state.packages[id].manifest.version,range))) {
          values[record.manifest.id]={...effective[record.manifest.id],enabled:false};changed=true;
        }
      }
    }
    state.revision++;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, path.join(pluginHome(), "state.json"));
    return result;
  } finally { fs.rmSync(temporary, { force: true }); fs.rmdirSync(lock); }
}
function workspaceKey(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const canonical = fs.realpathSync(cwd);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
function activation(state: State, id: string, profile: Profile, cwd?: string): PluginActivation {
  const base = state.profiles[profile].plugins[id] ?? { enabled: false, config: {} };
  const key = workspaceKey(cwd);
  const local = key ? state.profiles[profile].workspaces[key]?.[id] : undefined;
  return local ? { ...base, ...local, config: { ...base.config, ...local.config } } : structuredClone(base);
}
function table(state: State, profile: Profile, cwd?: string): Record<string, PluginActivation> {
  const key = workspaceKey(cwd);
  return key ? state.profiles[profile].workspaces[key] ??= {} : state.profiles[profile].plugins;
}
/** Re-hash the immutable package so a post-install edit invalidates native trust. */
export function packageIntegrity(directory: string): string {
  const hash = createHash("sha256");
  let files = 0, bytes = 0;
  const visit = (dir: string, rel = "") => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : 1)) {
      if ([".git", "node_modules", ".DS_Store"].includes(item.name)) continue;
      const name = path.posix.join(rel, item.name), file = path.join(dir, item.name);
      assert(!item.isSymbolicLink(), "Plugin packages cannot contain symlinks");
      if (item.isDirectory()) { visit(file, name); continue; }
      assert(item.isFile(), "Plugin packages must contain regular files");
      const data = fs.readFileSync(file);
      assert(++files <= 2000 && (bytes += data.length) <= 32 * 1024 * 1024, "Plugin exceeds 2000 files or 32 MiB");
      hash.update(name).update("\0").update(String(data.length)).update("\0").update(data);
    }
  };
  visit(directory);
  return `sha256-${hash.digest("hex")}`;
}
export function installPlugin(source: string, expectedRevision?: number, sourceLabel?:string): PublicPlugin {
  if(fs.statSync(source).isFile()) {
    const archive=fs.realpathSync(source),unpacked=unpackPlugin(archive);
    try { return installPlugin(unpacked.directory,expectedRevision,archive); }
    finally {unpacked.dispose();}
  }
  assert(typeof source === "string" && path.isAbsolute(path.resolve(source)), "A local plugin directory is required");
  const directory = fs.realpathSync(path.resolve(source));
  assert(fs.statSync(directory).isDirectory(), "Plugin source must be a directory");
  const manifest = readManifest(directory);
  const integrity = packageIntegrity(directory);
  let target = path.join(pluginHome(), "packages", manifest.id, `${manifest.version}-${integrity.slice(7, 23)}`);
  if(fs.existsSync(target) && packageIntegrity(target)!==integrity) target+=`-repair-${randomUUID().slice(0,8)}`;
  // Never copy a package directory into itself (also bounds recursive installs).
  assert(!path.resolve(pluginHome()).startsWith(directory + path.sep) && directory !== path.resolve(pluginHome()), "Plugin source cannot contain its installation home");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(target)) {
    const staging = `${target}.${randomUUID()}.tmp`;
    try {
      fs.cpSync(directory, staging, { recursive: true, filter: file => ![".git", "node_modules", ".DS_Store"].includes(path.basename(file)) });
      assert(packageIntegrity(staging) === integrity, "Plugin source changed during installation; retry");
      readManifest(staging);
      fs.renameSync(staging, target);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  transaction(state => {
    const old = state.packages[manifest.id];
    const previous = old && old.integrity !== integrity ? (({ previous: _, ...rest }) => rest)(old) : old?.previous;
    state.packages[manifest.id] = { manifest, directory: target, integrity, source: sourceLabel ?? directory, installedAt: new Date().toISOString(), ...(previous ? { previous } : {}) };
    const newPermissions=(manifest.permissions??[]).some(p=>!old?.manifest.permissions?.includes(p));
    if(old && old.integrity!==integrity && (newPermissions || manifest.runtime === "native")) for(const profile of Object.values(state.profiles)) {
      const entries=[profile.plugins,...Object.values(profile.workspaces)];
      for(const values of entries)if(values[manifest.id])values[manifest.id]={...values[manifest.id],enabled:false,nativeTrust:undefined};
    }
  }, expectedRevision);
  return listPlugins().plugins.find(p => p.manifest.id === manifest.id)!;
}
export function listPlugins(profile: Profile = "standard", cwd?: string): { revision: number; safeMode: boolean; plugins: PublicPlugin[]; providers: Record<string,string> } {
  const state = readState();
  const plugins = Object.values(state.packages).map(record => {
    const a = activation(state, record.manifest.id, profile, cwd);
    let error: string | undefined;
    try { checkRecord(record, a, profile); } catch (e) { error = String((e as Error).message); }
    return { manifest: record.manifest, integrity: record.integrity, source: record.source, installedAt: record.installedAt,
      enabled: a.enabled, config: { ...defaults(record.manifest.configuration), ...a.config }, error, rollback: Boolean(record.previous) };
  }).sort((a,b) => a.manifest.id.localeCompare(b.manifest.id));
  return { revision: state.revision, safeMode: safeMode(), plugins, providers: state.profiles[profile].providers };
}
function checkRecord(record: InstalledPlugin, a: PluginActivation, profile: Profile): void {
  assert(record.manifest.profiles === undefined || record.manifest.profiles.includes(profile), `Plugin does not support ${profile}`);
  assert(packageIntegrity(record.directory) === record.integrity, "Installed files changed; reinstall the plugin");
  if (a.enabled && record.manifest.runtime === "native" && record.manifest.entries?.agent) assert(a.nativeTrust === record.integrity, "Native code trust is required for this exact package revision");
  if (record.manifest.configuration) validateValue({ ...defaults(record.manifest.configuration), ...a.config }, record.manifest.configuration);
}
export function configurePlugin(id: string, patch: { enabled?: boolean; config?: JsonObject; trustNative?: boolean }, profile: Profile = "standard", cwd?: string, revision?: number): void {
  assert(ID.test(id), "Invalid plugin id");
  assert(patch.enabled === undefined || typeof patch.enabled === "boolean", "enabled must be boolean");
  assert(patch.config === undefined || object(patch.config), "Plugin config must be an object");
  transaction(state => {
    const record = state.packages[id]; assert(record, "Unknown plugin");
    const old = activation(state, id, profile, cwd);
    const next = { ...old, ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }), ...(patch.config === undefined ? {} : { config: patch.config }) };
    if (patch.trustNative === true) next.nativeTrust = record.integrity;
    if(next.enabled || patch.config !== undefined) checkRecord(record, next, profile);
    if (next.enabled) {
      for (const [dependency, range] of Object.entries(record.manifest.dependencies ?? {})) {
        assert(state.packages[dependency] && activation(state, dependency, profile, cwd).enabled && satisfies(state.packages[dependency].manifest.version, range), `Enable compatible dependency ${dependency}@${range} first`);
      }
    } else {
      for (const other of Object.values(state.packages)) if (activation(state, other.manifest.id, profile, cwd).enabled && other.manifest.dependencies?.[id]) throw new Error(`${other.manifest.id} depends on this plugin; disable it first`);
    }
    table(state, profile, cwd)[id] = next;
    resolveRecords(state, profile, cwd); // cycles fail before persistence
  }, revision);
}
export function removePlugin(id: string, revision?: number): void {
  transaction(state => {
    assert(ID.test(id) && state.packages[id], "Unknown plugin");
    for (const other of Object.values(state.packages)) assert(other.manifest.id === id || !other.manifest.dependencies?.[id], `${other.manifest.id} depends on this plugin; remove the dependent first`);
    delete state.packages[id];
    for (const p of Object.values(state.profiles)) { delete p.plugins[id]; for (const local of Object.values(p.workspaces)) delete local[id]; for (const [slot, provider] of Object.entries(p.providers)) if (provider.startsWith(`${id}/`)) delete p.providers[slot]; }
    // Keep immutable package files for in-flight tasks and rollback/debugging.
  }, revision);
}
export function rollbackPlugin(id: string, revision?: number): void {
  transaction(state => { const current = state.packages[id]; assert(current?.previous, "No previous plugin version"); const { previous, ...now } = current; state.packages[id] = { ...previous, previous: now }; }, revision);
}
export function selectProvider(slot: string, provider: string, profile: Profile, revision?: number): void {
  assert(["chat.composer", "chat.message.renderer", "chat.card.plan", "chat.card.tool", "persona"].includes(slot), "This slot is not replaceable");
  transaction(state => { assert(typeof provider === "string" && provider.length <= 160, "Invalid provider"); if (provider) state.profiles[profile].providers[slot] = provider; else delete state.profiles[profile].providers[slot]; }, revision);
}
function resolveRecords(state: State, profile: Profile, cwd?: string): PluginRecord[] {
  const active = new Map(Object.entries(state.packages).filter(([id]) => activation(state, id, profile, cwd).enabled));
  const done = new Set<string>(), visiting = new Set<string>(), output: PluginRecord[] = [];
  const visit = (id: string) => {
    if (done.has(id)) return;
    assert(!visiting.has(id), `Plugin dependency cycle at ${id}`);
    visiting.add(id);
    const record = active.get(id)!;
    for (const [dep, range] of Object.entries(record.manifest.dependencies ?? {})) { assert(active.has(dep) && satisfies(active.get(dep)!.manifest.version, range), `Missing dependency ${dep}@${range}`); visit(dep); }
    for (const [dep, range] of Object.entries(record.manifest.optionalDependencies ?? {})) if (active.has(dep) && satisfies(active.get(dep)!.manifest.version, range)) visit(dep);
    visiting.delete(id); done.add(id);
    output.push({ ...record, activation: activation(state, id, profile, cwd) });
  };
  for (const id of [...active.keys()].sort()) visit(id);
  return output;
}
export function pluginRecords(profile: Profile = "standard", cwd?: string): PluginRecord[] {
  if (safeMode()) return [];
  return resolveRecords(readState(), profile, cwd).map(record => { try { checkRecord(record, record.activation, profile); return record; } catch (e) { return { ...record, error: (e as Error).message }; } });
}
export function providerSelections(profile: Profile): Record<string,string> { return safeMode() ? {} : readState().profiles[profile].providers; }
export function pluginAsset(id: string, file: string, profile: Profile, cwd?: string): string {
  const record = pluginRecords(profile, cwd).find(r => r.manifest.id === id && !r.error);
  assert(record, "Plugin is disabled or unavailable");
  // Only assets explicitly used by a UI contribution may reach browsers.
  const allowed = new Set([...(record.manifest.contributes?.ui ?? []).map(u => u.view), record.manifest.entries?.web,...record.manifest.webAssets ?? []]);
  assert(allowed.has(file), "Asset is not a declared plugin view");
  const resolved = safeFile(record.directory, file);
  assert(fs.statSync(resolved).size <= 1_000_000, "Plugin view exceeds 1 MB");
  return fs.readFileSync(resolved, "utf8");
}
export function pluginStorage(id: string, key: string, value?: unknown, write = false): unknown {
  assert(ID.test(id) && /^[a-zA-Z0-9_.-]{1,80}$/.test(key) && key !== "..", "Invalid storage key");
  const dir = path.join(pluginHome(), "data", id); const file = path.join(dir, `${key}.json`);
  if (!write) return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const body = JSON.stringify(value ?? null); assert(body.length <= 256_000, "Plugin storage value exceeds 256 KB");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files=fs.readdirSync(dir).filter(name=>name.endsWith(".json"));
  assert(files.length<128 || fs.existsSync(file),"Plugin storage exceeds 128 keys");
  const otherBytes=files.filter(name=>name!==`${key}.json`).reduce((sum,name)=>sum+fs.statSync(path.join(dir,name)).size,0);
  assert(otherBytes+Buffer.byteLength(body)<=8*1024*1024,"Plugin storage exceeds 8 MiB");
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, body, { mode: 0o600 }); fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
}
