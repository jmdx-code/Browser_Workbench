# 构建、门禁与工具脚本

本目录仅保留当前正式工程实际使用的构建、质量门禁、隔离冒烟、媒体运行时与 MCP 桥接脚本：

- `build.mjs`：清理生成目录并完整构建主进程、渲染端（Vite）、持久化 Worker 与浏览器扩展。
- `build-extension.mjs`：构建固定 ID 浏览器桥接扩展至 `extension-build/`。
- `build-icons.mjs`：生成桌面端图标资源。
- `build-persistence-worker.mjs`：打包 SQLite 持久化 Worker。
- `build-release-bundle.mjs`：生成热更新包 `workbench-hot-update.zip`、`release-manifest.json` 与安装包固定别名。
- `check.mjs`：全量门禁入口（构建 + Feed 投影冒烟 + 架构边界检查 + Prettier 格式检查 + 全量单测）。
- `check-boundaries.mjs`：分层架构依赖边界与 TypeScript 类型红线检查。
- `test.mjs`：执行全部 Node 单测、MCP 单测、脚本单测与 Vitest 套件。
- `desktop-smoke.mjs`：使用临时隔离端口与临时目录验证桌面端启动闭环。
- `facebook-feed-projection-fixture.mjs`：使用系统临时目录执行 Electron 离屏 DOM 投影冒烟并在通过后自动清理临时文件。
- `generated-output.mjs`：受限清空 `dist/` 与 `extension-build/` 构建产物目录。
- `prepare-media-runtime.ps1`：按 `config/media-runtime.json` 固定哈希下载或校验可选 FFmpeg 媒体运行时组件。
- `run-node.mjs`：Node 24 运行时版本校验与子进程执行辅助。
- `workbench-mcp-stdio.mjs`：AI 专属工作夹 stdio MCP 桥接入口。
