// Actual local implementations/checkers with scripted reviewer responses. No external provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-standard-review-errors-'));
process.env.NEUTRINO_HOME = path.join(root, 'home');
process.env.NEUTRINO_PLUGIN_HOME = path.join(root, 'plugins');
const oldFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = async () => { network++; throw new Error('External access is disabled'); };
const { TaskRuntime } = await import('../dist/llm/runtime.js');
const { StandardTask } = await import('../dist/llm/standard.js');
const { executeTool } = await import('../dist/llm/tools.js');
const { assessToolCall } = await import('../dist/llm/risk.js');
const { parseReviewVerdict } = await import('../dist/llm/standard-verdict.js');
const { standardReviewGroups } = await import('../dist/llm/standard-review.js');
const accept = { accepted: true, unresolved: [], reason: 'The actual local oracle and captured inputs cover the request.' };
const run = (r, name, args) => r.tool(name, args, () => executeTool(name, args, r.cwd));
const options = fn => ({ capacity: 1_000_000, createClient: () => ({ outcome: { status: 'completed' },
  usage: { prompt: 10, completion: 10, total: 20 }, async complete(system, body, settings) {
    assert.equal(settings.maxOutputTokens, 16384); assert.equal(settings.jsonOutput, true);
    assert.match(system, /FULL ORIGINAL REQUEST/);
    const value = await fn(JSON.parse(body), this, system);
    return typeof value === 'string' ? value : JSON.stringify(value);
  } }) });
const argsFor = (t, ids, artifacts = ['value.json']) => ({ status: 'completed', report: '已交付并执行本地检查，等待独立验收。',
  unresolved: [], artifact_paths: artifacts, checks: t.state.requirements.map(r => ({ requirement_id: r.id,
    detail: 'The actual checker asserts answer === 42.', evidence_ids: ids })) });
const runtimes = [];
async function fixture(label, callback, request = 'Verify the delivered numeric answer.') {
  const dir = path.join(root, label); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'value.json'), '{"answer":42}');
  fs.writeFileSync(path.join(dir, 'verify.cjs'), "const assert=require('node:assert/strict'),fs=require('node:fs');assert.equal(JSON.parse(fs.readFileSync('value.json','utf8')).answer,42);console.log('ACTUAL ORACLE PASSED');");
  const r = new TaskRuntime({ cwd: dir, request, limits: { tokens: 4_000_000, modelRequests: 100, toolCalls: 100 } });
  runtimes.push(r); const t = new StandardTask(r);
  await r.run(async () => {
    await run(r, 'read_file', { path: 'value.json' });
    await run(r, 'run_command', { command: 'node verify.cjs' });
    assert.equal(r.evidence.at(-1).status, 'completed');
    await callback({ r, t, dir, id: r.evidence.at(-1).id });
  });
  r.finish(t.state.status === 'completed' ? 'completed' : 'partial');
  return { r, t };
}
try {
  for (const text of ['', '{"accepted":true', '[]', '{"accepted":"true","unresolved":[],"reason":"x"}',
    '{"accepted":true,"unresolved":["still missing"],"reason":"x"}',
    '{"read_requests":[{"evidence_id":"e","offset":-1}],"reason":"x"}']) {
    assert.throws(() => parseReviewVerdict(text), error => error.code === 'invalid_assessment');
  }
  assert.equal(parseReviewVerdict('```json\n' + JSON.stringify(accept) + '\n```').accepted, true);

  await fixture('recover-internally', async ({ r, t, id }) => {
    let requests = 0, usage = 0;
    const before = r.evidence.length, original = r.originalRequest;
    const review = options((data, client, system) => {
      requests++; assert.equal(data.original_request, original);
      assert.deepEqual(data.checks[0].evidence_ids, [id]);
      if (requests > 1) assert.match(system, /review execution error, not an implementation defect/);
      if (requests === 1) { client.outcome = { status: 'failed', error: { code: 'output_limit' } }; return '{"accepted":true'; }
      if (requests === 2) return 'not-json';
      return accept;
    }); review.onUsage = value => { usage += value.total; };
    const result = await t.finish(argsFor(t, [id]), review);
    assert.equal(result.completed, true); assert.equal(result.outcome, 'accepted');
    assert.equal(requests, 3); assert.equal(usage, 60); assert.equal(r.evidence.length, before);
    assert.equal(t.state.completionAttempts, 1); assert.equal(t.state.reviewErrors, 2); assert.equal(t.state.reviewRecoveries, 2);
  });
  console.log('PASS output-limit and malformed-JSON recover in one finish with unchanged proof, exact usage and no implementation rerun');

  for (const mode of ['output_limit', 'invalid_json', 'network']) {
    const { r, t } = await fixture('pending-' + mode, async ({ r, t, id }) => {
      let requests = 0;
      const result = await t.finish(argsFor(t, [id]), options((_data, client) => {
        requests++;
        if (mode === 'network') throw new Error('Synthetic reviewer connection failure');
        if (mode === 'output_limit') client.outcome = { status: 'failed', error: { code: 'output_limit' } };
        return '{"accepted":true';
      }));
      assert.equal(requests, 3); assert.equal(result.settled, true); assert.equal(result.completed, false);
      assert.equal(result.outcome, 'verification_pending'); assert.equal(t.state.status, 'verification_pending');
      assert.match(result.report, /独立审查暂未完成/); assert.ok(t.state.requirements.every(q => !q.verified));
      assert.equal(r.evidence.filter(e => e.name === 'run_command').length, 1);
    });
    assert.equal(r.snapshot().standard.status, 'verification_pending'); assert.equal(r.snapshot().state, 'partial');
    assert.equal(t.state.reviewRecoveries, 2);
  }
  console.log('PASS persistent reviewer truncation, invalid JSON and connection errors stop as verification_pending after three requests');

  await fixture('real-defect', async ({ t, id }) => {
    let requests = 0;
    const result = await t.finish(argsFor(t, [id]), options(() => { requests++; return {
      accepted: false, unresolved: ['Missing required alternate-input behavior.'], reason: 'The checker covers only one input.' };
    }));
    assert.equal(result.outcome, 'rejected'); assert.equal(result.settled, false); assert.equal(requests, 1);
    assert.equal(t.state.reviewErrors, 0);
  });
  await fixture('concurrent-change', async ({ t, id, dir }) => {
    const result = await t.finish(argsFor(t, [id]), options(() => {
      fs.writeFileSync(path.join(dir, 'value.json'), '{"answer":43}'); return accept;
    }));
    assert.equal(result.completed, false); assert.match(result.feedback, /changed during review/);
  });
  await fixture('missing-read', async ({ r, t, id }) => {
    let requests = 0, reads = 0;
    const review = options(() => ++requests === 1 ? { read_requests: [{ path: 'value.json', start_line: 1, end_line: 1 }], reason: 'Inspect current bytes.' } : accept);
    review.inspect = async args => { reads++; const result = '[Not executed: independent read approval denied]'; r.recordTool('read_file', args, result, 'denied'); return result; };
    const result = await t.finish(argsFor(t, [id]), review);
    assert.equal(result.outcome, 'needs_evidence'); assert.equal(result.settled, false);
    assert.equal(result.evidence_requests[0].path, 'value.json'); assert.equal(reads, 1); assert.equal(requests, 2);
    assert.equal(t.state.reviewRecoveries, 0);
  });
  console.log('PASS substantive defects, concurrent changes and denied reads retain rejection/evidence outcomes without approval bypass');

  await fixture('metadata', async ({ r, t, id }) => {
    const setup = r.recordTool('create_check_workspace', {}, '[Error: EPERM: setup only]', 'failed');
    const args = argsFor(t, [id, id, setup.id]);
    args.checks.push({ ...args.checks[0], detail: 'Additional result for the same original requirement.', evidence_ids: [id] });
    const result = await t.finish(args, options(data => {
      assert.equal(data.checks.length, 1); assert.deepEqual(data.checks[0].evidence_ids, [id]);
      assert.ok(data.failed_or_denied_history.some(e => e.id === setup.id));
      assert.ok(data.excluded_positive_evidence.some(e => e.evidence_id === setup.id)); return accept;
    }));
    assert.equal(result.completed, true); assert.ok(t.state.metadataNormalizations >= 3);
    assert.ok(r.evidence.some(e => e.id === setup.id && e.status === 'failed'));
  });
  for (const mode of ['unknown', 'denied', 'unresolved-test']) {
    await fixture('invalid-proof-' + mode, async ({ r, t, id }) => {
      const invalid = mode === 'unknown' ? 'unknown-evidence' : r.recordTool('run_command', { command: 'node failing-check.cjs' },
        '[Error: unresolved regression]', mode === 'denied' ? 'denied' : 'failed').id;
      const result = await t.finish(argsFor(t, [id, invalid]), options(() => { throw new Error('Invalid proof must fail before model dispatch'); }));
      assert.equal(result.completed, false); assert.equal(result.outcome, 'metadata_error'); assert.equal(t.state.reviewRequests, 0);
    });
  }
  await fixture('superseded-test', async ({ r, t, dir }) => {
    fs.writeFileSync(path.join(dir, 'value.json'), '{"answer":43}');
    await run(r, 'run_command', { command: 'node verify.cjs' }); const failed = r.evidence.at(-1).id;
    assert.equal(r.evidence.at(-1).status, 'failed');
    fs.writeFileSync(path.join(dir, 'value.json'), '{"answer":42}');
    await run(r, 'read_file', { path: 'value.json' });
    await run(r, 'run_command', { command: 'node verify.cjs' }); const passed = r.evidence.at(-1).id;
    const result = await t.finish(argsFor(t, [failed, passed]), options(data => {
      assert.deepEqual(data.checks[0].evidence_ids, [passed]);
      assert.equal(data.excluded_positive_evidence[0].superseded_by, passed); return accept;
    })); assert.equal(result.completed, true);
  });
  console.log('PASS duplicate requirement/ID normalization and resolved setup/test history preserve the full ledger; unknown, denied and unresolved failures still block');

  const session = path.join(root, 'wrong-session-root'), project = path.join(root, 'actual-project');
  fs.mkdirSync(session); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'package.json'), '{"name":"local-fixture"}');
  const wr = new TaskRuntime({ cwd: session, request: 'Verify the actual project.' }); runtimes.push(wr); const wt = new StandardTask(wr);
  await wr.run(async () => {
    await run(wr, 'read_file', { path: path.join(project, 'package.json') });
    const args = { label: 'actual-project' }, preview = wt.approvalArguments('create_check_workspace', args);
    assert.equal(path.dirname(preview.path), fs.realpathSync(project));
    assert.equal(assessToolCall('create_check_workspace', preview, session).level, 'high');
    const created = JSON.parse(await wt.controlTool('create_check_workspace', args, async () => { throw new Error('No command should run'); }));
    assert.equal(created.path, preview.path); assert.equal(created.project_root, fs.realpathSync(project));
    assert.ok(!fs.readdirSync(session).some(p => p.startsWith('.neutrino-check-')));
    const originalMkdir = fs.mkdirSync;
    try {
      fs.mkdirSync = (directory, ...rest) => {
        if (path.dirname(String(directory)) === session && path.basename(String(directory)).startsWith('.neutrino-check-')) {
          const error = new Error('synthetic permission failure'); error.code = 'EPERM'; throw error;
        }
        return originalMkdir(directory, ...rest);
      };
      await assert.rejects(() => wt.controlTool('create_check_workspace', { project_root: session }, async () => ''), /not writable.*project_root/);
    } finally { fs.mkdirSync = originalMkdir; }
  }); wr.finish('partial');
  const confined = new TaskRuntime({ cwd: session, request: 'Work only inside the current workspace.' }); runtimes.push(confined);
  const confinedTask = new StandardTask(confined);
  await confined.run(async () => {
    await assert.rejects(() => confinedTask.controlTool('create_check_workspace', { project_root: project }, async () => ''), /outside the explicitly confined workspace/);
  }); confined.finish('partial');
  console.log('PASS actual project root is visible to approval and used exactly; EPERM is actionable and confinement still prevents external writes');

  for (const permanent of [false, true]) {
    await fixture('omitted-scope-' + permanent, async ({ r, t, dir }) => {
      const control = (name, args) => r.tool(name, args, () => t.controlTool(name, args,
        (command, cwd) => executeTool('run_command', { command }, cwd)));
      const workspace = JSON.parse(await control('create_check_workspace', {}));
      const script = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'value.json'))},'utf8')).answer,42);console.log('SCOPE ORACLE PASSED');`;
      await run(r, 'write_file', { path: path.join(workspace.path, 'verify.cjs'), content: script });
      await control('run_task_check', { workspace_id: workspace.workspace_id, command: 'node verify.cjs', input_paths: ['value.json'] });
      const id = r.evidence.at(-1).id, before = r.evidence.length;
      let requests = 0;
      const result = await t.finish(argsFor(t, [id]), options((data, _client, system) => {
        requests++;
        const binding = data.evidence.find(e => e.id === id).freshness.binding;
        if (requests > 1) assert.match(system, /omitted the required dependency scope assessment/);
        return permanent || requests === 1 ? accept : { ...accept, scope_assessments: [{ check_id: binding.check_id,
          dependencies_complete: true, reason: 'The checker reads only its captured script and bound JSON file.' }] };
      }));
      assert.equal(requests, permanent ? 3 : 2); assert.equal(result.completed, !permanent);
      assert.equal(result.outcome, permanent ? 'verification_pending' : 'accepted');
      assert.equal(r.evidence.length, before); assert.equal(t.state.completionAttempts, 1);
    });
  }
  await fixture('omitted-coverage', async ({ r, t, dir, id }) => {
    fs.writeFileSync(path.join(dir, 'output.json'), '{"status":"current"}');
    await run(r, 'read_file', { path: 'output.json' });
    fs.writeFileSync(path.join(dir, 'final-check.cjs'), "const assert=require('node:assert/strict');assert.equal(require('./value.json').answer,42);assert.equal(require('./output.json').status,'current');console.log('FINAL ORACLE PASSED');");
    await run(r, 'run_command', { command: 'node final-check.cjs' });
    const args = argsFor(t, [r.evidence.at(-1).id], ['value.json', 'output.json']);
    args.checks[0].evidence_ids = [id];
    let requests = 0;
    const result = await t.finish(args, options((data, _client, system) => {
      requests++; assert.deepEqual(data.coverage_gaps_requiring_independent_assessment, ['r1']);
      if (requests === 1) return accept;
      assert.match(system, /omitted the required coverage assessment for r1/);
      return { ...accept, coverage_assessments: [{ requirement_id: 'r1', coverage_complete: true, evidence_ids: [id],
        dependencies_complete: true, input_paths: ['value.json'], reason: 'The captured checker depends only on the unchanged numeric answer.' }] };
    }));
    assert.equal(requests, 2); assert.equal(result.completed, true); assert.equal(t.state.completionAttempts, 1);
  }, 'Verify the delivered numeric answer.\n\nVerify the current output.');
  console.log('PASS omitted dependency/coverage assessments recover inside review; persistently incomplete verdicts cannot accept or trigger actor repairs');

  const one = [{ id: 'r1', text: 'Verify the complete compound requirement and every dependency.' }];
  const partitions = standardReviewGroups(one, [{ id: 'r1', evidence_ids: ['a', 'b', 'c', 'd'] }],
    ['a', 'b', 'c', 'd'].map(id => ({ id, arguments: '{}', result: 'x'.repeat(7000) })));
  assert.equal(partitions.length, 2); assert.ok(partitions.every(g => g.evidence_partition && g.requirement_ids[0] === 'r1'));
  assert.deepEqual(new Set(partitions.flatMap(g => g.evidence_ids)), new Set(['a', 'b', 'c', 'd']));

  await fixture('focused-cache', async ({ r, t, dir }) => {
    const control = (name, args) => r.tool(name, args, () => t.controlTool(name, args, (command, cwd) => executeTool('run_command', { command }, cwd)));
    const w = JSON.parse(await control('create_check_workspace', {}));
    const script = `const fs=require('node:fs'),assert=require('node:assert/strict');assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'value.json'))},'utf8')).answer,42);console.log('SCOPED ORACLE PASSED '+ 'actual assertion '.repeat(350));`;
    await run(r, 'write_file', { path: path.join(w.path, 'verify.cjs'), content: script });
    const ids = [];
    for (let i = 0; i < 4; i++) {
      await control('run_task_check', { workspace_id: w.workspace_id, command: 'node verify.cjs ' + i, input_paths: ['value.json'], independent: true });
      assert.equal(r.evidence.at(-1).status, 'completed'); ids.push(r.evidence.at(-1).id);
    }
    let globalPass = false, globals = 0, focused = 0;
    const review = options(data => {
      if (data.review_phase === 'global') {
        globals++; assert.equal(data.original_request, r.originalRequest);
        assert.equal(data.independent_group_results.length, 2);
        return globalPass ? accept : { accepted: false, unresolved: ['Global coverage still needs assessment.'], reason: 'Positive partial evidence alone does not finish the task.' };
      }
      focused++; assert.equal(data.review_phase, 'focused'); assert.equal(data.checks[0].coverage_scope, 'partial_evidence_only');
      assert.deepEqual(new Set(data.checks[0].evidence_ids), new Set(data.evidence.map(e => e.id)));
      return { ...accept, scope_assessments: data.evidence.map(e => ({ check_id: e.freshness.binding.check_id,
        dependencies_complete: true, reason: 'The checker reads only its bound JSON input and captured script.' })) };
    });
    const args = argsFor(t, ids);
    assert.equal((await t.finish(args, review)).completed, false); assert.equal(focused, 2); assert.equal(globals, 1);
    globalPass = true;
    assert.equal((await t.finish(args, review)).completed, true); assert.equal(focused, 2); assert.equal(globals, 2);
    assert.equal(t.state.reviewCacheHits, 2); assert.equal(r.evidence.filter(e => e.name === 'run_task_check').length, 4);
    fs.writeFileSync(path.join(dir, 'value.json'), '{"answer":43}');
    const stale = await t.finish(args, review); assert.equal(stale.completed, false); assert.match(stale.feedback, /predates/);
  });
  console.log('PASS one large requirement partitions by evidence; unchanged scoped assessments reuse safely, global review stays fresh and changed inputs fail closed');

  assert.equal(network, 0);
  console.log('STANDARD REVIEW ERROR REGRESSION PASSED; external requests=0');
} finally {
  for (const runtime of runtimes) { try { runtime.finish('partial'); } catch {} }
  globalThis.fetch = oldFetch;
  const relative = path.relative(process.cwd(), root);
  assert.ok(relative.startsWith('tmp-standard-review-errors-') && !relative.includes(path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
