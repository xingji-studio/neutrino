import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Executor, ExecuteResult, ResolvedProvider } from "@cloudflare/codemode/browser";

interface Limits { cpuMs: number; memoryBytes: number; idleMs: number }
const DEFAULT_LIMITS: Limits = { cpuMs: 3000, memoryBytes: 32 * 1024 * 1024, idleMs: 30_000 };

/** The worker owns QuickJS; only named tool RPCs can reach the host. */
export class LocalCodeExecutor implements Executor {
  constructor(private signal?: AbortSignal, private limits: Partial<Limits> = {}) {}

  async execute(code: string, providersOrFns: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>): Promise<ExecuteResult> {
    if (this.signal?.aborted) return { result: null, error: "Execution cancelled" };
    const providers: ResolvedProvider[] = Array.isArray(providersOrFns)
      ? providersOrFns : [{ name: "codemode", fns: providersOrFns }];
    const limits = { ...DEFAULT_LIMITS, ...this.limits };
    return new Promise(resolve => {
      const worker = new Worker(new URL(import.meta.url), {
        execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")),
        workerData: { neutrinoCode: true, code, limits, providers: providers.map(p => ({ name: p.name, tools: Object.keys(p.fns) })) },
      });
      let finished = false;
      let finalResultReceived = false;
      let pending = 0;
      let lastActivity = Date.now();
      let calls = 0;
      // The existing approval UI has one active decision. Serialize RPCs so a
      // Promise.all cannot overwrite an earlier approval or race side effects.
      let queue = Promise.resolve();
      const finish = (result: ExecuteResult) => {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        this.signal?.removeEventListener("abort", abort);
        void worker.terminate();
        resolve(result);
      };
      const abort = () => finish({ result: null, error: String(this.signal?.reason ?? "Execution cancelled") });
      const watchdog = setInterval(() => {
        if (!pending && Date.now() - lastActivity > limits.idleMs) finish({ result: null, error: "Program timed out without completing" });
      }, 100);
      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) { abort(); return; }
      worker.on("error", error => finish({ result: null, error: error.message }));
      worker.on("exit", code => { if (!finished && !finalResultReceived) finish({ result: null, error: `Execution worker exited (${code})` }); });
      worker.on("message", message => {
        if (finished) return;
        lastActivity = Date.now();
        if (message.type === "result") {
          finalResultReceived = true;
          // Report promptly so the program owner can abort host operations,
          // including an outstanding human approval, then settle its ledger.
          finish(pending && !message.value.error
            ? { ...message.value, error: "Program returned with unawaited tool calls; inspect completed operations" }
            : message.value);
          return;
        }
        if (message.type !== "tool") return;
        if (++calls > 256) { finish({ result: null, error: "Program exceeded 256 tool/progress calls" }); return; }
        pending++;
        queue = queue.then(async () => {
          if (finished || finalResultReceived) { pending--; return; }
          let value: unknown;
          let error: string | undefined;
          try {
            const provider = providers.find(p => p.name === message.provider);
            if (!provider || !Object.hasOwn(provider.fns, message.name)) throw new Error("Unknown program tool");
            value = await provider.fns[message.name](message.args);
          } catch (err) { error = err instanceof Error ? err.message : String(err); }
          finally { pending--; lastActivity = Date.now(); }
          if (!finished && !finalResultReceived) worker.postMessage({ type: "tool-result", id: message.id, value, error });
        }).catch(error => finish({ result: null, error: String(error) }));
      });
    });
  }
}

async function runSandbox(): Promise<void> {
  const { getQuickJS } = await import("quickjs-emscripten");
  const module = await getQuickJS();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(workerData.limits.memoryBytes);
  runtime.setMaxStackSize(256 * 1024);
  const vm = runtime.newContext();
  const pending = new Map<number, ReturnType<typeof vm.newPromise>>();
  const logs: string[] = [];
  let logSize = 0;
  let nextId = 0;
  let remainingCpu = workerData.limits.cpuMs;
  let sliceStart = Date.now();
  let closed = false;
  runtime.setInterruptHandler(() => Date.now() - sliceStart >= remainingCpu);
  const run = <T>(operation: () => T): T => {
    sliceStart = Date.now();
    try { return operation(); }
    finally { remainingCpu -= Date.now() - sliceStart; }
  };
  const errorText = (value: unknown) => typeof value === "object" && value && "message" in value
    ? String((value as { message: unknown }).message) : String(value);
  const complete = (value: ExecuteResult) => {
    if (closed) return;
    closed = true;
    parentPort!.postMessage({ type: "result", value: { ...value, logs } });
  };
  for (const provider of workerData.providers as Array<{ name: string; tools: string[] }>) {
    const object = vm.newObject();
    for (const name of provider.tools) {
      const fn = vm.newFunction(name, args => {
        const deferred = vm.newPromise();
        const id = ++nextId;
        pending.set(id, deferred);
        parentPort!.postMessage({ type: "tool", id, provider: provider.name, name, args: args ? vm.dump(args) : {} });
        return deferred.handle;
      });
      vm.setProp(object, name, fn);
      fn.dispose();
    }
    vm.setProp(vm.global, provider.name, object);
    object.dispose();
  }
  const consoleObject = vm.newObject();
  for (const name of ["log", "warn", "error"]) {
    const fn = vm.newFunction(name, (...args) => {
      if (logSize >= 8000) return;
      const line = args.map(arg => {
        const value = vm.dump(arg);
        return typeof value === "string" ? value : JSON.stringify(value);
      }).join(" ").slice(0, 8000 - logSize);
      logs.push(line); logSize += line.length;
    });
    vm.setProp(consoleObject, name, fn); fn.dispose();
  }
  vm.setProp(vm.global, "console", consoleObject); consoleObject.dispose();
  parentPort!.on("message", message => {
    if (closed || message.type !== "tool-result") return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    try {
      if (message.error) {
        const error = vm.newError(message.error); deferred.reject(error); error.dispose();
      } else {
        const handle = run(() => vm.unwrapResult(vm.evalCode(`(${JSON.stringify(message.value ?? null)})`)));
        deferred.resolve(handle); handle.dispose();
      }
    } catch (error) { complete({ result: null, error: errorText(error) }); }
    finally { deferred.dispose(); }
  });
  const program = String(workerData.code).trim().replace(/;+\s*$/, "");
  const evaluated = run(() => vm.evalCode(`(${program})()`));
  if (evaluated.error) {
    const error = errorText(vm.dump(evaluated.error)); evaluated.dispose();
    complete({ result: null, error });
  } else {
    const resultHandle = evaluated.value;
    while (!closed) {
      if (remainingCpu <= 0) { complete({ result: null, error: "Program exceeded CPU time limit" }); break; }
      const jobs = run(() => runtime.executePendingJobs(100));
      if (jobs.error) {
        const error = errorText(vm.dump(jobs.error)); jobs.dispose();
        complete({ result: null, error }); break;
      }
      const state = run(() => vm.getPromiseState(resultHandle));
      if (state.type === "fulfilled") {
        try { complete({ result: vm.dump(state.value), ...(pending.size ? { error: "Program returned with unawaited tool calls; inspect completed operations" } : {}) }); }
        finally { state.value.dispose(); }
        break;
      }
      if (state.type === "rejected") {
        const error = errorText(vm.dump(state.error)); state.error.dispose();
        complete({ result: null, error }); break;
      }
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    resultHandle.dispose();
  }
  for (const deferred of pending.values()) deferred.dispose();
  vm.dispose(); runtime.dispose();
  parentPort!.close();
}

if (!isMainThread && workerData?.neutrinoCode) {
  void runSandbox().catch(error => parentPort!.postMessage({ type: "result", value: { result: null, error: String(error) } }));
}
