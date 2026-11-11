// Regenerate the campaign summary from saved evidence; never calls a model.
import assert from "node:assert/strict";
import fs from "node:fs";
import { fastDataInput, relocateFastCaptures } from "./fast-data-paths.mjs";
import path from "node:path";
import {createHash} from "node:crypto";
import {summarizeStability} from "./fast-stability-analysis.mjs";

const argument=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
const input=argument("--input"),qualityFile=argument("--quality"),planFile=argument("--plan"),output=argument("--output"),markdown=argument("--markdown");
assert.ok(input&&qualityFile&&planFile&&output&&markdown,"Use --input, --quality, --plan, --output and --markdown");
const read=file=>JSON.parse(fs.readFileSync(file,"utf8"));
const raw=relocateFastCaptures(read(input)),quality=read(qualityFile),plan=read(planFile);
assert.equal(raw.state,"completed");assert.equal(raw.benchmark_id,quality.benchmark_id);assert.equal(quality.pending_manual_checks,0);
assert.equal(raw.model.provider,plan.provider);assert.equal(raw.model.name,plan.model);assert.equal(raw.model.intensity,plan.intensity);
const summary=summarizeStability(raw,quality),all=raw.scenarios.flatMap(row=>Object.entries(row.samples).flatMap(([mode,samples])=>samples.map(s=>({scenario:row.name,mode,...s}))));
assert.equal(all.length,summary.expected_pairs*2);
const hash=file=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const changed=Object.entries(raw.revision_sha256).filter(([file,sha])=>hash(file)!==sha).map(([file])=>file);
assert.deepEqual(changed,[],"Frozen campaign runtime or measurement harness changed");
const engineHash=createHash("sha256").update(["engine","scheduler","worker","pool","artifacts","types","planner"].map(name=>fs.readFileSync(`dist/fast/${name}.js`,"utf8")).join("\n")).digest("hex");
assert.equal(engineHash,raw.engine_sha256,"Combined Fast engine fingerprint changed");
const median=values=>{const a=[...values].sort((x,y)=>x-y);return a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2;};
const modeTotals=Object.fromEntries(["standard","fast_dag"].map(mode=>{
  const rows=all.filter(s=>s.mode===mode),audits=quality.scenarios.flatMap(s=>s.samples[mode]);
  return [mode,{runs:rows.length,completed:rows.filter(s=>s.success).length,primary_oracle_passed:rows.filter(s=>s.fixture_correct).length,quality_passed:audits.filter(s=>s.passed).length,input_tokens:rows.reduce((n,s)=>n+s.input_tokens,0),output_tokens:rows.reduce((n,s)=>n+s.output_tokens,0),reported_tokens:rows.reduce((n,s)=>n+s.tokens,0)}];
}));
const blocked=all.filter(s=>s.blocked_on_approval).map(s=>({scenario:s.scenario,mode:s.mode,round:s.round}));
const scopeViolations=quality.scenarios.flatMap(row=>Object.entries(row.samples).flatMap(([mode,samples])=>samples.flatMap(s=>s.manual_checks.filter(c=>c.name==="fixture_only_scope"&&c.status==="failed").map(check=>({scenario:row.name,mode,round:s.round,...check})))));
const orders=new Map();for(const item of raw.execution_order){const key=item.scenario+":"+item.round;if(!orders.has(key))orders.set(key,item.mode);}
const roleMedians=raw.scenarios.map(row=>({scenario:row.name,modes:Object.fromEntries(Object.entries(row.samples).map(([mode,samples])=>{
  const roles=[...new Set(samples.flatMap(s=>Object.keys(s.trace_analysis.roles)))];
  return [mode,Object.fromEntries(roles.map(role=>[role,{request_ms_cumulative:median(samples.map(s=>s.trace_analysis.roles[role]?.request_ms_cumulative??0)),reported_tokens:median(samples.map(s=>(s.trace_analysis.roles[role]?.reported_input_tokens??0)+(s.trace_analysis.roles[role]?.reported_output_tokens??0))),reported_output_tokens:median(samples.map(s=>s.trace_analysis.roles[role]?.reported_output_tokens??0))}]))];
}))}));
Object.assign(summary,{generated_at_utc:new Date().toISOString(),model:raw.model,output_budget:plan.output_budget,conditions:raw.conditions,mode_totals:modeTotals,
  quality:{pending_manual_checks:quality.pending_manual_checks,primary_oracle_passed:all.filter(s=>s.fixture_correct).length,completed:all.filter(s=>s.success).length,full_quality_passed:Object.values(modeTotals).reduce((n,s)=>n+s.quality_passed,0),blocked_on_approval:blocked,fixture_scope_violations:scopeViolations},
  integrity:{frozen_campaign_files_verified:Object.keys(raw.revision_sha256).length,combined_fast_engine_sha256_verified:engineHash,changed_campaign_files:changed,valid_attribution_traces:all.filter(s=>s.trace_analysis.valid_for_attribution).length,standard_first_pairs:[...orders.values()].filter(x=>x==="standard").length,fast_first_pairs:[...orders.values()].filter(x=>x==="fast_dag").length,post_run_audit_source_changes:Object.entries(plan.source_files_sha256).filter(([file,sha])=>hash(file)!==sha).map(([file])=>file),note:"Runtime and in-campaign harness are unchanged. Post-run source edits only bind protocol reviews to evidence and format statistics; they were made after all 24 real runs finished."},
  campaign_usage:raw.campaign_usage,role_medians:roleMedians,role_medians_note:"All three observations, including incomplete samples. Request durations can overlap; cumulative role time is not a wall-clock decomposition. Separate role medians are not additive.",
  sources:{raw:path.resolve(input),quality:path.resolve(qualityFile),plan:path.resolve(planFile)}});

const labels={multi_source_retrieval:"多源资料汇总",multi_module_code:"多模块编码",strong_sequential_dependencies:"严格顺序流水线",parallel_analysis:"四路独立并行分析"};
const pct=n=>(n>=0?"+":"")+(n*100).toFixed(1)+"%";
const spread=(s,scale=1)=>s?`${(s.median/scale).toFixed(2)} [${(s.min/scale).toFixed(2)}, ${(s.max/scale).toFixed(2)}]`:"—";
const changes=s=>s?`${pct(s.median)} [${pct(s.min)}, ${pct(s.max)}]`:"—";
const amount=n=>n.toLocaleString("en-US");
const qualityStatus=(s,q)=>!s.success?"审批中止":q.passed?"通过":"目录范围违规";
const lines=["# Fast Mode 多场景三轮真实对照", "",
  "结论：本轮没有确认 Fast 在不同任务上普遍、稳定提速或减少 Token。编码三轮均更快，但优势波动大；资料汇总未稳定提速；严格顺序和并行分析各仅一对满足完整验收，无法判断三轮稳定性。8 对完整合格配对中，7 对 Fast 的已回报 Token 更多。", "",
  `模型为 **${raw.model.provider}/${raw.model.name}，${raw.model.intensity}**；输出预算 ${amount(plan.output_budget)}。四个现有受控夹具，每个场景三轮 Standard/Fast，共 24 次全新真实模型运行。模型、思考档位、任务原始提示词、外部验收和共享配额保持一致；顺序各六对 Standard/Fast 先执行。运行时代码、提示词及活动内测量脚本的 ${Object.keys(raw.revision_sha256).length} 个指纹仍匹配。`, "",
  "## 合格配对结果", "",
  "时间列为 `1 − Fast/Standard`，正数表示提速；Token 列为 `Fast/Standard − 1`，正数表示消耗增加。均为逐对百分比的中位数 [最小值, 最大值]，不是两侧中位数的比值。合格要求双方完成、全部验收通过；Token 比较还要求 usage 完整。", "",
  "| 场景 | 合格对数 | Fast 时间节省 | Fast Token 变化 | 更快 / 更省 Token | 完整质量 Standard / Fast |",
  "|---|---:|---:|---:|---:|---:|"];
for(const row of summary.scenarios)lines.push(`| ${labels[row.name]} | ${row.qualified_pairs}/3 | ${changes(row.time_saved)} | ${changes(row.token_change)} | ${row.fast_faster_pairs}/${row.qualified_pairs} · ${row.fast_lower_token_pairs}/${row.complete_usage_pairs} | ${row.modes.standard.quality_passed}/3 · ${row.modes.fast_dag.quality_passed}/3 |`);
lines.push("", "编码配对的提速为 1.2%、35.8%、3.2%，其中最小优势约 0.51 秒；仅第二轮减少 Token。资料汇总唯一更快的一轮只快约 0.087 秒（0.21%），不足以认定有实际稳定优势。顺序流水线仅第三轮合格，Fast 慢 7.9%；并行分析仅第二轮合格，Fast 快 14.8%，Token 增加 78.7%。", "",
  "## 全部逐轮结果", "",
  "中止样本的秒数表示中止前已消耗时间，不能当作完成耗时。未合格的配对不计算提速，不补跑替换。", "",
  "| 场景 | 轮次 | Standard 秒 / Token | Fast 秒 / Token | 质量 Standard / Fast | 合格提速 |",
  "|---|---:|---:|---:|---|---:|");
for(const row of summary.scenarios){
  const source=raw.scenarios.find(s=>s.name===row.name),audited=quality.scenarios.find(s=>s.name===row.name);
  for(const pair of row.pairs){
    const a=source.samples.standard.find(s=>s.round===pair.round),b=source.samples.fast_dag.find(s=>s.round===pair.round),qa=audited.samples.standard.find(s=>s.round===pair.round),qb=audited.samples.fast_dag.find(s=>s.round===pair.round);
    const usageComplete=s=>s.trace_analysis.provider_attempts.every(t=>t.input_tokens!=null&&t.output_tokens!=null);
    lines.push(`| ${labels[row.name]} | ${pair.round} | ${(a.elapsed_ms/1000).toFixed(2)} / ${amount(a.tokens)}${usageComplete(a)?"":" + 未知"} | ${(b.elapsed_ms/1000).toFixed(2)} / ${amount(b.tokens)}${usageComplete(b)?"":" + 未知"} | ${qualityStatus(a,qa)} / ${qualityStatus(b,qb)} | ${pair.qualified?pct(pair.time_saved_fraction):"—"} |`);
  }
}
lines.push("", "## 三轮观测的分布", "", "下表保留全部三次观测，包含审批中止或范围违规样本，仅用于描述原始分布。范围为 [最小值, 最大值]，不能把这些中位数直接作为完整任务的提速结论。均值、样本标准差和原始耗时/Token 的变异系数另存于 summary JSON。", "",
  "| 场景 | 模式 | 耗时中位数 [范围]，秒 | Token 中位数 [范围] |", "|---|---|---:|---:|");
for(const row of summary.scenarios)for(const [mode,s]of Object.entries(row.modes))lines.push(`| ${labels[row.name]} | ${mode==="standard"?"Standard":"Fast"} | ${spread(s.elapsed_ms,1000)} | ${spread(s.reported_tokens)} |`);
lines.push("", "## 质量与异常", "",
  `- 精确结果与各场景数值断言：24/24；任务完整结束：${summary.quality.completed}/24；包含执行协议和目录范围的完整质量：${summary.quality.full_quality_passed}/24（Standard 9/12，Fast 11/12）。18 份执行协议复核记录均已绑定工具证据 SHA-256 与工具 ID，无 pending。编码的原始四条断言和额外 16 组公式输入在两侧各三轮全部通过。`,
  "- 审批中止：顺序流水线 Fast 第 1 轮、Standard 第 2 轮，以及并行分析 Standard 第 3 轮。均已产出正确数值，但运行未完成。证据中的 blocked_on_approval 为 true；不据此推定具体被拦截命令或将其归因于某次目录违规。",
  "- 目录范围违规：顺序流水线 Fast 第 1 轮创建四个 `/tmp/*.js`；并行分析 Standard 第 1 轮创建 `/tmp/verify_step5.js`。均违反原有“仅在夹具目录工作”的要求。另一次 `/tmp/validate_step7.js` 写入被拒绝，未当作成功写入。五个已写出的脚本已按记录内容逐字核对、归档并清理，记录见 `fast-stability-cleanup.json`。",
  "- 并行分析的六次运行均有四个实际受只读策略约束的独立检查者，协调者 Node 重算并对照实际报告后整合；最终仍按任务完成和目录限制独立判定质量。不能仅凭正确 JSON 自动判为完整通过。",
  "- 并行分析 Standard 第 1 轮有一次审批模型流式请求重试，HTTP 头为 200，usage 未报告；保留真实耗时和退避。该配对同时因目录范围违规不合格。三次 Fast 并行运行各有一次 AbortSignal 的 MaxListenersExceededWarning，已保留于 `fast-stability-runtime-warnings.json`；现有证据不能确认是持续性内存泄漏。", "",
  "## Token 口径与开销线索", "",
  `任务已回报 Token 合计 **${amount(summary.reported_task_tokens)}**，另有 ${summary.unknown_usage_attempts} 次尝试缺失 usage。Standard 已回报 ${amount(modeTotals.standard.reported_tokens)}，Fast ${amount(modeTotals.fast_dag.reported_tokens)}，均含中止/不合格样本，因此不把两个总数的差直接视为等质量成本差。总活动护栏结算 ${amount(raw.campaign_usage.settled_tokens_including_unknown_reservations)}（含未知用量保守预留及 75 Token 连通性探测），低于 8,000,000 上限；该护栏数不是精确账单。Token 为供应商回报 input+output，缓存输入仍计入 Token，未按缓存价格折算费用。`, "",
  "规划请求耗时中位数（秒，三次原始观测）：", "", "| 场景 | Standard | Fast |", "|---|---:|---:|");
for(const row of roleMedians)lines.push(`| ${labels[row.scenario]} | ${(row.modes.standard.planning.request_ms_cumulative/1000).toFixed(2)} | ${(row.modes.fast_dag.planning.request_ms_cumulative/1000).toFixed(2)} |`);
lines.push("", "前三类 Fast 使用单节点规划时规划明显缩短，但随后仍承担工作、独立验证、最终整合和审批用量；资料汇总的总 Token 仍三轮增加。并行场景保留四个独立检查者，Fast 的 DAG 规划输出为 5,344–5,801 Token，规划中位耗时 38.60 秒，验证与整合也有较高用量。角色明细支持后续排查方向，尚不能当作某个算法改动的因果证明；并发角色的累计请求时长不能直接相加成端到端耗时。", "",
  "## 适用边界与复核", "",
  "三轮只能展示受控夹具中的方向和波动，不能给出可靠 P95、总体稳定性或大型真实项目质量等价结论。完整合格配对只有 8/12，按预先约定不输出跨场景几何平均提速。不合格样本全部保留；本轮未修改运行时算法、模型、思考强度或验收要求，也未为改善成绩补跑。", "",
  "本轮 build、预算护栏回归及新增测量/验收回归已通过；最终复核命令因真实不合格样本返回 1，这是结果状态。此前规划优化的 82 脚本全量测试属于上一轮，本轮未声称执行新的 83 脚本全量测试。活动结束后才补充证据哈希绑定与统计展示代码；活动内运行时及测量脚本指纹保持一致。", "",
  "无需模型调用的复核命令：", "", "```sh",
  "node scripts/test-fast-stability.mjs",
  `node scripts/audit-fast-live.mjs --input ${input} --reviews ${fastDataInput("fast-stability-protocol-review.json")} --output ${qualityFile}`,
  `node scripts/report-fast-stability.mjs --input ${input} --quality ${qualityFile} --plan ${planFile} --output ${output} --markdown ${markdown}`,
  "```", "",
  "原始结果：`fast-stability-benchmark.json`；完整质量：`fast-stability-quality.json`；协议证据复核：`fast-stability-protocol-review.json`；统计：`fast-stability-summary.json`；前置约定：`fast-stability-plan.json`、`fast-stability-method.md`；各轮原始时间线及产物：`fast-stability-traces/`、`fast-stability-artifacts/`。", "");
for(const [file,body]of [[output,JSON.stringify(summary,null,2)+"\n"],[markdown,lines.join("\n")]]){fs.mkdirSync(path.dirname(path.resolve(file)),{recursive:true});fs.writeFileSync(file,body);}
console.log(JSON.stringify({runs:all.length,qualified_pairs:summary.qualified_pairs,full_quality_passed:summary.quality.full_quality_passed,reported_task_tokens:summary.reported_task_tokens,unknown_usage_attempts:summary.unknown_usage_attempts,output,markdown}));
