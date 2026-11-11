import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

const fixture=fs.mkdtempSync(path.join(os.tmpdir(),"neutrino-campaign-budget-test-"));
let requests=0,mode="blocked";
const server=http.createServer((req,res)=>{
  requests++;req.resume();res.setHeader("content-type","application/json");
  if(mode==="blocked"){res.statusCode=402;res.end(JSON.stringify({error:{message:"Insufficient Balance"}}));}
  else res.end(JSON.stringify({choices:[{message:{content:"OK"},finish_reason:"stop"}],usage:{prompt_tokens:15999,completion_tokens:1,total_tokens:16000}}));
});
try{
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const home=path.join(fixture,"home"),config=path.join(home,".neutrino");fs.mkdirSync(config,{recursive:true});
  fs.writeFileSync(path.join(config,"config.json"),JSON.stringify({selected_provider:"Fixture",selected_model:"fixture",selected_intensity:"High"}));
  fs.writeFileSync(path.join(config,"model.json"),JSON.stringify({providers:[{name:"Fixture",models:[{name:"fixture",url:`http://127.0.0.1:${server.address().port}/v1`,api_key:"owned-offline-fixture-key",intensity:["High"],supports_streaming:false}]}]}));
  const temporary=path.join(fixture,"tmp");fs.mkdirSync(temporary);
  const run=async(name,cap,extra=[])=>{
    const output=path.join(fixture,name+".json");
    const child=spawn(process.execPath,["scripts/benchmark-fast-live.mjs","--home",home,"--cases","multi_module_code","--runs","1","--token-cap",String(cap),"--trace-dir",path.join(fixture,"traces",name),"--output",output,...extra],{
      cwd:process.cwd(),env:{...process.env,HTTPS_PROXY:"",HTTP_PROXY:"",NEUTRINO_BENCHMARK_PROXY:"",TMPDIR:temporary,NEUTRINO_DIAGNOSTICS_DIR:""},stdio:["ignore","pipe","pipe"]});
    let log="";child.stdout.on("data",c=>{log+=c;});child.stderr.on("data",c=>{log+=c;});
    const timer=setTimeout(()=>child.kill("SIGKILL"),30000);
    const code=await new Promise(resolve=>child.on("close",resolve));clearTimeout(timer);
    assert.equal(code,1,log);assert.ok(fs.existsSync(output),log);
    assert.equal(fs.readdirSync(temporary).filter(n=>n.startsWith("neutrino-fast-live-")).length,0,"temporary credential fixture must be removed");
    return JSON.parse(fs.readFileSync(output,"utf8"));
  };
  const before=await run("before-probe",1);
  assert.equal(requests,0,"insufficient diagnostic cap must stop before any API request");
  assert.equal(before.error,"diagnostic_campaign_cap");
  const mismatch=await run("model-mismatch",300000,["--expect-provider","DifferentProvider"]);
  assert.equal(mismatch.error,"diagnostic_model_mismatch");assert.equal(requests,0,"model mismatch must stop before connecting");
  const blocked=await run("account-blocked",300000);
  assert.equal(requests,1,"one account failure probe, without retrying the campaign");
  assert.equal(blocked.connectivity.http_status,402);assert.equal(blocked.external_blocker.code,"HTTP 402");
  mode="available";
  const artifactRoot=path.join(fixture,"artifacts");
  const stopped=await run("cap-after-probe",17000,["--artifact-dir",artifactRoot]);
  assert.equal(requests,2,"after the probe, the cap must prevent every task provider attempt");
  assert.equal(stopped.error,"diagnostic_campaign_cap");assert.equal(stopped.campaign_usage.stopped,true);
  assert.ok(stopped.campaign_usage.requests_rejected_before_dispatch>0);
  assert.equal(stopped.campaign_usage.held_tokens,0);
  assert.equal(stopped.scenarios[0].samples.standard[0].trace_analysis.valid_for_attribution,true,"a cancelled campaign must wait for run-end and trace flushing before sampling");
  const exported=stopped.scenarios[0].samples.standard[0].artifacts;
  assert.ok(exported.directory.startsWith(artifactRoot));
  assert.deepEqual(exported.files.map(file=>file.name).sort(),["package.json","test.mjs"]);
  assert.ok(fs.existsSync(path.join(exported.directory,"final-answer.md")));
  const execution=JSON.parse(fs.readFileSync(path.join(exported.directory,"tool-evidence.json"),"utf8"));
  assert.ok(Array.isArray(execution.scopes));assert.ok(Array.isArray(execution.tools));
  assert.equal(stopped.execution_order[0].round,1);assert.equal(stopped.execution_order[0].mode,"standard");
  assert.ok(stopped.revision_sha256["scripts/fast-live-cases.mjs"]);
  for(const name of [...exported.files.map(file=>file.name),"final-answer.md"]){
    assert.equal(fs.readFileSync(path.join(exported.directory,name),"utf8").includes("owned-offline-fixture-key"),false,"artifact export must not include model credentials");
  }
  const fastFirst = await run("cap-fast-first",17000,["--first-mode","fast_dag","--artifact-dir",artifactRoot]);
  assert.equal(requests,3,"Fast-first order still dispatches only the connectivity probe after the cap is exhausted");
  assert.equal(fastFirst.first_mode,"fast_dag");assert.equal(fastFirst.execution_order[0].mode,"fast_dag");
  assert.equal(fastFirst.campaign_usage.held_tokens,0);
  assert.ok(fastFirst.revision_sha256["dist/fast/prefetch.js"]&&fastFirst.revision_sha256["dist/fast/context.js"]);
  console.log("PASS live diagnostic safeguards: pre-probe cap, HTTP 402 stop, per-attempt reservation, zero task dispatch after budget exhaustion and credential cleanup");
}finally{
  await new Promise(resolve=>server.close(resolve));fs.rmSync(fixture,{recursive:true,force:true});
}
