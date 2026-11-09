# Skill 与提示词

## Skill 格式和触发

```text
skills/review/
  SKILL.md
  references/
  scripts/
  assets/
```

`SKILL.md` 使用简短 front matter：

```md
---
name: review
description: Review code for concrete regressions and verification gaps.
---

Read the changes and their callers. Report findings supported by evidence.
```

本版解析单行 name / description；复杂 YAML、折叠字符串不属于此格式。name 应使用便于命令引用的短名称，例如 `review`。

清单注册：

```json
{ "permissions": ["prompts.contribute"],
  "contributes": { "skills": ["skills/review/SKILL.md"] } }
```

代码插件也可在 activate 中使用 `ctx.skills.register('skills/review/SKILL.md')`。

提示词首先只包含 skill 名称和描述。完整正文仅在当前请求使用以下显式引用时加入：

```text
/skill community.review-skills/review 审查这次修改
```

浏览器输入框工具栏提供 skill 选择器。普通文本提到某个名称不会自动执行脚本或加载全部 skill 正文。

resources 目录随包分发。skill 中的脚本不会自动执行；需要可执行能力时，另注册工具或命令，由宿主能力桥接执行。纯 skill 不需要 JS 入口。现有文件夹可添加最小的清单后直接安装。

## 提示词片段

```json
{
  "permissions": ["prompts.contribute"],
  "contributes": {
    "prompts": [
      { "id": "style", "file": "prompts/style.md", "slot": "rules", "order": 100 },
      { "id": "persona", "text": "You are a careful reviewer.", "slot": "persona", "replace": true, "roles": ["main"] }
    ]
  }
}
```

先按 persona / rules / context 排序，再按 order 和完整 ID 排序。`roles` 省略时用于适用的业务 Agent，指定时精确匹配运行角色。常见角色包括 main、subagent，以及 main_model、plan_model、backend_output_model 等 Pro 角色。审批角色 confirm_model / reviewer 不接受插件人格与片段注入。

replace 片段只有在 `persona` 提供者中被选中才生效，其他 replace 项不自动追加。普通片段加在所选基础提示词之后，并带有来源 ID。动态、与模型调用相关的上下文可以通过 request.before 的 systemSuffix 提供。

宿主任务原始约束、权限、预算和执行策略由运行时另外保留。改写人格或规则不能授予文件权限、扩展子 Agent 的写入范围或跳过审批。

## 检查实际生效内容

插件页的“当前回合诊断”显示最近的插件提示词片段和运行错误。`task_run.plugins` 保存包版本与配置；任务 journal 的 `plugin_prompt` 和 `plugin_request_suffix` 保存组装与请求补充记录。

配置或文件更新不会改变已经开始的回合。需要验证新片段时，保存配置后开始下一回合。子 Agent 使用同一份插件版本组合，并按自身角色选择提示词。
