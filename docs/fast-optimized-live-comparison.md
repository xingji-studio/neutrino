# 优化后 Fast 与 Standard：一轮真实模型对照

测量日期：2026-11-10（Asia/Shanghai）。本轮两个模式均完成并通过验收。**Fast 耗时增加 124.2%，已报告 Token 增加 33.1%；本轮没有提速。** Fast 有一次 HTTP 500 失败尝试未返回 usage，因此表中 Token 为已报告用量，不是完整账单。

| 项目 | Standard | 优化后 Fast |
| --- | ---: | ---: |
| 端到端耗时 | 49.32 秒 | 110.60 秒 |
| 已报告输入 Token | 92,288 | 118,267 |
| 已报告输出 Token | 6,244 | 12,835 |
| 已报告总 Token | 98,532 | 131,102 |
| 逻辑模型往返 | 29 | 24 |
| 实际 HTTP 尝试 | 29 | 25 |
| 无 usage 的 HTTP 尝试 | 0 | 1 |
| 工具调用 | 15 | 14 |
| 任务完成 / 原产物断言 | 通过 / 通过 | 通过 / 通过 |
| 独立质量复核 | 全部通过 | 全部通过 |

## 相同条件

- 模型为 `DeepSeek/deepseek-flash`，思考强度为 `Max`。两个模式全部模型请求的配置指纹一致：`2b9a793ce1340f2f913e4ec6a72ffa684c0b3df3a15f9f4222743325a055a123`；实际请求的输出预算均为 16384。
- 沿用 `multi_module_code`：实现独立的税额和运费模块，执行原始四条测试断言，用实际实现生成数值结果 JSON。用户输入、初始文件、外部验收标准相同；两个模式的内部规划及验证流程属于被比较的实现。
- 两份会话和工作目录独立，均重新执行；没有复用旧 Standard 成绩。本轮顺序为 Standard → Fast，各一次。
- 共享任务上限一致：24 个子智能体、128 次模型请求、256 次工具调用、200 万任务 Token、30 分钟。Fast 的模型池为 4；实际 HTTP 并发峰值分别为 2 和 2。
- 两侧均开启相同元数据时间线。墙钟从提交任务起至执行结束和日志冲刷完成；后续独立质量复核与产物导出不计入该墙钟。
- 本轮总 Token 护栏 60 万，未触发。供应商报告的配对用量合计 229,634，连通性探测另为 74；含未知用量预留的预算核算数 255,454 不等于真实账单。

## 结果质量

对两份保存产物使用完全相同的独立检查：原始 `test.mjs` 四条断言、16 组税额/运费公式检查、导出类型、模块独立性及 JSON 与实际函数结果的一致性，全部通过。原测试保持不变。

两份 `tax.mjs` 和 `shipping.mjs` **逐字节相同**；`answer.json` 仅排版不同，数值及结构相同。两个最终回答均报告了实现、原测试通过以及模块独立性。本场景未观察到功能质量差异；这一结果不代表开放式答案或一般任务的质量等价。

完整复核记录见 `fast-optimized-live-quality.json`。代码、原测试、JSON 和最终回答保存在 `fast-optimized-live-artifacts/c7c8ecc8-e6cd-401e-a5a2-a702f0b505c4/multi_module_code/` 的两个模式目录中。

## 本次主要可见耗时

重复验证层级已消除：Fast 实际只有 `implement_modules_and_answer` 及其自动 `.verify`，完整验收标准仍保留，之后进入强制全局审查。未出现额外的“验证工作任务 → 再验证”。

| 规划请求 | 模型进行中秒 | 已报告输出 Token | 其中接口报告的推理 Token |
| --- | ---: | ---: | ---: |
| Standard | 8.28 | 1,125 | 859 |
| Fast | 34.25 | 4,731 | 3,985 |

相同 Max 档位仍可能产生不同数量的实际推理输出；Fast 此次规划花费约 34.25 秒，Standard 约 8.28 秒。

Fast 的独立验证阶段有一次审批模型请求返回 HTTP 500：失败尝试耗时 22.30 秒，随后退避 5 秒再重试，最终通过。失败尝试没有 usage；逻辑请求成功后的 usage 不能覆盖这次未知尝试。报告使用实测总时间，包含这次失败尝试和退避。

Fast 工作节点持有工作区约 21.15 秒，独立验证节点约 44.98 秒；后者约 30.97 秒处于审批模型进行中（并行审批按区间并集计算）。这些时间包含网络、供应商处理和生成，不能当作纯思考耗时。Fast 模型队列累计仅 1.091 毫秒，审批队列仅 0.314 毫秒。减少往返本次未抵消较长规划、较大请求及失败重试的成本。

供应商报告的缓存输入 Token 分别为 62,208 和 84,608，因此总输入 Token 的差异不能直接当作同比例账单差异。重试及单次生成波动使本轮不能用于一般速度结论或 P95，也不能单独量化本轮代码优化相对旧 Fast 的净收益。

## 可复现记录

原始配对数据：`fast-optimized-live-benchmark.json`；归纳、配置核对与源码指纹：`fast-optimized-live-summary.json`；两份原始元数据时间线：`fast-optimized-live-traces/`。此次两份时间线均完整通过归因检查。

```sh
npm run build
node scripts/benchmark-fast-live.mjs --home /mnt/c/Users/GuoqiFish --runs 1 --cases multi_module_code --expect-provider DeepSeek --expect-model deepseek-flash --expect-intensity Max --token-cap 600000 --trace-dir docs/fast-optimized-live-traces --artifact-dir docs/fast-optimized-live-artifacts --output docs/fast-optimized-live-benchmark.json
```

以上命令会再次调用真实模型。本轮仅执行了一次配对。
