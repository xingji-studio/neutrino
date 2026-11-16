// P0-P4 regression: actual files/commands and independent local oracles; no live provider.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "neutrino-standard-revision-"));
process.env.NEUTRINO_HOME = path.join(root, "home");
process.env.NEUTRINO_PLUGIN_HOME = path.join(root, "plugins");
process.env.NEUTRINO_PLAN = "off";
const oldHome = os.homedir, oldFetch = globalThis.fetch;
os.homedir = () => root;
globalThis.fetch = async () => { throw new Error("No external provider is authorized for local regressions"); };
const { TaskRuntime } = await import("../dist/llm/runtime.js");
const { StandardTask, requirementInventory } = await import("../dist/llm/standard.js");
const { executeTool } = await import("../dist/llm/tools.js");
const { assessToolCall } = await import("../dist/llm/risk.js");
const { prepareContext, inputTokenBound } = await import("../dist/llm/context.js");
const { needsPlan, needsStandardPlan, STANDARD_PLANNING_CONTRACT } = await import("../dist/llm/plan.js");
const { fileHash } = await import("../dist/llm/editing.js");
const results = { external_provider_requests: 0, fixture_reviews: 0, cases: [], measurements: {} };
const fixtureReview = fn => ({ capacity: 1_000_000, createClient: () => ({ outcome: { status: "completed" },
  async complete(system, input) { results.fixture_reviews++; assert.match(system, /FULL ORIGINAL REQUEST/); return JSON.stringify(await fn(JSON.parse(input))); } }) });
const accept = { accepted: true, unresolved: [], reason: "The actual local oracle and current bindings cover this fixture" };
const run = (runtime, dir, name, args) => runtime.tool(name, args, () => executeTool(name, args, dir));
const finishArgs = (task, ids, artifacts) => ({ status: "completed", report: "Implemented and verified the local fixture", unresolved: [], artifact_paths: artifacts,
  checks: task.state.requirements.map(r => ({ requirement_id: r.id, detail: "Actual check results and operation audit", evidence_ids: /Do not use online/.test(r.text) ? [] : ids })) });
const pass = name => { results.cases.push({ name, passed: true }); console.log("PASS", name); };
try {
  // Exact failure shape: early command before final output reads, later current check,
  // retained early references, and a negative constraint without fabricated command IDs.
  const dir = path.join(root, "mixed"); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "program.mjs"), "export const answer = 42;\n");
  fs.writeFileSync(path.join(dir, "output.txt"), "old");
  fs.writeFileSync(path.join(dir, "check-impl.mjs"), "import assert from 'node:assert/strict'; import {answer} from './program.mjs'; assert.equal(answer,42); console.log('module oracle passed')");
  fs.writeFileSync(path.join(dir, "check-all.mjs"), "import assert from 'node:assert/strict'; import fs from 'node:fs'; import {answer} from './program.mjs'; assert.equal(answer,42); assert.equal(fs.readFileSync('output.txt','utf8'),'current'); console.log('current output oracle passed')");
  const runtime = new TaskRuntime({ cwd: dir, request: "Implement the answer module.\n\nVerify the delivered output.\n\nDo not use online solutions or hints specific to this task." });
  const task = new StandardTask(runtime); let early, fresh;
  await runtime.run(async () => {
    await run(runtime, dir, "read_file", { path: "program.mjs" });
    await run(runtime, dir, "run_command", { command: "node check-impl.mjs" }); early = runtime.evidence.at(-1).id;
    fs.writeFileSync(path.join(dir, "output.txt"), "current");
    await run(runtime, dir, "read_file", { path: "output.txt" });
    await run(runtime, dir, "run_command", { command: "node check-all.mjs" }); fresh = runtime.evidence.at(-1).id;
    const review = fixtureReview(data => {
      assert.ok(data.checks.slice(0, 2).every(c => c.current_evidence_ids.includes(fresh) && c.historical_evidence_ids.includes(early)));
      assert.equal(data.checks[2].constraint_audit, true); assert.deepEqual(data.checks[2].evidence_ids, []);
      assert.ok(data.operation_audit.operations.some(e => e.id === fresh));
      assert.match(JSON.stringify(data.evidence), /current output oracle passed/);
      return accept;
    });
    assert.equal((await task.finish(finishArgs(task, [early, fresh], ["program.mjs", "output.txt"]), review)).completed, true);
  });
  runtime.finish("completed"); assert.equal(task.state.reviewRequests, 1); assert.equal(task.state.metadataRepairs, 0);
  pass("mixed historical/current proof reaches one independent review; external-hint constraint uses bounded operation audit");

  const stale = new TaskRuntime({ cwd: dir, request: "Verify the program." }), staleTask = new StandardTask(stale);
  await stale.run(async () => {
    await run(stale, dir, "read_file", { path: "program.mjs" });
    await run(stale, dir, "run_command", { command: "node check-impl.mjs" }); const id = stale.evidence.at(-1).id;
    fs.appendFileSync(path.join(dir, "program.mjs"), "// new implementation version\n");
    const denied = await staleTask.finish(finishArgs(staleTask, [id], ["program.mjs"]), { capacity: 1_000_000, createClient() { throw new Error("Stale proof must stop before review"); } });
    assert.equal(denied.completed, false); assert.match(denied.feedback, /predates/); assert.equal(staleTask.state.semanticReviews, 0);
  }); stale.finish("partial");
  const confidential = new TaskRuntime({ cwd: dir, request: "Do not embed external hints in the output artifacts." }); const confidentialTask = new StandardTask(confidential);
  confidential.recordTool("list_files", {}, "files", "completed");
  await confidential.run(async () => {
    const verdict = await confidentialTask.finish(finishArgs(confidentialTask, [], []), { capacity: 1_000_000, createClient() { throw new Error("Output confidentiality cannot use an empty action audit"); } });
    assert.equal(verdict.completed, false); assert.match(verdict.feedback, /unsuccessful evidence/);
  }); confidential.finish("partial");
  pass("genuinely stale proof and output-confidentiality constraints remain blocked");

  const scopeDir = path.join(root, "scopes"); fs.mkdirSync(scopeDir);
  const core = path.join(scopeDir, "module.mjs"); fs.writeFileSync(core, "export const twice = n => n * 2;\n");
  const output = path.join(scopeDir, "output.txt"); fs.writeFileSync(output, "before");
  const scoped = new TaskRuntime({ cwd: scopeDir, request: "Verify the module on a variant input.\n\nVerify the final delivered output.", workspaceOnly: true });
  const scopedTask = new StandardTask(scoped); let physicalChecks = 0;
  const control = (name, args) => scoped.tool(name, args, () => scopedTask.controlTool(name, args, async (command, cwd) => { physicalChecks++; return executeTool("run_command", { command }, cwd); }));
  let workspace, originalId, originalCheck;
  await scoped.run(async () => {
    await run(scoped, scopeDir, "read_file", { path: core });
    workspace = JSON.parse(await control("create_check_workspace", { label: "variant" }));
    const checker = `import assert from 'node:assert/strict'; import fs from 'node:fs'; import {twice} from ${JSON.stringify(pathToFileURL(core).href)}; const q=JSON.parse(fs.readFileSync('input.json','utf8')); assert.equal(twice(q.n),q.expected); console.log('variant oracle passed');`;
    await run(scoped, scopeDir, "write_file", { path: path.join(workspace.path, "verify.mjs"), content: checker });
    await run(scoped, scopeDir, "write_file", { path: path.join(workspace.path, "input.json"), content: JSON.stringify({ n: 21, expected: 42 }) });
    const args = { workspace_id: workspace.workspace_id, command: "node verify.mjs", input_paths: [core] };
    originalCheck = JSON.parse(await control("run_task_check", args)); originalId = scoped.evidence.at(-1).id;
    assert.equal(originalCheck.passed, true); assert.equal(physicalChecks, 1);
    const reused = JSON.parse(await control("run_task_check", { ...args, reuse: true }));
    assert.equal(reused.reused, true); assert.equal(reused.original_evidence_id, originalId); assert.equal(physicalChecks, 1);
    const independent = JSON.parse(await control("run_task_check", { ...args, reuse: true, independent: true }));
    assert.notEqual(independent.check_id, originalCheck.check_id); assert.equal(physicalChecks, 2);
    process.env.NEUTRINO_REVISION_CHECK_ENV = "changed";
    assert.equal(scopedTask.checks.proof(originalId).current, false);
    await control("run_task_check", { ...args, reuse: true }); assert.equal(physicalChecks, 3);
    delete process.env.NEUTRINO_REVISION_CHECK_ENV;
    fs.writeFileSync(output, "current");
    await run(scoped, scopeDir, "read_file", { path: output });
    fs.writeFileSync(path.join(scopeDir, "check-output.mjs"), "import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(fs.readFileSync('output.txt','utf8'),'current');console.log('final output passed')");
    await run(scoped, scopeDir, "run_command", { command: "node check-output.mjs" }); const rootCheckId = scoped.evidence.at(-1).id;
    const argsFor = finishArgs(scopedTask, [originalId, rootCheckId], [core, output]);
    const review = fixtureReview(data => {
      const bound = data.evidence.find(e => e.id === originalId).freshness.binding;
      assert.equal(bound.current, true); assert.equal(bound.dependencies_complete, false); assert.match(bound.checker_source.text, /variant oracle/);
      assert.ok(!Object.keys(bound.inputs).includes(output), "root output is not an input of the variant check");
      return { ...accept, scope_assessments: [{ check_id: bound.check_id, dependencies_complete: true, reason: "Actual checker imports only the bound module and reads the captured input.json fixture" }] };
    });
    assert.equal((await scopedTask.finish(argsFor, review)).completed, true);
    assert.match(scopedTask.readEvidence({ check_id: originalCheck.check_id, path: "input.json" }), /expected/);
  }); scoped.finish("completed");
  results.measurements.check_reuse = { requests: 4, actual_command_executions: physicalChecks, aliases_are_new_independent_checks: false };
  pass("variant snapshots are independent of root outputs; exact cache, explicit independent execution and environment invalidation");

  const mutation = new TaskRuntime({ cwd: scopeDir, request: "Verify without changing inputs." }); const mutationTask = new StandardTask(mutation);
  await mutation.run(async () => {
    await run(mutation, scopeDir, "read_file", { path: core });
    const w = JSON.parse(await mutation.tool("create_check_workspace", {}, () => mutationTask.controlTool("create_check_workspace", {}, async () => "")));
    const script = path.join(w.path, "verify.mjs"); fs.writeFileSync(script, "console.log('test passed')");
    const args = { workspace_id: w.workspace_id, command: "node verify.mjs", input_paths: [core] };
    await mutation.tool("run_task_check", args, () => mutationTask.controlTool("run_task_check", args, async (command, cwd) => {
      const result = await executeTool("run_command", { command }, cwd); fs.appendFileSync(core, "// concurrent modification\n"); return result;
    }));
    assert.equal(mutation.evidence.at(-1).status, "failed"); assert.equal(mutationTask.checks.proof(mutation.evidence.at(-1).id).current, false);
    const bad = { ...args, input_paths: [path.join(scopeDir, "unobserved.mjs")] };
    fs.writeFileSync(bad.input_paths[0], "secret fixture");
    const result = await mutation.tool("run_task_check", bad, () => mutationTask.controlTool("run_task_check", bad, async () => { throw new Error("Unobserved dependency must never execute"); }));
    assert.match(result, /first be observed/);
    if (process.platform !== "win32") {
      fs.symlinkSync(core, path.join(w.path, "escape"));
      const result = await mutation.tool("run_task_check", args, () => mutationTask.controlTool("run_task_check", args, async () => { throw new Error("Symlink snapshot must never execute"); }));
      assert.match(result, /symlink/);
    }
  }); mutation.finish("partial");
  assert.equal(assessToolCall("run_task_check", { command: "rm -rf .scratch" }, scopeDir).level, assessToolCall("run_command", { command: "rm -rf .scratch" }, scopeDir).level);
  pass("input mutation, unobserved dependencies and snapshot symlinks fail; command risk classification preserved");

  const strictDir=path.join(root,'strict-check');fs.mkdirSync(strictDir);
  const strictFile=path.join(strictDir,'module.mjs');fs.writeFileSync(strictFile,'export const answer = 42;\n');
  const strictRuntime=new TaskRuntime({cwd:strictDir,request:'Verify the module with an inspectable check.'});
  const strictTask=new StandardTask(strictRuntime);
  await strictRuntime.run(async()=>{
    await run(strictRuntime,strictDir,'read_file',{path:strictFile});
    const control=(name,args,execute)=>strictRuntime.tool(name,args,()=>strictTask.controlTool(name,args,execute??((command,cwd)=>executeTool('run_command',{command},cwd))));
    const w=JSON.parse(await control('create_check_workspace',{}));const script=path.join(w.path,'verify.mjs');
    fs.writeFileSync(script,`import assert from 'node:assert/strict';import {answer} from ${JSON.stringify(pathToFileURL(strictFile).href)};assert.equal(answer,42);console.log('actual check passed')`);
    const args={workspace_id:w.workspace_id,command:`node ${script}`,input_paths:[strictFile]};
    await control('run_task_check',args);const id=strictRuntime.evidence.at(-1).id;
    assert.equal(strictTask.checks.describe(id).checker_source.complete,true,'absolute script paths still expose actual checker code');
    const verdict=await strictTask.finish(finishArgs(strictTask,[id],[strictFile]),fixtureReview(()=>accept));
    assert.equal(verdict.completed,false);assert.match(verdict.feedback,/dependency scope/);
    await control('run_task_check',args,async(command,cwd)=>{const text=await executeTool('run_command',{command},cwd);fs.appendFileSync(script,'\n// checker changed while executing\n');return text;});
    const failed=strictRuntime.evidence.at(-1);assert.equal(failed.status,'failed');
    const mixed=await strictTask.finish(finishArgs(strictTask,[id,failed.id],[strictFile]),{capacity:1_000_000,createClient(){throw new Error('Failed proof must stop locally');}});
    assert.equal(mixed.completed,false);assert.match(mixed.feedback,/unsuccessful evidence/);
    if(process.platform!=='win32'){
      const replacement=path.join(strictDir,'replacement.mjs');fs.copyFileSync(strictFile,replacement);fs.unlinkSync(strictFile);fs.symlinkSync(replacement,strictFile);
      assert.equal(strictTask.checks.proof(id).current,false,'symlink retarget cannot preserve proof merely by identical contents');
    }
  });strictRuntime.finish('partial');
  pass('unknown dependency scope, checker mutation, failed/current evidence mixtures and symlink retargeting remain blocked');

  // The review requests the ACTUAL current artifact through a read-only callback.
  // A real behavior oracle alone passes while embedded private text must still fail.
  for (const kind of ["artifact", "map", "manifest", "generated"]) {
    const d = path.join(root, "semantic-" + kind); fs.mkdirSync(d);
    const file = path.join(d, "output.json"); const marker = `PRIVATE_${fileHash(kind + Date.now()).slice(0, 16)}`;
    const data = { public: "ok", [kind]: marker }; fs.writeFileSync(file, JSON.stringify(data));
    fs.writeFileSync(path.join(d, "check.mjs"), "import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(JSON.parse(fs.readFileSync('output.json','utf8')).public,'ok');console.log('public behavior passed')");
    const r = new TaskRuntime({ cwd: d, request: "Preserve public behavior.\n\nKeep private content out of delivered files." }); const t = new StandardTask(r);
    await r.run(async () => {
      await run(r, d, "read_file", { path: "output.json" }); await run(r, d, "run_command", { command: "node check.mjs" });
      let evidenceId = r.evidence.at(-1).id;
      const options = { ...fixtureReview(input => {
        if (!input.inspections.length) return { read_requests: [{ path: file, start_line: 1, end_line: 1 }], reason: "Inspect actual delivered bytes beyond the proposed happy-path test" };
        const safe = !input.inspections.some(q => q.content.includes(marker));
        return { accepted: safe, unresolved: safe ? [] : ["Private text remains in actual output"], reason: safe ? "Public behavior and actual bytes are safe" : "Actual output leaks private text" };
      }), inspect: args => run(r, d, "read_file", args) };
      const first = await t.finish(finishArgs(t, [evidenceId], [file]), options);
      assert.equal(first.completed, false); assert.equal(t.state.inspectionReads, 1);
      fs.writeFileSync(file, JSON.stringify({ public: "ok", [kind]: "public" }));
      await run(r, d, "read_file", { path: file }); await run(r, d, "run_command", { command: "node check.mjs" }); evidenceId = r.evidence.at(-1).id;
      assert.equal((await t.finish(finishArgs(t, [evidenceId], [file]), options)).completed, true);
    }); r.finish("completed");
  }
  pass("independent current-file reads catch private text in four output forms; repaired outputs pass actual behavior checks");

  const denied = new TaskRuntime({ cwd: dir, request: "Verify current implementation." }); const deniedTask = new StandardTask(denied);
  await denied.run(async () => {
    await run(denied, dir, "read_file", { path: "program.mjs" }); await run(denied, dir, "run_command", { command: "node check-impl.mjs" }); const id = denied.evidence.at(-1).id;
    let turn = 0, reads = 0;
    const review = { ...fixtureReview(() => turn++ === 0 ? { read_requests: [{ path: "../not-authorized" }], reason: "Try to widen review scope" } : accept), inspect() { reads++; throw new Error("Out-of-scope read must be blocked before callback"); } };
    const result = await deniedTask.finish(finishArgs(deniedTask, [id], ["program.mjs"]), review);
    assert.equal(result.completed, false); assert.equal(reads, 0); assert.match(result.feedback, /unavailable or denied/);
  }); denied.finish("partial");
  pass("unavailable independent reads cannot be silently accepted or widen file permissions");

  // An unchanged variant can be assessed by its actual dependencies even when
  // a later, unrelated root artifact did not exist at the earlier check.
  for (const changed of [false, true]) {
    const d = path.join(root, 'coverage-' + changed); fs.mkdirSync(d);
    const implementation = path.join(d, 'program.mjs');
    fs.writeFileSync(implementation, 'export const answer = 42;\n');
    fs.writeFileSync(path.join(d, 'variant.mjs'), "import assert from 'node:assert/strict';import {answer} from './program.mjs';assert.equal(answer,42);console.log('variant passed')");
    fs.writeFileSync(path.join(d, 'final.mjs'), "import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(fs.readFileSync('output.txt','utf8'),'current');console.log('root output passed')");
    const r = new TaskRuntime({ cwd: d, request: 'Verify the module variant.\n\nVerify final output.' });
    const t = new StandardTask(r);
    await r.run(async () => {
      await run(r,d,'read_file',{path:implementation}); await run(r,d,'run_command',{command:'node variant.mjs'});
      const oldId = r.evidence.at(-1).id;
      if (changed) fs.appendFileSync(implementation, '// changed after the variant check\n');
      fs.writeFileSync(path.join(d,'output.txt'),'current');
      await run(r,d,'read_file',{path:'output.txt'}); await run(r,d,'run_command',{command:'node final.mjs'});
      const freshId = r.evidence.at(-1).id;
      const args = finishArgs(t,[freshId],['program.mjs','output.txt']); args.checks[0].evidence_ids=[oldId];
      const answer = await t.finish(args, fixtureReview(data => {
        assert.deepEqual(data.coverage_gaps_requiring_independent_assessment,['r1']);
        return {...accept,coverage_assessments:[{requirement_id:'r1',coverage_complete:true,evidence_ids:[oldId],dependencies_complete:true,input_paths:[implementation],reason:'The variant command depends on the captured module and immutable test code; root output is unrelated'}]};
      }));
      assert.equal(answer.completed,!changed);
      if (changed) assert.match(answer.feedback,/unchanged relevant inputs/);
      else assert.deepEqual(t.state.requirements[0].evidence_ids,[oldId]);
    }); r.finish(changed?'partial':'completed');
  }
  pass('historical variant coverage needs independent dependency assessment; changed dependencies cannot be rebound');

  const restricted = new TaskRuntime({cwd:scopeDir,request:'Verify within restricted policies.'});
  const restrictedTask = new StandardTask(restricted);
  await restricted.run(async () => {
    await restricted.child('reader','Read-only scope',async () => {
      for (const name of ['create_check_workspace','run_task_check']) assert.throws(()=>restricted.assertTool(name,{}),/read-only/);
    },{readOnly:true});
    await restricted.child('writer','Restricted write scope',async () => {
      assert.throws(()=>restricted.assertTool('run_task_check',{command:'node verify.mjs'}),/restricted write-path/);
      await assert.rejects(()=>restrictedTask.controlTool('create_check_workspace',{},async()=>''),/Only the root/);
    },{writePaths:['allowed']});
  }); restricted.finish('partial');
  pass('check controls preserve read-only, restricted-write and root-only policies');

  // Early packing with a large remaining budget, before context capacity pressure.
  const messages = [{ role: "system", content: "Immutable original policy" }, { role: "user", content: "Keep every original requirement" }];
  const bodies = Array.from({ length: 18 }, (_, i) => i % 3 === 0 ? "duplicate body ".repeat(2400) : `${i}: ${"source block ".repeat(2400)}`);
  for (let i = 0; i < bodies.length; i++) messages.push({ role: "assistant", reasoning_content: "signed reasoning kept", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${i}`, content: `${i === 9 ? '[Error: required check failed] ' : ''}${bodies[i]}\n[Task evidence: e${i}; status=${i === 9 ? 'failed' : 'completed'}]` });
  const before = inputTokenBound(messages); let checkpoint;
  await prepareContext({ messages, tools: [], capacity: 1_000_000, remainingBudget: 4_000_000, workingSet: true, evidenceBrief: "Full raw evidence is retained", onCheckpoint: q => checkpoint = q,
    createClient() { throw new Error("Early working set must not spend a compression model call"); } });
  assert.ok(inputTokenBound(messages) < before / 2); assert.equal(messages[0].content, "Immutable original policy");
  assert.ok(messages.some(m => m.content?.includes("Keep every original requirement")));
  assert.ok(messages.some(m => m.content?.includes("required check failed")));
  const parents = new Set(messages.flatMap(m => m.tool_calls?.map(c => c.id) ?? []));
  for (const m of messages) if (m.role === "tool") assert.ok(parents.has(m.tool_call_id));
  assert.ok(messages.some(m => m.reasoning_content === "signed reasoning kept")); assert.ok(checkpoint.deduplicated_bodies > 0);
  results.measurements.early_context = { ...checkpoint, remaining_budget: 4_000_000, extra_model_calls: 0 };
  pass("early durable working set: duplicate bodies, original constraints, failures, signed metadata and complete tool groups");

  const lookup = "Read the current configuration file and explain its meaning in a single answer. Do not modify files.";
  assert.equal(needsPlan(lookup), true); assert.equal(needsStandardPlan(lookup), false);
  assert.equal(needsStandardPlan("Please plan how to inspect the configuration."), true);
  assert.equal(needsStandardPlan("Implement the service, then verify it with integration tests."), true);
  assert.equal(needsStandardPlan("Read A. Write B."), true);
  assert.match(STANDARD_PLANNING_CONTRACT, /not the implementation/);
  pass("planning retains explicit/multi-step requests while one read-only lookup avoids a redundant planner");

  // Exercise actual Web and terminal loops: new check controls, shared approval
  // normalization, independent read callback, and real selected API Max settings.
  const {createWebSession} = await import('../dist/web/session.js');
  const {ChatScreen} = await import('../dist/screens/chat.js');
  const {defaultState} = await import('../dist/state.js');
  const config = await import('../dist/config.js');
  const model = {name:'deepseek-flash',url:'https://fixture.invalid/v1',api_key:'fixture-only',context_window:1_000_000};
  config.saveModels({providers:[{name:'DeepSeek',models:[model]}]});
  config.saveConfig({...config.loadConfig(),selected_provider:'DeepSeek',selected_model:model.name,selected_intensity:'Max',plan_first:false,task_budget_scope:'task',task_max_tokens:2_000_000,task_max_requests:100,task_max_tools:100});
  const response = (content='',calls=[]) => new Response(`data: ${JSON.stringify({choices:[{delta:{content,tool_calls:calls.map((c,index)=>({index,id:`c-${index}`,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:80,total_tokens:180}})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  const tool = (name,args) => ({name,args:{...args,reason:'Verify the requested local fixture'}});
  results.driver_results=[];
  for (const kind of ['web','terminal']) {
    const d=path.join(root,'driver-'+kind); fs.mkdirSync(d); const program=path.join(d,'program.mjs');
    fs.writeFileSync(program,'export const answer = 0;\n');
    const request='Implement the answer as 42.\n\nVerify the actual program.';
    let stage=0,reviewCalls=0,checkId,approvalReads=0,approvalChecks=0;
    globalThis.fetch=async(url,init)=>{
      assert.equal(new URL(String(url)).hostname,'fixture.invalid');
      assert.equal(new Headers(init.headers).get('authorization'),'Bearer fixture-only');
      const body=JSON.parse(init.body);
      assert.equal(body.model,'deepseek-flash');assert.equal(body.reasoning_effort,'max');assert.equal(body.thinking.type,'enabled');assert.equal(body.max_tokens,16384);
      if(body.messages[0].content.includes('independent completion reviewer for Standard')) {
        reviewCalls++;const data=JSON.parse(body.messages[1].content);
        const proof=data.evidence.find(e=>e.name==='run_task_check');
        assert.equal(proof.freshness.current,true);assert.match(proof.freshness.binding.checker_source.text,/answer,42/);
        if(reviewCalls===1)return response(JSON.stringify({read_requests:[{path:program,start_line:1,end_line:2}],reason:'Inspect the delivered implementation independently'}));
        assert.equal(reviewCalls,2);assert.match(data.inspections[0].content,/answer = 42/);
        return response(JSON.stringify({...accept,scope_assessments:[{check_id:checkId,dependencies_complete:true,reason:'Actual checker source only imports the bound module and Node assertions'}]}));
      }
      const record = name => [...body.messages].reverse().find(m=>m.role==='tool'&&m.content.includes(name));
      switch(stage++) {
        case 0:
          for(const name of ['create_check_workspace','run_task_check','finish_standard_task']) assert.ok(body.tools.some(t=>t.function.name===name));
          return response('Inspect and prepare',[tool('read_file',{path:program,start_line:1,end_line:2}),tool('create_check_workspace',{label:'actual driver check'})]);
        case 1: {
          const workspace=JSON.parse(record('workspace_id').content.split('\n[Task evidence:')[0]);
          return response('Small edit and retained checker',[tool('edit_file',{path:program,expected_sha256:fileHash(fs.readFileSync(program)),old_text:'answer = 0',new_text:'answer = 42'}),tool('write_file',{path:path.join(workspace.path,'verify.mjs'),content:`import assert from 'node:assert/strict';import {answer} from ${JSON.stringify(pathToFileURL(program).href)};assert.equal(answer,42);console.log('driver scoped oracle passed')`})]);
        }
        case 2: {
          const workspace=JSON.parse(record('workspace_id').content.split('\n[Task evidence:')[0]);
          return response('Verify',[tool('run_task_check',{workspace_id:workspace.workspace_id,command:'node verify.mjs',input_paths:[program]})]);
        }
        case 3: {
          const proof=record('driver scoped oracle passed');assert.ok(proof,JSON.stringify(body.messages.slice(-5)));
          const value=JSON.parse(proof.content.split('\n[Task evidence:')[0]);assert.equal(value.passed,true);checkId=value.check_id;
          const id=/Task evidence: ([^;]+);/.exec(proof.content)[1];
          return response('',[tool('finish_standard_task',{status:'completed',report:'Actual program and independent review passed',unresolved:[],artifact_paths:[program],checks:requirementInventory(request).map(r=>({requirement_id:r.id,detail:'Real scoped oracle',evidence_ids:[id]}))})]);
        }
        default:throw new Error('Unexpected fixture actor call '+stage+' in '+kind);
      }
    };
    let session;
    if(kind==='web'){session=createWebSession(d,{provider:'DeepSeek',model,intensity:'Max'});session.start();}
    else {
      session=new ChatScreen('');session.app={width:100,height:30,state:{...defaultState(),selectedProvider:'DeepSeek',selectedModelName:model.name,selectedModelUrl:model.url,selectedModelApiKey:model.api_key,selectedModelStreaming:true,selectedIntensity:'Max'},render(){},popScreen(){},showToast(){},bell(){}};
      session.loadedCwd=d;session.loadedModel=model.name;session.loadedProvider='DeepSeek';session.loadedIntensity='Max';session.onActivate();
    }
    const originalApproval=session.requestApproval;
    session.requestApproval=function(name,args,context){
      if(name==='run_task_check'){approvalChecks++;assert.match(args.command,/^cd '/);assert.ok(args.command.includes(' && node verify.mjs'));}
      if(name==='read_file'&&args.reason.startsWith('Independent completion review'))approvalReads++;
      return originalApproval.call(this,name,args,context);
    };
    try {
      session.liveSend(request);const stop=Date.now()+15000;
      while(session.liveMeta().busy){assert.ok(Date.now()<stop,'New Standard driver integration timed out');await new Promise(r=>setTimeout(r,5));}
      const snapshot=session.liveMeta().task;
      assert.equal(snapshot.state,'completed',JSON.stringify(session.messages.slice(-3)));
      assert.equal(snapshot.standard.semanticReviews,1);assert.equal(snapshot.standard.reviewRequests,2);assert.equal(snapshot.standard.inspectionReads,1);
      assert.equal(snapshot.counts.modelRequests,6);assert.equal(approvalReads,1);assert.equal(approvalChecks,1);assert.equal(stage,4);
      assert.match(fs.readFileSync(program,'utf8'),/answer = 42/);
      results.driver_results.push({driver:kind,passed:true,state:snapshot.state,fixture_model_requests:snapshot.counts.modelRequests,review_requests:reviewCalls,approved_review_reads:approvalReads,approved_scoped_checks:approvalChecks,model:'deepseek-flash',actual_api_effort:'max',thinking:'enabled',output_ceiling:16384});
    }finally{kind==='web'?session.dispose():session.onDeactivate();}
    pass(kind+' actual driver: scoped check and independent approved read; model/API Max/16384 unchanged');
  }
  globalThis.fetch=async()=>{throw new Error('No external provider authorized');};
  results.passed = true;
  if (process.env.NEUTRINO_STANDARD_REVISION_RESULTS) fs.writeFileSync(process.env.NEUTRINO_STANDARD_REVISION_RESULTS, JSON.stringify(results, null, 2) + "\n");
  console.log("STANDARD P0-P4 REVISION REGRESSION PASSED; real providers=0");
} finally {
  if (process.env.NEUTRINO_STANDARD_REVISION_FIXTURES) {
    const destination = path.join(process.env.NEUTRINO_STANDARD_REVISION_FIXTURES, path.basename(root));
    fs.mkdirSync(path.dirname(destination), {recursive:true}); fs.cpSync(root, destination, {recursive:true});
  }
  globalThis.fetch = oldFetch; os.homedir = oldHome; delete process.env.NEUTRINO_REVISION_CHECK_ENV;
  fs.rmSync(root, { recursive: true, force: true });
}
