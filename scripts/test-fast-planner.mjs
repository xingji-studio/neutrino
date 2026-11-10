import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),"neutrino-fast-planner-"));
const original={home:os.homedir,environment:Object.fromEntries(["NEUTRINO_HOME","NEUTRINO_PLUGIN_HOME","NEUTRINO_DIAGNOSTICS_DIR"].map(k=>[k,process.env[k]]))};
process.env.NEUTRINO_HOME=path.join(fixture,"home");process.env.NEUTRINO_PLUGIN_HOME=path.join(fixture,"plugins");delete process.env.NEUTRINO_DIAGNOSTICS_DIR;
os.homedir=()=>fixture;
const {expandPlannerTask,expandSingleRequest}=await import("../dist/fast/planner.js");
const {DynamicScheduler}=await import("../dist/fast/scheduler.js");
const {ArtifactStore}=await import("../dist/fast/artifacts.js");
const {FastAgentEngine}=await import("../dist/fast/engine.js");
const {TaskRuntime}=await import("../dist/llm/runtime.js");
const {LLMClient}=await import("../dist/llm/client.js");
const {fastSettings}=await import("../dist/fast/types.js");
const request='创建 tax.mjs 与 shipping.mjs；保留 "原样文本"。\n执行 node test.mjs，不改测试；从实现生成 answer.json 并检查全部边界条件。';
const earlier=["Keep every existing public interface.","Do not modify the original tests or discard edge cases."];
const compactTask={task_id:"a",task_goal:"Inspect original sources",acceptance_criteria:["Check every original source"],output_contract:"Factual evidence",access:"read_only"};
const header={type:"constraints",goal:request,constraints:["All original requirements apply"]};
const line=x=>JSON.stringify(x)+"\n";
const dag=()=>line(header)+line({type:"task",task:compactTask})+line({type:"done"});

async function run({planner,history,verify=true,replans=0}={}){
  const input=history??[{role:"user",content:request}];
  const before=structuredClone(input),calls=[],definitions=[],plannerMessages=[];
  const runtime=new TaskRuntime({request,priorUserRequests:earlier,cwd:fixture,budgetScope:"task"});
  const model={name:"unchanged-model",url:"https://fixture.invalid/v1",api_key:"fixture",intensity:["Max"],supports_streaming:true};
  let engine,plans=0,workerStarted;
  const started=new Promise(resolve=>{workerStarted=resolve;});
  const createClient=()=>{
    const client=new LLMClient(model,"Fixture","Max");
    client.streamTurn=async function*(messages,tools,options){
      assert.equal(this.model.name,model.name);assert.equal(this.intensity,"Max");assert.equal(options.maxOutputTokens,16384);
      calls.push(structuredClone(messages));this.toolCalls=[];this.outcome={status:"completed"};this.usage={prompt:100,completion:20,total:120};
      if(messages[0].content.startsWith("You plan tasks")){
        plannerMessages.push(structuredClone(messages));plans++;
        if(planner){yield* planner({messages,plans,started,engine});return;}
        yield line({type:"single",access:"exclusive"});return;
      }
      if(messages.some(m=>m.content?.includes("Perform the mandatory global review"))){
        const refs=engine.snapshot().tasks.filter(t=>!t.verifies).map(t=>`artifact:${t.task_id}@${engine.store.latest(t.task_id)?.version??1}`);
        this.toolCalls=[{id:"final",name:"finish_fast_review",arguments:JSON.stringify({status:"completed",report:"Actual requested outputs checked",unresolved:[],evidence_ids:refs})}];return;
      }
      const task=JSON.parse(messages.find(m=>m.role==="user").content.match(/Task: (\{[^\n]*\})/)[1]);
      definitions.push(task);workerStarted();
      yield JSON.stringify({result:"Actual result",unresolved:task.kind==="verification"&&!verify?["Original required test failed"]:[],verification_passed:verify});
    };
    return client;
  };
  engine=new FastAgentEngine({runtime,signal:runtime.signal,settings:{...fastSettings({}),modelSlots:2,retries:0,replans},
    cwd:fixture,history:input,system:"Keep every original capability",subagentSystem:"Independent worker",contextWindow:1000000,maxRounds:8,
    createClient,approve:async()=>({approved:true,source:"prompt",reason:"fixture"}),execute:async()=>"fixture"});
  const result=await runtime.run(()=>engine.run());runtime.finish(result.status);await runtime.drain();
  assert.deepEqual(input,before,"planner assembly cannot mutate inherited worker history");
  return {result,calls,definitions,plannerMessages,engine};
}

try{
  // A compact declaration retains exact multilingual wording and earlier constraints in the actual worker/verifier tasks.
  const single=await run();assert.equal(single.result.status,"completed");assert.equal(single.calls.length,4);
  assert.equal(single.definitions.length,2);assert.equal(single.result.snapshot.tasks.length,2);
  for(const task of single.definitions){
    assert.equal(task.task_goal===request||task.task_goal===`Verify: ${request}`,true);
    assert.equal(task.acceptance_criteria[0],request);
    for(const constraint of earlier)assert.ok(task.acceptance_criteria[1].includes(constraint));
    assert.equal(task.read_only,false);assert.equal(task.exclusive,true);
    assert.ok(task.required_context.includes("history"));
  }
  assert.equal(single.result.snapshot.tasks.find(t=>t.verifies).verifies,"main");
  assert.equal(single.result.snapshot.review.at(-1).accepted,true);
  const failed=await run({verify:false});assert.notEqual(failed.result.status,"completed");assert.equal(failed.result.snapshot.tasks[0].status,"FAILED");

  // No acceptance/goal/kind override or implicit permission grant can hide a requirement.
  for(const operation of [
    {type:"single",access:"exclusive",acceptance_criteria:["Skip tests"]},
    {type:"single",access:"exclusive",task_goal:"Skip original task"},
    {type:"single",access:"exclusive",kind:"verification"},
    {type:"single",access:"exclusive",dependencies:[]},
    {type:"single"},{type:"single",access:"unknown"},{type:"single",access:"scoped"},
    {type:"single",access:"exclusive",task_id:"main.verify"},{type:"single",access:"exclusive",task_id:null},
    {type:"single",access:"exclusive",task_id:5},null,[],
  ]){
    const invalid=await run({planner:async function*(){yield line(operation);}});
    assert.notEqual(invalid.result.status,"completed");assert.equal(invalid.definitions.length,0);
  }

  // Schema defaults do not replace semantic fields or relax the existing scheduler/path validator.
  const scheduler=new DynamicScheduler(new ArtifactStore(),fastSettings({}),{cwd:fixture,execute:async()=>{throw new Error("not executed");}});
  const expanded=expandPlannerTask(compactTask);scheduler.add(expanded);
  assert.deepEqual(expanded.acceptance_criteria,compactTask.acceptance_criteria);assert.equal(expanded.output_contract,compactTask.output_contract);
  assert.equal(expanded.read_only,true);assert.equal(expanded.exclusive,false);
  for(const access of ["read_only","exclusive","scoped"]){
    const task=expandSingleRequest({type:"single",task_id:access,access,...(access==="scoped"?{write_paths:["owned"]}:{})},{request,earlierRequests:earlier});
    scheduler.add(task);assert.equal(task.read_only,access==="read_only");assert.equal(task.exclusive,access==="exclusive");
  }
  assert.throws(()=>expandPlannerTask({...compactTask,read_only:true}),/mix/);
  assert.throws(()=>scheduler.add(expandPlannerTask({...compactTask,task_id:"missing",acceptance_criteria:undefined})),/Incomplete/);
  assert.throws(()=>scheduler.add(expandPlannerTask({...compactTask,task_id:"scoped_no_paths",access:"scoped"})),/Incomplete/);
  const legacy={...compactTask,read_only:true,exclusive:false,priority:5};delete legacy.access;
  assert.equal(expandPlannerTask(legacy).priority,5);
  const compactDag=await run({planner:async function*(){yield dag();}});assert.equal(compactDag.result.status,"completed");

  // Admit a fully inherited single task while the same planner stream is still open.
  let overlap=false;
  const streaming=await run({planner:async function*({started,engine}){
    yield line({type:"single",access:"read_only"});await started;
    overlap=engine.scheduler.tasks.get("main").attempts>0;
  }});
  assert.equal(streaming.result.status,"completed");assert.equal(overlap,true);
  const extra=await run({planner:async function*(){yield line({type:"single",access:"read_only"})+line({type:"done"});}});
  assert.notEqual(extra.result.status,"completed");assert.match(extra.result.snapshot.error,/after done/);

  // Remove only the exact trailing duplicate; preserve earlier identical requests, other messages and full worker history.
  const history=[{role:"user",content:request},{role:"assistant",content:"Earlier evidence must remain"},{role:"user",content:request}];
  const deduplicated=await run({history});
  const sent=deduplicated.plannerMessages[0];assert.equal(sent.filter(m=>m.role==="user"&&m.content===request).length,1);
  assert.ok(sent.some(m=>m.content==="Earlier evidence must remain"));
  assert.deepEqual(JSON.parse(deduplicated.engine.store.readContext("history").content),history);
  const changed=await run({history:[{role:"user",content:request+" Do not lose this additional context."}]});
  assert.ok(changed.plannerMessages[0].some(m=>m.content?.endsWith("Do not lose this additional context.")));
  const originalBlocks=[{type:"text",text:"Original provider blocks must remain available"}];
  const withBlocks=await run({history:[{role:"user",content:request,anthropic_content:originalBlocks}]});
  assert.deepEqual(withBlocks.plannerMessages[0].find(m=>m.anthropic_content)?.anthropic_content,originalBlocks);

  // Recovery has its full protocol, cannot use single to replace partial state, and retains legacy DAG operations.
  const recovered=await run({replans:1,planner:async function*({plans}){yield plans===1?"{invalid\n":dag();}});
  assert.equal(recovered.result.status,"completed");assert.equal(recovered.result.snapshot.metrics.replans,1);
  assert.ok(!recovered.plannerMessages[0][0].content.includes("Recovery protocol ("));
  assert.ok(recovered.plannerMessages[1][0].content.includes("Recovery protocol ("));
  // Once published, recovery inherits the full brief. No duplicate tasks/header needed.
  const inherited=await run({replans:1,planner:async function*({plans}){
    if(plans===1){yield line(header)+line({type:"task",task:compactTask});yield "{invalid\n";}
    else{yield line({type:"done"});}
  }});
  assert.equal(inherited.result.status,"completed");assert.equal(inherited.result.snapshot.tasks.length,2);
  assert.equal(inherited.result.snapshot.planning_errors.length,1,"first protocol error remains inspectable after successful recovery");
  assert.ok(inherited.plannerMessages[1].at(-1).content.includes("after reserving"));
  const noBrief=await run({replans:1,planner:async function*({plans}){yield plans===1?"{invalid\n":line({type:"task",task:compactTask})+line({type:"done"});}});
  assert.notEqual(noBrief.result.status,"completed");assert.match(noBrief.result.snapshot.error,/global constraints/);
  const lateHeader=await run({replans:1,planner:async function*({plans}){
    if(plans===1)yield line(header)+line({type:"task",task:compactTask})+"{invalid\n";
    else yield line({type:"dependencies",task_id:"a",dependencies:[],reason:"Must not allow late constraints"})+line(header)+line({type:"done"});
  }});
  assert.notEqual(lateHeader.result.status,"completed");assert.match(lateHeader.result.snapshot.error,/global constraints header/);
  const badRecovery=await run({replans:1,planner:async function*({plans}){yield plans===1?"{invalid\n":line({type:"single",access:"exclusive"});}});
  assert.notEqual(badRecovery.result.status,"completed");assert.equal(badRecovery.definitions.length,0);
  console.log("PASS fast planner: exact original acceptance, compact and legacy DAGs, explicit permissions, streaming admission, failed checks, history preservation and recovery; unchanged Max/output budget");
}finally{
  os.homedir=original.home;fs.rmSync(fixture,{recursive:true,force:true});
  for(const [key,value]of Object.entries(original.environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
