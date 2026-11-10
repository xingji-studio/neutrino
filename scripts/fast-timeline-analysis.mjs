// Metadata-only analysis. Task admission chains retain model waits inside their task nodes.
// They are not a provider-side compute critical path, and cumulative parallel spans are not wall time.
export function analyzeTimeline(events) {
  const issues = [], requests = new Map(), attempts = new Map(), resources = new Map(), tools = new Map(), spans = new Map();
  const definitions = new Map(), ready = new Map(), activeTasks = new Map(), tasks = [], workspaceWaits = [], control = [];
  const get = (map, key) => { if (!map.has(key)) map.set(key, {}); return map.get(key); };
  let runStart, runEnd, traceSummary;
  for (let i = 0; i < events.length; i++) {
    const e = events[i], d = e.data ?? {};
    if ((!i && e.seq !== 1) || (i && (e.seq !== events[i - 1].seq + 1 || e.at_ms < events[i - 1].at_ms))) issues.push("non_monotonic_or_missing_events");
    if (i && e.trace_id !== events[0].trace_id) issues.push("mixed_trace_ids");
    const role = d.role ?? e.role ?? "main", taskId = d.task_id ?? e.task_id;
    if (e.event === "run_start") runStart = e;
    if (e.event === "run_end") runEnd = e;
    if (e.event === "trace_summary") traceSummary = e;
    if (e.event === "task_defined") definitions.set(taskId, { ...d, at_ms: e.at_ms });
    if (e.event === "task_ready") ready.set(taskId, e.at_ms);
    if (e.event === "workspace_wait") workspaceWaits.push({ task_id: taskId, blocker_ids: d.blocker_ids, at_ms: e.at_ms });
    if (e.event === "workspace_acquired") {
      const task = { task_id: taskId, generation: d.generation, attempt: d.attempt, role, start_ms: e.at_ms,
        ready_ms: ready.get(taskId) ?? definitions.get(taskId)?.at_ms, end_ms: null, status: null };
      activeTasks.set(taskId, task); tasks.push(task);
    }
    if (e.event === "workspace_released") {
      const task = activeTasks.get(taskId);
      if (!task) issues.push("workspace_release_without_acquire");
      else { task.end_ms = e.at_ms; task.status = d.status; activeTasks.delete(taskId); }
    }
    if (e.event === "model_stream_start" || e.event === "model_stream_end") {
      const request = get(requests, d.request_id);
      const field = e.event === "model_stream_start" ? "start_ms" : "end_ms";
      if (request[field] !== undefined) issues.push("duplicate_request_boundary");
      Object.assign(request, { id: d.request_id, role, task_id: taskId, scope_run_id: e.scope_run_id });
      request[e.event === "model_stream_start" ? "start_ms" : "end_ms"] = e.at_ms;
      if (e.event === "model_stream_end") request.status = d.status;
    }
    if (e.event === "provider_dispatch") {
      const attempt = get(attempts, d.attempt_id);
      if (attempt.start_ms !== undefined) issues.push("duplicate_provider_attempt");
      Object.assign(attempt, { id: d.attempt_id, request_id: d.request_id, role, task_id: taskId, start_ms: e.at_ms,
        payload_bytes: d.payload_bytes, system_bytes: d.system_bytes, assistant_bytes: d.assistant_bytes,
        reasoning_echo_bytes: d.reasoning_echo_bytes, tool_schema_bytes: d.tool_schema_bytes, tool_result_bytes: d.tool_result_bytes });
    }
    if (e.event === "provider_headers") Object.assign(get(attempts, d.attempt_id), { headers_ms: e.at_ms, http_status: d.http_status });
    if (e.event.startsWith("provider_first_")) get(attempts, d.attempt_id)[e.event.slice("provider_first_".length) + "_ms"] = e.at_ms;
    if (e.event === "provider_attempt_end") Object.assign(get(attempts, d.attempt_id), { end_ms: e.at_ms, status: d.status,
      input_tokens: d.input_tokens, output_tokens: d.output_tokens, cached_input_tokens: d.cached_input_tokens, reasoning_tokens: d.reasoning_tokens });
    if (e.event.startsWith("resource_") && d.wait_id) {
      const wait = get(resources, d.wait_id);
      Object.assign(wait, { id: d.wait_id, resource: d.resource, role, task_id: taskId, request_id: d.request_id });
      if (e.event === "resource_queued") wait.queued_ms = e.at_ms;
      if (e.event === "resource_acquired") Object.assign(wait, { acquired_ms: e.at_ms, wait_ms: d.wait_ms });
      if (e.event === "resource_released") wait.released_ms = e.at_ms;
      if (e.event === "resource_cancelled") Object.assign(wait, { cancelled_ms: e.at_ms, wait_ms: d.wait_ms });
    }
    if ((e.event === "tool_started" || e.event === "tool_finished") && d.tool_id) {
      const tool = get(tools, d.tool_id);
      Object.assign(tool, { id: d.tool_id, name: d.tool_name, role, task_id: taskId, resource_hash: d.resource_hash, arguments_hash: d.arguments_hash });
      if (e.event === "tool_started") tool.start_ms = e.at_ms;
      else Object.assign(tool, { end_ms: e.at_ms, status: d.status, result_hash: d.result_hash });
    }
    if (d.span_id && /_(start|end)$/.test(e.event)) {
      const span = get(spans, d.span_id);
      Object.assign(span, { id: d.span_id, kind: e.event.replace(/_(start|end)$/, ""), role, task_id: taskId });
      span[e.event.endsWith("_start") ? "start_ms" : "end_ms"] = e.at_ms;
    }
    if (e.event === "control_rejected") control.push({ role, task_id: taskId, reason_code: d.reason_code });
  }
  if (!runStart || !runEnd || !traceSummary) issues.push("missing_run_or_trace_boundary");
  if (traceSummary?.data.dropped_events || traceSummary?.data.io_errors) issues.push("trace_loss_or_io_error");
  const completed = item => Number.isFinite(item.start_ms) && Number.isFinite(item.end_ms) && item.end_ms >= item.start_ms;
  if ([...requests.values(), ...attempts.values(), ...spans.values()].some(x => !completed(x))) issues.push("unbalanced_request_or_span");
  if (activeTasks.size) issues.push("unreleased_workspace");
  if ([...resources.values()].some(x => x.queued_ms === undefined ||
    (x.cancelled_ms === undefined && (x.acquired_ms === undefined || x.released_ms === undefined)))) issues.push("unbalanced_resource_wait");
  if ([...tools.values()].some(x => x.status !== "denied" && !completed(x))) issues.push("unbalanced_tool");

  const roles = {};
  for (const request of requests.values()) {
    const row = roles[request.role] ??= { logical_requests: 0, provider_attempts: 0, reported_input_tokens: 0,
      reported_output_tokens: 0, reported_cached_input_tokens: null, cached_usage_attempts: 0, reported_reasoning_tokens: null, reasoning_usage_attempts: 0,
      missing_usage_attempts: 0, request_ms_cumulative: 0, payload_bytes_cumulative: 0 };
    row.logical_requests++;
    if (completed(request)) row.request_ms_cumulative += request.end_ms - request.start_ms;
  }
  for (const attempt of attempts.values()) {
    const row = roles[attempt.role] ??= { logical_requests: 0, provider_attempts: 0, reported_input_tokens: 0,
      reported_output_tokens: 0, reported_cached_input_tokens: null, cached_usage_attempts: 0, reported_reasoning_tokens: null, reasoning_usage_attempts: 0,
      missing_usage_attempts: 0, request_ms_cumulative: 0, payload_bytes_cumulative: 0 };
    row.provider_attempts++; row.payload_bytes_cumulative += attempt.payload_bytes ?? 0;
    if (attempt.input_tokens == null || attempt.output_tokens == null) row.missing_usage_attempts++;
    row.reported_input_tokens += attempt.input_tokens ?? 0; row.reported_output_tokens += attempt.output_tokens ?? 0;
    if (attempt.cached_input_tokens != null) { row.reported_cached_input_tokens = (row.reported_cached_input_tokens ?? 0) + attempt.cached_input_tokens; row.cached_usage_attempts++; }
    if (attempt.reasoning_tokens != null) { row.reported_reasoning_tokens = (row.reported_reasoning_tokens ?? 0) + attempt.reasoning_tokens; row.reasoning_usage_attempts++; }
    attempt.time_to_first_content_ms = attempt.content_ms === undefined ? null : attempt.content_ms - attempt.start_ms;
    attempt.time_to_first_reasoning_ms = attempt.reasoning_ms === undefined ? null : attempt.reasoning_ms - attempt.start_ms;
    attempt.time_to_first_visible_ms = attempt.text_ms === undefined ? null : attempt.text_ms - attempt.start_ms;
    attempt.time_to_first_tool_ms = attempt.tool_ms === undefined ? null : attempt.tool_ms - attempt.start_ms;
  }
  const waits = {};
  for (const wait of resources.values()) {
    const row = waits[wait.resource] ??= { count: 0, wait_ms_cumulative: 0, max_wait_ms: 0 };
    row.count++; row.wait_ms_cumulative += wait.wait_ms ?? 0; row.max_wait_ms = Math.max(row.max_wait_ms, wait.wait_ms ?? 0);
  }
  const repeated = new Map();
  for (const tool of tools.values()) if (tool.status === "completed") {
    const key = `${tool.name}:${tool.resource_hash}:${tool.result_hash}`;
    const group = get(repeated, key); group.name = tool.name; group.count = (group.count ?? 0) + 1;
    (group.roles ??= new Set()).add(tool.role); (group.task_ids ??= new Set()).add(tool.task_id ?? "main");
  }

  // Cover each task interval with non-overlapping buckets, never summing its overlapping reviewers twice.
  for (const task of tasks.filter(completed)) {
    const activities = [];
    for (const request of requests.values()) if (request.task_id === task.task_id && completed(request)) activities.push({ start: request.start_ms, end: request.end_ms, bucket: `${request.role}_model`, priority: 5 });
    for (const wait of resources.values()) if (wait.task_id === task.task_id && wait.acquired_ms !== undefined) activities.push({ start: wait.queued_ms, end: wait.acquired_ms, bucket: `${wait.resource}_queue`, priority: 4 });
    for (const tool of tools.values()) if (tool.task_id === task.task_id && completed(tool)) activities.push({ start: tool.start_ms, end: tool.end_ms, bucket: "tool_execution", priority: 3 });
    for (const span of spans.values()) if (span.task_id === task.task_id && completed(span)) activities.push({ start: span.start_ms, end: span.end_ms,
      bucket: span.kind === "human_approval" ? "human_approval" : span.kind === "persistence" ? "persistence" : span.kind === "approval_decision" ? "approval_other" : "snapshot_other", priority: span.kind === "human_approval" ? 6 : span.kind === "persistence" ? 2 : 1 });
    const points = [...new Set([task.start_ms, task.end_ms, ...activities.flatMap(a => [Math.max(a.start, task.start_ms), Math.min(a.end, task.end_ms)])])]
      .filter(t => t >= task.start_ms && t <= task.end_ms).sort((a, b) => a - b);
    const buckets = {};
    for (let i = 1; i < points.length; i++) {
      const middle = (points[i - 1] + points[i]) / 2;
      const active = activities.filter(a => a.start <= middle && a.end >= middle).sort((a, b) => b.priority - a.priority)[0];
      const name = active?.bucket ?? "unattributed_orchestration";
      buckets[name] = (buckets[name] ?? 0) + points[i] - points[i - 1];
    }
    task.lease_hold_ms = task.end_ms - task.start_ms;
    task.ready_to_start_ms = task.start_ms - task.ready_ms;
    task.hold_buckets_ms = buckets;
    if (Math.abs(Object.values(buckets).reduce((a, b) => a + b, 0) - task.lease_hold_ms) > 0.001) issues.push("task_bucket_mismatch");
  }

  // Admission-level gating chain only: nested model queue waits remain inside their task's buckets.
  const chain = [], visited = new Set();
  let tail = tasks.filter(completed).sort((a, b) => b.end_ms - a.end_ms)[0];
  while (tail && !visited.has(tail)) {
    visited.add(tail); chain.unshift(tail.task_id);
    const definition = definitions.get(tail.task_id), candidates = [];
    const prior = id => tasks.filter(t => t.task_id === id && completed(t) && t.end_ms <= tail.start_ms).sort((a, b) => b.end_ms - a.end_ms)[0];
    for (const dep of definition?.dependencies ?? []) {
      const id = definition?.verifies === dep || !definitions.has(`${dep}.verify`) ? dep : `${dep}.verify`, task = prior(id);
      if (task) candidates.push(task);
    }
    for (const wait of workspaceWaits.filter(w => w.task_id === tail.task_id && w.at_ms <= tail.start_ms && w.at_ms >= (tail.ready_ms ?? 0))) {
      for (const blocker of wait.blocker_ids ?? []) { const task = prior(blocker); if (task && task.end_ms >= wait.at_ms) candidates.push(task); }
    }
    tail = candidates.sort((a, b) => b.end_ms - a.end_ms)[0];
  }
  return { valid_for_attribution: issues.length === 0, issues: [...new Set(issues)],
    trace_id: events[0]?.trace_id, mode: events[0]?.mode, source: events.find(e => e.event === "trace_start")?.data.source, outcome: runEnd?.data.status,
    wall_ms: runStart && runEnd ? runEnd.at_ms - runStart.at_ms : null,
    roles, resource_waits: waits, control_rejections: control, task_intervals: tasks,
    observed_task_admission_chain: chain,
    admission_chain_limitation: "Workspace and dependency gates are reconstructed. Nested model/approval waits remain in task hold buckets; this is not a full provider-compute critical path.",
    provider_attempts: [...attempts.values()], requests: [...requests.values()],
    repeated_tool_results: [...repeated.values()].filter(g => g.count > 1).map(g => ({ ...g, roles: [...g.roles], task_ids: [...g.task_ids] })),
    observer: traceSummary?.data,
    cumulative_duration_warning: "Parallel request/queue totals overlap. Only per-task hold buckets are a non-overlapping partition; they do not add up across concurrent tasks." };
}
