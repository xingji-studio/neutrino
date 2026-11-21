// Real local checks with scripted provider responses; no external model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neutrino-completion-recovery-'));
process.env.NEUTRINO_HOME = path.join(root, 'home');
process.env.NEUTRINO_PLUGIN_HOME = path.join(root, 'plugins');
process.env.NEUTRINO_PLAN = 'off';
const oldHome = os.homedir, oldFetch = globalThis.fetch;
os.homedir = () => root;
const { StandardTask } = await import('../dist/llm/standard.js');
const { fileHash } = await import('../dist/llm/editing.js');
const { createWebSession } = await import('../dist/web/session.js');
const { ChatScreen } = await import('../dist/screens/chat.js');
const { defaultState } = await import('../dist/state.js');
const config = await import('../dist/config.js');
const model = { name: 'deepseek-flash', url: 'https://fixture.invalid/v1', api_key: 'fixture-only', context_window: 1_000_000 };
const originalCurrent = StandardTask.prototype.acceptedArtifactsCurrent;
const response = (content = '', calls = [], finish = 'stop') => new Response(`data: ${JSON.stringify({
  choices: [{ delta: { content, tool_calls: calls.map((c, index) => ({ index, id: `c-${index}`, type: 'function',
    function: { name: c.name, arguments: JSON.stringify(c.args) } })) }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: finish === 'length' ? 16384 : 80, total_tokens: finish === 'length' ? 16484 : 180 },
})}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
const tool = (name, args) => ({ name, args: { ...args, reason: 'Verify the actual local fixture' } });
const latest = (body, marker) => [...body.messages].reverse().find(m => m.role === 'tool' && m.content.includes(marker));
const resultOf = message => JSON.parse(message.content.split('\n[Task evidence:')[0]);
const evidenceId = message => /Task evidence: ([^;]+);/.exec(message.content)[1];
const waitUntil = async predicate => {
  const stop = Date.now() + 15_000;
  while (!predicate()) { assert.ok(Date.now() < stop, 'Completion recovery timed out'); await new Promise(r => setTimeout(r, 5)); }
};
function open(kind, dir) {
  if (kind === 'web') {
    const session = createWebSession(dir, { provider: 'DeepSeek', model, intensity: 'Max' }); session.start(); return session;
  }
  const session = new ChatScreen('');
  session.app = { width: 100, height: 30, state: { ...defaultState(), selectedProvider: 'DeepSeek', selectedModelName: model.name,
    selectedModelUrl: model.url, selectedModelApiKey: model.api_key, selectedModelStreaming: true, selectedIntensity: 'Max' },
    render() {}, popScreen() {}, showToast() {}, bell() {} };
  session.loadedCwd = dir; session.loadedModel = model.name; session.loadedProvider = 'DeepSeek'; session.loadedIntensity = 'Max';
  session.onActivate(); return session;
}
const close = (kind, session) => kind === 'web' ? session.dispose() : session.onDeactivate();

try {
  config.saveConfig({ ...config.loadConfig(), selected_provider: 'DeepSeek', selected_model: model.name, selected_intensity: 'Max',
    approval_mode: 'full', task_budget_scope: 'delegation', auto_title: false });
  for (const kind of ['web', 'cli']) {
    const dir = path.join(root, kind); fs.mkdirSync(dir);
    const moduleFile = path.join(dir, 'module.json'), expectedFile = path.join(dir, 'expected.json');
    fs.writeFileSync(moduleFile, '{"answer":42}'); fs.writeFileSync(expectedFile, '{"answer":42}');
    const checker = `const fs=require('node:fs'),assert=require('node:assert/strict');
const actual=JSON.parse(fs.readFileSync(${JSON.stringify(moduleFile)},'utf8'));
const expected=JSON.parse(fs.readFileSync(${JSON.stringify(expectedFile)},'utf8'));
assert.equal(actual.answer,expected.answer);console.log('DEPENDENCY CHECK PASSED');`;
    const report = '已补全依赖并重新检查，模块结果与预期一致。';
    let actors = 0, reviews = 0, changed = false;
    StandardTask.prototype.acceptedArtifactsCurrent = function () {
      if (!changed && this.runtime.cwd === dir) { changed = true; fs.writeFileSync(moduleFile, '{"answer":43}'); }
      return originalCurrent.call(this);
    };
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).hostname, 'fixture.invalid');
      const body = JSON.parse(init.body);
      assert.equal(body.model, model.name); assert.equal(body.reasoning_effort, 'max'); assert.equal(body.max_tokens, 16384);
      if (body.messages[0].content.includes('independent completion reviewer for Standard')) {
        reviews++;
        const data = JSON.parse(body.messages[1].content), proof = data.evidence.find(e => e.name === 'run_task_check');
        assert.ok(proof?.freshness.current); assert.match(proof.result, /DEPENDENCY CHECK PASSED/);
        const binding = proof.freshness.binding;
        assert.match(binding.checker_source.text, /expected=JSON.parse/);
        if (reviews === 1) return response('{"accepted":', [], 'length');
        if (reviews === 2) {
          assert.equal(Object.hasOwn(binding.inputs, expectedFile), false);
          return response(JSON.stringify({ accepted: false, unresolved: ['Declare and hash the expected.json dependency, then rerun the check.'],
            reason: 'The passing checker reads an undeclared external input.',
            scope_assessments: [{ check_id: binding.check_id, dependencies_complete: false, reason: 'expected.json is not bound.' }] }));
        }
        assert.equal(binding.inputs[moduleFile], fileHash(fs.readFileSync(moduleFile)));
        assert.equal(binding.inputs[expectedFile], fileHash(fs.readFileSync(expectedFile)));
        return response(JSON.stringify({ accepted: true, unresolved: [], reason: 'Actual checks cover both captured inputs.',
          scope_assessments: [{ check_id: binding.check_id, dependencies_complete: true, reason: 'Both files read by the checker are hash-bound.' }] }));
      }
      const call = (name, args) => response('', [tool(name, args)]);
      const finish = () => call('finish_standard_task', { status: 'completed', report, artifact_paths: [moduleFile], unresolved: [],
        checks: [{ requirement_id: 'r1', evidence_ids: [evidenceId(latest(body, '"passed":true'))], detail: 'Actual dependency check passed.' }] });
      const workspace = () => resultOf(latest(body, '"retained_for_audit":true'));
      const check = inputs => call('run_task_check', { workspace_id: workspace().workspace_id,
        command: `node "${path.join(workspace().path, 'check dependency.cjs')}"`, input_paths: inputs });
      switch (actors++) {
        case 0: return call('read_file', { path: moduleFile });
        case 1:
        case 2: return call('finish_standard_task', { value: JSON.stringify({ status: 'completed', report }) });
        case 3: return call('finish_standard_task', { status: 'completed', report, checks: [], artifact_paths: [], unresolved: ['Work remains.'] });
        case 4: {
          const rejected = resultOf(latest(body, 'Completed requires checks'));
          assert.equal(rejected.settled, false); assert.equal(rejected.report, '');
          return call('finish_standard_task', { status: 'completed', report });
        }
        case 5:
        case 6:
        case 7:
        case 8: return response('The task is finished.');
        case 9:
          assert.ok(body.messages.some(m => m.content?.includes('Completion is not recorded.')));
          return call('create_check_workspace', { label: 'dependency-recovery' });
        case 10: return call('write_file', { path: path.join(workspace().path, 'check dependency.cjs'), content: checker });
        case 11: return check([moduleFile]);
        case 12: return finish();
        case 13:
          assert.equal(resultOf(latest(body, 'Independent review reached its output ceiling')).settled, false);
          return finish();
        case 14:
          assert.equal(resultOf(latest(body, 'Declare and hash the expected.json dependency')).settled, false);
          return call('read_file', { path: expectedFile });
        case 15: return check([moduleFile, expectedFile]);
        case 16: return finish();
        case 17:
          assert.equal(resultOf(latest(body, 'Artifacts changed after completion review')).settled, false);
          return call('read_file', { path: moduleFile });
        case 18: return call('edit_file', { path: moduleFile, expected_sha256: fileHash(fs.readFileSync(moduleFile)), old_text: '43', new_text: '42' });
        case 19: return check([moduleFile, expectedFile]);
        case 20: return finish();
        default: throw new Error(`Unexpected actor request ${actors}`);
      }
    };
    const session = open(kind, dir);
    try {
      session.liveSend('Verify the module result against the expected fixture.'); await waitUntil(() => !session.liveMeta().busy);
      const task = session.liveMeta().task;
      assert.equal(task.state, 'completed', JSON.stringify(session.messages.slice(-3)));
      assert.equal(actors, 21); assert.equal(reviews, 4);
      assert.equal(task.standard.metadataRepairs, 5); assert.equal(task.standard.semanticReviews, 4);
      assert.ok(task.standard.completionAttempts > 6); assert.ok(task.standard.requirements.every(r => r.verified));
      assert.equal(session.messages.at(-1).content, report);
      assert.equal(session.messages.some(m => m.role === 'assistant' && /Task incomplete\.|scope_assessments/.test(m.content)), false);
      assert.equal(JSON.parse(fs.readFileSync(moduleFile, 'utf8')).answer, 42);
      const checks = session.messages.filter(m => m.role === 'tool' && m.name === 'run_task_check');
      assert.equal(checks.length, 3); assert.ok(checks.every(m => JSON.parse(m.result).passed));
      console.log(`PASS ${kind}: four metadata errors, four unsupported replies, review output limit, missing dependency and changed artifact all repair and reach independently verified completion`);
    } finally { close(kind, session); StandardTask.prototype.acceptedArtifactsCurrent = originalCurrent; }

    // A real blocker still permits an explicit, readable partial report.
    let attempts = 0;
    const partialReport = '已完成本地检查；剩余步骤需要用户提供访问权限。';
    globalThis.fetch = async (url, init) => {
      assert.equal(new URL(String(url)).hostname, 'fixture.invalid');
      const body = JSON.parse(init.body); assert.ok(body.tools?.length, 'Partial reports do not dispatch a reviewer');
      if (attempts++ < 4) return response('', [tool('finish_standard_task', { status: 'completed', report: 'Missing metadata' })]);
      return response('', [tool('finish_standard_task', { status: 'partial', report: partialReport, checks: [], artifact_paths: [], unresolved: ['Access is unavailable.'] })]);
    };
    const partial = open(kind, dir);
    try {
      partial.liveSend('Verify the restricted resource.'); await waitUntil(() => !partial.liveMeta().busy);
      assert.equal(attempts, 5); assert.equal(partial.liveMeta().task.state, 'partial');
      assert.equal(partial.messages.at(-1).content, partialReport);
      assert.deepEqual(partial.liveMeta().task.standard.unresolved, ['Access is unavailable.']);
      console.log(`PASS ${kind}: explicit partial preserves the user's language and blocker after rejected attempts`);
    } finally { close(kind, partial); }
  }
  console.log('STANDARD COMPLETION RECOVERY PASSED; external model requests=0');
} finally {
  StandardTask.prototype.acceptedArtifactsCurrent = originalCurrent;
  globalThis.fetch = oldFetch; os.homedir = oldHome;
  fs.rmSync(root, { recursive: true, force: true });
}
