# Neutrino 插件指南（API v1）

插件可以同时提供 Agent 工具、用户命令、菜单、选项卡、输入框、消息与工具卡片、主题、skill 和提示词。安装插件不需要修改 Neutrino 源码。Standard 和 Pro 共用安装包，分别保存启用状态、配置和组件选择。

## 快速开始

从仓库根目录运行：

```sh
npm run build
node dist/bin.js plugin install ./examples/plugins/function-tools
node dist/bin.js plugin enable community.text-tools
node dist/bin.js plugin doctor
```

在终端或浏览器的对话中输入以下命令，可直接得到结果，不请求模型：

```text
/plugin community.text-tools/count {"text":"hello plugin"}
```

正常对话中，模型也可以调用此插件的文本统计和文件统计工具。工具使用 `p_<插件 ID 的散列>_<工具名>` 作为模型协议名；描述中保留完整的 `插件ID/工具名`。

安装主题：

```sh
neutrino plugin install ./examples/plugins/theme
neutrino plugin enable community.indigo-theme
```

安装自定义输入框后，在管理界面的 **组件提供者 → chat.composer** 中选择它。命令行也支持选择：

```sh
neutrino plugin install ./examples/plugins/composer
neutrino plugin enable community.writing-composer
neutrino plugin provider chat.composer community.writing-composer/editor
```

恢复默认输入框：

```sh
neutrino plugin provider chat.composer default
```

## 管理界面

浏览器侧边栏的 **插件 / Plugins** 按钮打开管理界面。可安装本机目录或 `.neutrino-plugin` 包、启用/停用插件、编辑由 Schema 生成的配置表单、更新、回滚、卸载，以及选择输入框、消息、计划、工具卡片和人格提示词提供者。

“当前模式”修改当前 Standard/Pro 的默认配置；“当前项目”将启用状态和配置保存到该项目的覆盖层。安装、更新、回滚、卸载作用于共享包。组件提供者选择按 Standard/Pro 保存。

终端起始页有 **Plugins** 入口，在其他页面按 `Ctrl+X` 也可打开。终端插件页支持：

| 按键 | 操作 |
| --- | --- |
| ↑ / ↓、Enter | 选择插件、查看详情 |
| E | 启用 / 停用 |
| I | 安装本机目录或插件包 |
| C | 编辑完整配置 JSON |
| U / R / D | 更新 / 回滚 / 卸载 |
| V | 选择该插件提供的替换组件 |
| M | 查看扩展页面的文本内容 |
| Tab | 切换 Standard / Pro |
| Esc | 返回 |

启用原生插件时，终端要求按 Y 明确信任该版本。Web 使用独立的信任复选框。

## 命令行

```text
neutrino plugin help
neutrino plugin list [--profile standard|pro] [--workspace /absolute/project]
neutrino plugin inspect <id>
neutrino plugin create <new-directory>
neutrino plugin install <directory-or-bundle>
neutrino plugin enable <id> [--trust-native]
neutrino plugin disable <id>
neutrino plugin config <id> '<完整配置 JSON>'
neutrino plugin update <id>
neutrino plugin rollback <id>
neutrino plugin remove <id>
neutrino plugin provider <slot> <plugin-id/contribution-id|default>
neutrino plugin pack <directory> <output.neutrino-plugin>
neutrino plugin doctor
```

配置命令提交完整插件配置，未提交的字段回到 Schema 默认值。参数包含空格或 JSON 时，请使用所在 shell 的引号规则。更新从上次安装的本机来源重新读取，原文件夹更新或替换原插件包后执行即可。

## 示例插件

| 目录 | ID | 验证的扩展方式 |
| --- | --- | --- |
| `examples/plugins/function-tools` | `community.text-tools` | 受限脚本工具、命令、只读文件访问、事件与存储 |
| `examples/plugins/menus-tabs` | `community.workbench` | 菜单、工作区选项卡、侧栏和终端回退 |
| `examples/plugins/composer` | `community.writing-composer` | 输入框替换、草稿版本检查、发送、工具栏 |
| `examples/plugins/cards` | `community.inspector-cards` | 工具、计划和消息渲染器 |
| `examples/plugins/theme` | `community.indigo-theme` | 无脚本 Web / TUI 主题 |
| `examples/plugins/skills-prompts` | `community.review-skills` | 按需 skill、规则片段和可选人格 |

插件默认全部停用。卸载不删除旧会话，也不自动重放过去的工具调用。旧包文件会保留，以供运行中的回合继续使用；用户数据保存在独立的 `data` 目录。

## 故障恢复

```sh
neutrino plugin disable <id>
neutrino plugin doctor
neutrino --safe-mode --no-web
```

安全模式跳过所有外部插件。`--no-web` 可确保不连接到之前已启动、未处于安全模式的后台控制台。如需浏览器安全模式，先停止旧后台服务，再运行 `neutrino --safe-mode web`。

运行中的回合固定包版本和配置，更新通常从下一回合生效。增加权限或更新原生代码时，插件会自动停用，需重新启用。Web 外观与组件配置会自动刷新。插件脚本激活失败时，该插件的注册项撤销，其他插件和内置功能继续运行；脚本执行失败会记录为该次调用的错误。

## 文档目录与支持范围

- [架构、作用域与生命周期](architecture.md)
- [清单与配置格式](manifest.md)，[编辑器 JSON Schema](manifest.schema.json)
- [Agent SDK 与事件契约](agent-sdk.md)
- [Web / TUI 界面 SDK](ui-sdk.md)
- [Skill 与提示词](skills-prompts.md)
- [权限、受限执行与原生信任](security.md)
- [开发、打包、测试与发布](development.md)
- [兼容性与迁移](compatibility.md)

API v1 支持本机目录和可校验的离线插件包。插件市场、直接拉取 npm/Git 依赖、模型供应商注册、任意替换 Agent 主循环，以及 DSH 插件二进制兼容不属于这一版的公开 API。可通过工具、命令、钩子、提示词和界面接口组合工作流。Web 可用 HTML/CSS/JavaScript 完整替换相应视图；TUI 提供菜单、文本页面、主题和文本渲染契约，浏览器组件可声明仅在 Web 生效。

架构参考：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)、[可逆注册与 Context](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md)。Neutrino 插件使用独立清单和 SDK。
