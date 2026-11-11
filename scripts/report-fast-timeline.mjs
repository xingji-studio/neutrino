import fs from "node:fs";
import { fastDataInput, fastDataOutput } from "./fast-data-paths.mjs";
const data=JSON.parse(fs.readFileSync(fastDataInput("fast-timeline-diagnostics.json"),"utf8"));
const pilot=fs.existsSync(fastDataInput("fast-live-timeline-pilot.json"))?JSON.parse(fs.readFileSync(fastDataInput("fast-live-timeline-pilot.json"),"utf8")):null;
const median=values=>{const v=[...values].sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
const number=x=>Number.isFinite(x)?x.toFixed(2):"未测";
const profile=name=>data.profiles.find(p=>p.name===name);
const med=(p,key)=>p?median(p.samples.map(s=>s[key])):null;
const role=(p,name)=>p?.samples[0]?.analysis?.roles[name]?.logical_requests??0;
const labels={observer_off:"关闭观测",observer_on:"开启观测",batch_reads:"三份资料合并工作节点",split_reads:"三份资料分开工作节点",deduplicate_system:"仅删除重复系统历史副本",history_20000:"继承历史 2 万字符",history_80000:"继承历史 8 万字符",one_model_slot:"推理槽位为 1",reviewed_reads:"自动审批整段串行",concurrent_auto_panels:"仅夹具：并发自动评估",scoped_edits:"局部编辑、全局验证",scoped_verifiers:"仅夹具：限定验证范围",shell_exclusive:"独立 Shell 任务整段独占",known_readonly_commands_parallel:"仅夹具：固定只读命令并行",fanout_1:"1 路只读任务",fanout_2:"2 路只读任务",fanout_4:"4 路只读任务",fanout_8:"8 路只读任务",pipeline_split:"三段文件流水线分开节点",pipeline_batch:"三段文件流水线合并节点",one_format_correction:"注入一次输出格式纠正",one_http_retry:"注入一次 HTTP 重试"};
const samples=data.profiles.flatMap(p=>p.samples),traced=samples.filter(s=>s.analysis);
let text="# 极速模式详细诊断报告\n\n";
text+=`本轮已接入默认关闭的观测，离线活动状态为 \`${data.state}\`，共 ${data.profiles.length} 组条件、每组 ${data.repetitions} 次。离线矩阵的外部网络调用 ${data.external_network_calls} 次，供应商 Token 未测；另有一次受限真实试跑，单独列于后文。本地传输返回的回复和 usage 均由脚本生成，不能作为真实推理速度、费用或答案质量的测量。\n\n`;
text+="所有消融仅作用于夹具实例。生产执行策略、审批人数与判定标准、模型档位及必要检查没有因这些实验而改变。\n\n";
text+="## 观测与完整性\n\n";
text+="启用方式：启动进程时设置 `NEUTRINO_DIAGNOSTICS_DIR=<本地诊断目录>`。每个 TaskRuntime 生成独立 JSONL，默认不开启。日志只含角色、标识、时序、数量、字节数和哈希，不保存请求正文、命令、文件内容、URL 或凭据。\n\n";
text+=`本组 ${traced.filter(s=>s.analysis.valid_for_attribution).length}/${traced.length} 份时间线通过边界、请求/尝试、资源队列与释放、工具和工作区配对校验；每个任务持有访问范围的时间均分成互不重叠的类别并核对总量。丢失事件或日志 I/O 错误的样本不会用于归因。\n\n`;
text+="首个推理事件、首个可见文本、首个工具调用分别记录。首内容前耗时包括服务端排队、网络和推理的混合，不能标成纯网络等待。仅调用工具而无可见文字的响应，其首文字时间为未知。\n\n";
const off=profile("observer_off"),on=profile("observer_on");
text+="| 观测对照（受控本地引擎） | 关闭 | 开启 |\n| --- | ---: | ---: |\n";
for(const[label,key]of[["引擎墙钟中位数，毫秒","engine_elapsed_ms"],["结束及日志冲刷中位数，毫秒","finish_and_trace_flush_ms"],["模型往返","logical_requests"],["实际工具操作","tool_calls"]])text+=`| ${label} | ${number(med(off,key))} | ${number(med(on,key))} |\n`;
text+="\n短小的本地响应会放大观测的相对成本；这里报告原始耗时，不将其外推到真实模型。样本另存最终 enqueue/write 统计，JSONL 的 summary 统计截至生成该 summary 之前，不包含它自身的最后写入。\n\n";
text+="## 单因素对照\n\n| 条件 | 模型往返 / HTTP 尝试 | 实际工具操作 | 累计请求体中位数 KiB | 验证模型 / 审批模型 |\n| --- | ---: | ---: | ---: | ---: |\n";
for(const p of data.profiles)text+=`| ${labels[p.name]??p.name} | ${p.samples[0].logical_requests} / ${p.samples[0].transport_calls} | ${p.samples[0].tool_calls} | ${number(med(p,"wire_payload_bytes")/1024)} | ${p.samples[0].analysis?`${role(p,"verification")} / ${role(p,"approval")}`:"未采集"} |\n`;
const base=profile("split_reads"),dedup=profile("deduplicate_system");
text+=`\n仅移除历史里的重复系统副本，三节点夹具的请求体中位数减少 ${number((1-med(dedup,"wire_payload_bytes")/med(base,"wire_payload_bytes"))*100)}%。模型往返和工具操作保持相同。这是输入装配成本的减少，不是已经测得的模型提速或质量结论。\n\n`;
text+="顺序流水线两种方案都执行 9 次读取、3 次写入，并独立检查三个已保存的输入/输出关系；模型往返从 17 次变为 11 次。输出格式纠正另增加 1 次逻辑请求而不增加文件操作；HTTP 重试则增加实际尝试，不增加逻辑轮次。\n\n";
text+="## 资源等待与任务推进\n\n| 夹具 | 模型队列累计毫秒 | 审批队列累计毫秒 | 可观察的任务准入门控链（一份样本） |\n| --- | ---: | ---: | --- |\n";
for(const name of["one_model_slot","reviewed_reads","concurrent_auto_panels","scoped_edits","scoped_verifiers","shell_exclusive","known_readonly_commands_parallel"]){const p=profile(name);if(!p)continue;const a=p.samples[0].analysis;text+=`| ${labels[name]} | ${number(a.resource_waits.model?.wait_ms_cumulative??0)} | ${number(a.resource_waits.approval?.wait_ms_cumulative??0)} | ${(a.observed_task_admission_chain||[]).join(" → ")} |\n`;}
text+="\n队列累计时间可能重叠，不能相加后从墙钟时间扣除。准入门控链只重建显式工作区阻塞和业务/验证依赖；模型或审批的内部排队留在各任务的持有时间分组内。这不是完整的供应商计算关键路径。\n\n";
text+="并发自动评估保持每次两名独立评估者，减少审批队列等待后会增加模型池竞争，所以不能只看某一个队列的下降。限定验证范围的夹具验证了局部节点可以更早推进，但不能证明任意项目测试都适用该范围。固定命令并行实验仅使用已审阅、只读的夹具脚本和各自目录；没有实现或启用生产环境任意命令的可靠隔离。\n\n";
text+="每个实际读取按资源哈希与结果哈希分组，并记录执行/验证角色。同一结果读两次可能是必要独立检查，重复计数本身不等于浪费；还需要结合验收覆盖判断。\n\n";
text+="## 真实模型试跑\n\n";
if(!pilot)text+="本报告生成时尚无本轮真实模型试跑记录；不据离线定时器计算模型加速率。\n\n";
else{
  text+=`活动状态：\`${pilot.state}\`。模型 \`${pilot.model?.provider}/${pilot.model?.name}\`，档位 \`${pilot.model?.intensity}\`；诊断总 Token 预算 ${pilot.campaign_token_cap??"未设置"}。原任务自身的模型和推理配置保持原值；诊断预算不足会中止并记为未完成，不作为提速成绩。\n\n`;
  if(pilot.external_blocker)text+=`供应商连通检查返回 ${pilot.external_blocker.code}（${pilot.external_blocker.reason}），未完成本轮配对；剩余性能归因仍需账户可调用后补齐。\n\n`;
  if(pilot.campaign_usage?.stopped)text+="诊断总额度触发，后续请求已在发出前阻止。未完成样本不用于速度对比。未知 usage 按保守预留量计入诊断预算，该数值不等于精确账单。\n\n";
  const known=(pilot.connectivity?.input_tokens??0)+(pilot.connectivity?.output_tokens??0)+(pilot.scenarios??[]).flatMap(r=>Object.values(r.samples).flat()).reduce((n,s)=>n+s.tokens,0);
  if(pilot.campaign_usage)text+=`本次接口已报告 ${known} Token；含未知用量的保守预算占用为 ${pilot.campaign_usage.settled_tokens_including_unknown_reservations} Token，当前未结算预留为 ${pilot.campaign_usage.held_tokens}。其差额保留为未知用量预算，不当成零费用，也不当成精确计费。\n\n`;
  const configurationHashes=new Set();
  for(const row of pilot.scenarios??[])for(const ss of Object.values(row.samples))for(const s of ss)if(s.trace_file&&fs.existsSync(s.trace_file))for(const line of fs.readFileSync(s.trace_file,"utf8").trim().split("\n")){const e=JSON.parse(line);if(e.event==="model_configuration")configurationHashes.add(e.data.model_config_hash);}
  if(configurationHashes.size===1)text+="两种模式的任务请求使用相同模型配置指纹；下列日志还可逐请求核对输出预算。\n\n";
  for(const row of pilot.scenarios??[]){
    text+=`场景：\`${row.name}\`。\n\n| 模式 | 观察墙钟秒 | Token（已报告） | 验收 / 独立产物断言 | 时间线可归因 |\n| --- | ---: | ---: | --- | --- |\n`;
    for(const mode of["standard","fast_dag"])for(const s of row.samples?.[mode]??[])text+=`| ${mode} | ${number(s.elapsed_ms/1000)} | ${s.tokens} | ${s.success} / ${s.fixture_correct} | ${s.trace_analysis?.valid_for_attribution??"未采集"} |\n`;
    text+="\n";
    for(const mode of["standard","fast_dag"]){
      const s=row.samples?.[mode]?.[0];if(!s?.trace_analysis)continue;
      const a=s.trace_analysis;
      const raw=fs.readFileSync(s.trace_file,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const configs=raw.filter(e=>e.event==="model_configuration").map(e=>e.data);
      let active=0,peak=0;for(const e of raw){if(e.event==="provider_dispatch"){active++;peak=Math.max(peak,active);}if(e.event==="provider_attempt_end")active--;}
      text+=`\`${mode}\` 实际 HTTP 并发峰值 ${peak}；任务日志中的输出上限为 ${[...new Set(configs.map(c=>c.output_budget))].join(", ")} Token。\n\n`;
      text+=`\`${mode}\` 模型请求角色（Token 仅为已报告用量）：\n\n| 角色 | 逻辑请求 | 实际 HTTP 尝试 | 输入 Token | 输出 Token | 接口报告缓存输入 Token | 缓存字段覆盖次数 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
      for(const[name,r]of Object.entries(a.roles))text+=`| ${name} | ${r.logical_requests} | ${r.provider_attempts} | ${r.reported_input_tokens} | ${r.reported_output_tokens} | ${r.reported_cached_input_tokens??"未知"} | ${r.cached_usage_attempts??0} |\n`;
      text+=`\n诊断结束等待 ${number(s.diagnostic_drain_ms)} 毫秒。完整元数据中的任务墙钟为 ${number(a.wall_ms/1000)} 秒；失败行仍不是完成时间。缓存数量来自原接口字段，不直接换算账单或推理耗时。\n\n`;
      if(s.initial_capture_issues)text+="本次初始摘要在取消收尾前采样，曾误报日志缺少结束事件。原始初始报告已保存为 `fast-live-timeline-pilot-at-capture.json`；当前分析由最终完整 JSONL 重算，原采样时间、Token 和成败标志没有改写。基准脚本已修复为等待 TaskRuntime.finish 再等待诊断冲刷，本地取消/预算夹具验证通过，没有重复付费请求。\n\n";
      if(mode==="fast_dag"){
        const modelWait=a.resource_waits.model?.wait_ms_cumulative??0,approvalWait=a.resource_waits.approval?.wait_ms_cumulative??0;
        text+=`真实 Fast 模型队列累计等待 ${number(modelWait)} 毫秒，审批队列累计等待 ${number(approvalWait)} 毫秒。因此这一个真实样本没有支持“队列等待是主要慢因”，不能据离线并发实验直接推荐增加槽位。\n\n`;
        const tasks=a.task_intervals.filter(t=>Number.isFinite(t.end_ms)).sort((x,y)=>x.start_ms-y.start_ms);
        text+="| Fast 任务 | 持有工作区秒 | 模型请求进行中秒（执行/验证） | 审批模型进行中秒（重叠只算一次） | 工具执行秒 |\n| --- | ---: | ---: | ---: | ---: |\n";
        for(const t of tasks){const b=t.hold_buckets_ms??{};text+=`| ${t.task_id} | ${number(t.lease_hold_ms/1000)} | ${number(((b.worker_model??0)+(b.verification_model??0))/1000)} | ${number((b.approval_model??0)/1000)} | ${number((b.tool_execution??0)/1000)} |\n`;}
        text+="\n模型进行中时间包含网络、服务端排队和生成，不等于纯推理时间。观察到的准入链为 `"+(a.observed_task_admission_chain??[]).join(" → ")+"`。后一个验证工作节点又带独立验证，确实形成了更多串行模型工作；现有隐私日志不保留验收正文，不能仅凭节点名字认定每项检查都可删除。\n\n";
      }
    }
  }
  text+="一次配对只能用于诊断，不报告可靠 P95，也不推断一般任务的 50% 目标已经达到。失败、人工审批阻塞和预算中止均保留在原始 JSON 中。\n\n";
}
text+="## 后续修改依据与未完成事项\n\n1. 优先明确验收覆盖并减少串行验证层级：真实试跑已出现额外验证工作节点再被验证的链条。应消除职责重叠，保留全部必要独立检查和全局审查。\n2. 清理重复系统历史、减少不必要上下文装配。供应商本次确有缓存命中，输入体积下降不等于相同比例的延迟或费用下降，实际收益仍需验证。\n3. 按验证清单限定访问范围、区分人工审批呈现和自动评估调度。离线已证明潜在收益，但这次真实样本的模型与审批队列几乎无等待，不能将其列为该样本的主要瓶颈。\n4. 生产算法尚未应用本轮实验性改动。完整真实配对、不同负载的稳定分布、P95 和人工质量评审仍未完成；不能声明实现了 50% 提速。\n\n";
text+=`离线配置与完整原始时间线索引：\`fast-timeline-diagnostics.json\`；活动标识 \`${data.campaign_id}\`；捕获构建指纹 \`${data.source_hash}\`。`;
if(data.analysis_revision)text+=`最终日志重分析指纹 \`${data.analysis_revision.analyzer_hash}\`，分析复用了既有日志，没有重放请求。`;
text+="运行 `npm run diagnose:fast:timeline` 复现离线实验，`npm run test:fast:diagnostics` 检查观测和预算护栏。\n";
fs.writeFileSync(fastDataOutput("fast-timeline-diagnosis.md"),text);
console.log(`Wrote detailed diagnosis: profiles=${data.profiles.length}, traces=${traced.length}, pilot=${pilot?.state??"not_run"}`);
