# 对话卡住修复：验证记录

日期：2026-11-19（北京时间）。Windows Node v24.12.0；Linux Node v26.13.1。

## 本次修复验证

- TypeScript 构建通过。
- Windows 与 Linux 命令生命周期回归通过：标准输入 EOF、输出及退出码、父进程先退出后的后代回收、暂停后没有延迟写入、后台句柄隔离、任务完成自动清理、命令超时和清理失败状态。
- 真实 Standard WebSession 使用本地模型夹具验证暂停后可直接继续；不调用外部模型。
- 网页恢复回归通过：暂停应答快照、HTTP 回退、心跳断流检测、旧快照及旧连接事件保护、导航竞态。
- 实际 HTTP/SSE 测试通过：暂停/继续返回版本化快照，任务没有变化时仍收到显式心跳。
- 子代理目录、网页设置和更新界面兼容性回归通过。
- 本地 npm 安装包包含 Windows 管理脚本和新命令模块，依赖列表与原全局安装相同。

## 完整回归的限制

完整 Windows 测试集共 95 项，89 项通过。以下 6 项在将本次修改的核心模块还原为 HEAD 的独立基线中也能复现，故未在本次修复中扩展修改其业务逻辑：

| 测试 | 失败位置或现象 |
| --- | --- |
| `test-search-network.mjs` | 网络代理测试的环境变量优先级场景出现 `UND_ERR_SOCKET` |
| `test-standard-revision.mjs` | Windows 绝对检查脚本路径的 `checker_source` 为 null |
| `test-local-api.mjs` | Windows 子进程被 SIGTERM 终止后，测试目录中的 API 状态文件仍存在 |
| `test-pro-team.mjs` | 嵌套后端夹具未产生预期 `pro-success` 内容 |
| `test-plugin-web.mjs` | Node 24 的全局 `crypto` 为只读 getter，旧测试直接赋值失败 |
| `test-fast-efficiency.mjs` | Windows 工作区路径边界测试缺少预期异常 |

通过修复前后的对照，未发现本次改动新增的回归失败。该记录不表示整个项目的测试集已全绿。

## 本机应用结果

已在后台没有运行或暂停任务时应用本地修复安装包并重新启动服务，健康检查通过，实际 HTTP 返回修复后的网页资源。首次切换的就绪检查遇到连接错误后已回滚；使用新连接并等待就绪后切换成功。

原全局安装保存在 Windows 临时目录的 `neutrino-before-pause-repair-20261119-vJRv7m` 下。本地安装包位于同一临时目录的 `neutrino-pause-repair-release/xingjisoft-neutrino-0.7.0.tgz`，未向 npm 发布。配置、模型凭据和保存的会话目录不包含在安装覆盖范围内。
