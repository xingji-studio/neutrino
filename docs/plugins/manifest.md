# 清单与配置格式

每个包根目录必须包含 `neutrino.plugin.json`。目录和离线包使用相同结构。

```json
{
  "id": "acme.example",
  "name": "Example",
  "version": "1.0.0",
  "apiVersion": 1,
  "runtime": "sandbox",
  "entries": { "agent": "agent.js" },
  "permissions": ["tools.register"],
  "profiles": ["standard", "pro"],
  "categories": ["function"],
  "configuration": {
    "type": "object",
    "properties": { "label": { "type": "string", "default": "Example" } },
    "additionalProperties": false
  }
}
```

| 字段 | 约束与含义 |
| --- | --- |
| `id` | 必填、命名空间标识，例如 `acme.example`。小写字母、数字、短横线，至少两段，最长 80 字符 |
| `name` | 必填，1–100 字符的显示名称 |
| `version` | 必填，`major.minor.patch`，可包含预发布后缀 |
| `apiVersion` | 必填，本版只能为数字 `1` |
| `runtime` | `sandbox`（默认）或 `native`，只控制 Agent 代码 |
| `entries.agent` | 后端入口，默认受限环境支持单文件 JS / TS 模块 |
| `entries.web` | 可选的单文件浏览器 ES 模块，对每个视图调用其 `mount` |
| `entries.tui` | 预留的终端资源入口；v1 的终端页面使用 `contributes.ui[].text`，不执行此入口 |
| `webAssets` | 动态注册的视图可读取的文件白名单 |
| `profiles` | `standard` / `pro`，省略则均支持 |
| `permissions` | 需要的公开能力列表，未知能力报错 |
| `dependencies` | 必需插件 ID 到版本范围的映射 |
| `optionalDependencies` | 已安装并兼容时建立顺序的可选依赖 |
| `configuration` | 插件配置的 JSON Schema 子集 |
| `contributes` | UI、主题、提示词和 skill 的声明式贡献 |
| `description` / `license` | 可选说明与许可证 |

依赖范围支持精确版本、`^1.2.3`、`~1.2.3` 和 `*`。预发布版本按精确版本匹配。依赖需要先安装并启用，管理器不会自动执行远程安装。循环依赖会失败。停用依赖前需先停用使用它的插件；卸载前需先移除仍声明该必需依赖的包。

## 配置 Schema 子集

支持 `type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`default`、`title`、`description`、`minimum`、`maximum`、`minLength`、`maxLength`、`minItems`、`maxItems`。

`type` 必须明确，根配置和工具参数必须是 object。最多嵌套 16 层。不支持的关键字会报错，不会悄悄忽略验证。默认值应用于顶层配置字段。配置提交后完整验证，再写入文件；失败时磁盘和运行中的配置保持原值。`__proto__` 等保留键不能用作配置属性。

配置会传给插件自己的运行实例，也能在管理界面查看。不要把宿主模型 API Key 复制到配置中；本版不提供插件凭据存储接口。

## 贡献定义

UI 项包含 `id`、`slot`、`title`，可使用 `order`、`view`、`command`、`text`、`insert`、`height`、`match`、`platforms`。详见 [UI SDK](ui-sdk.md)。

提示词项包含 `id`，以及二选一的 `text` / `file`；可配置 `slot`、`order`、`roles` 和 `replace`。Skill 使用 `SKILL.md` 相对路径数组。

主题是 CSS 变量到简单值的映射。路径必须位于包内，使用正斜线；符号链接、特殊文件和路径逃逸不允许。包最多 2000 个文件、32 MiB 原始内容，清单最多 128 KB，提示词 / skill 资源最多 64 KB，浏览器单个视图最多 1 MB。
