# Fast Mode 当前测试与性能报告

更新日期：2026-11-11（Asia/Shanghai）。这是项目内唯一的当前测试与性能报告；使用、架构和配置见 [极速模式说明](fast-mode.md)。

## 版本与结论

最近一次真实模型对照测量的是 Fast 优化提交 **`b9962e2`** 对应的实现。归档开始时项目 HEAD 为 **`c9e2800`**，其间已有其他功能提交；本次整理没有重新调用真实模型，不能把旧实测描述成整个当前项目版本的重新验收。当前 `src/fast/engine.ts`、`src/fast/worker.ts` 与最近实测记录的源码哈希一致。

最近一组复杂 DAG 配对中，Fast 比同期 Standard 耗时减少 **26.7%**，但 Token 增加 **45.8%**，两者均通过原定验收。当前仍不能确认多场景稳定收益、普遍节省 Token 或达到 50% 缩时目标。

## 最近一次真实对照

活动 ID：`d42e00cb-c368-4a30-aa21-51b94afdc5af`。场景：四路只读资料分析 `parallel_analysis`。样本为 **1 组新配对、2 次运行**，没有复用历史 Standard 样本或替换失败样本。

固定条件：DeepSeek / `deepseek-flash`，**Max**，上下文 1,000,000，输出 allowance 16,384，模型槽位 4；两侧使用相同原始任务和验收标准。

| 项目 | Standard | 优化后 Fast |
| --- | ---: | ---: |
| 墙钟耗时 | 116.87 秒 | 85.67 秒 |
| 报告的总 Token | 177,921 | 259,438 |
| 实际模型请求 | 35 | 31 |
| 实际工具调用 | 22 | 17 |
| 原定功能及执行协议验收 | 通过 | 通过 |
| 审批中止 / 缺失 usage | 0 / 0 | 0 / 0 |

验收核对了全部原始数据哈希和结果：四个独立检查员各自只读其指定源文件，协调器用 Node 从四份原始数据独立重算、逐项比较检查员报告后写出结果。Fast 的四个源任务及协调任务各自保留独立验证，最终主审引用全部十个当前工作/验证产物。两侧 `answer.json` 字节相同，总数为 `grand_units=367`、`grand_weighted=692`。

这是受控夹具的单轮结果，不是开放任务质量等价或总体稳定性证明。归档内更早的多场景三轮数据属于其各自版本，不并入本版的样本量，也不用于宣称本版稳定达标。

## 已实现的优化与剩余开销

- 已知文件路径直接读取；确需列目录时，与独立的已知路径读取放在同一回复。
- 同一角色内、顺序明确的读取、计算、写入和回读断言可以组合成完整命令；失败停止，完整命令体继续走原审批，独立验证保留在其他 Agent 作用域。
- 最终主审的验收和当前版本证据复用规则放在系统角色中；缺口、冲突、输入变更、必要集成检查和原始测试继续补查。

最近 Fast 样本的协调执行为 15.60 秒、独立验证 23.18 秒、最终主审 10.84 秒，串行尾段约 49.63 秒，占 trace 墙钟 57.9%。仍出现 1 个独立列目录回合，验证角色使用 110,112 Token。后续重点仍是验证上下文与串行往返；本轮没有删除独立检查或降低模型档位来换取速度。

## 本地验证状态

实测提交已通过隔离构建、9 组 Fast 回归、普通及极端风险审批回归；22 项测量指纹一致。归档前后记录的测试证据分别保留，不把历史测试文件数当成当前版本的新测试结果。

本次归档后已通过 TypeScript 构建和 **11 组 Fast 回归**，包括外部输出、原始归档不被覆盖、捕获路径映射、WSL 误用 Windows 路径拒绝及独立的分析单元检查。普通回归没有依赖 G 盘或历史样本。

随后使用 Windows Node 从 G 盘显式重放 **12 个已保存的 Fast 样本**，并重新分析、审查最近配对中的 **2 个运行记录**；功能及执行协议均通过，待人工复核项为 0。旧数据重放不计作新模型样本，不能增加最近实测的样本量。

另以单次采样运行 8 类受控调度夹具，确认输出只写入项目外目录；这是输出路径检查，不是模型性能测试。本次核验日志和结果保存在归档 `generated/archive-migration-2026-11-11/`。本次没有新的付费模型调用。

## 归档位置和数据口径

归档根目录：**`G:\测试数据存档\neutrino-fast`**。

- `archive-manifest.json`：原路径、字节数、SHA-256、来源提交和迁移状态。
- `docs/`：986 个迁移文件中的历史 Fast 报告、原始 JSON、时间线、夹具产物、日志和截图；保留原有相对目录结构。
- `.shots/`、`test-out.log`：项目内已生成的其他测试截图和日志，同样移出项目。
- `scripts/`：测量脚本和原始用例定义的两份只读源快照；项目中的可执行测试代码继续保留。
- `generated/`：后续离线复核、测试和报告的输出，与原始归档分开。

迁移文件共 **986 个、45,212,130 字节**，另复制 2 份源快照。移除原文件之前，988 个目标文件全部逐文件校验 SHA-256；历史工具记录、路径元数据和质量证据内容没有改写。归档内的旧“最新”“本轮”等措辞只指其原始活动，不代表本报告的当前状态。

本报告的原始依据位于归档 `docs/fast-roundtrip-benchmark.json`、`fast-roundtrip-summary.json`、`fast-roundtrip-quality.json`、`fast-roundtrip-protocol-review.json`、`fast-roundtrip-traces/`、`fast-roundtrip-artifacts/`。更早试验按原文件名前缀保留，完整清单以归档 manifest 为准。

## 测试与复核入口

本地回归不依赖 G 盘或历史数据：

```sh
npm run test:fast
```

需要审查归档时，通过 `--data-dir` 或 `NEUTRINO_FAST_DATA_DIR` 指定归档根目录。G 盘未挂载到 WSL 时，使用 Windows Node；以下为 Windows 终端示例，均不调用模型：

```powershell
node scripts/test-fast-opportunities.mjs --data-dir 'G:\测试数据存档\neutrino-fast' --input 'G:\测试数据存档\neutrino-fast\docs\fast-efficiency-v3-benchmark.json'
node scripts/analyze-fast-opportunities.mjs --data-dir 'G:\测试数据存档\neutrino-fast' --input 'G:\测试数据存档\neutrino-fast\docs\fast-roundtrip-benchmark.json'
node scripts/audit-fast-live.mjs --data-dir 'G:\测试数据存档\neutrino-fast' --input 'G:\测试数据存档\neutrino-fast\docs\fast-roundtrip-benchmark.json' --reviews 'G:\测试数据存档\neutrino-fast\docs\fast-roundtrip-protocol-review.json' --output 'G:\测试数据存档\neutrino-fast\generated\fast-roundtrip-quality.json'
```

默认生成结果写到数据根目录的 `generated/`，不回写项目或覆盖归档 `docs/`。未配置数据目录时使用系统临时目录下的 `neutrino-fast-data`；已有显式 `--output` 参数继续有效。捕获时的旧绝对路径由工具在内存中映射至归档位置，原始证据不改写。

## 模型 Token 预算

截至最近一次真实对照，累计保护计数为 **10,118,824 / 10,500,000 Token**，剩余 **381,176**。最近一组对照含连通性探测消耗 437,427 Token，缺失 usage 为 0。本次归档和离线验证不新增模型用量；缓存输入仍计入 Token，不在此推算费用。
