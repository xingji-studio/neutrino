// Saved-data analysis only. No model calls or source changes.
import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import {createHash} from "node:crypto";
import {summarizeStability} from "./fast-stability-analysis.mjs";
const arg=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const stem=arg("--stem","docs/fast-efficiency"),read=file=>JSON.parse(fs.readFileSync(file,"utf8"));
const raw=read(stem+"-benchmark.json"),quality=read(stem+"-quality.json"),plan=read(stem+"-plan.json");
const before=read(arg("--before","docs/fast-stability-benchmark.json")),beforeQuality=read(arg("--before-quality","docs/fast-stability-quality.json"));
assert.equal(raw.benchmark_id,quality.benchmark_id);assert.equal(quality.pending_manual_checks,0);
for(const key of ["provider","name","intensity"])assert.equal(raw.model[key],before.model[key]);
const hash=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const archived=process.argv.includes("--archived"),proofFile=arg("--revision-proof",stem+"-v1-correction-record.json"),versionOne=path.basename(stem)==="fast-efficiency",revisionDifferences=Object.entries(raw.revision_sha256).filter(([file,want])=>hash(file)!==want).map(([file])=>file);
if(archived){
  const proof=read(proofFile);assert.equal(proof.benchmark_id,raw.benchmark_id);
  assert.equal(proof.runtime_fingerprints_verified_before_correction,Object.keys(raw.revision_sha256).length);
}else assert.deepEqual(revisionDifferences,[],"Campaign revision changed");
const median=a=>{const s=[...a].sort((x,y)=>x-y);return !s.length?null:s.length%2?s[Math.floor(s.length/2)]:(s[s.length/2-1]+s[s.length/2])/2;};
const compact=a=>a.length?{n:a.length,median:median(a),min:Math.min(...a),max:Math.max(...a)}:null;
const complete=s=>s.trace_analysis?.provider_attempts.every(t=>t.input_tokens!=null&&t.output_tokens!=null)??s.missing_usage_requests===0;
const audit=(q,name,mode,round)=>q.scenarios.find(s=>s.name===name)?.samples[mode].find(s=>s.round===round);
const role=(s,name)=>s.trace_analysis.roles[name]??{reported_input_tokens:0,reported_output_tokens:0,request_ms_cumulative:0};
const tokens=(s,name)=>role(s,name).reported_input_tokens+role(s,name).reported_output_tokens;
const summary=summarizeStability(raw,quality),samples=raw.scenarios.flatMap(row=>Object.entries(row.samples).flatMap(([mode,ss])=>ss.map(s=>({scenario:row.name,mode,...s}))));
summary.model=raw.model;summary.conditions=raw.conditions;summary.output_budget=plan.output_budget;summary.context_window=plan.context_window;
summary.mode_totals=Object.fromEntries(["standard","fast_dag"].map(mode=>[mode,{attempted:samples.filter(s=>s.mode===mode).length,completed:samples.filter(s=>s.mode===mode&&s.success).length,quality_passed:quality.scenarios.flatMap(q=>q.samples[mode]).filter(q=>q.passed).length,reported_tokens:samples.filter(s=>s.mode===mode).reduce((n,s)=>n+s.tokens,0)}]));
summary.blocked_samples=samples.filter(s=>s.blocked_on_approval).map(s=>({scenario:s.scenario,mode:s.mode,round:s.round,blocked_approval:s.blocked_approval??null}));
summary.scope_failures=quality.scenarios.flatMap(row=>Object.entries(row.samples).flatMap(([mode,ss])=>ss.flatMap(s=>s.manual_checks.filter(c=>c.name==="fixture_only_scope"&&c.status==="failed").map(check=>({scenario:row.name,mode,round:s.round,check})))));
summary.workspace_preflight_denials=[];
summary.destructive_proposal_corrections=[];
summary.planning_failures=samples.filter(s=>s.mode==="fast_dag"&&(s.fast_planning_errors?.length||s.fast_metrics?.replans)).map(s=>({scenario:s.scenario,round:s.round,replans:s.fast_metrics.replans,errors:s.fast_planning_errors??null}));
for(const s of samples){
  const e=read(s.artifacts.directory+"/tool-evidence.json");
  for(const t of e.tools)if(t.status==="denied"&&/Nothing ran and no human decision was requested/.test(t.result))summary.destructive_proposal_corrections.push({scenario:s.scenario,mode:s.mode,round:s.round,id:t.id,name:t.name});
  for(const t of e.tools)if(t.status==="denied"&&/explicitly confined workspace|outside.*workspace/.test(t.result))summary.workspace_preflight_denials.push({scenario:s.scenario,mode:s.mode,round:s.round,id:t.id,name:t.name});
  const known=s.trace_analysis.provider_attempts.reduce((n,t)=>n+(t.input_tokens??0)+(t.output_tokens??0),0);assert.equal(known,s.tokens,"Trace token mismatch");
}
summary.campaign_usage=raw.campaign_usage;
summary.work_budget={total_cap:plan.total_work_token_cap??plan.campaign_token_cap,
  previous_guard_settled_tokens:plan.previous_guard_settled_tokens??plan.v1_guard_settled_tokens??0,
  current_cap:plan.campaign_token_cap,current_guard_settled_tokens:raw.campaign_usage.settled_tokens_including_unknown_reservations,
  historical_trials:plan.intermediate_trials??(plan.intermediate_trial?[plan.intermediate_trial]:[])};
summary.work_budget.total_guard_settled_tokens=summary.work_budget.previous_guard_settled_tokens+summary.work_budget.current_guard_settled_tokens;
assert.ok(summary.work_budget.total_guard_settled_tokens<=summary.work_budget.total_cap,"Recorded work cap exceeded");
summary.frozen_files_verified=Object.keys(raw.revision_sha256).length;
summary.runtime_verification={archived,current_revision_differences:revisionDifferences,proof:archived?proofFile:"current files match campaign hashes"};
summary.historical_fast_comparisons=raw.scenarios.map(row=>{
  const old=before.scenarios.find(s=>s.name===row.name),pairs=[];
  for(const next of row.samples.fast_dag){
    const previous=old?.samples.fast_dag.find((s,i)=>(s.round??i+1)===next.round);
    if(!previous?.success||!next.success||!audit(beforeQuality,row.name,"fast_dag",next.round)?.passed||!audit(quality,row.name,"fast_dag",next.round)?.passed||!complete(previous)||!complete(next))continue;
    pairs.push({round:next.round,previous:{elapsed_ms:previous.elapsed_ms,tokens:previous.tokens},current:{elapsed_ms:next.elapsed_ms,tokens:next.tokens},token_change:next.tokens/previous.tokens-1,time_saved:1-next.elapsed_ms/previous.elapsed_ms,
      planning_ms:{previous:role(previous,"planning").request_ms_cumulative,current:role(next,"planning").request_ms_cumulative},verification_tokens:{previous:tokens(previous,"verification"),current:tokens(next,"verification")},integration_tokens:{previous:tokens(previous,"integration"),current:tokens(next,"integration")}});
  }
  return {scenario:row.name,pairs,token_change:compact(pairs.map(p=>p.token_change)),time_saved:compact(pairs.map(p=>p.time_saved)),planning_ms:{previous:compact(pairs.map(p=>p.planning_ms.previous)),current:compact(pairs.map(p=>p.planning_ms.current))},verification_tokens:{previous:compact(pairs.map(p=>p.verification_tokens.previous)),current:compact(pairs.map(p=>p.verification_tokens.current))},integration_tokens:{previous:compact(pairs.map(p=>p.integration_tokens.previous)),current:compact(pairs.map(p=>p.integration_tokens.current))}};
});
summary.historical_comparison_note="Descriptive comparison of same-round Fast samples which completed and passed all original quality checks in BOTH campaigns, with complete usage. These are different-time observations, not controlled causal attribution. Shared safety changes also affect this campaign's Standard mode.";
summary.generated_at_utc=new Date().toISOString();

const labels={multi_source_retrieval:"多源资料汇总",multi_module_code:"多模块编码",strong_sequential_dependencies:"严格顺序流水线",parallel_analysis:"四路独立并行分析"};
const pct=x=>x==null?"—":`${x>=0?"+":""}${(x*100).toFixed(1)}%`;
const spread=s=>s?`${pct(s.median)} [${pct(s.min)}, ${pct(s.max)}]`:"—";
const num=x=>x==null?"—":x.toLocaleString("en-US");
const seconds=s=>s?`${(s.median/1000).toFixed(2)} [${(s.min/1000).toFixed(2)}, ${(s.max/1000).toFixed(2)}]`:"—";
const qualified=summary.scenarios.flatMap(s=>s.pairs).filter(p=>p.qualified),faster=qualified.filter(p=>p.time_saved_fraction>0).length,lower=qualified.filter(p=>p.token_change_fraction<0).length;
const full=Object.values(summary.mode_totals).reduce((n,s)=>n+s.quality_passed,0),finished=samples.filter(s=>s.success).length;
const lines=["# Token 与复杂 DAG 优化后的三轮真实对照", "",
  ...(archived&&versionOne?["**这是版本 1 的中间试验，不代表当前修正版的性能。** 该活动因 HTTP 402 / Insufficient Balance 自动停止；已发现路径误判和传递依赖证据缺失，修正版的数据另存 fast-efficiency-v2-*，不混用两版样本。", ""]:[]),
  ...(archived&&!versionOne?["**这是已冻结的版本 2 中间试验。** 全部 24 次尝试和失败均保留；后续针对审批中止及恢复规划的修复与真实对照另存 fast-efficiency-v3-*，不混用样本。", ""]:[]),
  `本轮执行 ${samples.length}/${summary.expected_pairs*2} 次新运行；${finished} 次完整结束，${full} 次通过完整验收，形成 ${qualified.length}/${summary.expected_pairs} 对合格性能配对。合格配对中 Fast 更快 ${faster} 对、Token 更少 ${lower} 对。模型 **${raw.model.provider}/${raw.model.name}，${raw.model.intensity}**；上下文 ${num(plan.context_window)}，输出预算 ${num(plan.output_budget)}。原始四个场景、每场景三轮、输入、提示词、外部验收、配额和交替顺序保持不变。`, "",
  "## 本轮 Standard / Fast", "",
  "变化为逐轮百分比的中位数 [最小值, 最大值]。时间节省 `1−Fast/Standard` 为正表示更快；Token 变化 `Fast/Standard−1` 为负表示消耗减少。只使用双方完整完成且全部质量通过的配对；完整 Token 比较还要求所有尝试 usage 完整。", "",
  "| 场景 | 合格对数 | Fast 时间节省 | Fast Token 变化 | 更快 / 更省 Token | 完整验收 Standard / Fast |", "|---|---:|---:|---:|---:|---:|"];
for(const s of summary.scenarios)lines.push(`| ${labels[s.name]} | ${s.qualified_pairs}/3 | ${spread(s.time_saved)} | ${spread(s.token_change)} | ${s.fast_faster_pairs}/${s.qualified_pairs} · ${s.fast_lower_token_pairs}/${s.complete_usage_pairs} | ${s.modes.standard.quality_passed}/3 · ${s.modes.fast_dag.quality_passed}/3 |`);
if(path.basename(stem)==="fast-efficiency-v3"){
  const dag=summary.historical_fast_comparisons.find(s=>s.scenario==="parallel_analysis");
  const change=(next,previous)=>next/previous-1;
  lines.push("", "## 本轮结论与仍未达到的目标", "",
    `Fast 12/12 完成且通过原始完整验收；Standard 9/12，三次中止均为附加负向/确定性测试中的临时文件删除进入人工审批。9 对合格性能配对全部更快，仅 4 对减少 Token。Fast 的复杂 DAG 三轮自身耗时为 96.0–103.0 秒，但只有首轮存在完整合格 Standard 对照；不能据此确认三轮成对提速稳定性。`, "",
    `相对上一轮同场景、同轮次且 Fast 都完整通过的历史观察，复杂 DAG 规划中位 ${seconds(dag.planning_ms.previous)} → ${seconds(dag.planning_ms.current)} 秒，变化 ${pct(change(dag.planning_ms.current.median,dag.planning_ms.previous.median))}；总 Token 配对变化中位 ${pct(dag.token_change.median)}，范围 [${pct(dag.token_change.min)}, ${pct(dag.token_change.max)}]，仍有一轮增加。`, "",
    `复杂 DAG 的独立验证角色 Token 中位 ${num(dag.verification_tokens.previous.median)} → ${num(dag.verification_tokens.current.median)}（${pct(change(dag.verification_tokens.current.median,dag.verification_tokens.previous.median))}），未实现下降；最终整合角色 ${num(dag.integration_tokens.previous.median)} → ${num(dag.integration_tokens.current.median)}（${pct(change(dag.integration_tokens.current.median,dag.integration_tokens.previous.median))}）。相对本轮唯一合格 Standard，Fast 总 Token 仍约两倍。规划缩短和整合节省不能等同于验证成本也下降。`, "",
    "独立检查实际发现并解释了 west 报告中的附加权重枚举错误；最终审查还保留了一个加权汇总校验表达式的真实失败，纠正表达式后重新从原始数据检查通过。所请求三元组和 answer.json 始终正确，记录见 fast-efficiency-v3-quality-observations.json。固定验收通过不等于一般开放任务答案质量等价。", "",
    "目录预检拒绝了两份未执行提议：Fast 汇总的一次父级目录访问，以及 Standard 流水线中包含进入子目录再 cd .. 的脚本。后者属于静态预检的保守拒绝，不能宣称是阻止了真实已发生的越界；Standard 改为显式路径后仍因删除走原人审。完整执行证据中没有识别出已执行的目录违规。", "",
    "本轮仍未证实 50% 端到端缩时目标、跨任务普遍 Token 减少、复杂 DAG 验证 Token 的稳定下降，或开放任务的一般质量等价。", "");
}
lines.push("", "## 全部逐轮数据", "", "未完成耗时是停止前的消耗，不是完成耗时。失败和中止均保留，没有补跑替换。", "", "| 场景 | 轮 | Standard 秒 / Token | Fast 秒 / Token | 质量 Standard / Fast | 合格提速 |", "|---|---:|---:|---:|---|---:|");
for(const s of summary.scenarios){const qrow=quality.scenarios.find(q=>q.name===s.name),r=raw.scenarios.find(r=>r.name===s.name);
  const status=(mode,p)=>{const q=qrow.samples[mode].find(q=>q.round===p.round);return !p.success?"未完成":q?.passed?"通过":"验收失败";};
  for(const p of s.pairs){const a=r.samples.standard.find(s=>s.round===p.round),b=r.samples.fast_dag.find(s=>s.round===p.round);if(!a||!b)continue;
    lines.push(`| ${labels[s.name]} | ${p.round} | ${(a.elapsed_ms/1000).toFixed(2)} / ${num(a.tokens)}${complete(a)?"":" + 未知"} | ${(b.elapsed_ms/1000).toFixed(2)} / ${num(b.tokens)}${complete(b)?"":" + 未知"} | ${status("standard",a)} / ${status("fast_dag",b)} | ${pct(p.time_saved_fraction)} |`);}
}
lines.push("", "## 相对上一轮的 Fast", "", "只比较两个活动中同场景、同轮次且双方 Fast 都完整验收通过、usage 完整的观察。不同时间的网络、缓存和模型采样会影响结果；本表描述历史变化，不把全部差异归因于某个改动。", "", "| 场景 | 可比较轮数 | Fast Token 变化 | Fast 时间节省 | 规划中位秒：旧 → 新 |", "|---|---:|---:|---:|---:|");
for(const s of summary.historical_fast_comparisons)lines.push(`| ${labels[s.scenario]} | ${s.pairs.length}/3 | ${spread(s.token_change)} | ${spread(s.time_saved)} | ${s.planning_ms.previous?(s.planning_ms.previous.median/1000).toFixed(2):"—"} → ${s.planning_ms.current?(s.planning_ms.current.median/1000).toFixed(2):"—"} |`);
lines.push("", "验证和整合列为相同合格 Fast 样本的角色 Token 中位数，独立角色的中位数不能相加成某次总数。规划请求时长可能与已发布任务重叠，不能把角色累计时长直接相加成墙钟耗时。", "", "| 场景 | 独立验证 Token：旧 → 新 | 最终整合 Token：旧 → 新 |", "|---|---:|---:|");
for(const s of summary.historical_fast_comparisons)lines.push(`| ${labels[s.scenario]} | ${num(s.verification_tokens.previous?.median)} → ${num(s.verification_tokens.current?.median)} | ${num(s.integration_tokens.previous?.median)} → ${num(s.integration_tokens.current?.median)} |`);
lines.push("", "## 质量、目录与审批", "",
  `- 主验收（包含独立检查者数量）通过 ${samples.filter(s=>s.fixture_correct).length}/${samples.length}；精确 JSON 数值/结构断言通过 ${quality.scenarios.flatMap(r=>Object.values(r.samples).flat()).filter(s=>s.checks.find(c=>c.name==="exact_answer")?.passed).length}/${samples.length}；完整验收 Standard ${summary.mode_totals.standard.quality_passed}/${summary.mode_totals.standard.attempted}，Fast ${summary.mode_totals.fast_dag.quality_passed}/${summary.mode_totals.fast_dag.attempted}。编码保留原始四条断言、16 组公式输入、导出与模块独立性检查；流水线保留逐个中间文件与因果顺序复核；并行分析保留四个受只读约束的检查者及协调者对全部原始数据和真实报告的 Node 验证。`,
  `- 人工审批中止 ${summary.blocked_samples.length} 次；完整证据复核识别的已执行目录违规 ${summary.scope_failures.length} 次；目录预检拒绝并记录的提议（包括需复核的误判） ${summary.workspace_preflight_denials.length} 次。被拒绝且未执行的提议不会被当作已执行违规，也不自动视为真实越界；仍需后续实际完成所有原始要求才能通过。`,
  `- 未执行的破坏性提议本轮纠正 ${summary.destructive_proposal_corrections.length} 次；发生恢复规划的 Fast 样本 ${summary.planning_failures.length} 个，逐项错误见 summary.planning_failures。必要的人工或自动审批仍走原机制。`,
  "- 共享目录预检和临时脚本执行说明同时适用于 Standard 与 Fast；没有改变审批票数、打开极高风险自动审批或由基准代替用户批准调用。待批参数、原始工具记录和 Fast 产物另存于本活动产物。目录检查覆盖复现的字面路径、引用、Node 程序和符号链接；它不等同于任意动态代码的操作系统沙箱。", "");
if(archived&&versionOne)lines.push("版本 1 的五次目录预检拒绝均为已定位的误判：合法的路径拼接后缀或日志分隔符被当作绝对路径。它们增加了改写和请求开销，不能记为拦住了五次真实越界。修正版离线回放已逐个验证这些调用应放行，同时真正读取根目录仍被拒绝。", "",
  "额外质量观察：north 检查者在一个非请求必需的附加说明中写出 `90*19=171`，正确值是 1710；被请求的 count/units/weighted=10/90/167 均正确。固定夹具与执行协议的通过数不构成一般报告质量等价证明，该错误另存 fast-efficiency-v1-quality-observations.json。", "");
for(const s of summary.blocked_samples)lines.push(`审批中止：${labels[s.scenario]} / ${s.mode} / 第 ${s.round} 轮。待批详情保存在原始结果的 blocked_approval。`);
for(const s of summary.scope_failures)lines.push(`目录违规：${labels[s.scenario]} / ${s.mode} / 第 ${s.round} 轮：${s.check.reason}`);
lines.push("", "## 验证和用量口径", "",
  `运行前完整 npm test 的 84 个测试脚本通过，见 [测试结果](${path.basename(stem)}-test-results.json) 和 [完整日志](${path.basename(stem)}-full-test.log)。活动内 ${summary.frozen_files_verified} 个运行时/提示词/测量文件指纹保持一致；原始夹具 SHA 与上一轮相同。没有在运行中修改算法或为改善成绩重跑。`, "",
  `本活动任务已回报 ${num(summary.reported_task_tokens)} Token，另有 ${summary.unknown_usage_attempts} 次尝试缺失 usage。包含失败样本的 Standard/Fast 已回报总数为 ${num(summary.mode_totals.standard.reported_tokens)} / ${num(summary.mode_totals.fast_dag.reported_tokens)}，不能直接作为等质量成本比。护栏结算 ${num(raw.campaign_usage.settled_tokens_including_unknown_reservations)}，包含连通性探测和未知用量保守预留，不是精确账单。供应商缓存输入仍计入 Token，未换算价格。重试和退避都保留在真实耗时中。`, "",
  `本次工作总护栏为 ${num(summary.work_budget.total_cap)} Token；早期活动护栏结算 ${num(summary.work_budget.previous_guard_settled_tokens)}，加本活动为 ${num(summary.work_budget.total_guard_settled_tokens)}。早期失败和中间试验保存在 ${summary.work_budget.historical_trials.length?summary.work_budget.historical_trials.map(f=>path.basename(f)).join("、"):"本报告列出的原始数据"}，没有并入本活动的合格性能配对。`, "",
  "每场景三轮不足以给出可靠 P95 或证明总体质量等价。所有 12 对合格时才计算等权跨场景几何平均时间比；其余情况下保持 null。主要结论按场景和有效分母报告。", "",
  `复核与数据：${["plan.json","benchmark.json","quality.json","protocol-review.json","summary.json","artifacts/","traces/"].map(file=>"\x60"+path.basename(stem)+"-"+file+"\x60").join("、")}。算法说明见 fast-efficiency-optimization.md。`, "",
  "```sh",`node scripts/audit-fast-live.mjs --input ${stem}-benchmark.json --reviews ${stem}-protocol-review.json --output ${stem}-quality.json`,`node scripts/report-fast-efficiency.mjs --stem ${stem}${archived?" --archived --revision-proof "+proofFile:""}`,"```","");
fs.writeFileSync(stem+"-summary.json",JSON.stringify(summary,null,2)+"\n");fs.writeFileSync(stem+"-comparison.md",lines.join("\n"));
console.log(JSON.stringify({runs:samples.length,finished,quality_passed:full,qualified_pairs:qualified.length,faster,lower_tokens:lower,blocked:summary.blocked_samples.length,scope_violations:summary.scope_failures.length,known_tokens:summary.reported_task_tokens,unknown_usage:summary.unknown_usage_attempts}));
