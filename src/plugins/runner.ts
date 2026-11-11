/** Private disposable process. Native code never runs on the terminal/server event loop. */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import type { QuickJSContext } from "quickjs-emscripten";
import type { JsonObject, PluginContext, PluginScope } from "./types.js";

interface Initial { id: string; entry: string; runtime: string; config: JsonObject; scope: PluginScope }
/** This function is also serialized into QuickJS. It must have no module dependencies. */
function bootstrap(bridge: (op: string, value: unknown) => Promise<unknown>, initial: Initial) {
  const handlers = new Map<string, (...args: never[]) => unknown>();
  const registrations: Array<Record<string, unknown>> = [];
  const effects: Array<() => unknown> = [];
  let counter = 0, sealed = false;
  const register = (kind: string, spec: Record<string, unknown>, handler?: unknown) => {
    if (sealed) throw new Error("Register contributions during activate()");
    const id = `${kind}:${++counter}`;
    if (typeof handler === "function") handlers.set(id, handler as (...args: never[]) => unknown);
    const { execute: _, ...data } = spec;
    const record = { ...data, kind, handler: id };
    registrations.push(record);
    return { dispose() { handlers.delete(id); const index = registrations.indexOf(record); if (index >= 0) registrations.splice(index, 1); } };
  };
  const call = (operation: string, args: unknown) => bridge(operation, args);
  const ctx = {
    id: initial.id, config: Object.freeze(initial.config), scope: Object.freeze(initial.scope),
    tools: { register: (spec: Record<string, unknown>) => register("tool", spec, spec.execute) },
    commands: { register: (spec: Record<string, unknown>) => register("command", spec, spec.execute) },
    prompts: { register: (spec: Record<string, unknown>) => register("prompt", spec) },
    skills: { register: (file: string) => register("skill", { file }) },
    ui: { register: (spec: Record<string, unknown>) => register("ui", spec) },
    hooks: { add: (name: string, handler: unknown) => register("hook", { name }, handler) },
    events: { on: (name: string, handler: unknown) => register("event", { name }, handler) },
    fs: {
      read: (path: string, reason: string) => call("read_file", { path, reason }),
      write: (path: string, content: string, reason: string) => call("write_file", { path, content, reason }),
      list: (path: string, reason: string) => call("list_files", { path, reason }),
    },
    net: { fetch: (url: string, reason: string) => call("fetch", { url, reason }) },
    process: { run: (command: string, reason: string) => call("run_command", { command, reason }) },
    storage: { get: (key: string) => call("storage.get", { key }), set: (key: string, value: unknown) => call("storage.set", { key, value }) },
    services: { call: (pluginId: string, command: string, args: unknown = {}) => call("service.call", { pluginId, command, args }) },
    log: (message: string) => { void call("log", { message: String(message).slice(0, 4000) }).catch(() => {}); },
    effect: (dispose: () => unknown) => effects.push(dispose),
  };
  return {
    ctx,
    seal() { sealed = true; return registrations; },
    async invoke(id: string, value: unknown, context: unknown) {
      const handler = handlers.get(id);
      if (!handler) throw new Error("Plugin registration was disposed");
      return await handler(value as never, context as never);
    },
    async dispose() { for (const dispose of effects.reverse()) await dispose(); handlers.clear(); registrations.length = 0; },
  };
}
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
let nextId = 0;
function send(value: unknown): void { if (process.connected) process.send?.(value); }
function bridge(op: string, value: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); send({ type: "operation", id, op, value }); });
}
let execute: ((handler: string, value: unknown, context: unknown) => Promise<unknown>) | undefined;
let dispose: (() => Promise<void>) | undefined;
let pumping: ReturnType<typeof setInterval> | undefined;
let engine: import("quickjs-emscripten").QuickJSRuntime | undefined;
let vm: QuickJSContext | undefined;
let cpuEnd = 0;
function evaluate(source: string): void {
  cpuEnd = Date.now() + 1000;
  const result = vm!.evalCode(source);
  if (result.error) { const error = vm!.dump(result.error); result.error.dispose(); throw new Error(typeof error?.message === "string" ? error.message : String(error)); }
  result.value.dispose();
  pump();
}
function pump(): void {
  cpuEnd = Date.now() + 1000;
  const jobs = engine?.executePendingJobs(100);
  if (jobs && "error" in jobs && jobs.error) { const error = vm!.dump(jobs.error); jobs.error.dispose(); send({ type: "fatal", error: String(error?.message ?? error) }); process.exitCode = 1; process.disconnect(); }
}
const sandboxCalls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
async function start(initial: Initial): Promise<void> {
  if (initial.runtime === "native") {
    const runtime = bootstrap(bridge, initial);
    const mod = await import(pathToFileURL(initial.entry).href);
    const plugin = mod.default ?? mod;
    if (typeof plugin.activate !== "function") throw new Error("Plugin must export activate(ctx)");
    const cleanup = await plugin.activate(runtime.ctx as unknown as PluginContext);
    if (typeof cleanup === "function") runtime.ctx.effect(cleanup);
    execute = runtime.invoke; dispose = runtime.dispose;
    send({ type: "ready", registrations: runtime.seal() });
    return;
  }
  const { getQuickJS } = await import("quickjs-emscripten");
  const module = await getQuickJS();
  engine = module.newRuntime(); engine.setMemoryLimit(32 * 1024 * 1024); engine.setMaxStackSize(512 * 1024);
  engine.setInterruptHandler(() => Date.now() >= cpuEnd);
  vm = engine.newContext();
  const host = vm.newFunction("__bridge", (operation, argument) => {
    const op = vm!.getString(operation), value = vm!.dump(argument);
    const deferred = vm!.newPromise();
    void bridge(op, value).then(result => {
      if (!vm?.alive) return;
      const handle = vm.evalCode(`(${JSON.stringify(result ?? null)})`);
      if (handle.error) { deferred.reject(handle.error); handle.error.dispose(); } else { deferred.resolve(handle.value); handle.value.dispose(); }
      deferred.dispose(); pump();
    }, error => {
      if (!vm?.alive) return;
      const handle = vm.newError(String(error.message)); deferred.reject(handle); handle.dispose(); deferred.dispose(); pump();
    });
    return deferred.handle;
  });
  vm.setProp(vm.global, "__bridge", host); host.dispose();
  const settle = vm.newFunction("__settle", (id, error, value) => {
    const call = sandboxCalls.get(vm!.getNumber(id));
    if (call) { sandboxCalls.delete(vm!.getNumber(id)); const err = vm!.dump(error); if (err) call.reject(new Error(String(err))); else call.resolve(vm!.dump(value)); }
  });
  vm.setProp(vm.global, "__settle", settle); settle.dispose();
  const compiled = ts.transpileModule(fs.readFileSync(initial.entry, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: initial.entry,
  }).outputText;
  const activation = new Promise<unknown>((resolve, reject) => sandboxCalls.set(0, { resolve, reject }));
  pumping = setInterval(pump, 10); pumping.unref();
  evaluate(`globalThis.__runtime = (${bootstrap.toString()})(__bridge, ${JSON.stringify(initial)});
    globalThis.exports = {}; globalThis.module = { exports };
    globalThis.require = (id) => { if (id === '@xingjisoft/neutrino/plugin') return { definePlugin: p => p }; throw new Error('Sandbox imports must be bundled: ' + id); };
    globalThis.console = { log: (...a) => __runtime.ctx.log(a.join(' ')), warn: (...a) => __runtime.ctx.log(a.join(' ')), error: (...a) => __runtime.ctx.log(a.join(' ')) };
    ${compiled}
    globalThis.__plugin = module.exports.default || module.exports;
    Promise.resolve().then(() => __plugin.activate(__runtime.ctx)).then(cleanup => { if (typeof cleanup === 'function') __runtime.ctx.effect(cleanup); __settle(0, null, __runtime.seal()); }, error => __settle(0, String(error), null));`);
  const registrations = await activation;
  execute = (handler, value, context) => new Promise((resolve, reject) => {
    const id = ++nextId; sandboxCalls.set(id, { resolve, reject });
    try { evaluate(`__runtime.invoke(${JSON.stringify(handler)}, ${JSON.stringify(value)}, ${JSON.stringify(context)}).then(v => __settle(${id}, null, v === undefined ? null : v), e => __settle(${id}, String(e), null))`); }
    catch (error) { sandboxCalls.delete(id); reject(error as Error); }
  });
  dispose = async () => {
    const id = ++nextId;
    await new Promise<void>((resolve, reject) => {
      sandboxCalls.set(id, { resolve: () => resolve(), reject });
      evaluate(`__runtime.dispose().then(() => __settle(${id}, null, null), e => __settle(${id}, String(e), null))`);
    });
  };
  send({ type: "ready", registrations });
}
let queue = Promise.resolve();
process.on("message", (message: { type: string; initial?: Initial; id?: number; handler?: string; value?: unknown; context?: unknown; error?: string }) => {
  if (message.type === "operation-result") {
    const call = pending.get(message.id!); pending.delete(message.id!);
    if (message.error) call?.reject(new Error(message.error)); else call?.resolve(message.value);
  } else if (message.type === "init") {
    queue = start(message.initial!).catch(error => send({ type: "fatal", error: String(error.message) }));
  } else if (message.type === "invoke") {
    queue = queue.then(async () => {
      try { send({ type: "result", id: message.id, value: (await execute!(message.handler!, message.value, message.context)) ?? null }); }
      catch (error) { send({ type: "result", id: message.id, error: String((error as Error).message) }); }
    });
  } else if (message.type === "dispose") {
    queue = queue.finally(async () => { try { await dispose?.(); } finally { if (pumping) clearInterval(pumping); process.disconnect(); } });
  }
});
process.on("disconnect", () => process.exit(0));
