# Agent SDK

TypeScript 类型从 `@xingjisoft/neutrino/plugin` 导入。默认沙箱只提供该模块的 `definePlugin` 辅助函数，其余依赖必须打包进入口。

```ts
import { definePlugin } from '@xingjisoft/neutrino/plugin';

export default definePlugin({
  activate(ctx) {
    ctx.tools.register({
      name: 'greet',
      description: 'Return a greeting.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      effects: [],
      execute: args => `Hello ${args.name}`,
    });
  },
});
```

## Context 与注册

`ctx.id` 是插件 ID，`ctx.config` 是当前回合的只读配置快照，`ctx.scope` 是激活时的 profile、cwd、sessionId、role 和 request。执行函数的第二个参数是当前调用作用域；子 Agent 的 role 和 runId 应读取该参数，不要使用激活时的主 Agent role 推断权限。

`ctx.tools.register(spec)` 和 `ctx.commands.register(spec)` 接受 name、description、parameters、effects 和 execute。工具名为最多 40 字符的小写字母、数字、下划线和短横线，以字母开头；工具可声明适用的 `roles`。

工具供模型调用；命令供用户主动调用，不需要模型回合：

```text
/plugin acme.example/greet {"name":"Neutrino"}
```

返回字符串或 JSON 可序列化结果。工具结果最终规范化为字符串并限长。所有宿主操作必须 await。高风险工具和原生工具的参数 Schema 自动加入必填的 reason 字段。

`effects` 必填，可以是空数组，或 `filesystem.read`、`filesystem.write`、`network`、`process` 的组合。它与清单 permissions 同时检查。工具声明只读不等于任意代码获得了只读隔离；原生插件在只读 / 限定写入路径的子任务中不可用。

## 宿主能力

| 接口 | 效果 / 权限 | 返回 |
| --- | --- | --- |
| `ctx.fs.read(path, reason)` | filesystem.read | 文件文本 |
| `ctx.fs.list(path, reason)` | filesystem.read | 目录文本 |
| `ctx.fs.write(path, content, reason)` | filesystem.write | 执行结果文本 |
| `ctx.net.fetch(url, reason)` | network | `{ status, body }`，仅 GET，HTTP(S)，不跟随重定向，最大 1 MB |
| `ctx.process.run(command, reason)` | process | 命令输出 |
| `ctx.storage.get(key)` | storage | JSON 值或 null |
| `ctx.storage.set(key, value)` | storage | Promise<void> |
| `ctx.log(message)` | 无额外效果 | 有长度限制的诊断日志 |

文件、网络、进程能力仅在活动会话的执行回调中可用，进入相同的 TaskScope、预算、审批和取消链。路径相对于会话 cwd。storage 用于插件自己的数据，不提供任意文件访问；单值最多 256 KB、每插件最多 128 个键和 8 MiB，键只能包含字母、数字、点、下划线、短横线。

## 钩子和事件

`ctx.hooks.add(name, handler)` 注册顺序执行的钩子。输入是副本，原始用户消息和已审批参数不受原地修改影响。

| 名称 | 输入 | 允许的结果 |
| --- | --- | --- |
| request.before | provider、model、role、toolCount | `{ systemSuffix?: string, deny?: boolean, reason?: string }` |
| tool.before | name、arguments | `{ deny?: boolean, reason?: string }` |

请求钩子只在工具回合调用；审批评审模型的提示词不经过插件拼接。工具钩子发生在原审批入口之前，只能收窄决策，不能把宿主拒绝变成允许，也不能修改已审批参数。钩子失败会拒绝对应操作。请求补充文本会记录到任务 journal。

`ctx.events.on(name, handler)` 注册观察器：

| 名称 | 内容 |
| --- | --- |
| turn.started | 当前原始请求 |
| tool.finished | 工具名、状态、证据 ID |
| turn.finished | 取消状态、工具证据概要 |

观察器失败记录为插件错误，不改变主任务的结果。钩子和事件没有文件、网络、进程效果，不能通过观察器偷偷启动外部操作；可以使用获授的插件 storage。处理函数应快速结束。

## 提示词、Skill、UI 与插件服务

`ctx.prompts.register(spec)` 使用与清单相同的提示词定义。`ctx.skills.register(file)` 注册包内 skill 资源。`ctx.ui.register(spec)` 使用与清单相同的 UI 定义；动态 HTML 视图路径必须出现在 `webAssets`。动态 UI 会随会话快照发布，若希望在尚未开始回合时展示，请在清单中声明。

插件之间通过命令作为服务边界：

```js
const result = await ctx.services.call('acme.helper', 'summarize', { text });
```

需在 dependencies 或 optionalDependencies 中声明目标插件。被调用命令的外部效果不能超过调用方已声明的效果。循环调用和超过八层的调用会被拒绝。

## 清理

注册函数返回 `{ dispose() }`。`ctx.effect(dispose)` 可登记资源清理；activate 也可返回清理函数。effect 按逆序清理。结束回合时宿主释放注册表与进程。沙箱没有 Node 计时器、全局 fetch、文件系统或 Node 模块；异步工作通过宿主桥接完成。
