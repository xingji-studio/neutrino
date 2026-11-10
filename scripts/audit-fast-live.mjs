// Independent post-run checks on owned benchmark artifacts. No model calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { fastLiveCases } from "./fast-live-cases.mjs";
const hash=s=>createHash("sha256").update(s).digest("hex");
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==="object"?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const additional=`import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tax} from './tax.mjs';
import {shipping} from './shipping.mjs';
assert.equal(typeof tax,'function');assert.equal(typeof shipping,'function');
const inputs=[-10,0,0.5,1,2,12.5,100,1000];
for(const x of inputs){const got=tax(x),want=x*0.2;assert.equal(typeof got,'number');assert.ok(Number.isFinite(got));assert.ok(Math.abs(got-want)<=1e-10*Math.max(1,Math.abs(want)));}
for(const x of inputs){const got=shipping(x),want=3+2*x;assert.equal(typeof got,'number');assert.ok(Number.isFinite(got));assert.ok(Math.abs(got-want)<=1e-10*Math.max(1,Math.abs(want)));}
const answer=JSON.parse(fs.readFileSync('answer.json','utf8'));
assert.deepEqual(Object.keys(answer).sort(),['shipping2','tax100']);assert.equal(typeof answer.tax100,'number');assert.equal(typeof answer.shipping2,'number');
assert.deepEqual(answer,{tax100:tax(100),shipping2:shipping(2)});
console.log(JSON.stringify({passed:true,additional_formula_cases:16,exports_checked:2,answer_matches_imported_functions:true}));`;

export function auditFastLive(raw){
  const catalogue=new Map(fastLiveCases().map(c=>[c.name,c]));
  const quality={kind:"post_run_independent_fixture_audit",benchmark_id:raw.benchmark_id,audited_at:new Date().toISOString(),repetitions:raw.repetitions,same_acceptance_for_both:true,external_model_calls:0,scenarios:[]};
  for(const row of raw.scenarios){
    const scenario=catalogue.get(row.name);if(!scenario)throw new Error("Unknown fixture: "+row.name);
    const qrow={name:row.name,samples:{standard:[],fast_dag:[]}};quality.scenarios.push(qrow);
    for(const mode of ["standard","fast_dag"])for(const [index,sample]of row.samples[mode].entries()){
      const cwd=sample.artifacts?.directory,checks=[],manual=[];
      const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:String(error.message).slice(0,700)});}};
      const read=name=>fs.readFileSync(path.join(cwd,name),"utf8");
      const json=name=>JSON.parse(read(name));
      let evidence;
      check("task_and_exact_oracle",()=>assert.ok(sample.success&&sample.fixture_correct,"runtime or primary fixture oracle failed"));
      check("artifact_manifest",()=>{assert.ok(cwd);for(const file of sample.artifacts.files)assert.equal(hash(fs.readFileSync(path.join(cwd,file.name))),file.sha256);});
      for(const [name,body]of Object.entries(scenario.files))check("unchanged_input:"+name,()=>assert.equal(hash(read(name)),hash(body)));
      check("exact_answer",()=>assert.deepEqual(canonical(json("answer.json")),canonical(scenario.expected)));
      if(sample.artifacts?.tool_evidence)check("execution_evidence",()=>{evidence=json(sample.artifacts.tool_evidence);assert.ok(Array.isArray(evidence.tools)&&Array.isArray(evidence.scopes));});
      if(row.name==="multi_module_code"){
        check("original_four_assertions",()=>{const p=spawnSync(process.execPath,["test.mjs"],{cwd,encoding:"utf8",timeout:10000});assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim(),"PASS");});
        check("sixteen_formula_cases_and_exports",()=>{const p=spawnSync(process.execPath,["--input-type=module","-e",additional],{cwd,encoding:"utf8",timeout:10000});assert.equal(p.status,0,p.stderr);assert.equal(JSON.parse(p.stdout).passed,true);});
        check("independent_modules",()=>{for(const file of ["tax.mjs","shipping.mjs"]){const other=file==="tax.mjs"?"shipping.mjs":"tax.mjs";for(const spec of ts.preProcessFile(read(file),true,true).importedFiles.map(x=>x.fileName))assert.ok(!(spec.startsWith(".")||path.isAbsolute(spec))||path.resolve(cwd,spec)!==path.resolve(cwd,other));}});
      }else if(row.name==="multi_source_retrieval"){
        check("recalculate_from_original_sources",()=>{const total=["a.txt","b.txt","c.txt"].reduce((n,f)=>n+Number(read(f).match(/population:\s*(\d+)/)[1]),0);assert.equal(json("answer.json").total,total);});
        check("all_source_citations",()=>{const answer=read(sample.artifacts.final_answer);for(const name of ["a.txt","b.txt","c.txt"])assert.ok(answer.includes(name),"missing citation "+name);});
        manual.push({name:"original_sources_actually_read",reason:"Review executed read_file/Node tool evidence for all three original sources."});
      }else if(row.name==="strong_sequential_dependencies"){
        check("saved_stages_and_relationships",()=>{const seed=Number(read("seed.txt")),s1=Number(read("stage1.txt")),s2=Number(read("stage2.txt")),s3=Number(read("stage3.txt"));assert.equal(s1,seed+2);assert.equal(s2,s1*s1);assert.equal(s3,s2-4);assert.deepEqual(json("answer.json"),{stage1:s1,stage2:s2,stage3:s3});});
        manual.push({name:"strict_execution_order",reason:"Review tool commands and written program bodies: downstream calculations must read their saved predecessor, after it is written."});
      }else if(row.name==="parallel_analysis"){
        check("independent_recalculation_all_datasets",()=>{const regions={};for(const name of ["north","south","east","west"]){const data=json(name+".json");regions[name]={count:data.length,units:data.reduce((n,r)=>n+r.units,0),weighted:data.reduce((n,r)=>n+r.units*r.weight,0)};}assert.deepEqual(canonical(json("answer.json")),canonical({regions,grand_units:Object.values(regions).reduce((n,r)=>n+r.units,0),grand_weighted:Object.values(regions).reduce((n,r)=>n+r.weighted,0)}));});
        check("four_actual_read_only_inspectors",()=>{
          assert.ok(evidence,"effective scope and tool evidence required");
          const taskMap=new Map((sample.fast_tasks??[]).map(t=>[t.task_id,t]));const owners=new Map();
          for(const scope of evidence.scopes){
            if(!scope.read_only||scope.run_id===evidence.root_run_id||taskMap.get(scope.task_id)?.verifies)continue;
            const calls=evidence.tools.filter(t=>t.runId===scope.run_id&&t.status==="completed");
            if(!calls.every(t=>["read_file","list_files"].includes(t.name)))continue;
            const files=calls.filter(t=>t.name==="read_file").map(t=>path.relative(evidence.original_cwd,path.resolve(evidence.original_cwd,String(t.arguments.path))));
            if(!files.length||new Set(files).size!==1)continue;
            if(["north.json","south.json","east.json","west.json"].includes(files[0]))owners.set(files[0],scope.run_id);
          }
          assert.equal(owners.size,4,"all four sources need separate effective read-only agent scopes");assert.equal(new Set(owners.values()).size,4);
        });
        check("coordinator_executed_node",()=>{assert.ok(evidence);const writable=new Set(evidence.scopes.filter(s=>!s.read_only).map(s=>s.run_id));assert.ok(evidence.tools.some(t=>t.name==="run_command"&&t.status==="completed"&&writable.has(t.runId)&&/\bnode\b/.test(String(t.arguments.command))));});
        manual.push({name:"coordinator_verified_inspector_reports",reason:"Review executed Node commands/program bodies for independent recomputation of all four original datasets and comparison before answer output."});
      }else{manual.push({name:"unsupported_protocol",reason:"This fixture only has the exact-output oracle until its protocol audit is implemented."});}
      const functional=checks.every(c=>c.passed);
      qrow.samples[mode].push({round:sample.round??index+1,artifact_directory:cwd,functional_passed:functional,passed:functional&&manual.length===0,checks,manual_checks:manual.map(x=>({...x,status:"pending"})),final_answer_file:cwd?path.join(cwd,sample.artifacts.final_answer):null});
    }
  }
  const samples=quality.scenarios.flatMap(r=>Object.values(r.samples).flat());
  quality.expected_samples=raw.requested_cases.length*raw.repetitions*2;quality.observed_samples=samples.length;
  quality.all_functional_passed=raw.state==="completed"&&samples.length===quality.expected_samples&&samples.every(s=>s.functional_passed);
  quality.all_quality_passed=quality.all_functional_passed&&samples.every(s=>s.passed);
  quality.pending_manual_checks=samples.reduce((n,s)=>n+s.manual_checks.filter(c=>c.status==="pending").length,0);
  if(quality.scenarios.length===1&&quality.scenarios[0].name==="multi_module_code"&&Object.values(quality.scenarios[0].samples).every(s=>s.length===1)){
    const row=raw.scenarios[0];quality.samples=Object.fromEntries(["standard","fast_dag"].map(m=>[m,quality.scenarios[0].samples[m][0]]));
    const read=(m,f)=>fs.readFileSync(path.join(row.samples[m][0].artifacts.directory,f),"utf8");
    quality.functional_modules_byte_identical=read("standard","tax.mjs")===read("fast_dag","tax.mjs")&&read("standard","shipping.mjs")===read("fast_dag","shipping.mjs");
    quality.answer_semantically_identical=JSON.stringify(canonical(JSON.parse(read("standard","answer.json"))))===JSON.stringify(canonical(JSON.parse(read("fast_dag","answer.json"))));
  }
  return quality;
}
// Reviews bind human protocol judgments to the exact saved execution evidence.
export function applyProtocolReviews(quality,raw,protocol){
  assert.equal(protocol.benchmark_id,raw.benchmark_id,"review belongs to another campaign");
  const seen=new Set();
  for(const review of protocol.reviews){
    const key=JSON.stringify([review.scenario,review.mode,review.round]);
    assert.ok(!seen.has(key),"duplicate sample review");seen.add(key);
    const sample=raw.scenarios.find(r=>r.name===review.scenario)?.samples[review.mode]?.find(s=>s.round===review.round);
    const audited=quality.scenarios.find(r=>r.name===review.scenario)?.samples[review.mode]?.find(s=>s.round===review.round);
    assert.ok(sample&&audited,"review sample not found");
    const directory=sample.artifacts.directory;
    const bytes=fs.readFileSync(path.join(directory,sample.artifacts.tool_evidence));
    assert.equal(hash(bytes),review.tool_evidence_sha256,"stale tool evidence review");
    const evidence=JSON.parse(bytes),ids=new Set(evidence.tools.map(t=>t.id));
    if(review.agent_artifacts_sha256)assert.equal(hash(fs.readFileSync(path.join(directory,"agent-artifacts.json"))),review.agent_artifacts_sha256,"stale inspector artifact review");
    const checkNames=new Set();
    for(const check of review.checks){
      assert.ok(!checkNames.has(check.name),"duplicate protocol check");checkNames.add(check.name);
      assert.ok(["passed","failed"].includes(check.status),"review must state passed or failed");
      const absenceFailure=check.status==="failed"&&evidence.tools.length===0&&check.name!=="fixture_only_scope";
      assert.ok(Array.isArray(check.evidence_ids)&&(check.evidence_ids.length>0||absenceFailure)&&check.evidence_ids.every(id=>ids.has(id)),"unknown review tool ID");
      const pending=audited.manual_checks.find(c=>c.name===check.name);
      assert.ok(pending||check.name==="fixture_only_scope","unknown protocol check");
      if(pending)Object.assign(pending,check);else audited.manual_checks.push({...check});
    }
    audited.protocol_review={reviewer:protocol.reviewer,tool_evidence_sha256:review.tool_evidence_sha256,...(review.agent_artifacts_sha256?{agent_artifacts_sha256:review.agent_artifacts_sha256}:{})};
  }
  const samples=quality.scenarios.flatMap(r=>Object.values(r.samples).flat());
  for(const sample of samples)sample.passed=sample.functional_passed&&sample.manual_checks.every(c=>c.status==="passed");
  quality.pending_manual_checks=samples.reduce((n,s)=>n+s.manual_checks.filter(c=>c.status==="pending").length,0);
  quality.all_quality_passed=quality.all_functional_passed&&samples.every(s=>s.passed);
  return quality;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const argument=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
  if(!argument("--input")||!argument("--output"))throw new Error("Use --input <live report> --output <quality report>");
  const raw=JSON.parse(fs.readFileSync(argument("--input"),"utf8")),quality=auditFastLive(raw);
  if(argument("--reviews"))applyProtocolReviews(quality,raw,JSON.parse(fs.readFileSync(argument("--reviews"),"utf8")));
  fs.mkdirSync(path.dirname(path.resolve(argument("--output"))),{recursive:true});fs.writeFileSync(argument("--output"),JSON.stringify(quality,null,2)+"\n");
  console.log(JSON.stringify({scenarios:quality.scenarios.length,samples:quality.observed_samples,functional_passed:quality.all_functional_passed,quality_passed:quality.all_quality_passed,pending_manual_checks:quality.pending_manual_checks}));
  if(!quality.all_functional_passed||(argument("--reviews")&&!quality.all_quality_passed))process.exitCode=1;
}
