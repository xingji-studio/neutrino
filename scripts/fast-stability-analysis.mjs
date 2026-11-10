const stats=(values,ratioScale=false)=>{
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),mean=values.reduce((n,x)=>n+x,0)/values.length;
  const sd=values.length>1?Math.sqrt(values.reduce((n,x)=>n+(x-mean)**2,0)/(values.length-1)):null;
  return {n:values.length,mean,median:sorted.length%2?sorted[Math.floor(sorted.length/2)]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2,min:sorted[0],max:sorted.at(-1),sample_sd:sd,coefficient_of_variation:ratioScale&&sd!==null&&mean>0?sd/mean:null};
};
export function summarizeStability(raw,quality){
  const scenarios=[];let allKnownTokens=0,unknownAttempts=0;
  for(const row of raw.scenarios){
    const qr=quality.scenarios.find(q=>q.name===row.name),pairs=[];
    const byRound=mode=>new Map(row.samples[mode].map((s,i)=>[s.round??i+1,s]));
    const standards=byRound("standard"),fasts=byRound("fast_dag");
    const modes={};
    for(const mode of ["standard","fast_dag"]){
      const samples=row.samples[mode];
      modes[mode]={attempted:samples.length,completed:samples.filter(s=>s.success).length,primary_oracle_passed:samples.filter(s=>s.fixture_correct).length,quality_passed:(qr?.samples[mode]??[]).filter(s=>s.passed).length,elapsed_ms:stats(samples.map(s=>s.elapsed_ms),true),reported_tokens:stats(samples.map(s=>s.tokens),true),retries:samples.reduce((n,s)=>n+(s.retries??0),0)};
      for(const sample of samples){allKnownTokens+=sample.tokens;unknownAttempts+=sample.trace_analysis?.provider_attempts.filter(t=>t.input_tokens==null||t.output_tokens==null).length??sample.missing_usage_requests??0;}
    }
    for(let round=1;round<=raw.repetitions;round++){
      const a=standards.get(round),b=fasts.get(round),qa=qr?.samples.standard.find(s=>s.round===round),qb=qr?.samples.fast_dag.find(s=>s.round===round);
      const qualified=!!(a?.success&&b?.success&&a.fixture_correct&&b.fixture_correct&&qa?.passed&&qb?.passed);
      const complete=s=>!!s&&(s.trace_analysis?.provider_attempts.every(t=>t.input_tokens!=null&&t.output_tokens!=null)??s.missing_usage_requests===0);
      const usage=complete(a)&&complete(b);
      pairs.push({round,standard:a?{elapsed_ms:a.elapsed_ms,tokens:a.tokens,success:a.success,fixture_correct:a.fixture_correct,quality_passed:qa?.passed??false}:null,fast_dag:b?{elapsed_ms:b.elapsed_ms,tokens:b.tokens,success:b.success,fixture_correct:b.fixture_correct,quality_passed:qb?.passed??false}:null,qualified,complete_usage:usage,time_saved_fraction:qualified?1-b.elapsed_ms/a.elapsed_ms:null,reported_token_change_fraction:a&&b?b.tokens/a.tokens-1:null,token_change_fraction:qualified&&usage?b.tokens/a.tokens-1:null});
    }
    const accepted=pairs.filter(p=>p.qualified),known=accepted.filter(p=>p.complete_usage);
    scenarios.push({name:row.name,modes,pairs,qualified_pairs:accepted.length,complete_usage_pairs:known.length,time_saved:stats(accepted.map(p=>p.time_saved_fraction)),token_change:stats(known.map(p=>p.token_change_fraction)),fast_faster_pairs:accepted.filter(p=>p.time_saved_fraction>0).length,fast_lower_token_pairs:known.filter(p=>p.token_change_fraction<0).length,quality_consistent:row.samples.standard.length===raw.repetitions&&row.samples.fast_dag.length===raw.repetitions&&modes.standard.quality_passed===raw.repetitions&&modes.fast_dag.quality_passed===raw.repetitions,observed_consistent_speedup:accepted.length===raw.repetitions&&accepted.every(p=>p.time_saved_fraction>0),observed_consistent_token_reduction:known.length===raw.repetitions&&known.every(p=>p.token_change_fraction<0)});
  }
  const qualified=scenarios.flatMap(s=>s.pairs).filter(p=>p.qualified),expected=raw.requested_cases.length*raw.repetitions;
  return {benchmark_id:raw.benchmark_id,state:raw.state,repetitions:raw.repetitions,expected_pairs:expected,qualified_pairs:qualified.length,scenarios,reported_task_tokens:allKnownTokens,unknown_usage_attempts:unknownAttempts,all_scenarios_quality_consistent:scenarios.length===raw.requested_cases.length&&scenarios.every(s=>s.quality_consistent),all_scenarios_observed_consistent_speedup:scenarios.length===raw.requested_cases.length&&scenarios.every(s=>s.observed_consistent_speedup),all_scenarios_observed_consistent_token_reduction:scenarios.length===raw.requested_cases.length&&scenarios.every(s=>s.observed_consistent_token_reduction),geometric_mean_time_saved:qualified.length===expected?1-Math.exp(qualified.reduce((n,p)=>n+Math.log(1-p.time_saved_fraction),0)/qualified.length):null,p95:null,limitation:"Three paired observations per fixture show observed direction and spread; they do not establish population stability, reliable P95 or general quality equivalence. Failed/unqualified samples remain visible and are not replaced."};
}
