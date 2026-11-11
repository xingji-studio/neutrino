# Local programmatic API / 本机程序 API

Neutrino 的后端运行时，会同时启动独立的本机 HTTP API。它只监听 IPv4 `127.0.0.1`；即使 Web 控制台开启局域网访问，本 API 也不会随之对局域网开放。默认端口为 `8766`，可在启动前设置 `NEUTRINO_API_PORT`（`0` 表示由操作系统选择空闲端口）。Web 端口设置为 `0` 时，未指定 API 端口也会自动选择空闲端口。端口被占用时后端启动失败并报告错误。API 随后端关闭而关闭。需要不启动 Web 界面时，可单独运行 `neutrino api`（可选 `--port 0` 自动选择端口），只启动本机 API；退出该进程后 API 关闭。`--no-web` 本身不会自动启动这个独立进程。

后端启动后在 `~/.neutrino/api.json` 写入连接信息；设置了 `NEUTRINO_HOME` 时使用 `$NEUTRINO_HOME/api.json`。文件内容为 `{ "pid": 123, "url": "http://127.0.0.1:8766/api/v1", "token": "..." }`，其中端口以文件中的实际地址为准。正常关闭时文件会删除；异常退出可能留下旧文件，连接失败时应检查进程和重新读取文件。多个使用同一数据目录的独立服务会共用发现文件，最后启动的服务会更新它。不要把 token 分享到日志、URL 或网页。Unix 上文件以 `0600` 创建；Windows 的访问控制取决于用户目录的 ACL。

所有请求都需要 `Authorization: Bearer <token>`；Host 必须是发现文件中的 `127.0.0.1:<port>`，带 `Origin` 的请求会被拒绝。使用编程语言的 HTTP 客户端访问；这个接口不开放浏览器跨域调用。接口中的路径均相对于 `api.json` 的 `url`。Pro 工作区在路径开头添加 `/pro`，例如 `/pro/conversations`、`/pro/live/:key/events`。普通和 Pro 的会话、历史互相隔离。

## 开始对话

1. `GET /models` 查看服务商、模型和支持的思考强度；`GET /capabilities` 查看模式。Pro 使用 `GET /pro/models` 查看团队预设。
2. `POST /conversations` 创建对话：

   ```json
   {
     "cwd": "/absolute/path/to/project",
     "selection": { "provider": "Provider", "model": "Model", "intensity": "High" },
     "agent_mode": "standard",
     "approval_mode": "request"
   }
   ```

   `cwd` 必须是存在的目录。`selection` 指已配置模型；可选 `agent_mode` 为 `standard`、`ptc`、`fast` 或 `fast_dag`，后者还受现有 Fast 可用性配置约束。审批模式为 `request` 或 `auto`。不传的字段沿用当前工作区默认值。返回 `{ok, key, cwd, snapshot}`；`key` 是当前进程中的活动会话标识，重启后应通过历史记录恢复。

   Pro 创建使用 `POST /pro/conversations` 和 `{ "cwd": "...", "pro_preset": "medium", "approval_mode": "request" }`。Pro 按团队预设选择各角色的模型与强度，不能通过普通 `agent_mode` 指定其他执行模式。
3. 建议先连接 `GET /live/:key/events`，再 `POST /live/:key/message`，请求体 `{ "text": "请检查这个项目" }`。运行中的消息按现有 Web 行为排队；请求也可带 `agent_mode` 指定下一回合的模式。
4. 流中出现 `snapshot.approval` 或 `approval.requested` 时，使用 `POST /live/:key/approvals/:approval_id` 答复 `{ "approved": true }` 或 `{ "approved": false }`。必须传 JSON 布尔值。请求已取消、已回答或 ID 已过期时返回 `409`；不能用旧 ID 回答新请求。多个审批会依次呈现。`auto` 模式仍遵循现有的自动审查和极高风险规则。

`examples/local-api.py` 是标准库示例：

```sh
python3 examples/local-api.py --cwd /path/to/project \
  --provider Provider --model Model --intensity High --mode standard \
  '请检查这个项目'
```

示例订阅输出与状态并在终端询问审批；按 Ctrl+C 可退出客户端。退出或断线不会自动停止服务端任务、批准或拒绝待处理审批；可重新连接并在快照中找到待处理请求，或调用暂停接口。长任务客户端应实现重连，保存事件 ID，并同时展示完整快照中的消息；示例只演示基础连接。

## 流式协议

`GET /live/:key/events` 返回 SSE，含 `snapshot`、`approval.requested`、`approval.resolved` 和 `gone` 事件，另有注释心跳。`snapshot` 与 Web 使用同一会话快照：

- `messages` 和 `streamingContent` 提供已记录消息、工具调用与当前流式文本；文本为当前累计值，不是增量。
- `busy`、`paused`、`queued`、`compressing`、`retrying`、`saveError`、`tokens`、`task`、`plan`、`subagent`、`fast`、`pro`、`reviewing` 和 `approval` 等字段描述运行状态。字段可为空或按模式缺省。应结合这些字段和最终消息判断结果，`busy: false` 本身不代表任务成功。
- `approval` 包含 ID、工具、完整参数、工作目录、风险等级、摘要和原因；`reviewing` 是自动审查进度，不表示正在等待人工审批。`approval.resolved` 表示该请求不再等待，并不单独声明批准还是拒绝。

快照更新采用现有 Web 的合并机制，适合实时显示当前状态，不保证逐 token 或每一次短暂中间状态都单独送达。订阅期间产生的事件带 `id`；重新连接时可用 `Last-Event-ID` 请求重放。服务端在首次订阅后为每个会话保留最近 256 个事件，且尽量限制到约 4 MiB，未连接的会话在 10 分钟后可被清理；单个大快照可能超过这个大小。重放历史不可用时发送 `reset`，随后发送当前完整 `snapshot`。每次连接都会提供当前快照；首次订阅之前的短暂事件和服务重启前的事件无法重放，历史消息请通过会话历史读取。服务支持最多 64 个同时被监视的会话，资源不足时返回 `503`。

## 其他接口

这些接口复用 Web 的业务处理，参数、响应及冲突行为与 [Web API](README.md#api) 一致；普通工作区在以下路径前加 `/api/v1`，Pro 在 `/api/v1` 后再加 `/pro`：

| 功能 | 路径 |
| --- | --- |
| 会话列表和状态 | `GET /overview`、`GET /sessions`、`GET /live/:key` |
| 活动会话控制 | `POST /live/:key/pause`、`resume`、`clear`、`close` |
| 会话配置 | `POST /live/:key/model`、`agent-mode`、`approval-mode`；Pro 使用 `pro-preset` |
| 历史记录 | `GET /session/:id`、`POST /session/:id/continue`、`POST /session/:id/delete` |
| 工作目录 | `GET/POST /workspaces`、`GET /fs?path=...`、`POST /fs/mkdir` |
| 其他 Agent 会话 | `GET /agents/:agent/sessions?cwd=...`、`GET /agents/:agent/sessions/:id`、`POST /agents/:agent/sessions/:id/migrate` |
| 插件 | `GET /plugins`、`GET /plugins/catalog`、`GET /plugins/asset`、`POST /plugins`；参见[插件文档](../docs/plugins/README.md) |
| 更新状态与操作 | `GET /update/events`、`POST /update/check`、`POST /update` |
| 侧边栏已读状态 | `GET/POST /seen` |

`GET /health` 为健康检查。`GET /live/:key/stream` 仍提供 Web 原有快照流，推荐新客户端使用 `/events`。Web 自身的 `/api/...`、登录方式和局域网行为保持不变。本 API 不提供全局设置、登录、后台服务管理接口；对话级配置和插件操作可用。终端拥有的会话不能通过 `close` 关闭，与 Web 相同。
