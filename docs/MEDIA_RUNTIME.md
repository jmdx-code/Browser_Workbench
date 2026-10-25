# 视频派生运行时

## 0.1.126 可选组件交付

视频文字处理已从基础安装包移出。用户在“菜单 → 可选组件”主动安装，组件存于用户数据目录的`media-components/<平台-架构>`，支持安装进度、取消、校验与损坏修复。当前固定并验证的组件仅Windows x64；macOS/Linux尚无经核验的下载描述，界面明确显示尚未提供，不能调用Windows二进制或任意PATH程序。

普通浏览、普通帖子原视频上传及无文案视频快拍均不依赖该组件。带文案的视频快拍在缺少组件时明确失败并提示安装，不会丢掉文案后继续发布。安装仅复制固定清单的FFmpeg/ffprobe/DLL和许可证；下载必须符合固定字节数、归档SHA256和逐文件SHA256，解压拒绝符号链接、重复条目及路径穿越。开发环境可从同一固定版本的vendor核验导入，发行包不包含vendor。排版层保持轻量的Canvas原生依赖，基础包并非完全没有原生依赖。

跨平台接口、可执行文件命名与字体候选已接入；这不等于已交付macOS组件或完成macOS真实发布验收。可选组件的许可证、固定构建来源及分发责任仍见下文。

本模块只生成上传缓存中的派生视频，不修改源文件，不拥有浏览器控制、素材消费或发布账本。

## 固定依赖

- 字体排版：[@napi-rs/canvas](https://github.com/Brooooooklyn/canvas) 1.0.11，MIT，Skia/Node-API；按需加载。Windows系统的Myanmar Text与Segoe UI Emoji用于缅文和emoji，不复制或分发系统字体。缺少所需字体时明确失败，不画替代方框后继续。
- 编解码：[BtbN FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-13-13-05)的`n9.0.2-27-g7e93014c5b`、Windows x64 LGPL shared构建；不使用本机D盘的开发工具或任意PATH上的ffmpeg。编码使用该构建实际存在的libopenh264与AAC，不依赖显卡编码器。
- 原始zip的SHA256为`9df4db960f3f0cd3ed76be0a2be96265d00db4c3be2526a6d39b03c2b547100d`，77230840字节，与发布者GitHub资产digest核对一致。二进制逐文件固定在`config/media-runtime.json`。

`scripts/prepare-media-runtime.ps1`下载或核验固定版本；`-VerifyOnly`不下载。保留供应包原LICENSE.txt。源代码与构建来源为[FFmpeg对应提交](https://github.com/FFmpeg/FFmpeg/commit/7e93014c5b)及[BtbN构建脚本](https://github.com/BtbN/FFmpeg-Builds/tree/63ac326)。未来向外分发时仍需按[FFmpeg许可说明](https://ffmpeg.org/legal.html)核对应源码、第三方组件通知和分发要求；本机验证不等于分发合规审查通过。

## 实现边界

`renderStoryCaption`保留全文、用Intl.Segmenter分词/字素换行，检查字体、画布/文本/输出预算；文字放不下时失败，不截断。`FfmpegStoryMedia`通过参数数组启动隐藏的本地进程，禁止网络输入，不拼shell命令；视频时长与方向保持，偶数像素补边，不裁掉内容。正常输出不覆盖已有文件；仅暂存目录内自己以wx创建的空临时输出可替换。进程有输出、时间预算和取消检查，退出后才交回结果。

schema33追加`story-video-derived-media`兼容门槛，旧迁移1..32冻结。原UploadStageManifest版本1保持；新版本2只接受一份视频及对应派生证明：原源SHA、原全文/全文SHA、叠字图SHA、渲染版本、固定运行时SHA、新视频SHA/大小/尺寸/时长。原intent、资源行、source file proof和使用归属不改，新字段沿原暂存表保存。

插件0.3.33新增派生文件清单能力声明；旧插件不得接新清单，普通版本1仍兼容。完整上传核验使用派生字节，但关联原Binding/attempt/素材及全文。Canvas、文件ACK或完整传输各自都不能单独授予提交；当前原生预览/按钮、当前账号/用途、好友范围和派生全文必须同时吻合。不伪造DOM中的文字，派生文案和原生文字分别处理。

本地证据：`audit/captioned-story-media-6491dff2-aa94-4782-a371-eeea89144e71`与实际worker的`captioned-story-media-616c9189-07db-4128-9364-4d27403b0f83`。源6秒720×1280未变；批准短句完整，输出2969861字节/SHA`76a4974edfea167aea254dcedd541c25d4d3e1ccb8e10b9ed57bf49e84662367`。这些是本地合成证据，不是快拍发布成功或最终安装验收。当前部署和未完成事项以CONTINUITY为准。
