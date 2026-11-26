# 架构概览（Public Architecture）

Browser Workbench 采用分层桌面架构：Electron 桌面壳承载本地 React 19 控制台与窗口管理，Node 24 本地 HTTP/SSE/WebSocket 网关负责任务调度、并发控制与持久化协调，Chromium MV3 扩展与 BlueStacks ADB 适配器分别执行浏览器与模拟器端原生操作。

## 八层源码架构与依赖门禁

`scripts/check-boundaries.mjs` 对 `src/` 全部 8 个目录执行零豁免 AST 依赖与类型门禁（禁止 `any`、非空断言 `!` 及 `@ts-ignore`）：

- `src/shared`：跨进程契约、Zod Schema、纯数据格式化与状态归类规则，不依赖平台 API。
- `src/domain`：纯领域逻辑（窗口露边几何、素材表校验、结算语义、浏览策略），仅依赖 `shared`。
- `src/application`：任务看板（`Workboard`）、定时排班、蓝蝶调度、Google 表格协同、SSE 事件中心（`WorkspaceEventHub`）及模块应用服务，仅依赖 `domain` 与 `shared`。
- `src/infrastructure`：单所有者 SQLite Worker（`persistence-worker.ts` / `workspace.sqlite` / `journal.sqlite`）、Chrome CDP 桥接（`kernel-bridge`）、各模块执行器（Reader / Actuator / Runner）、蓝蝶 ADB 设备管理、热更新校验与 MCP 服务。
- `src/http`：鉴权后的本地 REST API 与 `/api/workspace/events` SSE 增量推送端点。
- `src/bridge`：静态资源网关（`http-gateway.ts`）、WebSocket 扩展连接网关（`ws-peer-gateway.ts`）、无状态 `Core` 租约调度与 `journal.sqlite` 操作流水存储。
- `src/desktop`：Electron 主进程、Preload 桥与受控热更新 `runtime` 加载器。
- `src/renderer`：Tailwind v4 + 模块化 CSS + React 19 路由懒加载控制台，通过 SSE 增量失效与精准刷新协同工作。

## 核心工程不变量

1. **证据驱动结算**：发帖、顶贴、邀人、好友确认均须以原生 GraphQL/Relay/二次回读结果为准，`BEFORE_SUBMIT` / `UNKNOWN` / `pending_approval` 与 `VERIFIED` 严格隔离，绝不以点击回执冒充成功或自动重发未知提交。
2. **拉取式工作板与作用域租约**：浏览器扩展重启即回到无状态初始态；所有任务通过 `epoch` 代次、1.5 秒心跳租约与 `withBrowserSession` 闭环释放，单实例异常或离线不阻塞同批健康实例。
3. **单所有者异步持久化**：业务库与日志库全部收敛于独立 `persistence-worker` 线程（WAL + `synchronous=FULL`），主线程仅通过受控 RPC 异步调用，确保 100 并发长连接心跳不被慢盘写阻塞。
4. **可校验冷/热更新闭环**：热更新包严格核验 `release-manifest.json` 逐文件 SHA-256 与 `engineFingerprint`（Electron 及原生依赖指纹），校验失败自动回退基础包。详见 `docs/SOFTWARE_UPDATES.md` 与 `docs/MEDIA_RUNTIME.md`。
