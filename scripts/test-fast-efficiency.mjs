import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {getEventListeners} from "node:events";

const root=fs.mkdtempSync(path.join(os.tmpdir(),"neutrino-efficiency-regression-"));
const prior={home:os.homedir,environment:Object.fromEntries(["NEUTRINO_HOME","NEUTRINO_PLUGIN_HOME","NEUTRINO_DIAGNOSTICS_DIR"].map(k=>[k,process.env[k]]))};
os.homedir=()=>root;process.env.NEUTRINO_HOME=path.join(root,"config");process.env.NEUTRINO_PLUGIN_HOME=path.join(root,"plugins");delete process.env.NEUTRINO_DIAGNOSTICS_DIR;
const {TaskRuntime,TaskControlError,linkSignals}=await import("../dist/llm/runtime.js");
const {requestsWorkspaceOnly,workspaceViolation}=await import("../dist/llm/workspace.js");
const {executeTool}=await import("../dist/llm/tools.js");
const {assessToolCall}=await import("../dist/llm/risk.js");
const {ApprovalGate}=await import("../dist/llm/approval.js");
const {TaskEvidenceView,artifactBrief}=await import("../dist/fast/evidence.js");
const {expandPlannerGroup}=await import("../dist/fast/planner.js");
const {DynamicScheduler}=await import("../dist/fast/scheduler.js");
const {ArtifactStore}=await import("../dist/fast/artifacts.js");
const {fastSettings}=await import("../dist/fast/types.js");
const {FastAgentEngine}=await import("../dist/fast/engine.js");
const {LLMClient}=await import("../dist/llm/client.js");
const line=x=>JSON.stringify(x)+"\n";
const cwd=path.join(root,"project with spaces"),outside=path.join(root,"outside.txt");fs.mkdirSync(cwd);fs.writeFileSync(outside,"preserved");

try{
  // A transport group preserves each concrete criterion and still gets independent verifiers.
  const shared={access:"read_only",acceptance_criteria:["Verify every assigned original record"],output_contract:"Requested numerical findings and original evidence"};
  const group={type:"tasks",shared,tasks:[{task_id:"a",task_goal:"Read a.txt"},{task_id:"b",task_goal:"Read b.txt"}]};
  const definitions=expandPlannerGroup(group);assert.equal(definitions.length,2);
  assert.deepEqual(definitions[0].acceptance_criteria,shared.acceptance_criteria);
  definitions[0].acceptance_criteria.push("unique");assert.deepEqual(definitions[1].acceptance_criteria,shared.acceptance_criteria);
  const scheduler=new DynamicScheduler(new ArtifactStore(),fastSettings({}),{cwd,execute:async()=>{throw new Error("not executed");}});
  for(const task of expandPlannerGroup(group))scheduler.add(task);
  assert.equal(scheduler.tasks.size,4);assert.equal(scheduler.tasks.get("a.verify").verifies,"a");
  assert.throws(()=>expandPlannerGroup({...group,shared:{...shared,task_id:"spoofed"}}),/identity/);
  assert.throws(()=>expandPlannerGroup({...group,tasks:[]}),/Invalid/);
  assert.throws(()=>scheduler.add(expandPlannerGroup({...group,tasks:[{task_id:"no_access",task_goal:"Missing criteria",acceptance_criteria:undefined}]})[0]),/Incomplete/);
  assert.throws(()=>scheduler.add(expandPlannerGroup({...group,tasks:[{task_id:"spoofed",task_goal:"spoof",verifies:"a"}]})[0]),/runtime/);

  // Large exact records are absent from the index, recoverable without truncation, and cannot leak across views.
  const heavy="EXACT_ORIGINAL_EVIDENCE_".repeat(10000);
  const record={id:"actual-tool",runId:"owner",name:"read_file",arguments:{path:"input.txt"},result:heavy,status:"completed"};
  const artifact={task_id:"a",version:1,input_versions:{},verification:"verified",created_at:"test",result:"Actual claim",conclusions:["Distinct finding"],assumptions:[],unresolved:[],evidence:[record.id],side_effects:false};
  let current=true;const view=new TaskEvidenceView([artifact],[record],()=>current);
  record.result="mutated caller";assert.equal(JSON.parse(view.read({ids:["actual-tool"]}))[0].record.result,heavy);
  assert.ok(JSON.stringify(view.toolIndex()).length<heavy.length/100);assert.equal(JSON.stringify(view.toolIndex()).includes(heavy),false);
  assert.equal(view.inlineTools(),undefined,"large records stay available without bloating every prompt");
  const smallRecord={...record,result:"Exact small original record"};const smallView=new TaskEvidenceView([],[smallRecord]);
  assert.deepEqual(smallView.inlineTools(),[smallRecord],"small ledgers are passed inline intact, without a lookup request");
  assert.deepEqual(artifactBrief(artifact).conclusions,["Distinct finding"]);
  assert.throws(()=>view.read({ids:["actual-tool","unrelated-tool"]}),/exact IDs/);
  assert.throws(()=>view.read({ids:[]}),/exact IDs/);
  assert.equal(JSON.parse(view.read({ids:["artifact:a@1"]}))[0].record.verification,"verified");
  current=false;assert.throws(()=>view.read({ids:["artifact:a@1"]}),/superseded or invalidated/);

  // Explicit workspace scope is inherited. Quoting, JS stdin, local helper scripts, traversal and symlinks cannot evade literal-path checks.
  assert.equal(requestsWorkspaceOnly("Work only inside this temporary fixture."),true);
  assert.equal(requestsWorkspaceOnly("只在当前目录内修改文件。"),true);
  assert.equal(requestsWorkspaceOnly("Do not work only inside this directory."),false);
  assert.equal(requestsWorkspaceOnly("Edit an explicitly specified external path."),false);
  const runtime=new TaskRuntime({request:"Compute the result. Work only inside this directory.",cwd});
  assert.equal(runtime.workspaceOnly,true);assert.match(runtime.instructions(),/Optional tidying is not a task requirement/);
  fs.symlinkSync(root,path.join(cwd,"escape"),"dir");fs.symlinkSync(path.join(root,"missing"),path.join(cwd,"dangling"));
  const bad=[
    ["write_file",{path:outside,content:"overwritten"}],["read_file",{path:outside}],
    ["write_file",{path:"../outside.txt",content:"overwritten"}],["write_file",{path:"escape/outside.txt",content:"overwritten"}],
    ["write_file",{path:"dangling/new.txt",content:"overwritten"}],
    ["run_command",{command:`node -e "require('fs').writeFileSync('../outside.txt','bad')"`}],
    ["run_command",{command:`sh -c 'echo bad > ../outside.txt'`}],
    ["run_command",{command:`cat > '${outside}' <<'EOF'\nbad\nEOF`}],
    ["run_command",{command:`node <<'NODE'\nrequire('fs').writeFileSync('${outside}','bad');\nNODE`}],
    ["run_command",{command:"cd .. && echo bad > outside.txt"}],
    ["run_command",{command:"node -e 'require(\"fs\").readFileSync(\"/\")'"}],
    ["run_command",{command:"node -e 'const fs=require(\"fs\"); const rd=f=>fs.readFileSync(f); rd(\"../outside.txt\")'"}],
    ["run_command",{command:"node -e 'const fs=require(\"fs\"); const files=[\"../outside.txt\"];for(const file of files)fs.readFileSync(file)'"}],
    ["run_command",{command:"node -e 'const fs=require(\"fs\"); [\"../outside.txt\"].forEach(file=>fs.readFileSync(file))'"}],
  ];
  for(const [name,args]of bad)await runtime.run(async()=>{
    assert.throws(()=>runtime.assertTool(name,args),error=>error instanceof TaskControlError&&error.code==="workspace_scope");
    await assert.rejects(runtime.child("subagent","Preserve inherited confinement",async()=>runtime.assertTool(name,args)),/outside|symbolic link/i);
    assert.match(await executeTool(name,args,cwd,runtime.signal),/Error:/);
  });
  assert.equal(fs.readFileSync(outside,"utf8"),"preserved");
  fs.writeFileSync(path.join(cwd,"unsafe.js"),"require('fs').writeFileSync('../outside.txt','bad');");
  assert.ok(workspaceViolation("run_command",{command:"node unsafe.js"},cwd));
  fs.writeFileSync(path.join(cwd,"safe.js"),"console.log(/^safe$/.test('safe'));");
  assert.equal(workspaceViolation("run_command",{command:"node safe.js"},cwd),undefined);
  const prefixScript="const fs=require('fs');const d=__dirname;fs.writeFileSync(d+'/benign.json','{}');console.log('/', '/answer.json');";
  fs.writeFileSync(path.join(cwd,"prefix.js"),prefixScript);
  assert.equal(workspaceViolation("run_command",{command:"node prefix.js"},cwd),undefined,"a safe concatenated filesystem path and log separators are not standalone root paths");
  assert.equal(workspaceViolation("run_command",{command:"echo '/'"},cwd),undefined,"printed data is not a filesystem path");
  assert.ok(workspaceViolation("run_command",{command:"echo '/' > ../outside.txt"},cwd),"actual redirection remains checked");
  assert.equal(workspaceViolation("run_command",{command:`node -e 'const fs=require("fs");const d=process.cwd();fs.writeFileSync(d+"/benign.json","{}");console.log("/")'`},cwd),undefined);
  const safe=`node <<'NODE'\nconst fs=require('fs');if(!/^ok$/.test('ok'))throw Error('bad');fs.writeFileSync('answer.txt','ok');console.log('PASS');\nNODE`;
  await runtime.run(async()=>{runtime.assertTool("run_command",{command:safe});assert.match(await executeTool("run_command",{command:safe},cwd,runtime.signal),/PASS/);});
  assert.equal(fs.readFileSync(path.join(cwd,"answer.txt"),"utf8"),"ok");runtime.finish("completed");await runtime.drain();
  const unrestricted=new TaskRuntime({request:"Read an explicitly specified external source.",cwd});
  unrestricted.assertTool("read_file",{path:outside});unrestricted.finish("completed");

  // Actual deletion still requires a human when extreme auto-approval is off: no approval bypass or risk downgrade.
  const risk=assessToolCall("run_command",{command:"rm -f safe.js"},cwd);assert.equal(risk.level,"extreme");let asked=0;
  const gate=new ApprovalGate({askHuman:async()=>{asked++;return false;},reviewer:()=>{throw Error("No model is needed");},autoApprovalEnabled:()=>true,extremeAutoApprovalEnabled:()=>false});
  const denied=await gate.decide({tool:"run_command",args:{command:"rm -f safe.js",reason:"Remove an explicitly requested helper script"},cwd,prompt:"Remove the helper script",risk});
  assert.equal(denied.approved,false);assert.equal(denied.source,"human");assert.equal(asked,1);assert.ok(fs.existsSync(path.join(cwd,"safe.js")));

  // Parallel linked signals retain cancellation without accumulating listeners on their shared parent.
  const parent=new AbortController();const linked=Array.from({length:32},()=>linkSignals(parent.signal,new AbortController().signal));
  if(typeof AbortSignal.any==="function")assert.equal(getEventListeners(parent.signal,"abort").length,0);
  parent.abort("cancel all");for(const item of linked){assert.equal(item.signal.aborted,true);assert.equal(item.signal.reason,"cancel all");item.dispose();}

  // Real tools + deterministic model replies exercise compact DAG admission, exact evidence lookup, recoverable path denial and a mandatory failing verifier.
  async function runEngine(broken=false, largeProgram=false){
    const directory=path.join(root,largeProgram?"large-program":broken?"broken":"complete");fs.mkdirSync(directory);
    const regions=["north","south","east","west"];regions.forEach((region,i)=>fs.writeFileSync(path.join(directory,region+".txt"),String(i+1)));
    fs.writeFileSync(path.join(directory,"check.mjs"),"import fs from 'node:fs';import assert from 'node:assert/strict';const sum=['north','south','east','west'].reduce((n,r)=>n+Number(fs.readFileSync(r+'.txt','utf8')),0);assert.deepEqual(JSON.parse(fs.readFileSync('answer.json','utf8')),{sum});console.log('PASS independent actual sources');");
    const request="Read four original region files through independent read-only inspectors; integrate their verified results with Node and write answer.json. Work only inside this directory.";
    const rt=new TaskRuntime({request,cwd:directory}),executed=[],initial=[],lookups=[];
    const model={name:"unchanged-model",url:"https://offline.invalid/v1",api_key:"fixture",intensity:["Max"],supports_streaming:true};let engine;
    const createClient=()=>{
      const client=new LLMClient(model,"Fixture","Max");client.streamTurn=async function*(messages,tools,options){
        assert.equal(this.intensity,"Max");assert.equal(options.maxOutputTokens,16384);
        this.toolCalls=[];this.outcome={status:"completed"};this.usage={prompt:100,completion:20,total:120};
        const call=(name,args)=>{this.toolCalls=[{id:"call",name,arguments:JSON.stringify(args)}];};
        if(messages[0].content.startsWith("You plan tasks")){
          yield line({type:"constraints",goal:request,constraints:["All original checks remain mandatory"]});
          yield line({type:"tasks",shared,tasks:regions.map(region=>({task_id:region,task_goal:"Inspect only "+region+".txt"}))});
          yield line({type:"task",task:{task_id:"integrate",task_goal:"Independently recompute all originals and write answer.json",dependencies:regions,access:"exclusive",acceptance_criteria:["Output matches every original source","Run node check.mjs independently"],output_contract:"Correct sum in answer.json"}});
          yield line({type:"done"});return;
        }
        const results=messages.filter(m=>m.role==="tool");
        if(messages.some(m=>m.content?.includes("Perform the mandatory global review"))){
          const failed=!engine.scheduler.successful;
          if (!failed && !results.length) {
            const prompt=messages.find(m=>m.content?.includes("Actual DAG and versioned evidence")).content;
            const state=JSON.parse(prompt.split("not authorization): ")[1].split("\nInline tool records")[0]);
            const ledger=state.dependency_evidence;
            const check=rt.evidence.find(e=>e.arguments.command==="node check.mjs");
            if (largeProgram) assert.ok(ledger.tool_index.some(e=>e.id===check.id),"oversized programs remain addressable");
            else assert.ok(ledger.original_tool_records.some(e=>e.id===check.id && e.result===check.result),"final review sees the verbatim independent test");
          }
          if(!failed&&!results.length){lookups.push("final");call("read_task_evidence",{ids:["artifact:integrate.verify@1"],reason:"Audit the actual independent test verdict"});return;}
          call("finish_fast_review",{status:failed?"partial":"completed",report:failed?"Actual independent check failed":"All requested findings checked",unresolved:failed?["Incorrect integration"]:[],evidence_ids:engine.snapshot().tasks.filter(t=>engine.store.latest(t.task_id)?.verification==="verified").map(t=>`artifact:${t.task_id}@1`)});return;
        }
        const task=JSON.parse(messages.find(m=>m.role==="user").content.match(/Task: (\{[^\n]*\})/)[1]);
        if(!results.length)initial.push({task:task.task_id,messages:structuredClone(messages)});
        if(regions.includes(task.task_id)||regions.some(region=>task.task_id===region+".verify")){
          const region=task.verifies??task.task_id;
          if(!results.length){call("read_file",{path:region+".txt",reason:"Read the assigned original source independently"});return;}
          const got=Number(results.at(-1).content.split("\n")[0]),expected=regions.indexOf(region)+1;
          call("finish_task",{status:"completed",report:JSON.stringify({region,value:got}),unresolved:[],...(task.kind==="verification"?{verification_passed:got===expected}:{})});return;
        }
        if(task.task_id==="integrate"){
          if(!results.length){lookups.push("worker");call("read_task_evidence",{ids:regions.map(r=>`artifact:${r}@1`),reason:"Use exact independent inspector findings"});return;}
          if(results.length===1){call("run_command",{command:`node -e "require('fs').writeFileSync('../must-not-exist.txt','bad')"`,reason:"Exercise rejected workspace path without a side effect"});return;}
          if(results.length===2){call("run_command",{command:`node -e "const fs=require('fs');const sum=['north','south','east','west'].reduce((n,r)=>n+Number(fs.readFileSync(r+'.txt','utf8')),0);fs.writeFileSync('answer.json',JSON.stringify({sum:sum+${broken?1:0}}));console.log('written'); /*${largeProgram ? "padding ".repeat(2500) : ""}*/"`,reason:"Recompute every original source and integrate the result"});return;}
          call("finish_task",{status:"completed",report:"answer.json written from the original sources",unresolved:[]});return;
        }
        if (largeProgram) {
          const producer = rt.evidence.filter(e => e.name === "run_command" && !e.arguments.command.includes("node check.mjs"));
          if (!results.length) {
            call("finish_task",{status:"completed",report:"All work checked",verification_passed:true,unresolved:[]});return;
          }
          if (results.length === 1) {
            assert.match(results[0].content,/outstanding producer action records/);
            call("read_task_evidence",{ids:producer.map(e=>e.id),reason:"Inspect the original attempted and executed programs"});return;
          }
          if (results.length === 2) {
            assert.ok(results[1].content.includes("padding padding"));
            call("run_command",{command:"node check.mjs",reason:"Independent source/output assertions"});return;
          }
        }
        if(!results.length){lookups.push("verifier");const entry=rt.evidence.find(e=>e.name==="run_command"&&e.status==="completed");const originals=regions.map(region=>rt.evidence.find(e=>e.name==="read_file"&&e.status==="completed"&&e.arguments.path===region+".txt").id);call("read_task_evidence",{ids:[...originals,entry.id],reason:"Audit original inspector reads through recorded transitive dependencies and the integration command"});return;}
        if(results.length===1){assert.ok(!results[0].content.includes("[Error:"),"legitimate transitive evidence is available without a failed lookup");call("run_command",{command:"node check.mjs",reason:"Run mandatory independent assertions on actual source and output"});return;}
        const passed=results.at(-1).content.includes("PASS independent actual sources");
        call("finish_task",{status:"completed",report:passed?"Independent assertions passed":"Actual assertion failed",verification_passed:passed,unresolved:passed?[]:["Output mismatches originals"]});
      };return client;
    };
    engine=new FastAgentEngine({runtime:rt,signal:rt.signal,cwd:directory,history:[{role:"user",content:request}],system:"Original capabilities",subagentSystem:"Independent worker",settings:{...fastSettings({}),retries:0,replans:0},contextWindow:1000000,maxRounds:10,createClient,
      approve:async()=>({approved:true,source:"prompt",reason:"Local deterministic fixture"}),execute:async(name,args,signal)=>{executed.push({name,args});return executeTool(name,args,directory,signal);}});
    const result=await rt.run(()=>engine.run());rt.finish(result.status);await rt.drain();
    assert.equal(fs.existsSync(path.join(root,"must-not-exist.txt")),false);
    assert.ok(rt.evidence.some(e=>e.status==="denied"&&e.arguments.command?.includes("must-not-exist")),JSON.stringify({error:result.snapshot.error,tasks:result.snapshot.tasks.map(t=>({id:t.task_id,status:t.status,error:t.error})),evidence:rt.evidence.map(e=>({name:e.name,status:e.status,result:e.result.slice(0,180)}))}));
    assert.equal(executed.some(e=>e.args.command?.includes("must-not-exist")),false,"scope preflight occurs before execution");
    assert.ok(rt.evidence.some(e=>e.name==="read_task_evidence"&&e.status==="completed"));
    assert.ok(initial.every(x=>x.messages[0].content.includes(request)),"immutable original request is inherited at every level");
    assert.ok(engine.snapshot().tasks.filter(t=>t.verifies).length===5,"all five independent verifiers remain");
    return {result,lookups,rt};
  }
  const good=await runEngine();assert.equal(good.result.status,"completed");assert.deepEqual(new Set(good.lookups),new Set(["worker","verifier","final"]));
  assert.equal((await runEngine(false,true)).result.status,"completed");
  const broken=await runEngine(true);assert.notEqual(broken.result.status,"completed");assert.equal(broken.result.snapshot.tasks.find(t=>t.task_id==="integrate").status,"FAILED");
  // Exercise the proposal correction through real worker/tools plus the unchanged approval gate.
  // A schema flag requests a decision; it cannot supply consent or skip any review round.
  const {saveConfig,DEFAULT_CONFIG}=await import("../dist/config.js");
  const {FULL_TRUST_PHRASE,AUTO_REVIEWERS,EXTREME_ROUNDS}=await import("../dist/llm/approval.js");
  async function approvalWorkflow(kind){
    const directory=path.join(root,"approval-"+kind);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,"requested.txt"),"preserve until approved");
    const automatic=kind==="automatic",trusted=kind==="trusted",optional=kind==="optional";
    saveConfig({...DEFAULT_CONFIG,auto_approve_extreme_risk:automatic});
    const request=(optional?"Write answer.json with {ok:true}; independently assert its value.":"Delete requested.txt; independently assert it is absent.")+
      " Work only inside this directory."+(trusted?" "+FULL_TRUST_PHRASE:"");
    const rt=new TaskRuntime({request,cwd:directory});let engine,asked=0,reviewed=0,executed=0,checked=0;
    const deletionCommand=`rm -f requested.txt && node -e 'require("assert").strictEqual(require("fs").existsSync("requested.txt"),false);console.log("PASS deletion self-check")'`;
    const gate=new ApprovalGate({autoApprovalEnabled:()=>true,extremeAutoApprovalEnabled:()=>automatic,
      askHuman:async()=>{asked++;return false;},reviewer:()=>({model:{name:"offline-reviewer",url:"https://offline.invalid",api_key:"fixture"},provider:"Fixture",intensity:"Max"}),createReviewerClient:()=>{
        const client=new LLMClient({name:"offline-reviewer",url:"https://offline.invalid",api_key:"fixture"},"Fixture","Max");
        client.complete=async(system,prompt)=>{reviewed++;assert.ok(prompt.includes(JSON.stringify(deletionCommand)),"every approval seat sees the complete batched command, including the assertion");return JSON.stringify({approve:true,safety_score:95,relevance_score:95,hard_block:false,reason:"Delete the exact owned file explicitly required by the current request"});};return client;
      }});
    const createClient=()=>{
      const client=new LLMClient({name:"offline-worker",url:"https://offline.invalid",api_key:"fixture",intensity:["Max"]},"Fixture","Max");
      client.streamTurn=async function*(messages,tools,options){
        assert.equal(this.intensity,"Max");assert.equal(options.maxOutputTokens,16384);
        this.toolCalls=[];this.outcome={status:"completed"};this.usage={prompt:100,completion:20,total:120};
        const call=(name,args)=>{this.toolCalls=[{id:"call",name,arguments:JSON.stringify(args)}];};
        if(messages[0].content.startsWith("You plan tasks")){yield line({type:"single",access:"exclusive"});return;}
        if(messages.some(m=>m.content?.includes("Perform the mandatory global review"))){
          const complete=engine.scheduler.successful;call("finish_fast_review",{status:complete?"completed":"partial",report:complete?"Original requirement independently verified":"Necessary deletion was not authorized",unresolved:complete?[]:["Requested file still exists"],evidence_ids:complete?["artifact:main@1", "artifact:main.verify@1"]:[]});return;
        }
        const task=JSON.parse(messages.find(m=>m.role==="user").content.match(/Task: (\{[^\n]*\})/)[1]);
        const results=messages.filter(m=>m.role==="tool");
        assert.equal(tools.find(t=>t.function.name==="run_command").function.parameters.properties.request_user_approval.type,"boolean");
        if(!results.length){
          if(optional&&task.kind!=="verification"){call("write_file",{path:"answer.json",content:'{"ok":true}',reason:"Deliver the requested output"});return;}
          if(!optional&&task.kind==="verification"){
            call("run_command",{command:`node -e 'require("assert").strictEqual(require("fs").existsSync("requested.txt"),false);console.log("PASS required assertion")'`,reason:"Independently verify the requested deletion without repeating it"});return;
          }
          call("run_command",{command:optional?"rm -rf .unrequested_negative_test":deletionCommand,reason:optional?"Prepare optional tests of a scratch verifier":"Remove only the file explicitly requested by the user and assert it is absent",...(kind==="human"?{request_user_approval:true}:{})});return;
        }
        if(optional&&task.kind==="verification"&&results.length===1){
          assert.ok(results[0].content.includes("Nothing ran and no human decision was requested"));
          call("run_command",{command:`node -e 'require("assert").deepStrictEqual(JSON.parse(require("fs").readFileSync("answer.json","utf8")),{ok:true});console.log("PASS required assertion")'`,reason:"Independently verify the actual required output without unrequested destructive preparation"});return;
        }
        const refused=kind==="human";call("finish_task",{status:refused?"blocked":"completed",report:refused?"The user did not approve the necessary deletion":"Original task requirement checked",unresolved:refused?["Deletion denied"]:[],...(task.kind==="verification"?{verification_passed:!refused}:{})});
      };return client;
    };
    engine=new FastAgentEngine({runtime:rt,signal:rt.signal,cwd:directory,history:[{role:"user",content:request}],system:"Keep full tool capabilities",subagentSystem:"Independent checks",settings:{...fastSettings({}),retries:0,replans:0},contextWindow:1000000,maxRounds:6,createClient,
      approve:async(name,args)=>{const risk=assessToolCall(name,args,directory);return risk?.level==="extreme"?gate.decide({tool:name,args,cwd:directory,prompt:request,risk}):{approved:true,source:"prompt",reason:"Owned offline non-destructive fixture"};},
      execute:async(name,args,signal)=>{if(args.command?.startsWith("rm "))executed++;if(args.command?.includes("PASS required assertion"))checked++;return executeTool(name,args,directory,signal);}});
    const result=await rt.run(()=>engine.run());rt.finish(result.status);await rt.drain();
    if(kind==="human"){
      assert.notEqual(result.status,"completed");assert.equal(asked,1);assert.equal(executed,0);assert.equal(reviewed,0);assert.ok(fs.existsSync(path.join(directory,"requested.txt")),"request_user_approval never grants permission");
    }else{
      assert.equal(result.status,"completed",JSON.stringify({kind,error:result.snapshot.error,tasks:result.snapshot.tasks.map(t=>({id:t.task_id,error:t.error}))}));assert.equal(asked,0);assert.equal(checked,1,"independent acceptance assertion must actually execute");
      assert.equal(executed,optional?0:1);assert.equal(fs.existsSync(path.join(directory,"requested.txt")),optional);
      assert.equal(reviewed,automatic?AUTO_REVIEWERS*EXTREME_ROUNDS:0,"each actual destructive call retains the full three independent approval rounds");
      if(optional)assert.ok(rt.evidence.some(e=>e.status==="denied"&&e.result.includes("no human decision")));
    }
  }
  for(const kind of ["optional","human","trusted","automatic"])await approvalWorkflow(kind);
  console.log("PASS fast efficiency: grouped DAGs, exact adaptive evidence and transitive inputs, stale/unknown references, four independent read-only inspectors plus five verifiers, actual failing tests, semantic filesystem paths vs log separators, quoted/helper/symlink guards, local correction, unchanged extreme approval and cancellation; model Max/output 16384 retained; no provider calls");
}finally{
  os.homedir=prior.home;for(const [key,value]of Object.entries(prior.environment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  fs.rmSync(root,{recursive:true,force:true});
}
