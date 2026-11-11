# Fast Mode 模型往返优化

日期：2026-11-11。基于已推送的 `b5fe2ed` 继续优化；当前新增改动在工作区。本轮修改 Fast 的执行指令，并完成本地回归及一组复杂 DAG 真实模型对照。

## 改动

- `src/fast/worker.ts`：已知必需路径直接读取；需要列目录时，把它与路径已知的独立读取放在同一回复。根据实际继承后的只读策略，仅对有命令能力的节点提示组合相关命令。步骤明确时，在同一任务内合并读取、计算、写入、回读断言，保留前置顺序和失败退出；需要诊断或单独安全决策时拆开执行。
- `src/fast/engine.ts`：将最终主审的验收、冲突处理和证据复用规则移入系统角色，与通用 Agent 策略一起呈现。原始测试、必要独立检查、版本变化、缺口、冲突及集成检查依然必须完成。完整原始请求、工具能力、验收引用要求及最终全局审查保持不变。
- `scripts/test-fast-efficiency.mjs`：将审批回归中的必要删除改成“删除 + 断言”的完整命令，确认各审批席位看到完整命令体，极端风险仍保留三轮、每轮两票；拒绝时整条命令不执行，接受后仍有独立验证。

批处理是给模型的执行指导，不会自动重写模型命令、跳过工具调用、合并不同 Agent 的独立验证、替代审批或推断未执行检查已通过。本轮没有调整模型、Max、输出上限、任务验收条目、并发槽位及风险判定。

## 验证

[本地回归记录](fast-roundtrip-local-checks.json) 全部通过：TypeScript 构建、Fast 的 9 组测试、普通审批评审、极端风险审批，以及离线诊断回归。完整输出见 [测试日志](fast-roundtrip-test.log)。本地测试覆盖实际失败结果阻断、依赖版本失效、只读与目录约束、审批拒绝、独立验证和最终验收。

[真实测试计划](fast-roundtrip-plan.json) 在调用前冻结：`parallel_analysis`，Standard/Fast 各一次新运行，固定 DeepSeek/deepseek-flash、Max、1,000,000 上下文、16,384 输出 allowance、4 模型槽位，使用原夹具和原验收标准。没有用旧样本替换失败结果，也没有自动批准待处理人工请求。

| 同期真实对照 | Standard | 优化后 Fast |
| --- | ---: | ---: |
| 总耗时 | 116.87 秒 | 85.67 秒 |
| 报告的总 Token | 177,921 | 259,438 |
| 实际模型请求 | 35 | 31 |
| 实际工具调用 | 22 | 17 |
| 原定验收 | 通过 | 通过 |
| 审批中止 / 缺失 usage | 0 / 0 | 0 / 0 |

Fast 在这一组中耗时减少 **26.7%**，Token **增加 45.8%**。耗时改善与 Token 节省不能混为一个结论；目前尚未实现复杂 DAG 的 Token 消耗低于同期 Standard。

事后审查核对了全部源数据哈希、输出、四个独立只读检查员的实际作用域与读取记录、协调器完整 Node 程序及写入顺序。Fast 的协调器在一条 Node 命令中重算全部四个原始数据集、与实际检查员数值比较，分歧时抛错，随后写入并回读断言；另一独立作用域以新 Node 程序再次重算，并读取原始检查员报告核对。四个源文件各自的独立验证和最终全局主审也完整保留。两模式的 `answer.json` 字节相同，原始验收及执行协议均通过，详见 [质量结果](fast-roundtrip-quality.json) 与绑定记录哈希的 [协议复核](fast-roundtrip-protocol-review.json)。这些结果限于本次闭合夹具，不代表一般开放任务的质量评估。

冻结的运行时、提示和测试 harness 指纹中，相对 V3 仅 `dist/fast/engine.js`、`dist/fast/worker.js` 改变，其他 20 项一致。测试脚本修改单独记录在计划和本地回归的源文件哈希中。

## 从本组日志看到的效果与剩余开销

Fast 协调执行用时 15.60 秒，独立验证 23.18 秒，最终主审 10.84 秒。串行尾段合计 49.63 秒，占 trace 墙钟 **57.9%**；其中审批模型请求区间并集为 4.37 秒，已包含在上述时间内，不能重复相加。

三轮历史 V3 的 Fast 中位数为 98.08 秒、346,885 Token；本次为 85.67 秒、259,438 Token，分别低 12.6%、25.2%。历史样本来自不同时间，模型输出、规划内容和服务时延存在波动；这些是描述性比较，不能作为本次代码变动的因果收益或稳定性证明。

历史三轮各有 2、2、3 个“只列目录、下一轮再读已知文件”的开场回合；本次仍出现 1 个，消耗 4,284 Token、约 0.82 秒模型请求时间。已知路径指导降低了部分拆分，尚不能保证模型完全遵循。协调器也仍有回读结果，验证器仍会单独补读原始检查员报告。不能把这些调用全部标为浪费：原始报告的真实性核对与必要的独立检查必须保留。

本次规划请求用时约 20.37 秒，其中报告的推理 Token 为 2,957；规划实现没有改变。验证角色使用 110,112 Token，是仍需进一步分析的主要输入开销之一。下一轮适合分别验证授权依赖报告的选择性预装与无损上下文复用，衡量新增输入和减少往返之间的取舍。本轮没有把这两项未经实测的机制混入实现。

全部原始数据与时间线见 [benchmark](fast-roundtrip-benchmark.json)、[阶段分析](fast-roundtrip-analysis.json)、[汇总](fast-roundtrip-summary.json)。本次只有一组新对照，不足以确认多个场景、多个轮次的稳定提速或 Token 收益。

## Token 预算

本次实际报告 437,359 Token，连通性请求 68 Token，保护计数共 **437,427**；缺失 usage 为 0。累计保护计数 **10,118,824 / 10,500,000**，剩余 **381,176**。既有累计上限继续有效，没有重置预算或额外发起其他真实模型测试。

## 复现

```sh
npm run test:fast
node scripts/test-approval-review.mjs
node scripts/test-approval-extreme.mjs
node scripts/test-fast-opportunities.mjs
node scripts/analyze-fast-opportunities.mjs --input docs/fast-roundtrip-benchmark.json --output docs/fast-roundtrip-analysis.json
node scripts/audit-fast-live.mjs --input docs/fast-roundtrip-benchmark.json --reviews docs/fast-roundtrip-protocol-review.json --output docs/fast-roundtrip-quality.json
```

上述分析和审查命令只读取已保存记录，不会重新调用模型。真实对照的固定参数、哈希和预算见运行前计划；再次运行真实模型需要从当前剩余额度中扣除。
