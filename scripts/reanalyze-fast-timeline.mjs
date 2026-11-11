// Re-analyze final metadata logs without replaying tools or contacting any provider.
import fs from "node:fs";
import { fastDataInput, fastDataOutput, resolveFastCapture } from "./fast-data-paths.mjs";
import { createHash } from "node:crypto";
import { analyzeTimeline } from "./fast-timeline-analysis.mjs";
const revision={analyzer_hash:createHash("sha256").update(fs.readFileSync("scripts/fast-timeline-analysis.mjs")).digest("hex"),recomputed_at:new Date().toISOString(),source:"existing metadata JSONL; no requests replayed"};
const load=file=>fs.readFileSync(file,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
for(const filename of["fast-timeline-diagnostics.json","fast-live-timeline-pilot.json"].map(fastDataInput)){
  if(!fs.existsSync(filename))continue;
  if(filename.includes("live-timeline")&&!fs.existsSync(fastDataInput("fast-live-timeline-pilot-at-capture.json")))fs.copyFileSync(filename,fastDataOutput("fast-live-timeline-pilot-at-capture.json"));
  const report=JSON.parse(fs.readFileSync(filename,"utf8"));
  const samples=report.profiles?report.profiles.flatMap(p=>p.samples):(report.scenarios??[]).flatMap(r=>Object.values(r.samples).flat());
  let count=0;
  for(const sample of samples){
    if(!sample.trace_file)continue;
    let traceFile;try{traceFile=resolveFastCapture(sample.trace_file);}catch{continue;}
    if(sample.trace_analysis&&!sample.trace_analysis.valid_for_attribution&&!sample.initial_capture_issues)sample.initial_capture_issues=[...sample.trace_analysis.issues];
    const analysis=analyzeTimeline(load(traceFile));
    if(report.profiles)sample.analysis=analysis;else sample.trace_analysis=analysis;
    count++;
  }
  report.analysis_revision={...revision,traces:count};
  if(report.kind==="live_model_end_to_end"&&!report.requested_cases)report.requested_cases=(report.scenarios??[]).map(row=>row.name);
  fs.writeFileSync(fastDataOutput(filename.replaceAll("\\","/").split("/").at(-1)),JSON.stringify(report,null,2)+"\n");
  console.log(`Re-analyzed ${count} final traces in ${filename}`);
}
