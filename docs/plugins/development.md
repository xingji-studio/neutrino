# 开发、打包、测试与发布

## 创建插件

```sh
neutrino plugin create ./my-plugin
```

命令复制文本工具示例，不覆盖现有目录。修改清单 ID、名称、版本和权限，再安装该目录。安装复制源码快照；编辑源文件后执行 update 才会进入新回合。

使用 TypeScript 时安装 Neutrino 的开发依赖并导入 `@xingjisoft/neutrino/plugin` 类型。默认沙箱可处理单文件 JS/TS；涉及第三方依赖时用项目现有构建工具打包为一个文件，不要依赖运行时下载。浏览器入口也需打包为单个 ESM。

native 后端使用 `.mjs`，或随包提供 `package.json` 且设置 `"type": "module"`。Node 不会自动把任意 `.js` 当作 ESM。使用原生依赖时将其打包或按 Node 的标准解析规则部署；安装器不复制 node_modules，也不会执行 install 脚本。

## 调试循环

```sh
neutrino plugin install ./my-plugin
neutrino plugin enable acme.my-plugin
neutrino plugin doctor
# 编辑源文件后
neutrino plugin update acme.my-plugin
```

doctor 激活已启用的后端、显示工具和命令及错误，然后清理实例。它没有活动会话，文件、进程和网络桥接不可用。activate 应只注册贡献，不执行用户任务。

配置表单与命令行配置走同一 Schema。通过 `ctx.log` 查看回合诊断；实际工具调用和插件提示词保存在任务 journal。遇到重复名称、未知 Schema 关键字、资源路径错误、未声明效果、原生信任失效时，优先修复清单或声明。

## 离线包

```sh
neutrino plugin pack ./my-plugin ./my-plugin-1.0.0.neutrino-plugin
neutrino plugin install ./my-plugin-1.0.0.neutrino-plugin
```

插件包是 `format: neutrino-plugin`、`version: 1` 的 JSON 容器，包含相对路径、base64 内容和完整性散列。相同目录得到相同内容；输出文件不能放进源包目录。安装器验证每个路径、大小和完整性，不执行解压脚本。包的完整性散列用于检测变化，不等于发布者签名。

更新时重新打包并替换原包文件，再执行 update。回滚恢复上一个包指针，原生信任仍按当前字节散列校验。

## 测试

```sh
npm run test:plugins
npm test
```

插件测试覆盖真实 QuickJS 执行、能力限制、原生信任、配置快照、只读子任务、宿主审批、证据、skill、提示词、包和回滚，以及本地 HTTP 管理接口。HTTP 检查需要允许监听本机回环端口。测试使用临时的 NEUTRINO_HOME / NEUTRINO_PLUGIN_HOME。

发布前至少手动验证一次浏览器与终端：启用、停用、切换 Standard/Pro、草稿冲突、视图失败恢复、运行中更新、旧会话阅读。修改 SDK 时维护已有插件示例，并确保 npm 打包结果包含 dist、web、examples/plugins 和 docs/plugins。

## 发布约定

公开版本使用语义化版本；不兼容行为提高主版本。apiVersion 与包版本分别管理。所需权限、外部效果、支持平台和原生信任要求应写在 README。分发构建后的本地目录或离线包即可；本版没有远程市场或自动依赖安装。

不要导入 dist 下的私有内部模块。新增公开方法需要同步类型、权限检查、生命周期清理、文档和行为测试。无法在卸载时撤销的全局副作用不应作为普通受限插件功能。
