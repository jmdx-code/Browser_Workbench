# 开发与验收入口

隔离并发研究入口见 `concurrency-lab/README.md`：只用临时生成数据，运行Electron→utilityProcess→worker的SQLite锁争用与真实仓储读侧归因，不连接浏览器、不打开正式数据库；结果不能代表真实百台业务。

正常软件：start-test-workbench.ps1；重载：reopen-test-workbench.ps1。软件重载前核对原任务实际停止，不重启用户浏览器。

## 当前可复用入口

- accept-browse-workflow.mjs：一份资料的新浏览组合。
- accept-page-reuse.mjs：完成后复用准确主页，新计划及停止保页。
- accept-workspace-isolation.mjs：双资料停止隔离，或--mode mixed完整组合；不代表公平后台计时。
- observe-browse-plan.mjs、end-browse-acceptance.mjs：只接明确原记录的观察/停止，不分配替代计划。
- verify-workbench-delivery.mjs：源码/dist/目录包/HTTP核对；未指定--already-reloaded时会重启正常软件，不应在活动任务期间使用。
- verify-installed-workbench.mjs：实际安装asar/exe/插件manifest与目录包核对。
- desktop-smoke.mjs：隔离端口/临时数据启动，不用隔离结果冒充真实账号任务。
- snapshot-interrupted-control.mjs：只读备份原未确认停止，不代替原停止回执。

真实任务脚本必须指定全新audit记录，已有记录不得覆盖或重放。外部上传/发布另按明确内容及可见范围执行；当前四条历史SELF样本已耗尽，不能直接运行旧发布准备脚本重新分配。

## 已退役

2026-10-24清理：删除054/097单次验收、旧schema26–30升级核对、固定旧路径时序分析，以及已撤销的Brave参数启动器，共8个脚本；不从历史记录恢复为运行入口。三分钟tabCapture试验及其专用测试已移除，正式浏览/发布/停止和露边回归保留。构建会清空受限的dist/extension-build输出，避免已删源码残留在编译产物中。

清理明细见../docs/PROJECT_CLEANUP_20261024.md。历史结果已压缩到audit/maintenance-20261024/historical-evidence.zip，条目保留原始相对路径；由于永久删除被自动审批拒绝，原始大目录目前仍在，不能将归档视为已释放空间。

2026-10-15移除七份20261013日期化、旧协议/插件版本绑定的单次脚本。当前源码无引用；副本保存在audit/retired-script-sources-20261015，仅供查看，不恢复为执行入口。历史结果文件、任务、UNKNOWN及数据库未删除。通用入口的脚本参数检查和原始证据保持。
