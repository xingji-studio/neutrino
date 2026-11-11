# Web / TUI 界面 SDK

## 插槽

| 插槽 | 组合方式 | 用途 |
| --- | --- | --- |
| app.menu | 多项追加 | 插件菜单按钮 |
| workspace.tabs | 多项追加 | 工作区选项卡 / 面板 |
| sidebar.footer | 多项追加 | 侧栏信息 |
| chat.header.actions | 多项追加 | 对话标题操作 |
| chat.composer.toolbar | 多项追加 | 输入辅助、预设文本 |
| chat.composer | 显式选择一个提供者 | 输入编辑器 |
| chat.message.actions | 按消息匹配追加 | 消息操作按钮 |
| chat.message.renderer | 显式选择一个提供者 | 消息正文视图 |
| chat.card.plan | 显式选择一个提供者 | 计划卡片 |
| chat.card.tool | 显式选择一个提供者 | 工具结果卡片 |
| settings.sections | 声明设置页面 | 插件自己的设置相关内容 |

追加项按 order 和完整 key 稳定排序。替换项必须在管理界面或 `plugin provider` 命令中选择；安装或排序靠前不会自动接管输入框。默认配置表单由管理器根据 configuration 自动生成。

```json
{
  "id": "panel",
  "slot": "workspace.tabs",
  "title": "My panel",
  "view": "panel.html",
  "height": 240,
  "text": "Terminal fallback text",
  "platforms": ["web", "tui"]
}
```

`id` 在包内唯一，完整 key 为 `<插件ID>/<id>`。`view` 是包内 HTML 文件；`height` 为 40–1200 像素。`text` 提供无需脚本的内容及终端回退。`command` 是插件自己的用户命令名；点击时通过活动会话提交 `/plugin` 命令。`insert` 将文本加入当前草稿。`match.role` 和 `match.tool` 可限定消息 / 工具卡片。

## HTML 视图

HTML 可以包含自己的样式与脚本。宿主在插件脚本之前注入 `window.neutrino`：

```html
<button id="read">Read draft</button><pre id="output"></pre>
<script>
document.getElementById('read').onclick = async () => {
  const draft = await neutrino.composer.read();
  document.getElementById('output').textContent = draft.text;
};
</script>
```

这需要清单的 `composer.read` 权限。建议处理 Promise 错误；未处理的脚本错误会触发视图回退。

每个 iframe 使用 `sandbox="allow-scripts"`，不启用 same-origin。CSP 禁止网络请求、表单提交、外部脚本和任意资源加载；可使用内联样式、内联脚本、打包的模块与 data 图片。视图资源通过已认证的 JSON API 读取后嵌入，不作为同源 HTML 执行。

如使用单文件 ESM，可设置 `entries.web`：

```js
export default {
  mount(api, root) {
    root.textContent = api.context.title;
  },
};
```

可从 `@xingjisoft/neutrino/plugin/web` 导入类型和 `defineWebPlugin`，构建时将依赖打包为一个 ES 模块。运行时不解析 npm 裸模块名。

## 浏览器 API

| 接口 | 权限 / 行为 |
| --- | --- |
| `neutrino.context` | 插件 ID、贡献 ID、标题、profile；读取会话权限存在时包含当前消息或计划 |
| `composer.read()` | composer.read，返回 `{ text, revision }` |
| `composer.write({ text, expectedRevision })` | composer.write，版本不匹配时拒绝，返回新版本 |
| `composer.submit()` | composer.submit，通过宿主正常发送流程提交当前草稿 |
| `conversation.read()` | conversation.read，返回当前只读会话投影 |
| `commands.execute(name, args)` | commands.register，只能调用本插件命令，经活动会话执行 |
| `configuration.read()` / `configuration.write({ values, expectedRevision })` | ui.contribute，仅当前插件配置；写入当前项目覆盖层，配置由服务端验证 |
| `view.resize(height)` | 将当前 iframe 高度限制到 40–1200 |
| `on('context.changed', handler)` | 订阅会话 / 草稿相关刷新，返回取消订阅函数 |

宿主检查消息来源窗口、随机 nonce、当前会话身份、消息速率和每项权限。切换对话后旧 iframe 被释放。插件不能经此 API 直接批准请求或修改已保存消息。

编辑草稿前先 read，写入时使用读取的 revision；发生冲突后重新 read，让用户决定如何合并。宿主 textarea 保留为草稿来源，iframe 成功准备后才隐藏它。停用、卸载、组件错误或十秒初始化超时会恢复默认组件和草稿。发送、停止、模式和审批控件仍由宿主维护。

工具和消息原文保留在宿主的回退区域；成功加载的自定义视图只改变呈现。插件被移除后，文本仍能显示。

## 主题

`contributes.theme` 设置简单的 CSS 变量值。例如：

```json
{
  "--bg": "#171725",
  "--accent": "#b8b2ff",
  "--neutrino-composer-radius": "12px",
  "--neutrino-message-radius": "12px",
  "--neutrino-tui-accent": "#b8b2ff"
}
```

支持已有 Web 设计变量；`--neutrino-composer-radius` 和 `--neutrino-message-radius` 专用于聊天外观。CSS 值不允许 URL、表达式、规则或分号。移除主题时恢复原先变量。

## TUI

TUI 读取同一份声明。app.menu 和 workspace.tabs 出现在起始页；命令通过同一会话运行，文本页面支持返回和滚动。Web 专用组件使用 `platforms: ["web"]`，避免在终端显示无法使用的界面。

选择了提供者后，终端 text 模板支持 `{{content}}`、`{{role}}`（消息），`{{name}}`、`{{result}}`、`{{arguments}}`（工具），`{{plan}}`（计划）和 `{{text}}`（输入提示）。模板替换显示文本，保留原始历史和输入行为。

终端主题支持 `--neutrino-tui-accent`、`--neutrino-tui-tool-header`、`--neutrino-tui-user`、`--neutrino-tui-assistant`、`--neutrino-tui-dim`，值为六位十六进制颜色。取消主题会恢复内置颜色。审批状态色不受这些变量覆盖。

v1 不把终端 Buffer、原始 stdin/stdout 或内部 App 暴露给脚本。新的键鼠交互组件应通过宿主后续版本的公开契约扩展，避免依赖私有渲染实现。完整 HTML 编辑器和任意 JavaScript 卡片在 Web 中提供。
