# Browser Workbench

基于 Electron、TypeScript、React 与浏览器扩展的本地任务工作台。

当前软件版本 **0.1.226**，桥接插件 **0.3.83**。支持浏览器分组与批量管理、离线浏览器可见勾选与定时/立即自动唤醒、任务组合、任务记录（含发帖/顶贴记录一键批量复制至表格）、发帖素材卡片与矩阵、小组发帖、小组邀请、小组顶贴、专页顶贴、蓝蝶小组顶贴与蓝蝶专页顶贴、AI 专属工作夹（21 项 MCP 全功能工具联动 Antigravity / Codex），以及软件和插件更新。

## 安装使用

从 [Releases](https://github.com/jmdx-code/Browser_Workbench/releases/latest) 下载 Windows 安装包。

1. 安装并启动工作台。
2. 打开“菜单 → 软件与插件更新”，复制固定插件路径。
3. 在每个浏览器的扩展管理页开启开发者模式，加载该固定目录。工作台自动连接本机插件。
4. 在左侧选择浏览器，再配置并启动任务。

Windows 插件固定目录：`%APPDATA%\Browser Workbench\extension`。软件移动位置后无需迁移该目录。旧版从其他目录加载的插件，需要先手动改用固定目录；此后空闲插件可自动热刷新。

运行数据保存在 `%APPDATA%\Browser Workbench\data`，素材只记录原路径，不移动或删除源文件。请保留任务浏览器的可见边缘，避免最小化或完全遮挡。默认并发上限100是配置能力，实际容量取决于硬件和浏览器负载，尚未完成真实百台验收。

浏览器关闭重开或软件重启后，旧执行自动收尾，不继续发送旧操作；未来尚未触发的定时任务保留。结果未知的提交保留待核对和防重记录，结束旧控制后不再长期占用整个账号。

## 开发

需要 Node.js **24.19 或更新的24版本**。

```sh
npm ci
npm run check
npm run desktop
```

`npm run check` 包含类型、架构、前端构建、结构场景与回归测试。Windows 为当前已验证平台；macOS/Linux 尚未完成实机验收。可选视频文字处理组件见 [媒体运行时](docs/MEDIA_RUNTIME.md)。

## 构建与发布

```sh
npm run build:release
npm run package:win -- --publish never
```

推送与 package.json 匹配的版本标签（如 `v0.1.141`），GitHub Actions 会检查工程、构建并上传安装包、热更新ZIP和校验清单。也可手动运行 Release 工作流。

客户端默认更新源为 `jmdx-code/Browser_Workbench`。引擎/依赖指纹兼容时使用固定 runtime 热更新；不兼容时下载安装包。详见 [更新说明](docs/SOFTWARE_UPDATES.md) 与 [架构概览](docs/PUBLIC_ARCHITECTURE.md)。

账号数据、凭据、素材、数据库、开发审计记录和本机运行历史不包含在仓库中。测试中的账号标识为匿名样例。
