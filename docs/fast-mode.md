# 极速模式（Fast Mode）

## 审计与改造计划

基线提交：`7cbee2a`；开发分支：`codex/fast-agent-mode`。

项目是 TypeScript/Node Agent，浏览器使用原生 HTML/CSS/JS 和 SSE。Web 执行入口在
`src/web/session.ts`，HTTP 路由在 `src/web/server.ts`，TUI 有独立循环。
已有 `standard`、`ptc`、`fast` 三种会话策略和独立 `pro` 工作区。
旧 `fast` 使用 `assets/fast.txt`，跳过单独规划；保留其标识、提示词和执行机制。
新增模式标识为 `fast_dag`，中文名称「极速模式」，英文名称「Fast Mode」。

1. 扩展模式枚举和确定性路由，旧数据默认 standard；模式随消息冻结。
2. 在现有输入框模式卡片菜单增加闪电卡片，保留所有旧选项和键盘交互。
3. 新增 `src/fast/`：流式 JSONL 规划、动态 DAG、有界资源池、版本化产物、局部验证和最终审查。
4. 复用相同 LLMClient、模型/推理配置、TaskRuntime、子智能体、上下文管理和审批机制。
5. 将真实状态通过既有 SSE 发布，保存实际模式和任务产物；失败明确呈现，不自动换模式。
6. 跑原有测试、并发/失效/取消/路由回归和八类调度对照。真实模型性能与质量必须单独测量。

标准模式基线使用原有测试与原循环建立。调度基准与真实模型对照分别报告，不能将模拟耗时作为模型加速率。

## 架构与执行边界

| 项目 | 标准模式 `standard` | 新增极速模式 `fast_dag` |
| --- | --- | --- |
| 路由 | 原有 `runTaskTurn` 分支 | 独立 `FastAgentEngine` |
| 规划 | 原有完整规划与顺序步骤 | JSONL 流式发布完整任务，先发布全局约束 |
| 执行 | 原 Agent 循环、原子智能体 | 动态 DAG 与有界 Worker Pool |
| 推进 | 原步骤执行策略 | 必需前驱通过验证后立即解锁后继 |
| 验证 | 原机制保留 | 独立局部验证节点 + 主智能体最终全局审查 |
| 模型、推理 | 原选择和档位 | 完全复用同一模型、档位和输出预算 |
| 工具、安全 | 原审批、权限、预算、取消 | 复用原接口和 TaskRuntime，审批串行呈现 |
| 上下文 | 原压缩和历史策略 | 同一容量与压缩实现，另加版本化上下文/产物 |

旧 `ptc`、旧 `fast` 和 `/pro` 执行分支及提示词继续存在。`fast_dag` 不使用旧 `fast.txt` 的精简推理提示词。

```mermaid
flowchart LR
  U[Web 消息 + agent_mode] --> R[确定性模式路由]
  R --> S[原 Standard / PTC / Fast 引擎]
  R --> P[Fast 流式 Planner]
  P --> C[全局约束 + 完整任务定义]
  C --> D[动态 DAG]
  D --> W[并发 Workers]
  W --> V[独立局部验证节点]
  V --> A[版本化产物库]
  A --> D
  A --> I[异步整合引用]
  I --> G[主智能体全局审查]
  G --> F[显式验收与最终回答]
```

Planner 仅在目标、依赖、上下文、验收标准、输出契约和访问范围完整后发布任务。调度器支持前向依赖、优先级、环检测、动态依赖更新、失效传播和版本绑定。
状态为 `PENDING / READY / RUNNING / VERIFYING / VERIFIED / FAILED / BLOCKED / INVALIDATED / COMPLETED`。
每个工作任务有独立 `.verify` 节点；后继任务等待已验证产物，而不是仅等待模型返回文本。

验证 Worker 使用独立的 Fast Worker 循环，继承原模型客户端、子智能体提示词、上下文容量、轮次、权限和审批规则。
`finish_task` 负责提交机器可读结果；验证必须提供显式布尔结论。
漏填字段时在同一私有上下文中纠正，不重跑已完成的写入。
历史上出现过失败检查时保留全部失败证据，并允许纠错后重新验证；未解决问题、拒绝的操作和预算耗尽不能冒充成功。

最终主智能体使用原模型和不受子智能体轮次限制的执行循环。它可继续推理、调用工具、解决冲突和补齐全局检查。
`finish_fast_review` 要求引用当前有效版本的产物，且全部任务通过验证、未解决问题为空，才能记录完成。
伪造引用、旧版本引用和无显式验收的文本回答均不能将任务标记为完成。

## 并发、权限与恢复

- 模型推理、工具 I/O、后台整合分别使用资源池，初始额度分别为 4、8、2。
- Worker 上限默认是模型槽位的两倍；实际模型请求仍受模型池上限约束。
- API 限流通知会降低本轮模型并发，最低为 1；不切换模型、不降低推理档位。
- 相互独立的只读任务可并行；相互独立且路径不重叠的编辑可并行。
- 任意 shell 命令使用独占工作区访问；有路径限制的编辑不能执行任意 shell，也不能越过其读写范围。
- 读写路径按真实文件系统路径解析，避免符号链接把重叠路径伪装成独立路径。
- 审批仍使用原审批门。多个 Worker 的人类审批串行呈现，避免覆盖同一审批横幅；自动审批也遵循原规则。
- 每个 Worker 和规划请求都有超时；取消传播给排队请求、模型流、工具和进程，调度器等实际操作退出后释放访问范围。
- 自动重试仅适用于安全的只读任务；已启动的写入任务失效后需要显式修复任务。
- `repair` 用新任务处理现有部分状态，再按原任务验收标准重新验证，不重复执行原写入。
- 规划异常与局部失败可在独立的有界次数内重规划；正确产物保留。不会静默切换到 Standard。
- 余额不足、鉴权失败等永久模型错误会明确透传，并停止新的模型请求与重规划；不会把接口错误文本误当成规划 JSON。

动态任务的 `dependencies / required_context / input_versions` 必须一致。输入版本不匹配时阻塞并要求重新规划；失效结果不会解锁后继。
投机执行没有启用。默认继承原 `task_max_*` 共享配额；规划还会为局部验证和恢复预留智能体容量，避免按 Worker 数量误算预算。

## Web、消息与持久化

现有输入框的模式菜单新增闪电卡片「极速模式」，英文标识 `Fast Mode`，保留 Standard、PTC、旧 Fast 和 Pro。
菜单继承原布局、悬停、点击、方向键、Home/End、Escape 与焦点行为；选中卡片有边框、背景和勾选状态。
移动端沿用现有响应式宽度与可滚动菜单。

普通工作区发送消息时携带：

```json
{"text":"用户任务", "agent_mode":"fast_dag"}
```

后端在提交消息的同一个同步操作中校验并选择模式。未知模式返回 400，不追加用户消息。
旧客户端可继续只提交 `text`，沿用会话模式；旧数据缺少模式时默认 Standard。
自然语言里出现「极速模式」不会改变模式。

`agentMode` 表示下一轮选择，`activeAgentMode` 冻结当前轮。排队消息也冻结其提交模式。
运行时改选模式不会修改正在执行的策略。任务快照额外记录 `execution_mode`，Fast 运行记录明确标注 `actual_mode: fast_dag`。

会话保存 `agent_mode` 和 `fast_run`，沿用现有会话刷新恢复逻辑。
每轮另有独立目录：

```text
<sessionDir>/tasks/<sessionId>/fast/<runId>/
  artifacts.json   # 稳定上下文、历史版本和验证状态
  run.json         # 实际 DAG、状态、整合引用、审查记录和指标
```

文件通过临时文件和重命名原子更新；不同轮次和会话使用不同 UUID。
进程重启后不会把磁盘中的 RUNNING 当成活 Worker，也不会自动重放工具。恢复时提示检查部分状态，再由新一轮规划处理。
失败后可显式点击「选择标准模式继续」；该操作只选择后续执行策略，不伪装成极速模式成功。

进度来自同一引擎快照，经原 SSE 通道展示。规划、并发执行、验证、整合、审查、取消与完成均来自实际状态；进度展示没有额外模型调用。
标准模式继续使用原进度显示，旧 Fast 运行记录不会覆盖当前 Standard 的状态。

## 配置与回滚

在现有普通工作区配置中设置以下字段；全部为新增可选字段：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `fast_mode_enabled` | `true` | 新模式 Feature Flag |
| `fast_model_slots` | `4` | 推理并发，最大 16 |
| `fast_tool_slots` | `8` | 工具并发，最大 32 |
| `fast_background_slots` | `2` | 异步整合并发，最大 8 |
| `fast_worker_slots` | 推理槽位 × 2 | 活动任务上限，最大 32 |
| `fast_task_timeout_ms` | `1800000` | 单 Worker / 规划请求超时 |
| `fast_max_tasks` | `24` | 工作任务总上限，另受共享配额约束 |
| `fast_retries` | `1` | 安全只读重试，0 可关闭 |
| `fast_replans` | `2` | 有界重规划，0 可关闭 |

关闭新任务入口可设置 `fast_mode_enabled: false`，或启动进程时设置 `NEUTRINO_FAST_MODE=0`。
已有运行冻结其配置，不受新选择影响；需要停止时使用原 Pause。关闭后 Web 卡片不可选，显式提交新模式返回错误，不自动改模式。
旧会话和已有产物无需迁移或删除，恢复标志后仍可查看。

Git 开发分支保留原始提交作为回滚点。工作区还有并行插件开发，撤回代码时应只撤回 Fast 增量，避免覆盖其他工作；关闭 Feature Flag 是无需撤回其他代码的回退方式。

## 测试、性能与指标

```sh
npm run test:fast
npm run benchmark:fast
npm run benchmark:fast:live -- --home <包含现有 .neutrino 配置的用户目录> --runs 1
```

`test:fast` 覆盖流式启动、依赖解锁、环和缺失依赖、局部验证失败、动态失效、输入版本、显式修复、资源优先级/缩容/取消、读写范围、持久化、规划恢复、纠错、最终验收引用、HTTP 路由、模式冻结、旧数据、Feature Flag、Web 卡片发送和 TUI 执行。

`scripts/test-fast-browser.mjs` 是可选的真实 Chromium 检查，不向项目增加浏览器依赖：

```sh
NEUTRINO_PLAYWRIGHT_MODULE=<已安装 playwright 的 index.mjs> node scripts/test-fast-browser.mjs
```

已提供桌面和移动端截图：`docs/screenshots/fast-mode-desktop.png`、`docs/screenshots/fast-mode-mobile.png`。
Linux 验收环境缺少中文字库时，测试可复用宿主机已有字体；产品样式没有因此改变。

性能与 Token 结果见 `docs/fast-performance.md`；机器可读原始结果为 `docs/fast-live-benchmark.json`、`docs/fast-live-metrics.json` 和 `docs/fast-scheduling-benchmark.json`。
变慢原因的代码级复现、证据边界及调整优先级见 `docs/fast-diagnostics.md`；可用 `node scripts/diagnose-fast-mode.mjs` 运行不调用供应商模型的离线诊断。
最终全量 `npm test` 通过 77 个测试文件；原始基线的 72 个测试也已在隔离检出中通过。测试清单、交付引擎指纹与浏览器检查记录见 `docs/fast-test-results.json`。
实时指标按规划、各 Worker、验证、最终主智能体整合分别统计输入/输出 Token，另有总量、吞吐、重试、重规划、工具等待和调度耗时。
主智能体最终审查归入 `integration`。接口内的 `requests` 为逻辑请求轮次；TaskRuntime 还记录实际请求/工具/智能体计数。
现有 `verification` 指标合并了局部验证和自动审批模型用量，不能直接当作纯正确性验证成本；离线诊断会将两者单独计数。
本地上下文缓存命中不能当作供应商的计费缓存命中；供应商缓存 Token 为 `null`，表示接口没有提供可验证数据。

## 当前实现边界与未完成验收

- 50% 是性能验收目标，是否达到以真实模型报告为准。调度器的定时器基准不代表 Agent 端到端加速。
- 流式规划期间可以新增任务和更新依赖；失败后的模型重规划在当前一波调度结束后执行。正常后继仍在前驱验证通过后立即启动，不等待其他独立分支。
- 后台整合持续合并已验证的产物版本引用，供后续规划和主智能体读取。语义冲突由最终主智能体完整推理处理；当前没有额外的后台语义审查模型。
- 工作区访问范围在同一次 Fast 运行内协调，不是跨进程文件锁或操作系统沙箱。外部程序或另一个会话对同一目录的修改仍需用户协调。
- 重启恢复保留历史、产物与失败原因，不会恢复已消失的进程或自动重放写入。后续一轮根据实际磁盘状态重新规划。
- 大型真实项目、开放式答案人工评审、公网多站点检索及统计可靠的 P95 尚未验收；受控样本的自动断言不能替代这些评测。
- 真实模型对照完成七类；第八类 Fast 因供应商 HTTP 402「余额不足」中断，补充四路并行对照未完成。50% 缩时目标尚未达到，完整数据及关键路径分析见性能报告；需要账户恢复可调用后才能补齐实测。

## 本次修改范围

- 新增引擎：`src/fast/types.ts`、`pool.ts`、`artifacts.ts`、`scheduler.ts`、`worker.ts`、`engine.ts`。
- 新增规划约定：`assets/fast-planner.txt`。
- 路由、保存和观察：`src/config.ts`、`src/llm/runtime.ts`（仅增加模式审计元数据）、`src/web/session.ts`、`src/web/hub.ts`、`src/web/server.ts`、`src/web/terminalBridge.ts`。
- 终端会话兼容：`src/screens/chat.ts`、`src/app.ts`。
- 前端：`web/index.html`、`web/app.js`、`web/style.css`、`web/i18n.js`。
- 测试/基准：`scripts/test-fast-*.mjs`、`scripts/benchmark-fast-*.mjs`、`scripts/report-fast-benchmark.mjs`、`scripts/test-web-settings.mjs`（发送协议断言增加模式）、`package.json`（新增命令）。
- 交付文档和截图：`docs/fast-mode.md`、`docs/fast-performance.md`、`docs/fast-test-results.json`、`docs/fast-live-*.json`、`docs/fast-scheduling-benchmark.json`、`docs/screenshots/fast-mode-*.png`。
- 使用入口文档：`README.md`、`README-zh.md`、`README-en.md` 和 `web/README.md` 中的 Fast 模式说明与实测链接。

其他插件目录、插件示例、插件 Web/TUI、依赖/导出及 README 中的插件相关并行修改不属于本次 Fast 实现；已保留，未替换。
