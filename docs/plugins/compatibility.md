# 兼容性与迁移

## 现有 Neutrino 行为

没有已启用插件时，内置工具、模型调用、历史、压缩、计划、PTC、子 Agent、审批和 Pro 的调用入口继续保留。工具定义函数、executeTool 和 TaskRuntime 仍然存在。

启用插件后，工具通过当前回合的注册表发现；PTC 获取同一份工具描述，Pro 与子 Agent 使用相同组合。子任务再次按角色与只读 / 写入范围筛选。插件不能通过原生工具绕过受限子任务。

新增会话字段均位于可选的 task_run 插件元数据中。旧文件可直接读取；未知插件不使历史读取失败。模型上下文与显示历史继续分开；插件卡片只替换显示，工具结果的文本仍保留。

## 从私有改造迁移

| 原做法 | 插件接口 |
| --- | --- |
| 修改 tools.ts 固定工具列表与分发 | ctx.tools.register |
| 修改主提示词文本 | contributes.prompts / ctx.prompts.register |
| 在界面中插入按钮和页面 | contributes.ui / ctx.ui.register |
| 修改全局 CSS | contributes.theme 或插件 iframe 样式 |
| 修改输入框内部状态 | composer 的版本化草稿 API |
| 添加脚本命令 | ctx.commands.register + /plugin |
| 调用内部审批、文件或进程对象 | ctx.fs / ctx.net / ctx.process |
| 给所有会话增加全局监听器 | ctx.events.on / ctx.effect，按回合清理 |

UI 应声明适用平台。终端不解析 HTML，也不把浏览器样式当作终端渲染指令。Web 替换组件需要用户选择提供者，不根据安装顺序抢占。

## 与 DeepSeek Harness 的关系

本系统借鉴 Context、作用域、可逆注册、类型化事件和 Profile 组合。Neutrino 使用自己的包结构和 SDK，不能直接加载 Cordis/DSH 二进制插件。

迁移 DSH 插件时，将服务依赖转换为插件依赖，将模型工具转换为 tools.register，将提示词片段转换为 prompts.register，将 UI 转换为声明插槽和 iframe SDK，将清理逻辑登记为 effect。需要任意 Node API 的代码使用原生模式并明确披露信任要求，或改成受限宿主能力。

## v1 的边界

此版公开工具、命令、事件、两个流程钩子、提示词、skill、UI 和存储。模型适配器、Agent 驱动替换、任意后端自定义 HTTP 路由、机器级常驻服务和远程插件市场没有公开契约。插件可通过已公开能力实现功能增强；不要通过未记录的私有类实现这些接口。
