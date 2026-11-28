# 浏览器工作台（Browser Workbench）AI 专属工作区

本文件夹是「浏览器工作台（Browser Workbench）」的固定 AI 专属工作夹，同时支持 **Google Antigravity** 与 **OpenAI Codex**，且仅在打开本文件夹的 AI 窗口内生效，不会影响其他项目窗口。

## 核心协作规则

1. **优先调用工作台专属 MCP 工具（`wb_*`）**：
   - 凡涉及查看在线受控 Chrome 浏览器与已登录 Facebook 专页/账号、活跃账号任务组合（浏览视频/动态/商城、通过好友、发帖）与全局执行记录、读取排期表（`.xlsx` / `.csv`）、Facebook 小组立即或定时发帖、小组/专页顶贴、拉人进群、蓝蝶模拟器（BlueStacks 小组顶贴与专页顶贴、声音开关与参数配置）控制，或使用已登录受控浏览器执行外部网页操作，**必须使用 `browser_workbench` / `workbench` MCP 服务提供的 `wb_*` 工具**。
   - **禁止误用通用桌面截图点击（Computer Use）或未挂载工作台协议的普通内置浏览器插件去盲目操控屏幕**。
2. **严格遵守操作手册与真实状态核验**：
   - 执行任务前请先阅读并遵循 [`.agents/skills/workbench-operator/SKILL.md`](./.agents/skills/workbench-operator/SKILL.md) 中的三层执行策略（优先原生零 Token 模块 -> 零 Token 自然浏览 `browseSeconds` -> 按需网页交互 `wb_browser_*`）。
   - 严禁把“任务已提交/排队”等同于“发帖已成功”；必须依据真实回执（`postUrl`、`postedCount`、`pendingReviewOperations`、`wb_diagnose` 日志）向用户汇报准确状态。
   - 遇到任何验证码（CAPTCHA）或双重验证（2FA / Checkpoint）严禁自动点击或绕过，请调用 `wb_browser_act(action="bring_to_front")` 交由人工完成。
3. **保护用户业务文件**：
   - 用户可将排期表格（`.xlsx` / `.csv`）、文案、图片、视频素材直接放入本工作夹或子目录中；可直接通过 `wb_read_table` 与 `wb_poster_save_material` 读取，未经用户明确要求不得擅自修改或删除用户的业务文件。
4. **Codex 首次打开提示**：
   - 如果当前在 OpenAI Codex 中尚未看到 `wb_*` 工具，请提示用户将本文件夹（`AI-Workspace`）标记为 **受信任（Trusted）** 后重新开始对话，以加载 [`.codex/config.toml`](./.codex/config.toml) 中的项目级 MCP 服务。
