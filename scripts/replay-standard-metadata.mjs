// Offline control-flow replay. Recorded commands are DATA and are never executed.
// File contents are version placeholders: this cannot judge actual task quality.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileHash} from '../dist/llm/editing.js';
import {TaskRuntime} from '../dist/llm/runtime.js';
import {StandardTask} from '../dist/llm/standard.js';
import {executeTool} from '../dist/llm/tools.js';

const inputPath=process.argv[2],outputPath=process.argv[3];
if(!inputPath||!outputPath)throw new Error('Usage: node scripts/replay-standard-metadata.mjs <metadata-input.json> <result.json>');
const input=JSON.parse(fs.readFileSync(inputPath,'utf8'));
assert.equal(typeof input.original_request,'string');assert.ok(Array.isArray(input.events));
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'neutrino-standard-metadata-'));
const oldFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Recorded metadata replay forbids external model calls');};
const runtime=new TaskRuntime({cwd,request:input.original_request});
const task=new StandardTask(runtime);
const attempts=[];let fixtureReviews=0;
const remap=raw=>{
  const relative=raw.startsWith('/app/')?raw.slice(5):raw.replace(/^[/\\]+/,'');
  const file=path.resolve(cwd,relative);
  assert.ok(file.startsWith(cwd+path.sep),'Recorded file path escapes the synthetic replay directory');
  return file;
};
try{
  // Declared artifacts existed in the source execution. Precreate placeholders
  // without marking them observed, so later reads still govern version binding.
  for(const event of input.events.filter(e=>e.name==='finish_standard_task')){
    for(const raw of event.args.artifact_paths){const file=remap(raw);if(!fs.existsSync(file)){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'Unobserved declared artifact placeholder\n');}}
  }
  await runtime.run(async()=>{
    for(const event of input.events){
      const args={...event.args};
      if(typeof args.path==='string')args.path=remap(args.path);
      if(event.name==='finish_standard_task'){
        args.artifact_paths=args.artifact_paths.map(remap);
        const before=fixtureReviews;
        const outcome=await task.finish(args,{capacity:1_000_000,createClient:()=>({outcome:{status:'completed'},async complete(system,body){
          fixtureReviews++;assert.match(system,/FULL ORIGINAL REQUEST/);
          const data=JSON.parse(body);assert.equal(data.original_request,input.original_request);
          // Deliberately refuse a semantic pass: placeholders cannot establish
          // behavior, dependency completeness, or the official acceptance score.
          return JSON.stringify({accepted:false,unresolved:['Recorded metadata and synthetic file versions do not prove actual semantic coverage'],reason:'Independent review is reachable; real artifact/variant verification is still required'});
        }})});
        attempts.push({attempt:attempts.length+1,old_result:JSON.parse(event.result),new_result:outcome,independent_review_requests:fixtureReviews-before});
        runtime.recordTool(event.name,args,JSON.stringify(outcome),event.status,event.id);
        continue;
      }
      let result=event.result;
      if(event.status==='completed'&&event.file_version&&typeof args.path==='string'){
        const content=`Recorded version placeholder: ${event.file_version}\n`;
        fs.mkdirSync(path.dirname(args.path),{recursive:true});fs.writeFileSync(args.path,content);
        if(event.name==='read_file')result=await executeTool('read_file',args,cwd);
        if(event.name==='write_file'){args.content=content;result='Recorded placeholder write';}
        if(event.name==='edit_file')result=JSON.stringify({sha256:fileHash(content)});
      }
      // Keep original IDs/order/results; never call executeTool on a recorded command.
      runtime.recordTool(event.name,args,result,event.status,event.id);
    }
  });
  assert.ok(attempts.length>0);assert.equal(attempts.at(-1).independent_review_requests,1);
  assert.ok(attempts.every(a=>a.new_result.completed===false));
  assert.equal(task.state.status==='completed',false);
  const result={source_sha256:input.source_sha256,input_sha256:fileHash(fs.readFileSync(inputPath)),events:input.events.length,attempts,fixture_reviews:fixtureReviews,metadata_repairs:task.state.metadataRepairs,semantic_reviews:task.state.semanticReviews,external_model_calls:0,recorded_commands_executed:0,actual_task_quality_measured:false,official_score_changed:false,limitations:'Original requirements, evidence IDs, proposal payloads and event order are replayed. Files contain synthetic version markers; declared artifact placeholders are precreated; shell effects and actual semantic quality are not reproduced. The scripted independent reviewer always rejects a semantic success.'};
  fs.writeFileSync(outputPath,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({passed:true,attempts:attempts.length,fixture_reviews:fixtureReviews,external_model_calls:0,official_score_changed:false}));
}finally{runtime.finish('partial');globalThis.fetch=oldFetch;fs.rmSync(cwd,{recursive:true,force:true});}
