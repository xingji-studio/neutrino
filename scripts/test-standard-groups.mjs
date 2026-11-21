// Actual local files/commands; every model response is scripted, no external provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neutrino-standard-groups-'));
process.env.NEUTRINO_HOME = path.join(root, 'home');
process.env.NEUTRINO_PLUGIN_HOME = path.join(root, 'plugins');
const oldHome = os.homedir, oldFetch = globalThis.fetch;
os.homedir = () => root;
globalThis.fetch = async () => { throw new Error('External providers are forbidden in local regression'); };
const { TaskRuntime } = await import('../dist/llm/runtime.js');
const { StandardTask, requirementInventory } = await import('../dist/llm/standard.js');
const { StandardReadCache } = await import('../dist/llm/standard-read-cache.js');
const { standardReviewGroups } = await import('../dist/llm/standard-review.js');
const { parsePlan, coalesceStandardPlan } = await import('../dist/llm/plan.js');
const { readFileRange, fileHash } = await import('../dist/llm/editing.js');
const { executeTool } = await import('../dist/llm/tools.js');
const results = { external_provider_requests: 0, cases: [], measurements: {}, driver_results: [] };
const pass = name => { results.cases.push({ name, passed: true }); console.log('PASS', name); };
const delay = ms => new Promise(r => setTimeout(r, ms));
const accept = { accepted: true, unresolved: [], reason: 'The actual local oracle and current evidence cover the assigned complete clauses' };
const run = (r, name, args) => r.tool(name, args, () => executeTool(name, args, r.cwd));
const finishArgs = (task, ids, artifacts) => ({ status: 'completed', report: 'Local implementation and actual checks verified', artifact_paths: artifacts, unresolved: [],
  checks: task.state.requirements.map((r, i) => ({ requirement_id: r.id, detail: 'Actual local checker and current artifact contents', evidence_ids: [ids[i % ids.length]] })) });
const reviewOptions = fn => ({ capacity: 1_000_000, createClient: () => ({ outcome: { status: 'completed' }, usage: { prompt: 11, completion: 6, total: 17 },
  async complete(system, body, options) { assert.match(system, /FULL ORIGINAL REQUEST/); assert.equal(options.maxOutputTokens, 16384); return JSON.stringify(await fn(JSON.parse(body), this)); } }) });
const inspect = r => args => r.tool('read_file', args, () => executeTool('read_file', args, r.cwd));
const planned = { goal: 'Implement and verify the complete transformation', steps: [
  { title: 'Inspect module', kind: 'inspect', targets: ['module.mjs'], detail: 'Preserve every public branch' },
  { title: 'Build transformation', kind: 'implement', targets: ['./module.mjs'], detail: 'Derive values from the input' },
  { title: 'Filter metadata', kind: 'implement', targets: ['module.mjs'], detail: 'Remove private metadata without dropping public mappings' },
  { title: 'Emit index', kind: 'implement', targets: ['module.mjs'], acceptanceCriteria: ['Keep relative paths'], detail: 'Describe every output' },
  { title: 'Independent variations', kind: 'verify', targets: ['verify.mjs'], independent: true, detail: 'Exercise alternate inputs and inspect derived content' },
] };
try {
  const parsed = parsePlan(JSON.stringify(planned));
  const merged = coalesceStandardPlan(parsed, 'Implement the transformation, then verify the actual outputs.', root);
  assert.equal(merged.steps.length, 2); assert.equal(merged.steps[0].mergedFrom.length, 4);
  for (const original of parsed.steps.slice(0, 4)) assert.ok(merged.steps[0].detail.includes(original.detail));
  assert.deepEqual(merged.steps[0].acceptanceCriteria, ['Keep relative paths']);
  assert.equal(merged.steps[1].independent, true); assert.equal(parsed.steps.length, 5);
  assert.equal(coalesceStandardPlan(parsed, '1. Inspect\n2. Implement', root), parsed);
  assert.equal(coalesceStandardPlan(parsed, '1.检查\n2.实现', root), parsed);
  const dependent = { ...parsed, steps: parsed.steps.map((s, i) => ({ ...s, id: 's' + i, dependsOn: i ? ['s' + (i - 1)] : [] })) };
  assert.equal(coalesceStandardPlan(dependent, 'Implement', root), dependent);
  const legacy = parsePlan('{"steps":["Inspect","Implement","Verify"]}');
  assert.equal(coalesceStandardPlan(legacy, 'Implement', root).steps.length, 3);
  const separate = { ...parsed, steps: [parsed.steps[1], { ...parsed.steps[2], independent: true }, parsed.steps[4]] };
  assert.equal(coalesceStandardPlan(separate, 'Implement', root).steps.length, 3);
  results.measurements.plan = { model_planned_steps: 5, coalesced_steps: 2, preserved_original_parts: 5, required_independent_checks: 1 };
  pass('same-file work coalesces with all original details; user lists, dependencies, independent checks and legacy plans are preserved');

  // Real read pages join by version and actual line numbers; a partial read cannot assert EOF.
  const pages = path.join(root, 'pages.txt'); fs.writeFileSync(pages, 'a\r\nb\r\nc\r\nd\r\n');
  const sha = fileHash(fs.readFileSync(pages)), cache = new StandardReadCache();
  assert.equal(cache.remember(pages, sha, 'fabricated text', 'e0'), false);
  assert.equal(cache.remember(pages, sha, readFileRange(pages, { start_line: 1, end_line: 2 }), 'e1'), true);
  assert.equal(cache.read(pages, sha, 2, 4), undefined); assert.equal(cache.read(pages, sha, 6, 7), undefined);
  cache.remember(pages, sha, readFileRange(pages, { start_line: 3, end_line: 8 }), 'e2');
  const joined = cache.read(pages, sha, 2, 4); assert.deepEqual(joined.evidenceIds, ['e1', 'e2']); assert.match(joined.content, /2: b/);
  assert.equal(cache.read(pages, sha, 6, 7).eof, true);
  assert.equal(cache.read(pages, fileHash('changed'), 1, 2), undefined);
  const large = path.join(root, 'large-page.txt'); fs.writeFileSync(large, Array.from({length: 150}, () => 'long source line '.repeat(30)).join('\n'));
  const largeHash = fileHash(fs.readFileSync(large)); cache.remember(large, largeHash, readFileRange(large, {start_line: 1, end_line: 200}), 'large-evidence');
  const limited = cache.read(large, largeHash, 1, 200); assert.ok(limited.content.length <= 12000);
  assert.equal(JSON.parse(limited.content).truncated, true); assert.deepEqual(JSON.parse(limited.content).original_evidence_ids, ['large-evidence']);
  assert.doesNotMatch(cache.read(large, largeHash, 151, 160).content, /already inspected/);
  pass('same-version CRLF pages join with original proof IDs; stale, incomplete and fabricated observations cannot answer reads');

  async function complex(label, callback, extra = {}) {
    const dir = path.join(root, label); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'output.json'), JSON.stringify({ answer: 42, publicName: 'Ada', metadata: ['public'] }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'oracle.cjs'), `const assert=require('node:assert/strict'),fs=require('node:fs');const q=JSON.parse(fs.readFileSync('output.json','utf8'));assert.equal(q.answer,42);assert.equal(q.publicName,'Ada');console.log('oracle passed '+process.argv[2]+' '+ 'observed assertion '.repeat(190));`);
    const request = ['Preserve the public numeric answer.', 'Preserve the public display name.', 'Keep metadata public and never embed private contents or local paths.',
      'Preserve the actual output format.', 'Verify compatible alternate input behavior.', 'Keep the entry command compatible.', 'Inspect all derived content, including nested metadata.', 'Retain the required independent validation.'].join('\n\n');
    const runtime = new TaskRuntime({ cwd: dir, request, limits: { tokens: 2_000_000, modelRequests: 100, toolCalls: 100, ...extra.limits } });
    const task = new StandardTask(runtime); let ids = [];
    await runtime.run(async () => {
      await run(runtime, 'read_file', { path: 'output.json', start_line: 1, end_line: 20 });
      for (let i = 0; i < 8; i++) { await run(runtime, 'run_command', { command: 'node oracle.cjs ' + i }); ids.push(runtime.evidence.at(-1).id); }
      await callback({ dir, request, runtime, task, args: finishArgs(task, ids, ['output.json']), ...extra });
    }); runtime.finish(task.state.status === 'completed' ? 'completed' : 'partial');
    return task;
  }
  let active = 0, peak = 0, finished = 0, usage = 0; const payloads = [];
  await complex('group-success', async ({ request, runtime, task, args }) => {
    const options = reviewOptions(async data => {
      active++; peak = Math.max(peak, active); payloads.push(data); await delay(8); active--;
      assert.equal(data.original_request, request); assert.equal(data.requirements.length, 8);
      if (data.review_phase === 'focused') {
        assert.ok(data.checks.every(c => data.focus_requirement_ids.includes(c.id)));
        const needed = new Set(data.checks.flatMap(c => c.evidence_ids));
        assert.deepEqual(new Set(data.evidence.map(e => e.id)), needed); finished++;
      } else { assert.equal(finished, 2); assert.equal(data.review_phase, 'global'); assert.equal(data.independent_group_results.length, 2); assert.ok(data.evidence.every(e => e.result === undefined)); }
      return accept;
    }); options.onUsage = q => { usage += q.total; };
    assert.equal((await task.finish(args, options)).completed, true);
    assert.equal(task.state.reviewGroups, 2); assert.equal(task.state.reviewRequests, 3);
    assert.ok(task.state.requirements.every(r => r.verified));
    const focused = payloads.filter(p => p.review_phase === 'focused');
    assert.deepEqual(new Set(focused.flatMap(p => p.focus_requirement_ids)), new Set(task.state.requirements.map(r => r.id)));
    const bytes = focused.map(p => Buffer.byteLength(JSON.stringify(p)));
    results.measurements.grouped_review = { requirements: 8, focus_groups: 2, global_verdicts: 1, requests: 3, peak_concurrent: peak,
      focus_payload_bytes: bytes, global_payload_bytes: Buffer.byteLength(JSON.stringify(payloads.at(-1))), scripted_usage_total: usage };
  });
  assert.equal(peak, 2); assert.equal(usage, 51);
  pass('complex independent reviews run at most two in parallel; every whole requirement and the final global verdict remain mandatory');

  for (const mode of ['group-reject', 'global-reject', 'truncated', 'cancelled']) {
    await complex(mode, async ({ runtime, task, args }) => {
      let calls = 0, charged = 0, drained = false;
      const options = reviewOptions(async (data, client) => {
        calls++;
        if (data.review_phase === 'focused' && calls === 1 && mode !== 'global-reject') {
          if (mode === 'truncated') { client.outcome = { status: 'failed', error: { code: 'output_limit' } }; return accept; }
          if (mode === 'cancelled') { await delay(2); runtime.cancel('fixture cancellation'); return accept; }
          return { accepted: false, unresolved: ['Missing derived-content proof'], reason: 'Public checks cannot prove privacy' };
        }
        await delay(12); drained = true;
        return data.review_phase === 'global' ? { accepted: false, unresolved: ['Uncovered interaction'], reason: 'Global validation still required' } : accept;
      }); options.onUsage = q => { charged += q.total; };
      const result = await task.finish(args, options); assert.equal(result.completed, false);
      assert.ok(task.state.requirements.every(r => !r.verified)); assert.equal(charged, calls * 17);
      if (mode !== 'global-reject') { assert.equal(calls, 2); assert.equal(drained, true); }
      else assert.equal(calls, 3);
      results.measurements[mode] = { requests: calls, usage_settled: charged, completed: result.completed };
    });
  }
  pass('group/global rejection, output limit and cancellation fail closed and drain already dispatched usage');

  await complex('group-reads', async ({ runtime, task, args }) => {
    const turns = new Map(); let physical = 0;
    const options = reviewOptions(async data => {
      const key = data.focus_requirement_ids?.join(',') ?? 'global', n = (turns.get(key) ?? 0) + 1; turns.set(key, n);
      if (n === 1) return { read_requests: [{ path: 'output.json', start_line: data.review_phase === 'global' ? 2 : 1, end_line: 4 }], reason: 'Inspect actual current content' };
      assert.equal(n, 2); assert.equal(data.inspections.length, 1);
      if (data.review_phase === 'global') { const read = JSON.parse(data.inspections[0].content); assert.equal(read.source, 'independent_read_cache'); assert.ok(read.original_evidence_ids.length); }
      else assert.match(data.inspections[0].content, /42/);
      return accept;
    });
    options.inspect = async q => { physical++; await delay(10); return inspect(runtime)(q); };
    assert.equal((await task.finish(args, options)).completed, true);
    assert.equal(physical, 1); assert.equal(task.state.inspectionReads, 1); assert.equal(task.state.inspectionSharedReads, 1); assert.ok(task.state.inspectionCacheHits >= 1); assert.equal(task.state.reviewRequests, 6);
    results.measurements.shared_reads = { requested_pages: 3, physical_reads: physical, original_evidence_ids_retained: true, review_requests: task.state.reviewRequests };
  });
  pass('parallel identical reads share one approved operation; overlapping global rereads use same-SHA observations with original IDs');

  for (const conflict of [false, true]) {
    await complex('scope-' + conflict, async ({ runtime, task, args, dir }) => {
      const control = (name, a) => runtime.tool(name, a, () => task.controlTool(name, a, (command, cwd) => executeTool('run_command', { command }, cwd)));
      const w = JSON.parse(await control('create_check_workspace', {}));
      const script = "const fs=require('node:fs'),assert=require('node:assert/strict');const q=JSON.parse(fs.readFileSync(" + JSON.stringify(path.join(dir, 'output.json')) + ",'utf8'));assert.equal(q.answer,42);console.log('scoped oracle passed')";
      await run(runtime, 'write_file', { path: path.join(w.path, 'verify.cjs'), content: script });
      const proof = JSON.parse(await control('run_task_check', { workspace_id: w.workspace_id, command: 'node verify.cjs', input_paths: [path.join(dir, 'output.json')] }));
      const eid = runtime.evidence.at(-1).id; args.checks[0].evidence_ids.push(eid);
      const options = reviewOptions(async data => {
        const bound = data.evidence.find(e => e.id === eid)?.freshness?.binding;
        if (bound) { assert.match(bound.checker_source.text, /assert.equal/); return { ...accept, scope_assessments: [{ check_id: proof.check_id, dependencies_complete: true, reason: 'Actual script reads only the captured output and Node built-ins' }] }; }
        return data.review_phase === 'global' && conflict ? { ...accept, scope_assessments: [{ check_id: proof.check_id, dependencies_complete: false, reason: 'Global scope remains uncertain' }] } : accept;
      });
      const result = await task.finish(args, options); assert.equal(result.completed, !conflict, result.feedback);
      if (conflict) assert.match(result.feedback, /conflicting|incomplete/);
    });
  }
  pass('focused dependency assessment can support the global check, but a conflicting global assessment always rejects completion');

  await complex('global-content-oracle', async ({ dir, runtime, task, args }) => {
    // Public behavior remains correct; the generic confidentiality oracle inspects actual bytes.
    const file = path.join(dir, 'output.json'); const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    content.metadata.push({ privateDebug: 'PRIVATE_LOCAL_FIXTURE' }); fs.writeFileSync(file, JSON.stringify(content) + '\n');
    await run(runtime, 'read_file', { path: file });
    for (let i = 0; i < args.checks.length; i++) { await run(runtime, 'run_command', { command: 'node oracle.cjs ' + i }); args.checks[i].evidence_ids = [runtime.evidence.at(-1).id]; }
    const options = reviewOptions(data => data.review_phase === 'global' && fs.readFileSync(file, 'utf8').includes('PRIVATE_LOCAL_FIXTURE')
      ? { accepted: false, unresolved: ['Actual derived metadata contains private bytes'], reason: 'Public behavior passed; actual confidentiality failed' } : accept);
    assert.equal((await task.finish(args, options)).completed, false); assert.equal(task.state.reviewRequests, 3);
    assert.ok(task.state.requirements.every(r => !r.verified));
  });
  pass('positive focused labels and passing public behavior cannot bypass the final actual derived-content confidentiality oracle');

  await complex('bounded-reads', async ({ task, args }) => {
    let calls = 0;
    const options = reviewOptions(data => { calls++; return { read_requests: [{ evidence_id: data.evidence[0].id, offset: 0 }], reason: 'Still missing an essential detail' }; });
    assert.equal((await task.finish(args, options)).completed, false); assert.ok(calls <= 4);
    assert.ok(task.state.requirements.every(r => !r.verified));
  });
  pass('repeated missing-detail requests stop within the bounded phase allowance; no speculative acceptance or unbounded review loop');

  // Persist observations across completion candidates, but invalidate on actual changes and denials.
  for (const mode of ['unchanged', 'changed', 'denied', 'symlink', 'callback-unrecorded', 'out-of-range']) {
    if (mode === 'symlink' && process.platform === 'win32') continue;
    const dir = path.join(root, 'cache-' + mode); fs.mkdirSync(dir);
    const output = path.join(dir, 'out.txt'); fs.writeFileSync(output, 'public\nline two\nline three\n');
    const runtime = new TaskRuntime({ cwd: dir, request: 'Verify the actual delivered output.', workspaceOnly: true }); const task = new StandardTask(runtime);
    let physical = 0, candidate = 0;
    await runtime.run(async () => {
      const prove = async () => { await run(runtime, 'read_file', { path: output, start_line: 1, end_line: 10 }); await run(runtime, 'run_command', { command: "node -e \"console.log('actual output check passed')\"" }); return runtime.evidence.at(-1).id; };
      let id = await prove();
      const options = reviewOptions(async data => {
        if (!data.inspections.length) return { read_requests: [{ path: output, start_line: candidate && mode === 'out-of-range' ? 5 : 1, end_line: candidate && mode === 'out-of-range' ? 6 : 10 }], reason: 'Read actual current output' };
        if (!candidate) return { accepted: false, unresolved: ['Need a stronger completion explanation'], reason: 'Retain read but reject this candidate' };
        return accept;
      });
      options.inspect = async q => {
        physical++;
        if (mode === 'denied') { const msg = '[Not executed: independent read approval denied]'; runtime.recordTool('read_file', q, msg, 'denied'); return msg; }
        if (mode === 'callback-unrecorded') return readFileRange(q.path, q);
        return inspect(runtime)(q);
      };
      assert.equal((await task.finish(finishArgs(task, [id], [output]), options)).completed, false);
      candidate++;
      if (mode === 'changed') fs.appendFileSync(output, 'new content\n');
      if (mode === 'symlink') { const outside = path.join(root, 'outside-' + mode); fs.writeFileSync(outside, 'outside'); fs.unlinkSync(output); fs.symlinkSync(outside, output); }
      if (mode !== 'symlink') id = await prove();
      const result = await task.finish(finishArgs(task, [id], [output]), options);
      if (mode === 'denied' || mode === 'symlink') assert.equal(result.completed, false); else assert.equal(result.completed, true, result.feedback);
      if (mode === 'unchanged' || mode === 'out-of-range') { assert.equal(physical, 1); assert.equal(task.state.inspectionCacheHits, 1); }
      else if (mode === 'symlink') assert.equal(physical, 1); else assert.equal(physical, 2);
      results.measurements['cache-' + mode] = { actual_callbacks: physical, cache_hits: task.state.inspectionCacheHits, completed: result.completed };
    }); runtime.finish('partial');
  }
  pass('cross-candidate reads reuse only authorized recorded current versions; changes, denials, symlinks and unrecorded callbacks never become cached proof');

  // Same workspace with newly generated output is a changed pre-execution snapshot, so a real rerun is essential.
  const cd = path.join(root, 'generated-check'); fs.mkdirSync(cd); const input = path.join(cd, 'input.txt'); fs.writeFileSync(input, 'public');
  const cr = new TaskRuntime({ cwd: cd, request: 'Verify the ordinary regression and an independent repetition.' }), ct = new StandardTask(cr); let commands = 0;
  await cr.run(async () => {
    await run(cr, 'read_file', { path: input });
    const control = (name, args) => cr.tool(name, args, () => ct.controlTool(name, args, async (command, cwd) => { commands++; return executeTool('run_command', { command }, cwd); }));
    const w = JSON.parse(await control('create_check_workspace', {}));
    await run(cr, 'write_file', { path: path.join(w.path, 'check.cjs'), content: "const fs=require('node:fs');fs.writeFileSync('generated.txt','stable');console.log('check passed')" });
    const a = { workspace_id: w.workspace_id, command: 'node check.cjs', input_paths: [input], reuse: true };
    await control('run_task_check', a); await control('run_task_check', a); assert.equal(commands, 2);
    const alias = JSON.parse(await control('run_task_check', a)); assert.equal(alias.reused, true); assert.equal(commands, 2);
    await control('run_task_check', { ...a, independent: true }); assert.equal(commands, 3);
    fs.writeFileSync(path.join(w.path, 'generated.txt'), 'different'); await control('run_task_check', a); assert.equal(commands, 4);
  }); cr.finish('partial');
  results.measurements.explicit_reuse = { requests: 5, commands, independent_executions_never_cached: true };
  pass('ordinary explicit reuse needs identical pre-run fixtures; generated outputs, changed fixtures and independent flags force actual execution');

  // Actual Web/TUI planner and API paths: metadata coalesces five steps into two,
  // immutable original contract precedes the changing phase directive in both requests.
  const { createWebSession } = await import('../dist/web/session.js');
  const { ChatScreen } = await import('../dist/screens/chat.js');
  const { defaultState } = await import('../dist/state.js');
  const config = await import('../dist/config.js');
  const model = { name: 'deepseek-flash', url: 'https://fixture.invalid/v1', api_key: 'fixture-only', context_window: 1_000_000 };
  config.saveModels({ providers: [{ name: 'DeepSeek', models: [model] }] });
  config.saveConfig({ ...config.loadConfig(), selected_provider: 'DeepSeek', selected_model: model.name, selected_intensity: 'Max', plan_first: true, task_budget_scope: 'task', task_max_tokens: 2_000_000, task_max_requests: 100, task_max_tools: 100 });
  process.env.NEUTRINO_PLAN = 'on';
  const response = (content = '', calls = []) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content, tool_calls: calls.map((c, index) => ({ index, id: `c-${index}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  const { LLMClient } = await import('../dist/llm/client.js');
  await complex('shared-model-budget', async ({ runtime, task, args }) => {
    let dispatched = 0;
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).hostname, 'fixture.invalid');
      const body = JSON.parse(init.body); assert.equal(body.reasoning_effort, 'max'); assert.equal(body.max_tokens, 16384);
      dispatched++; await delay(5); return response(JSON.stringify(accept));
    };
    const result = await task.finish(args, { capacity: 1_000_000, createClient: () => new LLMClient(model, 'DeepSeek', 'Max') });
    assert.equal(result.completed, false); assert.equal(dispatched, 2); assert.equal(runtime.snapshot().counts.modelRequests, 2);
    assert.equal(runtime.snapshot().counts.tokens, 360); assert.equal(runtime.snapshot().budgetStop.code, 'request_budget');
    assert.equal(runtime.remainingRequestTokens(), runtime.limits.tokens - 360);
    results.measurements.shared_budget = { dispatched, charged_scripted_tokens: 360, final_global_review_blocked: true, remaining_reservations: 0 };
  }, { limits: { modelRequests: 3 } });
  pass('grouped calls use the actual shared client budget; a missing global-review allowance cannot record completion and reservations settle');

  for (const kind of ['web', 'terminal']) {
    const dir = path.join(root, 'driver-' + kind); fs.mkdirSync(dir); const file = path.join(dir, 'module.mjs'); fs.writeFileSync(file, 'export const answer = 42;\n');
    fs.writeFileSync(path.join(dir, 'verify.cjs'), "import('./module.mjs').then(m=>{require('node:assert/strict').equal(m.answer,42);console.log('verified')})");
    const request = 'Please plan how to inspect the module, then independently verify its actual answer.';
    let planning = 0, actors = 0, reviews = 0; const systems = [];
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).hostname, 'fixture.invalid');
      const b = JSON.parse(init.body); assert.equal(b.model, model.name); assert.equal(b.reasoning_effort, 'max'); assert.equal(b.thinking.type, 'enabled'); assert.equal(b.max_tokens, 16384);
      const system = b.messages[0].content;
      if (system.includes('independent completion reviewer for Standard')) { reviews++; return response(JSON.stringify(accept)); }
      if (!b.tools?.length) { planning++; return response(JSON.stringify(planned)); }
      systems.push(system); actors++;
      const call = (name, args) => ({ name, args: { ...args, reason: 'Verify the actual local fixture' } });
      if (actors === 1) return response('Inspect the original module', [call('read_file', { path: file, start_line: 1, end_line: 2 })]);
      if (actors === 2) return response('Implementation group ready');
      if (actors === 3) return response('Run actual required check', [call('run_command', { command: 'node verify.cjs' })]);
      if (actors === 4) {
        const proof = [...b.messages].reverse().find(m => m.role === 'tool' && m.content.includes('verified')); assert.ok(proof);
        const id = /Task evidence: ([^;]+);/.exec(proof.content)[1];
        return response('', [call('finish_standard_task', finishArgs({ state: { requirements: requirementInventory(request) } }, [id], [file]))]);
      }
      throw new Error('Unexpected actor request ' + actors);
    };
    let session;
    if (kind === 'web') { session = createWebSession(dir, { provider: 'DeepSeek', model, intensity: 'Max' }); session.start(); }
    else { session = new ChatScreen(''); session.app = { width: 100, height: 30, state: { ...defaultState(), selectedProvider: 'DeepSeek', selectedModelName: model.name, selectedModelUrl: model.url, selectedModelApiKey: model.api_key, selectedModelStreaming: true, selectedIntensity: 'Max' }, render() {}, popScreen() {}, showToast() {}, bell() {} }; session.loadedCwd = dir; session.loadedModel = model.name; session.loadedProvider = 'DeepSeek'; session.loadedIntensity = 'Max'; session.onActivate(); }
    try {
      session.liveSend(request); const stop = Date.now() + 15_000;
      while (session.liveMeta().busy) { assert.ok(Date.now() < stop, 'Planner integration timed out'); await delay(5); }
      const s = session.liveMeta(); assert.equal(s.task.state, 'completed', JSON.stringify(session.messages.slice(-3)));
      assert.equal(session.plan.steps.length, 2); assert.deepEqual(session.plan.steps.map(s => s.status), ['done', 'done']);
      assert.equal(planning, 1); assert.equal(actors, 4); assert.equal(reviews, 1);
      const marker = 'Acceptance inventory (';
      const prefix = x => x.slice(0, x.indexOf('\n', x.indexOf(marker)));
      assert.ok(systems.every(s => s.includes(marker))); assert.equal(prefix(systems[0]), prefix(systems[2]));
      assert.ok(systems[0].indexOf('Original user request and constraints') < systems[0].indexOf('Detail for this step:'));
      results.driver_results.push({ driver: kind, planned_steps: 5, executed_steps: 2, model_requests: s.task.counts.modelRequests,
        model: model.name, actual_api_effort: 'max', thinking: 'enabled', output_ceiling: 16384, stable_contract_prefix_bytes: Buffer.byteLength(prefix(systems[0])) });
    } finally { kind === 'web' ? session.dispose() : session.onDeactivate(); }
  }
  pass('Web and TUI execute the coalesced plan; fixed contract prefix, full original request, actual API Max and 16384 output ceiling remain intact');
  results.passed = true;
  if (process.env.NEUTRINO_STANDARD_GROUPS_RESULTS) fs.writeFileSync(process.env.NEUTRINO_STANDARD_GROUPS_RESULTS, JSON.stringify(results, null, 2) + '\n');
  console.log('STANDARD GROUPED REVIEW REGRESSION PASSED; external providers=0');
} finally {
  globalThis.fetch = oldFetch; os.homedir = oldHome; delete process.env.NEUTRINO_PLAN;
  if (process.env.NEUTRINO_STANDARD_GROUPS_FIXTURES) { fs.mkdirSync(process.env.NEUTRINO_STANDARD_GROUPS_FIXTURES, { recursive: true }); fs.cpSync(root, path.join(process.env.NEUTRINO_STANDARD_GROUPS_FIXTURES, path.basename(root)), { recursive: true }); }
  fs.rmSync(root, { recursive: true, force: true });
}
