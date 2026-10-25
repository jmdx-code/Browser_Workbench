# 隔离控制面实验入口

只生成临时库和合成资料，使用工程node_modules中的Electron启动无窗口实验入口。不会导入正式desktop/server、占用18767、读取正式库或连接扩展/浏览器，不重启用户软件。实验库保留在报告注明的临时路径；不自动递归删除目录。

在Browser_Workbench目录运行：

```powershell
node scripts/concurrency-lab/run.mjs
```

只补测E1、避免重复5秒锁争用场景：

```powershell
node scripts/concurrency-lab/run.mjs --e1-only
```

历史深度/运行状态/顺序补测（11场景）：

```powershell
node scripts/concurrency-lab/run.mjs --e1-matrix
node scripts/concurrency-lab/matrix-summary.mjs <本轮报告目录>
```

矩阵含12→50→100及100→50→12（历史4条），100资料历史4/20/100条及50 RUNNING+50 QUEUED。历史使用临时库批量克隆的生成行，校验外键、计划数和账号锁；不执行领取/输入、不改变正式上限。语句prepare与执行分开计时。单case完成即保存JSON，完整报告只有全部场景完成才complete=true；最大场景10100计划/80800步骤，仍仅为合成读负载。

非UI范围查询微测：`node scripts/concurrency-lab/run.mjs --scoped-reads <矩阵config.json>`。只接受具有隔离标记的生成库，以只读源backup到新scratch，在新副本测100次list过滤/profile查询及候选索引前后EXPLAIN；不调用actor停止，也不修改源库或正式迁移。

系统Node只用于esbuild/进程编排，不在该进程使用node:sqlite。SQLite实际运行于Electron utilityProcess；worker对照再经worker_threads。每次生成独立audit目录、源码哈希、运行时/硬件信息、结果及日志。合成数据不是真实并发验收。

E5覆盖直接/worker成功、独立进程写锁超时、短等待、释放后成功、WAL读者与普通写、关闭阶段TRUNCATE被读者阻碍；验证错误码与行数。直接阻塞与worker对照测的是实验utilityProcess定时器，不是实际网关或百台peer。

E1通过当前源码打包后的真实WorkspaceStore/WorkspaceService/TaskService，以12/50/100份合成资料、每资料5计划/每计划8步骤测读侧。计划只为QUEUED/COMPLETED，未绕过50并发上限去启动任务。仪表只存在于实验进程，结束恢复；包含去仪表的读侧对照。

若进程异常，入口会保存部分报告和错误，不把complete=false作为通过。每个子场景及整个实验设超时，只终止本实验创建的子进程。E2～E7其余能力不由本入口的成功自动证明。

合并指定两份已经完成的报告：

记录页补测：`node scripts/concurrency-lab/run.mjs --records <矩阵config.json>`。验证隔离标记，只读源backup至新scratch，对100资料历史4/20/100的真实records入口测50行页面、3次暖读及独立仪表；另用原事务helper构造未防护读事务的嵌套写回滚示例。后者是机制复现，不是生产事故断言。无浏览器/执行器/正式库。

完整历史等价验证：`node scripts/concurrency-lab/run.mjs --verify-records <已生成records-h100.sqlite的实验config.json>`。只接受匹配隔离标记的生成库，复制至新scratch，以原纯规则和批量输入生成规范化字段哈希，再逐页比较80800行和顺序；不重复运行慢的旧全量接口基线。真实operations/UNKNOWN由单独回归覆盖，不把该生成数据验证当作真实业务。综合records脚本同时包含迁移、旧基线和完整验证，可能超时；complete=false不得当作通过。

```powershell
node scripts/concurrency-lab/summarize.mjs <E5报告目录> <补测E1报告目录>
```
