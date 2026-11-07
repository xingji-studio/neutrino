// Interface translations for the Neutrino web console.
//
// English source strings are the lookup keys. `t()` returns the source text
// unchanged when a translation is missing, so a new label can never render as
// an internal identifier — it simply stays in English until it is translated.
// Translation values may use `{name}` placeholders; `t()` fills them in.

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "zh", label: "简体中文" },
];

export function normalizeLanguage(value) {
  return String(value ?? "").trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

let current = "en";

export function getLanguage() {
  return current;
}

export function setLanguage(value) {
  current = normalizeLanguage(value);
  return current;
}

function interpolate(template, values) {
  if (!values) return template;
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}

export function t(source, values) {
  const text = String(source ?? "");
  const translated = current === "zh" ? ZH[text] : undefined;
  return interpolate(translated ?? text, values);
}

/** True when the Chinese dictionary covers this English source string. */
export function hasTranslation(source) {
  return Object.prototype.hasOwnProperty.call(ZH, String(source ?? ""));
}

// Apply every `data-i18n*` annotation under `root`. The attribute value is the
// English source string, so switching back to English always works without
// keeping a second copy of the DOM.
export function applyTranslations(root = typeof document === "undefined" ? null : document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const node of root.querySelectorAll("[data-i18n]")) {
    node.textContent = t(node.getAttribute("data-i18n"));
  }
  for (const node of root.querySelectorAll("[data-i18n-html]")) {
    // Translations are authored locally (never model or user output), so the
    // small amount of markup they carry is safe here.
    node.innerHTML = t(node.getAttribute("data-i18n-html"));
  }
  for (const node of root.querySelectorAll("[data-i18n-title]")) {
    node.title = t(node.getAttribute("data-i18n-title"));
  }
  for (const node of root.querySelectorAll("[data-i18n-placeholder]")) {
    node.placeholder = t(node.getAttribute("data-i18n-placeholder"));
  }
  for (const node of root.querySelectorAll("[data-i18n-aria-label]")) {
    node.setAttribute("aria-label", t(node.getAttribute("data-i18n-aria-label")));
  }
  if (typeof document !== "undefined" && root === document) {
    document.documentElement?.setAttribute?.("lang", current === "zh" ? "zh-CN" : "en");
  }
}

export function isChinese() {
  return current === "zh";
}

/** Locale tag for `toLocaleDateString` and friends. */
export function locale() {
  return current === "zh" ? "zh-CN" : "en-US";
}

const ZH = {
  "Agent mode": "Agent 模式",
  "Standard mode": "标准模式",
  "PTC mode": "PTC模式",
  "Fast mode": "快速模式",
  "Professional mode": "专业模式",
  "Full-featured Agent for every scenario": "功能完整的Agent，适用于所有场景",
  "All standard capabilities, with code-based planning to save tokens": "拥有标准模式所有功能，通过代码实现规划，节省Token",
  "Less thinking and fewer calls for quick answers": "减少思考和调用，迅速回答问题",
  "Assign tasks to the best-suited models so multiple models complement each other": "适合需要多个模型取长补短的任务，将任务分给最适合他的模型",
  "Applies to the next turn": "从下一轮开始生效",
  "Changing mode…": "正在切换模式…",
  "Could not change mode: {error}": "无法切换模式：{error}",
  "Select a working directory first.": "请先选择工作目录。",
  "Program": "程序",

  "Pro preset": "Pro 预设",
  "Preset": "预设",
  "Neutrino Pro": "Neutrino Pro",
  "Model details": "详细模型配置",
  "Main model": "主模型",
  "Reasoning model": "推理模型",
  "Frontend model": "前端补全模型",
  "Backend model": "后端补全模型",
  "Approval model": "审批模型",
  "Image model": "生图模型",
  "Planning model": "规划模型",
  "Modeling model": "建模模型",
  "Reserved": "预留",
  "Temporary fallback": "临时降档",
  "No available model": "无可用模型",
  "Checking every professional model before this task…": "正在检查本次任务的各个专业模型…",
  "Pause the current turn to change presets.": "请暂停当前任务后再切换预设。",
  "Models are checked before each task. Unavailable roles temporarily use a lower preset.": "每次任务开始前检查模型；不可用的角色临时使用低档位对应模型。",
  "Pro orchestration": "Pro 智能体协作",
  "Default Pro preset": "默认 Pro 预设",
  "Maximum delegation depth": "最大调用递归深度",
  "Every Pro task is planned first. All roles share the regular provider configuration. Image generation is reserved.": "每个 Pro 任务均先进行规划。各角色共用普通模式的供应商配置，生图功能暂时预留。",
  "Edit role models, intensity and context windows in ~/.neutrino/pro/model.json. Default delegation depth: 10.": "在 ~/.neutrino/pro/model.json 中配置各角色模型、强度与上下文窗口。默认调用递归深度为 10。",
  "Choose a working directory and a professional team preset.": "选择工作目录和专业模型团队预设。",
  "Professional model availability": "专业模型可用性检查",
  "These model substitutions apply only to this task in this conversation. Your preset configuration is unchanged.": "以下模型替换仅对当前对话的本次任务生效，不会修改预设配置文件。",
  "Got it": "知道了",
  "A new version is available": "有新版本可用",
  "Neutrino updates itself with npm. Restart it afterwards to use the new version.": "Neutrino 通过 npm 自动更新，更新完成后请重新启动以使用新版本。",
  "Running {current} · published {latest}": "当前版本 {current} · 最新版本 {latest}",
  "Update now": "立即更新",
  "Later": "稍后",
  "Updating with npm…": "正在通过 npm 更新…",
  "Updated to {version}. Restart Neutrino to use it.": "已更新到 {version}，请重新启动 Neutrino 以使用新版本。",
  "Update failed: {error}": "更新失败：{error}",
  "Update by hand with:": "也可以手动更新：",
  "Updates": "更新",
  "Check for updates": "检查更新",
  "Checking for updates…": "正在检查更新…",
  "Version {latest} is available. This install runs {current}.": "发现新版本 {latest}，当前安装为 {current}。",
  "Neutrino {version} is up to date.": "Neutrino {version} 已是最新版本。",
  "Update check failed: {error}": "检查更新失败：{error}",
  "Neutrino checks npm for new releases every 30 minutes. Both workspaces share that check.": "Neutrino 每 30 分钟通过 npm 检查一次新版本，普通模式与 Pro 模式共用该检查。",
  // -- chrome -------------------------------------------------------------
  "Neutrino": "Neutrino",
  "Switch to Pro mode": "切换至Pro模式",
  "Exit Pro mode": "返回普通模式",
  "Click the badge to switch to Pro mode": "点击徽标切换至Pro模式",
  "Dismiss": "关闭提示",
  "Refresh conversations": "刷新会话",
  "Settings": "设置",
  "Send message": "发送消息",
  "Close": "关闭",
  "Close settings": "关闭设置",
  "Back to conversations": "返回会话列表",
  "Select a conversation": "选择一个会话",
  "connecting…": "连接中…",
  "reconnecting…": "重新连接中…",
  "online": "在线",
  "offline": "离线",
  "locked": "已锁定",
  "live": "实时",
  "Local agent console": "本地 Agent 控制台",
  "Interface language": "界面语言",
  "New conversation": "新建对话",
  "All directories": "所有目录",
  "Working directory": "工作目录",
  "Working directories": "工作目录",
  "Other agents": "其他 Agent",
  "Migrate session": "迁移会话",
  "Migrating…": "迁移中…",
  "Copy this history into a new Neutrino conversation in the same folder": "将历史复制为同一工作目录下的新 Neutrino 会话",
  "Could not migrate this session: {error}": "无法迁移此会话：{error}",
  "session not found in this working directory": "此工作目录中未找到该会话",
  "this session has no messages to migrate": "此会话没有可迁移的消息",
  "Read-only sessions recorded by other coding agents in this working directory.": "其他编码 Agent 在此工作目录中记录的只读会话。",
  "No saved sessions from other agents in this folder.": "此文件夹中暂无其他 Agent 保存的会话。",
  "Claude Code": "Claude Code",
  "Codex": "Codex",
  "OpenCode": "OpenCode",
  "Could not load other agents' history: {error}": "无法加载其他 Agent 的历史记录：{error}",
  "Could not load this session: {error}": "无法加载此会话：{error}",
  "Choose a working directory to browse and start conversations in.": "选择一个工作目录，在其中浏览并开始对话。",
  "Open folder…": "打开文件夹…",
  "Open working directory": "打开工作目录",
  "Choose a folder to open as the working directory.": "选择一个文件夹作为工作目录。",
  "This folder no longer exists.": "此文件夹已不存在。",
  "{n} conversations": "{n} 个对话",
  "Recent folders": "最近文件夹",
  "No recent folders.": "暂无最近文件夹。",
  "Folders": "文件夹",
  "No subfolders.": "没有子文件夹。",
  "Open": "打开",
  "Up": "上一级",
  "New folder": "新建文件夹",
  "Folder name": "文件夹名称",
  "Create": "创建",
  "Cancel": "取消",
  "Use this folder": "使用此文件夹",
  "This folder": "当前文件夹",
  "Loading folders…": "正在加载文件夹…",
  "Could not open this folder: {error}": "无法打开此文件夹：{error}",
  "Folder created.": "文件夹已创建。",
  "Enter a folder name.": "请输入文件夹名称。",
  "Use an absolute path, for example C:\\projects or /home/me/projects.": "请使用绝对路径，例如 C:\\projects 或 /home/me/projects。",
  "This working directory is used for the conversation's tools.": "该工作目录将用于对话中的工具操作。",
  "New folder…": "新建文件夹…",

  // -- new conversation ---------------------------------------------------
  "Choose a working directory and a model.": "选择工作目录和模型。",
  "Start conversation": "开始对话",
  "Starting…": "正在启动…",
  "Creating…": "正在创建…",
  "Provider": "服务商",
  "Model": "模型",
  "Conversation model": "对话模型",
  "Conversation model: {selection}": "对话模型：{selection}",
  "Choose a model": "选择模型",
  "(unavailable)": "（不可用）",
  "Low": "低",
  "Medium": "中",
  "High": "高",
  "Max": "极高",
  "Ultra": "超高",
  "Thinking": "思考强度",
  "Default approval mode": "默认审批模式",
  "Request Approval": "请求审批",
  "Auto Approval": "自动审批",
  "Delete-class calls still ask a human unless extreme-risk auto-approval is enabled in Settings.": "除非在设置中启用极高风险自动审批，删除类命令仍会询问用户。",
  "This model has no API key configured. Add one in the terminal model screen, or choose another model.": "该模型尚未配置 API 密钥。请在终端模型界面添加密钥，或选择其他模型。",
  "Could not start the conversation: {error}": "无法开始对话：{error}",
  "Choose another folder": "选择其他文件夹",
  "Browse…": "浏览…",

  // -- conversation -------------------------------------------------------
  "No conversation open": "未打开对话",
  "Choose a conversation from the sidebar to view it.": "从侧边栏选择一个对话查看。",
  "No conversations yet.": "暂无对话。",
  "No conversations in this folder yet.": "此文件夹中暂无对话。",
  "New conversation in this folder": "在此文件夹中新建对话",
  "Type a message below to start a conversation in this folder.": "在下方输入消息，即可在此文件夹中开始对话。",
  "Send a message to get started.": "发送一条消息开始对话。",
  "This conversation is empty.": "此对话为空。",
  "This live session has ended.": "此实时会话已结束。",
  "Session ended": "会话已结束",
  "The terminal session was closed.": "终端会话已关闭。",
  "Connecting…": "连接中…",
  "Loading…": "加载中…",
  "Conversation": "对话",
  "Could not load this conversation: {error}": "无法加载此对话：{error}",
  "Read-only": "只读",
  "Continue here": "在此继续",
  "Resume this conversation in the browser and keep chatting": "在浏览器中恢复此对话并继续聊天",
  "Could not continue this conversation: {error}": "无法继续此对话：{error}",
  "Continue this conversation…": "继续此对话…",
  "Message Neutrino…": "向 Neutrino 发送消息…",
  "Message Neutrino in this folder…": "在此文件夹中向 Neutrino 发送消息…",
  "Enter to send · Shift + Enter for a new line": "Enter 发送 · Shift + Enter 换行",
  "to send": "发送",
  "for a new line": "换行",
  "just now": "刚刚",
  "{n}m ago": "{n} 分钟前",
  "{n}h ago": "{n} 小时前",
  "{n} message": "{n} 条消息",
  "{n} messages": "{n} 条消息",
  "Show less": "收起",
  "Show {n} more": "再显示 {n} 个",
  "Live": "实时",
  "Running": "运行中",
  "Waiting for approval": "等待审批",
  "Earlier conversation · {n} messages": "更早的对话 · {n} 条消息",
  "Context summary · {n} messages": "上下文摘要 · {n} 条消息",
  "You": "你",
  "You: {text}": "你：{text}",
  "{n} of {m} messages folded": "已折叠 {n}/{m} 条消息",
  " — click to expand": " — 点击展开",
  " — click to collapse": " — 点击收起",
  "Clear": "清空",
  "Clear conversation": "清空对话",
  "Clear this conversation and start a fresh one in the same folder? The current transcript stays saved.": "清空此对话并在同一文件夹中重新开始？当前记录仍会保存在历史中。",
  "Conversation cleared.": "对话已清空。",
  "Could not clear this conversation: {error}": "无法清空此对话：{error}",
  "Delete": "删除",
  "Delete conversation": "删除对话",
  "Delete this conversation? Its saved history will be removed.": "删除此对话？已保存的历史记录将被移除。",
  "Conversation deleted.": "对话已删除。",
  "Could not delete this conversation: {error}": "无法删除此对话：{error}",

  // -- live status --------------------------------------------------------
  "paused": "已暂停",
  "Stopping tasks…": "正在停止任务…",
  "Blocked": "受阻",
  "Cancelled": "已取消",
  "Skipped": "已跳过",
  "working": "处理中",
  "idle": "空闲",
  "compressing": "正在压缩上下文",
  "retrying {attempt}/{attempts}": "重试 {attempt}/{attempts}",
  "reviewing": "自动审查中",
  "reviewing · {n} reviewer": "自动审查中 · {n} 位审查者",
  "reviewing · {n} reviewers": "自动审查中 · {n} 位审查者",
  "reviewing round {round}/{rounds}": "自动审查中 第 {round}/{rounds} 轮",
  "sub-agent: {label}": "子智能体：{label}",
  "History save failed: {error}": "历史保存失败：{error}",
  "Resume": "继续",
  "Pause": "暂停",
  "queued": "已排队",
  "{prompt}→{completion} tok": "{prompt}→{completion} tok",

  // -- approval -----------------------------------------------------------
  "Approval required": "需要审批",
  "EXTREME RISK": "极高风险",
  "HIGH RISK": "高风险",
  "Independent review": "独立审查",
  "round {round} of {rounds}, ": "第 {round}/{rounds} 轮，",
  "{n} reviewer": "{n} 位审查者",
  "{n} reviewers": "{n} 位审查者",
  "Working directory: {path}": "工作目录：{path}",
  "Why: ": "原因：",
  "All arguments": "全部参数",
  "Approve": "批准",
  "Deny": "拒绝",
  "Command details unavailable.": "命令详情不可用。",
  "Tool call": "工具调用",
  "Switch between requesting approval and automatic review": "在请求审批与自动审查之间切换",
  "Could not change approval mode: {error}": "无法切换审批模式：{error}",

  // -- plan / usage -------------------------------------------------------
  "Plan": "计划",
  "Usage": "用量",
  "No plan for this turn.": "本回合没有计划。",
  "Done": "已完成",
  "Active": "进行中",
  "Pending": "待处理",
  "Failed": "失败",
  "Stopped": "已停止",
  "{done} of {total} steps done": "已完成 {done}/{total} 步",
  "Prompt": "提示",
  "Completion": "补全",
  "Total": "总计",
  "tokens": "tokens",
  "Show plan": "显示计划",
  "Hide plan": "隐藏计划",

  // -- settings -----------------------------------------------------------
  "Models, approvals, and console access.": "模型、审批与控制台访问。",
  "Defaults for new conversations": "新对话的默认设置",
  "Thinking intensity": "思考强度",
  "Apply": "应用",
  "Conversation and approvals": "对话与审批",
  "Model context window (tokens)": "模型上下文窗口（tokens）",
  "Auto-compress at 80% of this model's context window. Default: 1,000,000 tokens.": "当上下文达到该模型窗口的 80% 时自动压缩。默认：1,000,000 tokens。",
  "Approval reviewer model": "审批审查模型",
  "Same as conversation": "与对话相同",
  "Extreme-risk auto-approval (del class, 3 separate review rounds)": "极高风险自动审批（删除类命令，独立审查 3 轮）",
  "Sound alerts (turn finished, approval waiting)": "声音提醒（回合结束、等待审批）",
  "Start the Web console with the terminal": "随终端启动 Web 控制台（下次启动生效）",
  "Background residency": "后台常驻",
  "Run the Web console in the background and keep browser tasks alive after the CLI exits": "让 Web 控制台在后台运行，CLI 退出后浏览器中的任务继续执行",
  "Off by default. Changes take effect immediately, including for running browser tasks. The regular and Pro workspaces share this setting. Terminal conversations still end when the terminal closes.": "默认关闭。切换立即生效，正在运行的浏览器任务也会受到保护；普通模式与 Pro 模式共用此设置。终端内的对话仍会在终端关闭时结束。",
  "Enable background residency to avoid accidentally interrupting tasks": "建议开启后台常驻，避免误触中断任务",
  "Enable": "开启",
  "Background residency is on. Browser tasks keep running after the terminal closes.": "后台常驻已立即开启。关闭终端后，浏览器任务会继续执行。",
  "Background residency is off. Current tasks can finish before the console closes.": "后台常驻已立即关闭。控制台退出前会等待当前任务完成。",
  "Background residency could not be applied. Restart the console and try again.": "后台常驻未能生效，请重启控制台后重试。",
  "Safety determines automatic approval; task relevance only blocks unanimously confirmed, extreme mismatches. Delete-class automatic approval also requires this setting.": "自动审批取决于安全性；任务相关性只有在两位审查者一致确认极端不匹配时才会阻止执行。删除类命令的自动审批还需要开启此设置。",
  "Web access": "Web 访问",
  "Allow access from other devices (LAN, 0.0.0.0)": "允许其他设备访问（局域网，0.0.0.0）",
  "Binds the Web console to 0.0.0.0 so other devices on your network can open it, like --lan. Takes effect immediately; turning it off returns the console to 127.0.0.1. Keep the Web password on: anyone who can reach this port can drive the agent.": "将 Web 控制台绑定到 0.0.0.0，使局域网内的其他设备也能打开（等同于 --lan）。立即生效；关闭后恢复为 127.0.0.1。请保持 Web 密码开启：任何能访问此端口的人都可以驱动该 Agent。",
  "LAN access is on. Open {urls} from another device.": "局域网访问已开启。请在其他设备上打开 {urls}。",
  "LAN access is on, but no network address was found. Only this machine can connect.": "局域网访问已开启，但未找到可用的网络地址，目前只能在本机访问。",
  "LAN access is off. Only this machine can connect.": "局域网访问已关闭，现在只能在本机访问。",
  "New Web password": "新的 Web 密码",
  "Confirm password": "确认密码",
  "Leave blank to keep current password": "留空则保留当前密码",
  "Repeat new password": "再次输入新密码",
  "The password is permanent and survives restarts. Default: 114514. Saving a new password signs out other browsers.": "密码永久有效，重启后仍保留。默认：114514。保存新密码会使其他浏览器退出登录。",
  "Save changes": "保存更改",
  "Language": "语言",
  "Interface": "界面",
  "Plan-first turns": "先规划后执行",
  "Split multi-step requests into a plan before answering.": "回答前先将多步骤请求拆分为计划。",
  "Default approval mode for new conversations.": "新对话的默认审批模式。",
  "Applying…": "正在应用…",
  "Apply to conversation": "应用到对话",
  "Continue with model": "使用该模型继续",
  "Applies to the next turn.": "应用于下一回合。",
  "Pause the current turn to change models.": "请先暂停当前回合再切换模型。",
  "Model and intensity updated.": "模型与思考强度已更新。",
  "Auto-compress at 80%: {tokens} tokens. Applies to this model in all conversations.": "达到 80% 时自动压缩：{tokens} tokens。应用于所有对话中的该模型。",
  "Enter a positive whole number of tokens. Default: 1,000,000.": "请输入正整数的 token 数量。默认：1,000,000。",
  "Defaults apply to new conversations. Other settings apply to future turns.": "默认设置应用于新对话；其他设置应用于之后的回合。",
  "Passwords do not match.": "两次输入的密码不一致。",
  "Password cannot be blank.": "密码不能为空。",
  "Settings saved.": "设置已保存。",
  "Settings saved. Web password updated permanently.": "设置已保存。Web 密码已永久更新。",
  "(API key missing)": "（未配置 API 密钥）",

  // -- login / server -----------------------------------------------------
  "Sign in": "登录",
  "Enter your Web password to open this console. The default password is 114514.": "输入 Web 密码以打开控制台。默认密码为 114514。",
  "Password": "密码",
  "Could not sign in.": "无法登录。",
  "Incorrect password.": "密码错误。",
  "Password login required.": "需要密码登录。",
  "Select a conversation first.": "请先选择一个对话。",
  "pause the current turn before changing models": "请先暂停当前回合再切换模型",
  "unknown live session": "未知的实时会话",
  "session not found": "未找到会话",
  "this session cannot change approval mode": "此会话无法切换审批模式",
  "this session has ended": "此会话已结束",
  "this session cannot change models": "此会话无法切换模型",
  "this session is owned by the terminal UI": "此会话由终端界面管理",
  "working directory is required": "需要工作目录",
  "working directory must be an absolute path": "工作目录必须是绝对路径",
  "working directory does not exist": "工作目录不存在",
  "working directory is not a folder": "工作目录不是文件夹",
  "folder already exists": "文件夹已存在",
  "folder name is required": "需要文件夹名称",
  "folder name cannot contain a path separator": "文件夹名称不能包含路径分隔符",
  "parent folder does not exist": "父文件夹不存在",
  "cannot create a folder here": "无法在此创建文件夹",
  "invalid settings body": "设置内容无效",
  "invalid settings": "设置无效",
  "unknown settings field": "未知的设置项",
  "invalid language": "语言无效",
  "invalid plan setting": "计划设置无效",
  "invalid approval mode": "审批模式无效",
  "invalid model selection": "模型选择无效",
  "invalid request": "请求无效",
  "invalid session id": "会话 ID 无效",
  "invalid JSON body": "JSON 内容无效",
  "empty message": "消息不能为空",
  "cannot delete a running conversation": "无法删除正在运行的对话",
  "this session cannot be cleared": "此会话无法清空",
  "unknown agent": "未知的 Agent",
  "cannot read this folder": "无法读取此文件夹",
  "no approval is pending": "当前没有待处理的审批",
  "mode must be request or auto": "模式必须是 request 或 auto",
  "cross-origin request rejected": "跨域请求已被拒绝",
  "provider, model and intensity are required": "需要服务商、模型和思考强度",
  "invalid thinking intensity": "思考强度无效",
  "this model does not support that thinking intensity": "该模型不支持此思考强度",
  "unknown provider": "未知的服务商",
  "unknown model for this provider": "该服务商下没有此模型",
  "this model has no API key configured": "该模型尚未配置 API 密钥",
};
