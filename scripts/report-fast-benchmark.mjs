import fs from "node:fs";
import { createHash } from "node:crypto";
const live = JSON.parse(fs.readFileSync("docs/fast-live-benchmark.json", "utf8"));
const fixture = JSON.parse(fs.readFileSync("docs/fast-scheduling-benchmark.json", "utf8"));
const capturedMetrics = fs.existsSync("docs/fast-live-metrics.json")
  ? JSON.parse(fs.readFileSync("docs/fast-live-metrics.json", "utf8")) : null;
const names = { multi_source_retrieval: "多来源资料检索", multi_dimension_comparison: "多维度比较", complex_logic: "逻辑推理",
  multi_module_code: "多模块代码", multi_agent_collaboration: "多智能体协作", long_tool_sequence: "长步骤工具调用",
  iterative_correction: "反复纠错", strong_sequential_dependencies: "强顺序依赖", parallel_analysis: "四路并行资料分析" };
const number = value => Number.isFinite(value) ? value.toFixed(2) : "未测";
const pct = value => Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "不适用";
const samples = (row, mode) => row.samples?.[mode] || [];
const sum = (values, key) => values.reduce((total, value) => total + (value[key] || 0), 0);
const allStandard = live.scenarios.flatMap(row => samples(row, "standard"));
const allFast = live.scenarios.flatMap(row => samples(row, "fast_dag"));
const missingUsage = sum(allStandard, "missing_usage_requests") + sum(allFast, "missing_usage_requests");
const measuredTokens = values => !values.length || (!sum(values, "tokens") && sum(values, "missing_usage_requests"))
  ? "未测" : sum(values, "tokens") + (sum(values, "missing_usage_requests") ? "（已知部分）" : "");
const success = values => values.length ? `${values.filter(v => v.success).length}/${values.length}` : "未测";
const correct = values => values.length ? `${values.filter(v => v.fixture_correct).length}/${values.length}` : "未测";
const valid = live.scenarios.filter(row => row.valid_successful_comparison);
const complete = live.state === "completed" && live.scenarios.length >= 8;
const standardTime = valid.reduce((n, row) => n + row.standard.mean_ms, 0);
const fastTime = valid.reduce((n, row) => n + row.fast_dag.mean_ms, 0);
const saving = standardTime ? 1 - fastTime / standardTime : null;
let text = `# 极速模式性能与验证报告\n\n`;
text += `本报告由机器可读实测结果生成。真实模型活动状态：\`${live.state}\`。`;
text += `模型：\`${live.model?.provider || "未测"}/${live.model?.name || "未测"}\`，推理档位：\`${live.model?.intensity || "未测"}\`。两种模式使用同一模型配置、任务要求、必要检查及账户配额。\n\n`;
text += `**50% 端到端缩时目标：${complete && valid.length === live.scenarios.length && saving >= 0.5 ? "本组受控样本达到，尚不能推广到所有复杂任务" : "尚未证实达到"}。** `;
text += valid.length ? `有效成功对照 ${valid.length} 类，合计时间节省 ${pct(saving)}（负值表示变慢）。\n\n` : "尚无两种模式均成功验收的有效对照，不能计算加速率。\n\n";
text += "每类每模式仅运行 " + live.repetitions + " 次；单样本均值与中位数相同。P95 需要更多重复样本，本次标记为未测。失败、中断或等待审批而未完成的样本不能用于宣称加速。\n\n";
if (live.standard_baseline) text += "部分 Standard 数据复用已完成的基线，以避免重复付费调用。复用前校验了相同模型/档位、原始测试输入、30 个相关编译模块与四份原提示词的指纹；原样本均在旧时限内成功完成。原始出处及校验信息保存在 JSON 的 standard_baseline/reused_from 字段中。旧构建的 Fast 失败样本另存 fast-live-before-scope-fix.json，没有被伪装成成功或抹去。\n\n";
if (live.external_blocker) text += "**外部阻塞：供应商返回 HTTP 402 / Insufficient Balance（余额不足）。** 前七类已完成有效对照；强顺序依赖任务的 Fast 在执行中中断，补充四路分析没有完成对照。没有充值、换模型或降低推理档位来绕过此限制。失败行的时间是截至中断的经历时间，并非任务完成时间。\n\n";
text += "真实调用使用生产默认的 30 分钟时限。第九类是补充的明确可并行负载：四路受限只读资料检查，协调者用 Node 独立重算并验证全部原始资料；同一要求应用于两种模式。前八类是小型受控任务，并不代表大型开放任务。单次顺序调用与复用基线也会受到服务延迟变化影响，不能替代随机化重复实验。\n\n";
text += "## 真实模型对照\n\n| 任务 | Standard 秒 | Fast 秒 | 时间节省 | Standard Token | Fast Token | Fast 验收/产物正确 |\n| --- | ---: | ---: | ---: | ---: | ---: | --- |\n";
for (const row of live.scenarios) {
  const fast = samples(row, "fast_dag"), standard = samples(row, "standard");
  text += `| ${names[row.name] || row.name} | ${number(row.standard?.mean_ms / 1000)} | ${number(row.fast_dag?.mean_ms / 1000)} | ${pct(row.time_saved_fraction)} | ${measuredTokens(standard)} | ${measuredTokens(fast)} | ${success(fast)} / ${correct(fast)} |\n`;
}
text += "\nToken 是供应商返回的输入与输出总和，包含规划、执行、验证、整合和自动审批模型。多个 Worker 并行不会减少已消费的 Token。若供应商缺少 usage，原始样本的 `missing_usage_requests` 会明确记录，不能将未知费用当作零。\n\n";
if (missingUsage) text += `本组有 ${missingUsage} 个失败请求未返回 usage。以下用量仅汇总供应商已报告的部分，不代表完整费用；未完成与账户错误也不能作为模型答案质量下降的证据。\n\n`;
text += "## Token、吞吐与质量\n\n| 指标 | Standard | Fast |\n| --- | ---: | ---: |\n";
for (const [label, key] of [["输入 Token", "input_tokens"], ["输出 Token", "output_tokens"], ["总 Token", "tokens"], ["重试次数", "retries"]]) text += `| ${label} | ${sum(allStandard, key)} | ${sum(allFast, key)} |\n`;
text += `| 输入+输出 Token / 秒（合计量 / 合计墙钟时间） | ${number(sum(allStandard, "tokens") * 1000 / sum(allStandard, "elapsed_ms"))} | ${number(sum(allFast, "tokens") * 1000 / sum(allFast, "elapsed_ms"))} |\n`;
text += `| 引擎成功验收 | ${success(allStandard)} | ${success(allFast)} |\n| 独立产物断言正确 | ${correct(allStandard)} | ${correct(allFast)} |\n`;
if (allStandard.length === allFast.length && allStandard.length) text += `\n总 Token 变化：${pct(sum(allFast, "tokens") / sum(allStandard, "tokens") - 1)}。`;
text += "\n自动产物断言只覆盖受控数据和代码测试，不等同于开放式答案的人工质量评审。\n\n";
if (valid.length) {
  const a = valid.flatMap(row => samples(row, "standard")), b = valid.flatMap(row => samples(row, "fast_dag"));
  text += `仅对两种模式都成功验收的 ${valid.length} 类，Token 总量为 Standard ${sum(a, "tokens")}、Fast ${sum(b, "tokens")}，变化 ${pct(sum(b, "tokens") / sum(a, "tokens") - 1)}；吞吐量变化 ${pct((sum(b, "tokens") / sum(b, "elapsed_ms")) / (sum(a, "tokens") / sum(a, "elapsed_ms")) - 1)}。\n\n`;
}
text += "重试次数统计 HTTP 和调度器自动重试；模型自行纠错发起的新工具调用计入工具与模型请求总数。\n\n";
text += "## Fast 阶段与 Worker Token\n\n| 任务 | 规划 Token | 执行 Worker Token | 独立验证 Token | 最终主智能体 Token | 本地缓存命中 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n";
const tokenCount = usage => usage.prompt + usage.completion;
const workerRows = [];
for (const row of live.scenarios) {
  const metrics = samples(row, "fast_dag").map((sample, index) => {
    const captured = capturedMetrics?.benchmark_id === live.benchmark_id
      ? capturedMetrics.samples[`${row.name}:${index}`] : null;
    const value = sample.fast_metrics || captured?.metrics;
    // An in-flight capture must never be presented as the final cost.
    return value && tokenCount(value.total) === sample.tokens ? value : null;
  });
  if (!metrics.length || metrics.some(value => !value)) {
    text += `| ${names[row.name] || row.name} | 未测 | 未测 | 未测 | 未测 | 未测 |\n`; continue;
  }
  const role = key => metrics.reduce((total, value) => total + tokenCount(value[key]), 0);
  const workers = metrics.reduce((total, value) => total + Object.values(value.workers).reduce((n, usage) => n + tokenCount(usage), 0), 0);
  text += `| ${names[row.name] || row.name} | ${role("planning")} | ${workers} | ${role("verification")} | ${role("integration")} | ${sum(metrics, "context_cache_hits")} |\n`;
  metrics.forEach((value, index) => Object.entries(value.workers).forEach(([id, usage]) => {
    workerRows.push(`| ${names[row.name] || row.name} / ${index + 1} | ${id} | ${usage.prompt} | ${usage.completion} | ${usage.requests} |`);
  }));
}
text += "\n阶段成本取自相同运行的持久化指标，只有总量与真实请求用量完全吻合时才纳入。独立验证列包含原有自动审批模型的成本；最终主智能体对应 integration 指标。本地缓存命中不表示供应商减少计费。\n\n";
if (workerRows.length) text += "| 场景 / 次数 | Worker | 输入 Token | 输出 Token | 模型轮次 |\n| --- | --- | ---: | ---: | ---: |\n" + workerRows.join("\n") + "\n\n";
text += "## 等待与关键路径\n\n| 任务 | Standard 工具累计秒 | Fast 工具累计秒 | Standard 审批等待秒 | Fast 审批等待秒 | Fast 调度毫秒 |\n| --- | ---: | ---: | ---: | ---: | ---: |\n";
for (const row of live.scenarios) {
  const a = samples(row, "standard"), b = samples(row, "fast_dag");
  text += `| ${names[row.name] || row.name} | ${number(sum(a, "tool_wait_ms") / 1000)} | ${number(sum(b, "tool_wait_ms") / 1000)} | ${number(sum(a, "approval_wait_ms") / 1000)} | ${number(sum(b, "approval_wait_ms") / 1000)} | ${number(sum(b, "scheduling_ms"))} |\n`;
}
text += "\n主表保留完整墙钟时间，包含真实审批等待。原始数据另记 `execution_ms` 供排除测试审核交互后的诊断，未将其冒充端到端完成时间。工具累计时间可能重叠，不能简单从墙钟时间中相减来推算模型耗时。\n\n";
text += "| 有效成功对照 | Standard 剔除审批等待秒 | Fast 剔除审批等待秒 | 诊断时间节省 |\n| --- | ---: | ---: | ---: |\n";
for (const row of valid) {
  const a = sum(samples(row, "standard"), "execution_ms"), b = sum(samples(row, "fast_dag"), "execution_ms");
  text += `| ${names[row.name] || row.name} | ${number(a / 1000)} | ${number(b / 1000)} | ${pct(1 - b / a)} |\n`;
}
if (valid.length) {
  const a = sum(valid.flatMap(row => samples(row, "standard")), "execution_ms"), b = sum(valid.flatMap(row => samples(row, "fast_dag")), "execution_ms");
  text += `\n有效成功对照剔除人工审批等待后的合计诊断时间节省为 ${pct(1 - b / a)}。这仍包含所有必要模型推理、自动审批和验证。`;
  const logic = valid.find(row => row.name === "complex_logic");
  if (logic && sum(samples(logic, "standard"), "approval_wait_ms")) text += `逻辑推理样本的主表改善含 Standard ${number(sum(samples(logic, "standard"), "approval_wait_ms") / 1000)} 秒人工审批等待的影响，不能直接归因于架构提速。`;
  text += "\n\n";
}
text += "| 任务 | Standard 模型请求 | Fast 模型请求 | Standard 工具调用 | Fast 工具调用 | Fast 工作任务 | Fast 重规划 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n";
for (const row of live.scenarios) {
  const a = samples(row, "standard"), b = samples(row, "fast_dag");
  const work = b.reduce((total, value) => total + (value.fast_tasks || []).filter(task => !task.task_id.endsWith(".verify")).length, 0);
  const replans = b.reduce((total, value, index) => total + (value.fast_metrics?.replans ??
    (capturedMetrics?.benchmark_id === live.benchmark_id ? capturedMetrics.samples[`${row.name}:${index}`]?.metrics.replans : 0) ?? 0), 0);
  text += `| ${names[row.name] || row.name} | ${sum(a, "model_requests")} | ${sum(b, "model_requests")} | ${sum(a, "tool_calls")} | ${sum(b, "tool_calls")} | ${work} | ${replans} |\n`;
}
text += `\n本组 Fast 模型请求合计 ${sum(allFast, "model_requests")} 次，Standard 为 ${sum(allStandard, "model_requests")} 次；Fast 调度累计 ${number(sum(allFast, "scheduling_ms"))} 毫秒。模型请求计数来自共享 TaskRuntime；阶段指标中的 requests 是逻辑轮次，口径不同。\n\n`;
text += "关键路径分析：没有独立分支的任务必须顺序执行；额外增加并发槽位不能缩短真实依赖。小任务的独立规划、局部验证与最终审查会增加固定模型往返开销。可从原始数据中的 `model_requests`、工作任务数、验证节点和审批等待识别这些情况；若调度开销和工具等待很小而模型轮次明显增加，可以推断瓶颈主要在模型请求和验证依赖链，而不是 DAG 扫描。该推断不是直接测得的模型纯推理时间。\n\n";
text += "任意 shell 任务当前使用独占工作区范围，包含命令的分支可能因此串行；显式只读分支和不相交的限定路径编辑才可并行。单次改善也可能来自模型执行路径或服务延迟的变化；只有一个工作节点的样本尤其不能用来证明并发的因果收益。\n\n";
text += "实现已采用的优化包括：流式启动、依赖满足后立即解锁、复用真实工具证据、限定 Worker 任务范围、在原上下文纠正输出格式、避免重放写入，以及让审批模型也受同一推理池限制。未降低模型、推理档位、输出预算或必要检查。\n\n";
text += "## 受控调度测试（不是模型性能）\n\n| 场景 | 串行调度均值毫秒 | 并发调度均值毫秒 | 时间节省 |\n| --- | ---: | ---: | ---: |\n";
for (const row of fixture.scenarios) text += `| ${names[row.name] || row.name} | ${number(row.serial.mean_ms)} | ${number(row.concurrent.mean_ms)} | ${pct(row.time_saved_fraction)} |\n`;
text += `\n每类每模式 ${fixture.samples_per_mode} 次。这些数据只测真实异步定时器和调度器，未调用模型，Token 和模型质量均未测；不能将这些百分比当作 Fast Agent 的端到端加速率。\n\n`;
if (fs.existsSync("docs/fast-live-retest.json")) {
  const retest = JSON.parse(fs.readFileSync("docs/fast-live-retest.json", "utf8"));
  text += `## 交付构建复测\n\n复测状态：\`${retest.state}\`；构建：\`${retest.engine_sha256}\`。复测没有删除或替换上面的失败样本。\n\n`;
  text += "| 复测场景 | Standard 秒 | Fast 秒 | 时间节省 | Fast 验收/产物正确 |\n| --- | ---: | ---: | ---: | --- |\n";
  for (const row of retest.scenarios) text += `| ${names[row.name] || row.name} | ${number(row.standard?.mean_ms / 1000)} | ${number(row.fast_dag?.mean_ms / 1000)} | ${pct(row.time_saved_fraction)} | ${success(samples(row, "fast_dag"))} / ${correct(samples(row, "fast_dag"))} |\n`;
  text += "\n复测使用生产默认的 30 分钟任务时限，模型、推理档位与必要检查不变。四路分析为补充的明确可并行工作负载：四个受限只读检查者，主智能体以 Node 独立校验全部原始资料；同一要求应用于两种模式。\n\n";
}
text += "## 未完成的验收与限制\n\n- 尚不能据此宣称一般复杂任务的 50% 缩时目标已经实现。\n- 统计可靠的 P95、多轮随机化顺序、开放式答案人工评审、公网多站点检索和大型项目开发尚未测；本组为可重复的本地资料、逻辑和小型代码任务。\n- 供应商缓存计费 Token 没有由现有接口可靠提供，标记为未知；本地上下文缓存命中不代表供应商计费减免。\n- 初次中断记录保存在 `fast-live-interrupted.json`，其中失败/超时任务不是成功的速度对照。\n\n";
text += "后续待验证的优化包括：让 Planner 将简单任务合并为更少的工作节点，避免另建与隐式验证重复的审查任务；在保留独立验证和最终审查的前提下，让不相交的编辑先并行、再由协调者运行必要测试。任意 shell 的真正并行需要可验证的文件系统隔离，当前未实现；不能仅放松访问范围来换取速度。\n\n";
const currentHash = createHash("sha256").update(["engine", "scheduler", "worker", "pool", "artifacts", "types", "planner"]
  .map(name => fs.readFileSync(new URL(`../dist/fast/${name}.js`, import.meta.url), "utf8")).join("\n")).digest("hex");
text += `测量构建指纹：\`${live.engine_sha256}\`。交付构建指纹：\`${currentHash}\`。`;
if (currentHash !== live.engine_sha256) text += "实测后补充了模型错误透传，以及遇到余额/鉴权等永久错误时停止新请求和重规划的处理，避免将供应商错误误报为规划 JSON 解析错误。这些变更经过回归；上面的付费数据属于测量构建，未冒充交付构建的逐位相同测量。账户余额不足，新增错误分支没有再次付费复测。";
text += "原始数据：`fast-live-benchmark.json`、`fast-live-metrics.json`、`fast-scheduling-benchmark.json`。\n";
fs.writeFileSync("docs/fast-performance.md", text);
console.log(`Wrote performance report: state=${live.state}, valid comparisons=${valid.length}`);
