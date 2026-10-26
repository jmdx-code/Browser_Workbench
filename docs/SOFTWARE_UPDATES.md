# 软件与插件更新

## 日常使用

菜单 → 软件与插件更新。首次将浏览器的解压插件加载位置改用面板显示的固定目录；以后移动软件安装目录，不影响该插件路径。

Windows 默认路径：

- 插件：`%APPDATA%\Browser Workbench\extension`
- 热更新运行产物：`%APPDATA%\Browser Workbench\runtime`
- 更新配置：`%APPDATA%\Browser Workbench\data\update-config.json`

在面板填写公开 GitHub 仓库 `owner/repo`，点击“保存并检查更新”。更新源为空时不发网络检查、不显示错误；开启自动检查后启动时与每30分钟检查一次。顶部发现新版本可点“一键更新”，或在面板查看说明。运行中任务须先暂停/停止。下载校验通过后切换运行产物、同步插件，刷新空闲插件，再沿正常草稿保存流程重启。

“复制固定插件路径”“打开插件文件夹”“一键热刷新全部插件”也可在连接诊断的插件版本区域使用。后者只表示请求已发出，实际插件版本仍以浏览器重连后的版本显示为准。原来从其他目录加载的插件，`chrome.runtime.reload()` 只会重载原目录；需先手动改用固定目录，软件不会强装或修改浏览器注册表策略。

## 发布

1. 将完整工程源码（含新增文件）提交到公开 GitHub 仓库；不提交 data、audit、node_modules 或本机授权验收范围文件。
2. 修改 `package.json` 软件版本；修改插件代码时也提高 `extension/manifest.json` 版本，并保持公钥/插件身份稳定。`workbenchEngine.electron` 与 `devDependencies.electron` 保持一致，以便打包去除开发依赖后仍可比较引擎。
3. 推送匹配版本的标签，例如 `v0.1.131`；也可手动运行 Release 工作流。工作流校验标签与软件版本、运行 npm ci/check/build:release、生成Windows安装包，再上传 Release。
4. 工作流自动将当前仓库写入产物的默认 `config/update-source.json`；本地开发默认仍为空。客户端手动保存的更新源优先于默认值。

本地构建：`npm run build:release`。产物为 `release/workbench-hot-update.zip` 与 `release/release-manifest.json`。Windows完整安装包使用 `npm run package:win -- --publish never`。

`npm run release:bundle` 一次生成热更新包、完整安装包和两个下载别名：`Browser.Workbench.Setup.<版本>.exe`、`Browser.Workbench.Setup.exe`。新版 Release 同时提供这两个别名，永久最新安装包入口为 `/releases/latest/download/Browser.Workbench.Setup.exe`。v0.1.134 的原安装包链接作为兼容入口覆盖为0.1.141内容；旧链接文件名保留134，安装程序内部版本仍为141。

软件与插件对用户显示为“浏览器工作台”；productName、可执行文件名及原数据/runtime/extension目录保持“Browser Workbench”，显示名称变更不迁移数据。

工作流使用内置 GITHUB_TOKEN（contents: write），无需另配发布密钥。首次安装必须使用带新启动器的基础安装包；旧安装包没有本次启动器，不能仅靠放置 runtime 目录获得升级能力。

## 热更新边界

安装包的 app.asar 保持完整。启动器只选择高于内置基础版、全部清单文件哈希完整、依赖指纹相同的固定 runtime；否则回退内置基础版。外部代码通过模块解析钩子复用已安装的 Electron 与生产依赖，不复制 node_modules。

指纹包含 Electron 与生产依赖的确定版本。引擎/依赖不同或缺少可校验清单时，面板引导到 GitHub 发布页下载安装包。每个正式发布都应提高软件版本，不能用同名旧版本标签替换不同代码。

安装前在临时目录校验 ZIP SHA-256、文件清单与结构，拒绝路径穿越、符号链接、重复条目和缺失文件；安装异常恢复原 runtime，插件同步异常恢复已替换文件。最多保留一个 runtime-previous；下载暂存目录成功或失败均清理。不会覆盖用户数据库、素材或账号配置，也不自动回滚数据库迁移。

本批在 Windows x64 验证。macOS/Linux 的路径与加载代码使用跨平台接口，但未做对应平台实机验收；当前 CI 仅构建 Windows 完整安装包。
