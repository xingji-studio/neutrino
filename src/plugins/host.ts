import fs from "node:fs";
import { fork, type ChildProcess } from "node:child_process";
import { AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defaults, assert, NAME, object, safeFile, validatePrompt, validateSchema, validateUI, validateValue } from "./validation.js";
import { pluginRecords, pluginStorage, providerSelections } from "./manager.js";
import type { ToolDefinition } from "../llm/tools.js";
import type { Effect, EventName, InvocationContext, JsonObject, PluginPin, PluginRecord, PluginScope, Profile, PromptContribution, UIContribution } from "./types.js";

interface Registered { kind: string; handler: string; [key: string]: unknown }
interface Owned { record: PluginRecord; worker?: PluginWorker }
interface Tool extends Owned { definition: ToolDefinition; handler: string; effects: Effect[]; roles?: string[] }
interface Command extends Owned { handler: string; name: string; description: string; parameters: JsonObject; effects: Effect[] }
interface Listener extends Owned { handler: string; name: string }
export interface OwnedUI extends UIContribution { pluginId: string; key: string; entry?: string; permissions: string[] }
export interface Skill { id: string; name: string; description: string; text: string; pluginId: string }
interface HostOptions {
  scope: PluginScope;
  context?(): InvocationContext;
  broker?(name: string, args: JsonObject, signal?: AbortSignal): Promise<unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  allowNative?(): boolean;
}
const EFFECTS = ["filesystem.read", "filesystem.write", "network", "process"];
const EXCLUSIVE = new Set(["chat.composer", "chat.message.renderer", "chat.card.plan", "chat.card.tool"]);

class PluginWorker {
  private child: ChildProcess;
  private readyResolve!: (items: Registered[]) => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<Registered[]>;
  private current?: { id: number; resolve(value: unknown): void; reject(error: Error): void; operation(op: string, args: JsonObject): Promise<unknown>; timer?: ReturnType<typeof setTimeout>; abort(): void; signal?: AbortSignal; operations: number; calls:number; stop: AbortController };
  private sequence = 0;
  private queue = Promise.resolve();
  private operationQueue = Promise.resolve();
  private closed = false;
  private initTimer: ReturnType<typeof setTimeout>;
  constructor(private record: PluginRecord, scope: PluginScope, private timeout: number, private log: (message: string) => void) {
    this.ready = new Promise((resolve,reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.child = fork(fileURLToPath(new URL("./runner.js", import.meta.url)), [], { cwd: record.directory,
      stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: ["--max-old-space-size=128"], ...{ windowsHide: true },
      env: record.manifest.runtime === "native" ? process.env : { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    this.initTimer = setTimeout(() => this.fail(new Error("Plugin activation timed out")), timeout);
    this.child.stderr?.on("data", data => this.log(String(data).slice(0, 1000)));
    this.child.on("error", error => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("Plugin process exited")));
    this.child.on("message", message => { void this.receive(message as Record<string,unknown>).catch(error=>this.fail(error instanceof Error?error:new Error(String(error)))); });
    this.child.send({ type: "init", initial: { id: record.manifest.id, entry: safeFile(record.directory, record.manifest.entries!.agent!), runtime: record.manifest.runtime ?? "sandbox", config: { ...defaults(record.manifest.configuration), ...record.activation.config }, scope } });
  }
  private resetTimer(): void {
    if (!this.current) return;
    clearTimeout(this.current.timer);
    this.current.timer = setTimeout(() => this.fail(new Error("Plugin callback timed out")), this.timeout);
  }
  private async receive(m: Record<string,unknown>): Promise<void> {
    assert(object(m),"Invalid plugin protocol message");
    if (m.type === "ready") { clearTimeout(this.initTimer); this.readyResolve(m.registrations as Registered[]); }
    else if (m.type === "fatal") this.fail(new Error(String(m.error)));
    else if (m.type === "result" && this.current?.id === m.id) {
      const c = this.current!; this.current = undefined;
      clearTimeout(c.timer); c.signal?.removeEventListener("abort", c.abort);
      if (c.operations) { c.stop.abort(); c.reject(new Error("Plugin returned with unawaited host operations")); }
      else if (m.error) c.reject(new Error(String(m.error))); else c.resolve(m.value);
    } else if (m.type === "operation") {
      const c = this.current;
      if (m.op === "log") { this.log(String((m.value as JsonObject)?.message ?? "").slice(0,4000)); this.reply(m.id, null); return; }
      if (!c) {
        if(["storage.get","storage.set"].includes(String(m.op)) && this.record.manifest.permissions?.includes("storage")) {
          try{const args=m.value as JsonObject;this.reply(m.id,pluginStorage(this.record.manifest.id,String(args.key),args.value,m.op==="storage.set"));}catch(e){this.reply(m.id,undefined,(e as Error).message);}return;
        }
        this.reply(m.id, undefined, "Host operations are available only inside an awaited callback"); return;
      }
      if(++c.calls>256 || c.operations>=64) { this.fail(new Error("Plugin exceeded host operation limits"));return; }
      c.operations++; clearTimeout(c.timer);
      const operation=this.operationQueue.then(async()=>{assert(this.current === c && !c.stop.signal.aborted,"Plugin callback already ended");return c.operation(String(m.op),(m.value??{}) as JsonObject);});
      this.operationQueue=operation.then(()=>{},()=>{});
      try { this.reply(m.id, await operation); }
      catch (e) { this.reply(m.id, undefined, (e as Error).message); }
      finally { c.operations--; if (this.current === c && !c.operations) this.resetTimer(); }
    }
  }
  private reply(id: unknown, value: unknown, error?: string): void { if (this.child.connected) this.child.send({ type: "operation-result", id, value, error }); }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.initTimer); this.readyReject(error);
    if (this.current) { const c = this.current; this.current = undefined; clearTimeout(c.timer); c.stop.abort(error); c.signal?.removeEventListener("abort", c.abort); c.reject(error); }
    this.child.kill("SIGKILL");
  }
  invoke(handler: string, value: unknown, context: InvocationContext, operation: (op: string,args: JsonObject,signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
    const stop = new AbortController();
    const boundOperation = AsyncResource.bind((op: string,args: JsonObject) => operation(op,args,stop.signal));
    const { signal, ...wire } = context;
    const boundInvoke = AsyncResource.bind(() => new Promise<unknown>((resolve,reject) => {
      if (this.closed) { reject(new Error("Plugin is unavailable")); return; }
      const abort = () => this.fail(new Error("Plugin callback cancelled"));
      this.current = { id: ++this.sequence, resolve, reject, operation: boundOperation, abort, signal, operations: 0, calls:0, stop };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      this.resetTimer();
      this.child.send({ type: "invoke", id: this.sequence, handler, value, context: wire });
    }));
    const result = this.queue.then(boundInvoke);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  async dispose(): Promise<void> {
    if (this.closed) return;
    await this.queue;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.fail(new Error("Plugin cleanup timed out")); resolve(); }, 1000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      if (this.child.connected) this.child.send({ type: "dispose" }); else { clearTimeout(timer); resolve(); }
    });
    this.closed = true;
  }
}

/** One frozen plugin composition per turn, shared by both frontends and all child scopes. */
export class PluginHost {
  readonly tools = new Map<string, Tool>();
  readonly commands = new Map<string, Command>();
  readonly ui: OwnedUI[] = [];
  readonly skills: Skill[] = [];
  readonly pins: PluginPin[] = [];
  readonly diagnostics: string[] = [];
  readonly prompts: Array<PromptContribution & { pluginId: string }> = [];
  readonly theme: Record<string,string> = {};
  private workers: PluginWorker[] = [];
  private hooks: Listener[] = [];
  private events: Listener[] = [];
  private disposed = false;
  get profile():Profile { return this.options.scope.profile; }
  private constructor(private options: HostOptions, readonly providers: Record<string,string>) {}
  static async create(options: HostOptions): Promise<PluginHost> {
    let providers:Record<string,string>={};
    try{providers=providerSelections(options.scope.profile);}catch(e){const host=new PluginHost(options,{});host.report("host",(e as Error).message);return host;}
    const host = new PluginHost(options, providers);
    let records: PluginRecord[];
    try { records = pluginRecords(options.scope.profile, options.scope.cwd); }
    catch (e) { host.report("host", (e as Error).message); return host; }
    const failed = new Set<string>();
    for (const record of records) {
      let worker: PluginWorker | undefined;
      const previousTheme={...host.theme};
      try {
        assert(!options.signal?.aborted, "Task cancelled during plugin activation");
        assert(!record.error, record.error ?? "Invalid plugin");
        for (const dep of Object.keys(record.manifest.dependencies ?? {})) assert(!failed.has(dep), `Dependency ${dep} failed to activate`);
        if (record.manifest.entries?.agent) {
          worker = new PluginWorker(record, options.scope, options.timeoutMs ?? 15000, message => host.report(record.manifest.id, message));
          host.workers.push(worker);
          const registrations = await worker.ready;
          assert(Array.isArray(registrations) && registrations.length <= 300, "Too many plugin registrations");
          for (const item of registrations) host.register(record, worker, item);
        }
        host.declarations(record);
        host.pins.push({ id: record.manifest.id, version: record.manifest.version, integrity: record.integrity, config: { ...defaults(record.manifest.configuration), ...record.activation.config } });
      } catch (e) {
        for(const key of Object.keys(host.theme))delete host.theme[key];Object.assign(host.theme,previousTheme);
        failed.add(record.manifest.id); host.remove(record.manifest.id);
        await worker?.dispose(); host.report(record.manifest.id, (e as Error).message);
      }
    }
    return host;
  }
  private report(id: string, message: string): void { if (this.diagnostics.length < 100) this.diagnostics.push(`${id}: ${message.slice(0,4000)}`); }
  private permission(record: PluginRecord, permission: string): void { assert(record.manifest.permissions?.includes(permission as never), `${record.manifest.id} requires ${permission}`); }
  private declarations(record: PluginRecord): void {
    const c = record.manifest.contributes;
    for (const prompt of c?.prompts ?? []) this.addPrompt(record, prompt);
    for (const ui of c?.ui ?? []) this.addUI(record, ui);
    if (c?.theme) { this.permission(record, "ui.contribute"); Object.assign(this.theme,c.theme); }
    for (const file of c?.skills ?? []) {
      this.addSkill(record,file);
    }
  }
  private addSkill(record:PluginRecord,file:string):void {
      this.permission(record, "prompts.contribute");
      const text = this.resource(record,file);
      const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
      const name = /^name:\s*["']?([^\r\n"']+)/m.exec(front?.[1] ?? "")?.[1]?.trim() ?? file.split("/").slice(-2,-1)[0] ?? "skill";
      const description = /^description:\s*["']?([^\r\n"']+)/m.exec(front?.[1] ?? "")?.[1]?.trim() ?? name;
      const id = `${record.manifest.id}/${name}`;
      assert(!this.skills.some(s => s.id === id), `Duplicate skill ${id}`);
      this.skills.push({ id, name, description, text: text.slice(front?.[0].length ?? 0), pluginId: record.manifest.id });
  }
  private resource(record: PluginRecord, file: string): string { const resolved = safeFile(record.directory,file); assert(fs.statSync(resolved).size <= 64_000, "Plugin text resource exceeds 64 KB"); return fs.readFileSync(resolved,"utf8"); }
  private addPrompt(record: PluginRecord, prompt: PromptContribution): void {
    this.permission(record,"prompts.contribute"); validatePrompt(prompt);
    assert(!this.prompts.some(p => p.pluginId === record.manifest.id && p.id === prompt.id), "Duplicate prompt id");
    this.prompts.push({ ...prompt, text: prompt.file ? this.resource(record,prompt.file) : prompt.text, file: undefined, pluginId: record.manifest.id });
  }
  private addUI(record: PluginRecord, ui: UIContribution): void {
    this.permission(record,"ui.contribute"); validateUI(ui);
    const key = `${record.manifest.id}/${ui.id}`; assert(!this.ui.some(u => u.key === key), `Duplicate UI contribution ${key}`);
    if (ui.view) { safeFile(record.directory,ui.view); assert((record.manifest.contributes?.ui ?? []).some(u => u.view === ui.view) || record.manifest.webAssets?.includes(ui.view),"Dynamic views must be declared in webAssets"); }
    this.ui.push({ ...ui, key, pluginId: record.manifest.id, entry: record.manifest.entries?.web, permissions: record.manifest.permissions ?? [] });
  }
  private register(record: PluginRecord, worker: PluginWorker, item: Registered): void {
    assert(object(item) && typeof item.handler === "string", "Invalid registration");
    if (item.kind === "prompt") { this.addPrompt(record,item as unknown as PromptContribution); return; }
    if (item.kind === "skill") { assert(typeof item.file === "string","Invalid skill file"); this.addSkill(record,item.file); return; }
    if (item.kind === "ui") { this.addUI(record,item as unknown as UIContribution); return; }
    if (item.kind === "tool" || item.kind === "command") {
      this.permission(record,item.kind === "tool" ? "tools.register" : "commands.register");
      assert(NAME.test(String(item.name)) && typeof item.description === "string" && item.description.length <= 8000, "Invalid tool/command name or description");
      const parameters = (item.parameters ?? { type: "object", additionalProperties: false }) as JsonObject;
      validateSchema(parameters); assert(parameters.type === "object", "Tool arguments must be an object");
      assert(Array.isArray(item.effects) && item.effects.every(e => EFFECTS.includes(String(e))), "Tools and commands must declare effects[] (empty for pure computation)");
      for (const effect of item.effects) this.permission(record,String(effect));
      if(item.kind === "tool" && (record.manifest.runtime === "native" || item.effects.some(e=>e!=="filesystem.read"))) {
        const properties=(parameters.properties??{}) as JsonObject;
        assert(!properties.reason || (properties.reason as JsonObject).type === "string","Risky tool reason must be a string");
        parameters.properties={...properties,reason:properties.reason??{type:"string",minLength:4,maxLength:600,description:"Required: explain why this call is needed for the user's request."}};
        parameters.required=[...new Set([...(parameters.required??[]) as string[],"reason"])];
      }
      const common = { record, worker, handler: item.handler, effects: item.effects as Effect[] };
      const publicName = `${record.manifest.id}/${item.name}`;
      if (item.kind === "tool") {
        const alias = `p_${createHash("sha256").update(record.manifest.id).digest("hex").slice(0,12)}_${item.name}`;
        assert(!this.tools.has(alias), `Duplicate tool ${publicName}`);
        assert(item.roles === undefined || (Array.isArray(item.roles) && item.roles.every(r => typeof r === "string")), "Invalid tool roles");
        this.tools.set(alias,{ ...common, roles: item.roles as string[] | undefined,
          definition: { type:"function", function: { name:alias, description:`[${publicName}] ${item.description}`, parameters } } });
      } else { assert(!this.commands.has(publicName), `Duplicate command ${publicName}`); this.commands.set(publicName,{ ...common, name:publicName, description:item.description, parameters }); }
    } else if (item.kind === "hook" || item.kind === "event") {
      this.permission(record,"hooks.register");
      const names = item.kind === "hook" ? ["request.before","tool.before"] : ["turn.started","turn.finished","tool.finished"];
      assert(names.includes(String(item.name)), "Unsupported plugin hook/event");
      (item.kind === "hook" ? this.hooks : this.events).push({ record, worker, handler:item.handler, name:String(item.name) });
    } else throw new Error(`Unsupported registration ${item.kind}`);
  }
  private remove(id: string): void {
    for (const [key, tool] of this.tools) if (tool.record.manifest.id === id) this.tools.delete(key);
    for (const [key, cmd] of this.commands) if (cmd.record.manifest.id === id) this.commands.delete(key);
    for (const list of [this.ui,this.prompts,this.skills]) for (let i=list.length-1;i>=0;i--) if (list[i].pluginId === id) list.splice(i,1);
    this.hooks = this.hooks.filter(h => h.record.manifest.id !== id); this.events = this.events.filter(h => h.record.manifest.id !== id);
  }
  definitions(role = this.context().role): ToolDefinition[] { return [...this.tools.values()].filter(t => !t.roles || t.roles.includes(role)).map(t => structuredClone(t.definition)); }
  toolPolicy(name: string): { effects: Effect[]; native: boolean; roles?: string[] } | undefined {
    const tool = this.tools.get(name); return tool ? { effects:tool.effects, native:tool.record.manifest.runtime === "native", roles:tool.roles } : undefined;
  }
  private context(): InvocationContext { return this.options.context?.() ?? { ...this.options.scope, signal:this.options.signal }; }
  private async invoke(owned: Owned & { handler: string }, value: unknown, effects: Effect[] = [], stack: string[] = []): Promise<unknown> {
    assert(!this.disposed, "Plugin host was disposed");
    const id = owned.record.manifest.id;
    assert(owned.record.manifest.runtime !== "native" || this.options.allowNative?.() !== false, "Native plugins cannot run inside a restricted child scope");
    assert(!stack.includes(id) && stack.length < 8, "Plugin service dependency cycle");
    const context = this.context();
    return owned.worker!.invoke(owned.handler,structuredClone(value),context,async (op,args,signal) => {
      if (op === "storage.get" || op === "storage.set") { this.permission(owned.record,"storage"); return pluginStorage(id,String(args.key),args.value,op === "storage.set"); }
      if (op === "service.call") {
        const target = String(args.pluginId);
        assert(Object.hasOwn(owned.record.manifest.dependencies ?? {}, target) || Object.hasOwn(owned.record.manifest.optionalDependencies ?? {},target), "Declare a dependency before calling another plugin");
        const command = this.commands.get(`${target}/${args.command}`); assert(command,"Unknown plugin service command");
        assert(command.effects.every(e => effects.includes(e)), "Service effects exceed the caller's declared effects");
        return this.runCommand(command.name,(args.args ?? {}) as JsonObject,[...stack,id]);
      }
      const effect = ({ read_file:"filesystem.read", list_files:"filesystem.read", write_file:"filesystem.write", run_command:"process", fetch:"network" } as Record<string,string>)[op];
      assert(effect && effects.includes(effect as Effect), `Operation ${op} exceeds callback effects`);
      this.permission(owned.record,effect);
      assert(this.options.broker,"Host operations require an active conversation");
      assert(typeof args.reason === "string" && args.reason.trim().length >= 4, "Host operations need an honest reason");
      return this.options.broker(op,args,signal);
    });
  }
  async execute(name: string,args: JsonObject): Promise<string> {
    const tool = this.tools.get(name); assert(tool,"Unknown plugin tool");
    validateValue(args,tool.definition.function.parameters,"arguments");
    const result = await this.invoke(tool,args,tool.effects);
    return (typeof result === "string" ? result : JSON.stringify(result ?? null)).slice(0,200_000);
  }
  async runCommand(name: string,args: JsonObject = {},stack: string[] = []): Promise<unknown> {
    const command = this.commands.get(name); assert(command,"Unknown plugin command"); validateValue(args,command.parameters,"arguments");
    return this.invoke(command,args,command.effects,stack);
  }
  async guardTool(name: string,args: JsonObject): Promise<void> {
    const tool = this.tools.get(name); if (tool) validateValue(args,tool.definition.function.parameters,"arguments");
    for (const hook of this.hooks.filter(h => h.name === "tool.before")) {
      const result = await this.invoke(hook,{ name, arguments:args });
      assert(!object(result) || !result.deny, `${hook.record.manifest.id}: ${object(result) ? result.reason ?? "Tool denied by plugin" : "Tool denied"}`);
    }
  }
  async requestSuffix(value: JsonObject): Promise<string> {
    let text = "";
    for (const hook of this.hooks.filter(h => h.name === "request.before")) {
      const result = await this.invoke(hook,value);
      if (object(result)) { assert(!result.deny,String(result.reason ?? "Request denied by plugin")); if (typeof result.systemSuffix === "string") text += `\n[Plugin ${hook.record.manifest.id}]\n${result.systemSuffix.slice(0,32_000)}`; }
    }
    return text;
  }
  async emit(name: EventName,value: JsonObject): Promise<void> {
    for (const listener of this.events.filter(h => h.name === name)) try { await this.invoke(listener,value); } catch (e) { this.report(listener.record.manifest.id,(e as Error).message); }
  }
  composePrompt(base: string,role: string): { text:string; sections:Array<{ id:string; text:string }> } {
    if (["confirm_model","reviewer"].includes(role)) return { text:base, sections:[] };
    const active = this.prompts.filter(p => !p.roles || p.roles.includes(role)).sort((a,b) => ({ persona:0,rules:1,context:2 }[a.slot ?? "rules"] - { persona:0,rules:1,context:2 }[b.slot ?? "rules"]) || (a.order ?? 0)-(b.order ?? 0) || `${a.pluginId}/${a.id}`.localeCompare(`${b.pluginId}/${b.id}`));
    const replacement = active.find(p => p.replace && this.providers.persona === `${p.pluginId}/${p.id}`);
    if (base.includes("[Plugin section: ")) return { text:base, sections:[] };
    const sections = active.filter(p => !p.replace).map(p => ({ id:`${p.pluginId}/${p.id}`, text:p.text ?? "" }));
    if (this.skills.length) {
      sections.push({ id:"skills/catalog", text:"Available skills (load by writing /skill <id> in the request):\n" + this.skills.map(s => `${s.id}: ${s.description}`).join("\n") });
      for (const match of (this.options.scope.request ?? "").matchAll(/\/skill\s+([a-zA-Z0-9_.\/-]+)/g)) { const skill = this.skills.find(s => s.id === match[1]); if (skill) sections.push({ id:skill.id,text:skill.text }); }
    }
    return { text:(replacement?.text ?? base) + sections.map(s => `\n\n[Plugin section: ${s.id}]\n${s.text}`).join(""), sections };
  }
  effectiveUI(platform: "web" | "tui"): OwnedUI[] { return this.ui.filter(u => (!u.platforms || u.platforms.includes(platform)) && (!EXCLUSIVE.has(u.slot) || this.providers[u.slot] === u.key)).sort((a,b) => (a.order ?? 0)-(b.order ?? 0) || a.key.localeCompare(b.key)); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const worker of this.workers.reverse()) await worker.dispose(); this.tools.clear(); this.commands.clear(); }
}
