import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type DiagnosticRole = "main" | "planning" | "worker" | "verification" | "approval" | "compression" | "integration";
export interface DiagnosticScope { runId: string; parentRunId?: string; role: string }
export interface DiagnosticRequestContext { request_id?: string; task_id?: string; role?: DiagnosticRole }
export interface DiagnosticEvent {
  seq: number; trace_id: string; at_ms: number; event: string;
  mode?: string; role?: string; task_id?: string; scope_run_id?: string; parent_scope_run_id?: string;
  data: Record<string, unknown>;
}
export const diagnosticHash = (value: unknown): string => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value) ?? "null").digest("hex");
const bytes = (value: unknown): number => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
const stringFields = new Set(["request_id", "attempt_id", "wait_id", "span_id", "tool_id", "tool_name", "task_id", "verifies",
  "engine_run_id", "scope_run_id", "parent_scope_run_id", "role", "status", "reason_code", "resource", "artifact_kind", "mode", "provider", "source"]);
function safeData(data: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean" || value === null) result[key] = value;
    else if (typeof value === "string" && stringFields.has(key)) result[key] = value.slice(0, 160);
    else if (typeof value === "string" && key.endsWith("_hash") && /^[a-f\d]{64}$/.test(value)) result[key] = value;
    else if (Array.isArray(value) && ["dependencies", "blocker_ids"].includes(key)) result[key] = value.slice(0, 128).filter(v => typeof v === "string" && /^[a-zA-Z\d_.:-]{1,100}$/.test(v));
    else if (value && typeof value === "object" && !Array.isArray(value) && depth < 2) result[key] = safeData(value as Record<string, unknown>, depth + 1);
  }
  return result;
}

/** Opt-in metadata only. I/O failures and buffer pressure never change task decisions. */
export class DiagnosticRecorder {
  readonly traceId: string;
  private began = performance.now();
  private sequence = 0;
  private identifiers = 0;
  private buffer: string[] = [];
  private bufferedBytes = 0;
  private scheduled?: ReturnType<typeof setTimeout>;
  private writing?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private unavailable = false;
  private scopes = new Map<string, { role?: string; task_id?: string; parent_scope_run_id?: string }>();
  dropped = 0;
  ioErrors = 0;
  bytesWritten = 0;
  enqueueMs = 0;
  writeMs = 0;
  constructor(readonly file: string, private options: { traceId?: string; mode?: string; source?: "offline_scripted_transport" | "runtime_transport"; maxBufferedBytes?: number; flushIntervalMs?: number } = {}) {
    this.traceId = options.traceId ?? randomUUID();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    } catch { this.ioErrors++; this.unavailable = true; }
    this.emit("trace_start", { mode: options.mode ?? "unknown", source: options.source ?? "runtime_transport" });
  }
  id(kind: string): string { return `${kind}-${++this.identifiers}`; }
  associate(scope: DiagnosticScope, context: { role?: string; task_id?: string }): void {
    this.scopes.set(scope.runId, { ...this.scopes.get(scope.runId), ...context, parent_scope_run_id: scope.parentRunId });
  }
  context(scope?: DiagnosticScope): { role?: string; task_id?: string; scope_run_id?: string; parent_scope_run_id?: string } {
    if (!scope) return {};
    let record = this.scopes.get(scope.runId), parent = scope.parentRunId;
    for (let depth = 0; !record?.task_id && parent && depth < 32; depth++) {
      const inherited = this.scopes.get(parent);
      if (inherited?.task_id) record = { ...record, task_id: inherited.task_id };
      parent = inherited?.parent_scope_run_id;
    }
    return { role: record?.role ?? scope.role, task_id: record?.task_id, scope_run_id: scope.runId, parent_scope_run_id: scope.parentRunId };
  }
  emit(event: string, data: Record<string, unknown> = {}, scope?: DiagnosticScope): void {
    if (this.closed) return;
    if (this.unavailable) { this.dropped++; return; }
    const started = performance.now();
    const context = this.context(scope);
    const sanitized = safeData(data);
    const record: DiagnosticEvent = { seq: ++this.sequence, trace_id: this.traceId, at_ms: performance.now() - this.began,
      event, mode: this.options.mode, ...context,
      ...(typeof sanitized.role === "string" ? { role: sanitized.role } : {}),
      ...(typeof sanitized.task_id === "string" ? { task_id: sanitized.task_id } : {}), data: sanitized };
    const line = JSON.stringify(record) + "\n", size = Buffer.byteLength(line);
    if (size > 8192 || this.bufferedBytes + size > (this.options.maxBufferedBytes ?? 512_000)) this.dropped++;
    else { this.buffer.push(line); this.bufferedBytes += size; }
    this.enqueueMs += performance.now() - started;
    if (!this.scheduled && !this.writing) this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.flush(); }, this.options.flushIntervalMs ?? 25);
  }
  span(event: string, data: Record<string, unknown> = {}, scope?: DiagnosticScope): { id: string; end(extra?: Record<string, unknown>): void } {
    const spanId = this.id("span"), began = performance.now();
    this.emit(`${event}_start`, { ...data, span_id: spanId }, scope);
    let ended = false;
    return { id: spanId, end: extra => { if (!ended) { ended = true; this.emit(`${event}_end`, { ...data, ...extra, span_id: spanId, duration_ms: performance.now() - began }, scope); } } };
  }
  async flush(): Promise<void> {
    if (this.writing) return this.writing;
    if (!this.buffer.length || this.unavailable) return;
    const content = this.buffer.join(""); this.buffer = []; this.bufferedBytes = 0;
    const began = performance.now();
    this.writing = (async () => {
      try {
        // Deleting a run must not cause a late write to recreate it.
        if (!fs.existsSync(this.file)) { this.unavailable = true; this.dropped += content.split("\n").length - 1; return; }
        const handle = await fs.promises.open(this.file, "r+");
        try {
          const contentBytes = Buffer.from(content), start = (await handle.stat()).size;
          for (let offset = 0; offset < contentBytes.length;) {
            const written = await handle.write(contentBytes, offset, contentBytes.length - offset, start + offset);
            if (!written.bytesWritten) throw new Error("trace write made no progress");
            offset += written.bytesWritten;
          }
        } finally { await handle.close(); }
        this.bytesWritten += Buffer.byteLength(content);
      } catch { this.ioErrors++; this.unavailable = true; }
      finally { this.writeMs += performance.now() - began; }
    })();
    try { await this.writing; }
    finally {
      this.writing = undefined;
      if (this.buffer.length && !this.closed && !this.unavailable && !this.scheduled) this.scheduled = setTimeout(() => { this.scheduled = undefined; void this.flush(); }, this.options.flushIntervalMs ?? 25);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.emit("trace_summary", { dropped_events: this.dropped, io_errors: this.ioErrors, enqueue_ms: this.enqueueMs, write_ms: this.writeMs });
    this.closed = true;
    if (this.scheduled) { clearTimeout(this.scheduled); this.scheduled = undefined; }
    this.closing = (async () => { await this.writing; while (this.buffer.length && !this.unavailable) await this.flush(); })();
    return this.closing;
  }
}

/** One logical stream, with distinct attempts and first reasoning/text/tool events. */
export class DiagnosticRequest {
  readonly requestId: string;
  private attemptId?: string;
  private attemptNumber = 0;
  private first = new Set<string>();
  private usage: Record<string, number | null> = {};
  constructor(private trace: DiagnosticRecorder, private context: DiagnosticRequestContext, private scope?: DiagnosticScope) {
    this.requestId = context.request_id ?? trace.id("request");
    this.emit("model_stream_start");
  }
  private emit(event: string, data: Record<string, unknown> = {}): void {
    this.trace.emit(event, { request_id: this.requestId, role: this.context.role ?? "main", task_id: this.context.task_id, ...data }, this.scope);
  }
  dispatch(body: string): void {
    this.finishAttempt("abandoned");
    this.attemptId = this.trace.id("attempt"); this.attemptNumber++; this.first.clear(); this.usage = {};
    const payload = JSON.parse(body) as Record<string, unknown>;
    const messages = Array.isArray(payload.messages) ? payload.messages as Array<Record<string, unknown>> : [];
    this.emit("provider_dispatch", { attempt_id: this.attemptId, attempt: this.attemptNumber, payload_bytes: bytes(body), payload_hash: diagnosticHash(body),
      system_bytes: bytes(payload.system ?? "") + messages.filter(m => m.role === "system").reduce((n, m) => n + bytes(m), 0),
      user_bytes: messages.filter(m => m.role === "user").reduce((n, m) => n + bytes(m), 0),
      assistant_bytes: messages.filter(m => m.role === "assistant").reduce((n, m) => n + bytes(m), 0),
      tool_result_bytes: messages.filter(m => m.role === "tool").reduce((n, m) => n + bytes(m), 0),
      reasoning_echo_bytes: messages.reduce((n, m) => n + bytes(m.reasoning_content ?? ""), 0),
      tool_schema_bytes: bytes(payload.tools ?? []), streaming: payload.stream !== false });
  }
  headers(status: number): void { this.emit("provider_headers", { attempt_id: this.attemptId, http_status: status }); }
  content(kind: "reasoning" | "text" | "tool"): void {
    if (!this.first.has("content")) { this.first.add("content"); this.emit("provider_first_content", { attempt_id: this.attemptId }); }
    if (!this.first.has(kind)) { this.first.add(kind); this.emit(`provider_first_${kind}`, { attempt_id: this.attemptId }); }
  }
  usageUpdate(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>, prompt = v.prompt_tokens ?? v.input_tokens, completion = v.completion_tokens ?? v.output_tokens;
    const details = v.prompt_tokens_details as Record<string, unknown> | undefined;
    const completionDetails = v.completion_tokens_details as Record<string, unknown> | undefined;
    const entries = { input_tokens: prompt, output_tokens: completion, cached_input_tokens: details?.cached_tokens ?? v.prompt_cache_hit_tokens ?? v.cache_read_input_tokens,
      reasoning_tokens: completionDetails?.reasoning_tokens };
    for (const [key, count] of Object.entries(entries)) if (typeof count === "number" && Number.isFinite(count)) this.usage[key] = count;
  }
  retry(delayMs: number): void { this.finishAttempt("retry"); this.emit("model_retry_wait", { delay_ms: delayMs }); }
  private finishAttempt(status: string): void {
    if (!this.attemptId) return;
    this.emit("provider_attempt_end", { attempt_id: this.attemptId, status, input_tokens: this.usage.input_tokens ?? null,
      output_tokens: this.usage.output_tokens ?? null, cached_input_tokens: this.usage.cached_input_tokens ?? null, reasoning_tokens: this.usage.reasoning_tokens ?? null });
    this.attemptId = undefined;
  }
  end(status: string): void { this.finishAttempt(status); this.emit("model_stream_end", { status }); }
}
