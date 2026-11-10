import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {fastLiveCases} from "./fast-live-cases.mjs";
import {auditFastLive,applyProtocolReviews} from "./audit-fast-live.mjs";
import {summarizeStability} from "./fast-stability-analysis.mjs";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"neutrino-stability-oracle-")),hash=x=>createHash("sha256").update(x).digest("hex");
const names=["multi_source_retrieval","multi_module_code","strong_sequential_dependencies","parallel_analysis"];
const raw={benchmark_id:"synthetic-unit-only",state:"completed",repetitions:3,requested_cases:names,scenarios:[]};
try{
  for(const scenario of fastLiveCases().filter(c=>names.includes(c.name))){
    const row={name:scenario.name,samples:{standard:[],fast_dag:[]}};raw.scenarios.push(row);
    for(const mode of ["standard","fast_dag"])for(let round=1;round<=3;round++){
      const cwd=path.join(root,scenario.name,mode,String(round));fs.mkdirSync(cwd,{recursive:true});
      for(const [name,body]of Object.entries(scenario.files))fs.writeFileSync(path.join(cwd,name),body);
      fs.writeFileSync(path.join(cwd,"answer.json"),JSON.stringify(scenario.expected));
      fs.writeFileSync(path.join(cwd,"final-answer.md"),"Checked a.txt, b.txt and c.txt with original sources.");
      if(scenario.name==="multi_module_code"){
        fs.writeFileSync(path.join(cwd,"tax.mjs"),"export const tax=x=>x*0.2;");fs.writeFileSync(path.join(cwd,"shipping.mjs"),"export const shipping=x=>3+2*x;");
      }
      if(scenario.name==="strong_sequential_dependencies")for(const [i,v]of [5,25,21].entries())fs.writeFileSync(path.join(cwd,`stage${i+1}.txt`),String(v));
      const evidence={original_cwd:cwd,root_run_id:"root",scopes:[{run_id:"root",read_only:false}],tools:[]};
      if(scenario.name==="parallel_analysis"){
        for(const region of ["north","south","east","west"]){evidence.scopes.push({run_id:region,read_only:true});evidence.tools.push({runId:region,name:"read_file",arguments:{path:region+".json"},status:"completed"});}
        evidence.tools.push({runId:"root",name:"run_command",arguments:{command:"node verify-all.mjs"},status:"completed"});
      }
      evidence.tools.forEach((tool,index)=>{tool.id="synthetic-tool-"+index;});
      fs.writeFileSync(path.join(cwd,"tool-evidence.json"),JSON.stringify(evidence));
      const outputs=[...new Set([...Object.keys(scenario.files),...(scenario.outputs??["answer.json"])])];
      const files=outputs.map(name=>({name,sha256:hash(fs.readFileSync(path.join(cwd,name)))}));
      row.samples[mode].push({round,success:true,fixture_correct:true,tokens:mode==="standard"?100:90,elapsed_ms:mode==="standard"?100:80,missing_usage_requests:0,retries:0,artifacts:{directory:cwd,files,final_answer:"final-answer.md",tool_evidence:"tool-evidence.json"}});
    }
  }
  const audited=auditFastLive(raw);assert.equal(audited.observed_samples,24);assert.equal(audited.all_functional_passed,true);
  assert.equal(audited.pending_manual_checks,18,"protocol provenance must not silently pass based on final values");
  const reviewedSample=raw.scenarios.find(r=>r.name==="parallel_analysis").samples.standard[0];
  const protocol={benchmark_id:raw.benchmark_id,reviewer:"synthetic unit test",reviews:[{scenario:"parallel_analysis",mode:"standard",round:1,tool_evidence_sha256:hash(fs.readFileSync(path.join(reviewedSample.artifacts.directory,"tool-evidence.json"))),checks:[{name:"coordinator_verified_inspector_reports",status:"passed",evidence_ids:["synthetic-tool-4"],reason:"Synthetic review gate test only."}]}]};
  const reviewed=applyProtocolReviews(structuredClone(audited),raw,protocol);assert.equal(reviewed.pending_manual_checks,17);assert.equal(reviewed.scenarios.find(r=>r.name==="parallel_analysis").samples.standard[0].passed,true);
  const stale=structuredClone(protocol);stale.reviews[0].tool_evidence_sha256="stale";assert.throws(()=>applyProtocolReviews(structuredClone(audited),raw,stale),/stale tool evidence/);
  const unknownTool=structuredClone(protocol);unknownTool.reviews[0].checks[0].evidence_ids=["not-executed"];assert.throws(()=>applyProtocolReviews(structuredClone(audited),raw,unknownTool),/unknown review tool/);
  const absent=structuredClone(protocol);absent.reviews[0].checks[0]={name:"coordinator_verified_inspector_reports",status:"failed",evidence_ids:[],reason:"No tool ran, so required coordinator verification is absent."};
  assert.throws(()=>applyProtocolReviews(structuredClone(audited),raw,absent),/unknown review tool/,"a missing citation cannot silently pass on a nonempty ledger");
  const evidenceFile=path.join(reviewedSample.artifacts.directory,"tool-evidence.json"),savedEvidence=fs.readFileSync(evidenceFile);
  const emptyEvidence=JSON.parse(savedEvidence);emptyEvidence.tools=[];fs.writeFileSync(evidenceFile,JSON.stringify(emptyEvidence));absent.reviews[0].tool_evidence_sha256=hash(fs.readFileSync(evidenceFile));
  assert.equal(applyProtocolReviews(structuredClone(audited),raw,absent).scenarios.find(r=>r.name==="parallel_analysis").samples.standard[0].passed,false,"a hash-bound empty ledger proves absent checks, never success");fs.writeFileSync(evidenceFile,savedEvidence);
  const duplicate=structuredClone(protocol);duplicate.reviews.push(duplicate.reviews[0]);assert.throws(()=>applyProtocolReviews(structuredClone(audited),raw,duplicate),/duplicate sample review/);
  const scoped=structuredClone(protocol);scoped.reviews[0].checks.push({name:"fixture_only_scope",status:"failed",evidence_ids:["synthetic-tool-4"],reason:"Synthetic scope failure."});assert.equal(applyProtocolReviews(structuredClone(audited),raw,scoped).scenarios.find(r=>r.name==="parallel_analysis").samples.standard[0].passed,false);
  const accept=q=>{for(const row of q.scenarios)for(const samples of Object.values(row.samples))for(const sample of samples){sample.manual_checks=sample.manual_checks.map(c=>({...c,status:"passed",reviewer:"synthetic unit test"}));sample.passed=sample.functional_passed;}return q;};
  const quality=accept(audited),summary=summarizeStability(raw,quality);
  assert.equal(summary.qualified_pairs,12);assert.equal(summary.all_scenarios_observed_consistent_speedup,true);assert.equal(summary.all_scenarios_observed_consistent_token_reduction,true);assert.ok(Math.abs(summary.geometric_mean_time_saved-0.2)<1e-9);assert.equal(summary.p95,null);
  assert.equal(summary.scenarios[0].token_change.coefficient_of_variation,null,"signed change fractions are not a ratio scale for CV");
  const changed=structuredClone(raw);changed.scenarios[0].samples.fast_dag[1].elapsed_ms=150;
  const mixed=summarizeStability(changed,quality);assert.equal(mixed.scenarios[0].observed_consistent_speedup,false);assert.equal(mixed.scenarios[0].fast_faster_pairs,2);
  const failed=structuredClone(raw);failed.scenarios[0].samples.fast_dag[0].success=false;
  const partial=summarizeStability(failed,quality);assert.equal(partial.qualified_pairs,11);assert.equal(partial.geometric_mean_time_saved,null);assert.equal(partial.scenarios[0].modes.fast_dag.attempted,3);
  const unknown=structuredClone(raw);unknown.scenarios[0].samples.fast_dag[0].missing_usage_requests=1;
  const covered=summarizeStability(unknown,quality);assert.equal(covered.scenarios[0].complete_usage_pairs,2);assert.equal(covered.scenarios[0].pairs[0].token_change_fraction,null);
  const pipeline=raw.scenarios.find(r=>r.name==="strong_sequential_dependencies").samples.fast_dag[0].artifacts.directory;
  fs.writeFileSync(path.join(pipeline,"stage2.txt"),"999");assert.equal(auditFastLive(raw).all_functional_passed,false);fs.writeFileSync(path.join(pipeline,"stage2.txt"),"25");
  const parallel=raw.scenarios.find(r=>r.name==="parallel_analysis").samples.fast_dag[0].artifacts.directory;
  const evidence=JSON.parse(fs.readFileSync(path.join(parallel,"tool-evidence.json"),"utf8"));evidence.scopes[1].read_only=false;fs.writeFileSync(path.join(parallel,"tool-evidence.json"),JSON.stringify(evidence));
  const invalid=auditFastLive(raw);assert.equal(invalid.all_functional_passed,false);assert.ok(invalid.scenarios.find(r=>r.name==="parallel_analysis").samples.fast_dag[0].checks.some(c=>c.name==="four_actual_read_only_inspectors"&&!c.passed));
  console.log("PASS stability measurement: 24 artifact audits, fixed oracles, read-only inspectors, hash-bound protocol reviews, paired spread/wins, failures and unknown usage; no model calls");
}finally{fs.rmSync(root,{recursive:true,force:true});}
