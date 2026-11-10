# 规划优化后的真实模型对照

测量日期：2026-11-10（Asia/Shanghai）。本轮 Standard 和 Fast 均完成并通过同一验收；**Fast 耗时减少 19.7%，Token 减少 2.0%**。这是单场景的一次配对。

| 指标 | Standard | 优化规划后的 Fast |
| --- | ---: | ---: |
| 端到端耗时 | 56.20 秒 | 45.12 秒 |
| 输入 Token | 108,744 | 107,374 |
| 输出 Token | 7,080 | 6,145 |
| 总 Token | 115,824 | 113,519 |
| 逻辑模型往返 / HTTP 尝试 | 33 / 33 | 23 / 23 |
| 工具调用 | 15 | 14 |
| 重试 / 缺失 usage | 0 / 0 | 0 / 0 |
| 原始验收 / 独立质量复核 | 全部通过 | 全部通过 |

## 规划阶段

| 规划请求 | 耗时秒 | 输入 Token | 输出 Token | 接口报告的推理 Token |
| --- | ---: | ---: | ---: | ---: |
| 本轮 Standard | 7.46 | 592 | 1,003 | 694 |
| 本轮 Fast | 1.68 | 1,027 | 126 | 115 |
| 上一轮 Fast（历史参考） | 34.25 | 1,718 | 4,731 | 3,985 |

本轮时间线记录了单任务声明，随后执行 `main → main.verify → 强制全局审查`。原始请求完整保留在两个节点的验收标准中，不需要模型重写成较长的任务契约。单任务声明、默认字段展开、按需恢复协议及重复消息处理详见 `fast-planning-optimization.md`。

上一轮 Fast 规划耗时 34.25 秒，本轮为 1.68 秒；上一轮规划输出 4,731 Token，本轮为 126。两轮是独立采样，不能把全程差异全部归因于规划代码；上一轮在审批阶段还有一次 HTTP 500。本轮提速率只由本轮新 Standard 和新 Fast 的完整耗时计算。

## 一致性与质量

- 两侧固定 `DeepSeek/deepseek-flash`、`Max`。所有请求的模型配置指纹均为 `2b9a793ce1340f2f913e4ec6a72ffa684c0b3df3a15f9f4222743325a055a123`，实际输出预算均为 16,384。没有设置更低的思考档位、输出额度或替代模型。相同档位不表示每次生成固定数量的实际推理 Token。
- 用户输入、初始 `package.json`、原始 `test.mjs` 及外部验收标准相同。每个模式使用独立目录和新会话，顺序为 Standard → Fast，各一次，没有复用历史成绩。
- 共享上限仍为 24 个子智能体、128 次模型请求、256 次工具调用、200 万任务 Token、30 分钟。审批、工作区访问及必要独立验证没有绕过。两边实际 HTTP 并发峰值均为 2。
- 两份时间线均完整通过归因校验，所有 56 次任务 HTTP 尝试均有 usage。本轮无重试，也未触发 60 万 Token 活动护栏。
- `scripts/audit-fast-live.mjs` 对两份产物执行原始 4 条断言、16 组公式输入检查、导出类型、模块独立性及 JSON 与实际函数结果的一致性，全部通过。原测试未改动。
- 两份 `tax.mjs`、`shipping.mjs` 逐字节相同，JSON 数值和结构相同。两份最终回答、代码和测试均已保留。本场景未发现功能质量差异；不能据此断言一般任务或开放式答案质量等价。

墙钟从提交任务起至执行结束及日志冲刷完成，包含实际模型等待、工具和审批。产物导出及后续独立复核不计入该墙钟。供应商报告的缓存输入 Token 分别为 75,136 / 82,688；Token 下降比例不等于费用下降比例。单次结果尚不能代表稳定分布、P95 或整体 50% 目标。

## 测试与复现

`npm test` 全量 82 个脚本通过，测试清单与源码指纹见 `fast-planning-test-results.json`。新回归检查原始验收逐字保留、非法覆盖、权限、流式启动、历史内容和恢复边界；旧 DAG 及原有模式仍兼容。

原始配对数据：`fast-planning-live-benchmark.json`；配置核对、规划角色数据和源码指纹：`fast-planning-live-summary.json`；独立复核：`fast-planning-live-quality.json`。原始时间线为 `fast-planning-live-traces/`，保存产物为 `fast-planning-live-artifacts/0d043bfb-42bf-4e17-8c85-736d25a9347a/multi_module_code/`。

```sh
npm run build
node scripts/benchmark-fast-live.mjs --home /mnt/c/Users/GuoqiFish --runs 1 --cases multi_module_code --expect-provider DeepSeek --expect-model deepseek-flash --expect-intensity Max --token-cap 600000 --trace-dir docs/fast-planning-live-traces --artifact-dir docs/fast-planning-live-artifacts --output docs/fast-planning-live-benchmark.json
node scripts/audit-fast-live.mjs --input docs/fast-planning-live-benchmark.json --output docs/fast-planning-live-quality.json
```

基准命令会重新调用真实模型。本轮仅执行一次真实配对；独立质量复核只运行本地代码。
