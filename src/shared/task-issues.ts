import { taskAdmissionIssue } from './task-admission-issues.js';
const STORY_RES =
  '快拍发布结果未确认\t本次失败结束后可运行其他任务；原内容不自动重发，请核对原发布记录。';
const REASON_LINES = `
WINDOW_LAYOUT_CAPACITY_EXCEEDED|所选屏幕放不下当前窗口布局\t在菜单→任务窗口布局扩大活动区域或更换屏幕。
WINDOW_LAYOUT_DISPLAY_MISSING|布局目标屏幕未连接\t在菜单→任务窗口布局重新选择屏幕，或关闭自动布局。
WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED|桥接扩展需要更新\t手动刷新参与布局的浏览器扩展及任务页后运行新任务。
WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED|任务浏览器需要还原为普通窗口\t将最大化、最小化或全屏的任务浏览器还原，再重新整理。
WINDOW_LAYOUT_USER_CHANGED|旧版任务记录：窗口位置发生变化\t新版使用窗口当前位置；停止此旧任务后可重新启动，无需恢复原位置。
FACEBOOK_NATIVE_NAVIGATION_TARGET_UNAVAILABLE|当前页面没有可用的原生导航入口\t检查页面是否可见、加载完成或有弹窗；本次没有改用硬导航或重复点击。
FACEBOOK_NATIVE_NAVIGATION_TARGET_CHANGED|浏览导航目标在操作前发生变化\t本次不沿用旧目标继续点击，查看原任务记录与停止状态。
KERNEL_RPC_RESULT_UNKNOWN|浏览器控制回执超时\t页面可能已经执行操作；先确认当前控制已停止，不自动重发原操作。
KERNEL_RPC_CAPACITY_REJECTED|浏览器通信请求过多\t该请求未进入发送队列；保留原操作结果与停止保护，等待通道恢复后再处理任务。
STORY_EFFECT_PENDING|正在核验快拍编辑结果\t保持原任务页面；上传或点击回执不代表已经就绪或发布。
STORY_VIDEO_CANVAS_ADAPTER_REQUIRED|当前视频快拍预览尚未接通\t该编辑器使用 Canvas 且没有原生叠字工具，需要媒体合成及预览适配；本次不提交缺少文案的视频。
STORY_VIDEO_TRANSFER_PENDING|正在等待本次视频上传完成\t沿本次上传核验原生传输结果，不重复上传；可正常停止。
RESOURCE_MATERIAL_BUDGET|素材读取或准备超时\t本次已暂停；检查文件和当前任务记录，软件不会因此重复上传或发布。
POST_AI_LABEL_CONFIGURATION_UNAVAILABLE|当前编辑器不能设置指定的 AI 声明\t本次发布步骤失败后继续独立后续步骤，不忽略指定设置。
POST_AI_LABEL_UNCONFIRMED_BEFORE_CONTENT|AI 声明未确认，本次不继续提交\t查看原任务记录；不会重复提交或忽略指定设置。
POST_AI_LABEL_CHANGED|本次 AI 声明设置已变化\t结束当前发布步骤，不盲目反复切换或继续提交。
USER_STOP|用户请求停止任务\t以浏览器停止确认为准；原操作不会重放。
USER_PAUSE|用户请求暂停任务\t确认暂停后继续，保留原版本、顺序和进度。
SOFTWARE_RESTART_STOPPED|软件重启，未完成任务已自动结束\t保留已完成的步骤进度与记录；不会自动重放中断操作。
EXECUTION_INTERRUPTED|浏览器或工作台重启，旧任务已结束\t已完成结果保留；可启动新任务，旧操作不会自动续跑。
SOFTWARE_RESTART_BROWSE_CANCELLED|软件重启，未完成任务已自动结束\t保留已完成的步骤进度与记录；不会自动重放中断操作。
BROWSER_OFFLINE_STOPPED|浏览器已关闭或离线超时，任务自动结束\t保留已完成的步骤进度与记录；重新打开浏览器后可安排新任务。
OFFLINE_BROWSE_CANCELLED|浏览器离线，任务已结束\t保留已完成的步骤进度与记录；不会自动重放中断操作。
SOFTWARE_RESTART|软件重启后任务已暂停\t先核对浏览器和任务记录；不会自动重放中断操作。
POST_HOME_PREPARATION_BLOCKED|等待当前页面解除编辑或加载占用\t不会丢弃当前草稿或附件；解除占用后接续页面准备。
FACEBOOK_POST_EDITOR_CLOSED|本次发帖编辑器已关闭\t结束本步骤，不另起发布尝试；独立后续步骤在实际停止确认后继续。
POST_HOME_PREPARATION_INTERRUPTED|发帖页面准备被中断\t结束本步骤，不重复导航或补发；查看原记录和后续步骤状态。
FACEBOOK_CURRENT_CREATOR_UNCONFIRMED|当前页面发帖身份未确认\t保持浏览器连接，先确认本次控制已停止；不会沿用不明确的页面身份继续输入。
FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED|当前页面账号身份未确认\t检查该资料是否仍正常登录，保留原任务和未确认操作。
FACEBOOK_IDENTITY_READ_FAILED|页面身份读取中断\t保持浏览器连接并核对停止状态；原任务记录保留，不自动重发已派发操作。
PARTIAL_STEP_FAILURE|组合已结束，部分步骤失败或跳过\t查看各步骤结果；已完成步骤保留进度，未确认的发布内容不会自动重发。
RESOURCE_EXHAUSTED|发帖资源已耗尽，本步骤未达到目标数量\t保留已经确认的发布进度，本步骤结束后继续独立后续步骤。
NEXT_STEP_REQUIRES_ADMISSION|等待接续下一步骤\t重新确认当前资料和账号后接续，不重放失败步骤。
FACEBOOK_BROWSE_FOREGROUND_REQUIRED|等待浏览页面可见\t恢复任务页可见后自动接续；等待期间不输入、不累计有效时间。
FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT|浏览页面恢复可见超时，已请求停止控制\t恢复任务窗口和任务标签，检查当前控制状态后再继续；未确认的原操作不会自动重发，等待时间不计入浏览。
FACEBOOK_IDENTITY_NATIVE_REVIEW_REQUIRED|遗留检查页仍占用控制\t停止本次任务后，在测试工作台点击“结束遗留占用”，再新建测试。
FACEBOOK_TASK_NATIVE_REVIEW_REQUIRED|旧任务仍有控制占用\t先停止并处理原任务，再检查浏览器状态；不会自动重放旧操作。
KERNEL_PROFILE_NOT_IDLE|浏览器正在检查或停止中\t等待当前检查结束；其他浏览器可独立执行。
IDENTITY_REQUIRED|等待确认Facebook登录状态\t保持浏览器打开并登录，点击检查FB状态查看原因。
SCHEDULE_MISSED|错过定时启动\t软件未运行或睡眠导致超过启动宽限，本次不会补跑。请重新安排新的任务。
SCHEDULE_MISSED_ON_RESTART|重启时启动时间已过\t不会自动补跑。核对任务内容后，重新安排新的任务。
SCHEDULE_WINDOW_CLOSED|等待下个运行时间窗\t软件保持运行且停止已确认时，下个允许窗口继续。重启软件后需手动继续。
PUBLISH_RESULT_UNCONFIRMED|发布结果未确认\t本次失败已结束后可运行其他任务；原内容不自动重发，请查看原发布记录。
STORY_EDITOR_CLOSED|本次快拍编辑器已关闭\t结束本步骤，不另起发布尝试；确认停止后继续独立后续步骤。
STORY_FRIENDS_AUDIENCE_UNAVAILABLE|当前身份不支持好友范围快拍，本次未发布\t本步骤已结束；如需使用原生现有范围，请选择保持当前后重新运行。
POST_SELF_AUDIENCE_UNAVAILABLE|当前身份不支持仅自己范围\t本步骤已结束，未更改为公开发布；请核对分享范围。
STORY_AUDIENCE_UNSUPPORTED|快拍不支持仅自己范围\t请选择好友或保持当前范围。
POST_PREPARATION_TIMEOUT|发布准备未能完成\t本步骤已结束且未提交；页面可能有保留草稿、尚未加载或缺少所需控件，请查看步骤原因。
FACEBOOK_CURRENT_STORY_IDENTITY_UNCONFIRMED|未能确认当前快拍发布身份\t结束本次发布准备，不消费素材；请查看对应步骤记录。
STORY_EFFECT_UNCONFIRMED|快拍步骤效果未确认\t查看原任务记录；本次不自动重复输入或提交。
STORY_TEXT_TOOL_NOT_READY|等待快拍文字工具\t保持当前快拍预览，软件尚未输入文案或提交。
STORY_TEXT_LIMIT_EXCEEDED|快拍叠字超过 200 个字符\t缩短叠字或先将完整文案合成进媒体；软件不会截断后发布。
STORY_EMPTY_ENTRY_REQUIRED|等待快拍空白入口\t当前页面尚不能开始新快拍，不覆盖已有草稿。
STORY_ORIGINAL_MEDIA_CHANGED|快拍预览与原素材不一致\t本次不提交，原文件和待核对记录保持不变。
STORY_FOREIGN_DRAFT|快拍草稿中已有其他内容\t保留当前草稿，结束本次发布步骤，不覆盖或丢弃已有内容。
OPERATION_RESULT_UNCONFIRMED|操作结果未确认\t查看记录并确认停止控制，结束本次失败任务。
POST_BACKGROUND_LOADING|正在读取原生发帖背景\t等待编辑器加载；不会改成普通文字提交。
POST_BACKGROUND_CONFIGURATION_UNAVAILABLE|当前编辑器没有可用的原生背景控件\t本次发布步骤失败后，独立后续步骤在确认停止后继续；彩贴不会替换为普通文字。
POST_BACKGROUND_CHANGED|原生背景已变化或被编辑器取消\t本次不提交。可能是文案超出背景限制，检查资源后再运行新任务。
POST_BACKGROUND_UNCONFIRMED|无法确认彩贴背景仍有效\t本次不提交，不把输入回执当作背景生效。
ENDING_UNCONFIRMED_TASK|正在结束未确认任务\t保持浏览器连接，等待停止确认。
BROWSE_EFFECT_TIMEOUT|未确认页面操作效果\t查看任务记录，停止并结束本次任务后再启动新的浏览任务。
FACEBOOK_NATIVE_ACCOUNT_CHANGED|浏览器中的账号已变化\t确认当前登录账号后重新检查资料，原任务不能沿用之前的账号身份。
FACEBOOK_MARKETPLACE_ITEMS_REQUIRED_TIMEOUT|没有找到可浏览商品\t检查商城是否可用，或调整关键词后运行新任务。
FACEBOOK_MARKETPLACE_UNAVAILABLE|当前身份无法使用商城\t已跳过商城，继续后续任务。
MARKETPLACE_UNAVAILABLE|当前身份无法使用商城，已正常跳过\t其他步骤照常执行，不计为任务失败。
FACEBOOK_BROWSE_LOADING_OR_DIALOG_TIMEOUT|页面加载或弹窗等待超时\t处理浏览器中的页面提示，再根据任务当前状态继续或重新启动。
FACEBOOK_VIDEO_PLAYER_REQUIRED_TIMEOUT|没有找到可播放的 Reels\t检查视频页面是否可用，处理页面提示后再运行。
FACEBOOK_VIDEO_PLAYBACK_STALLED_TIMEOUT|Reels 持续缓冲或暂停\t检查浏览器、网络和视频播放状态，再根据任务当前状态继续或重新启动。
FACEBOOK_VIDEO_DECODE_FAILED_TIMEOUT|视频无法正常播放\t在浏览器检查播放器错误；本段没有累计有效播放时间。
FACEBOOK_FEED_CONTENT_REQUIRED_TIMEOUT|首页没有可浏览内容\t检查首页加载、登录及页面提示后再运行。
FACEBOOK_BROWSE_ROUTE_REQUIRED|正在切回可浏览的 Facebook 页面\t软件将自动导航回 Facebook 首页后继续执行。
FACEBOOK_IDENTITY_UNCONFIRMED|正在确认当前 Facebook 账号身份\t保持浏览器登录状态，确认账号后自动开始。
FACEBOOK_BROWSE_ROUTE_REQUIRED_TIMEOUT|任务页面离开了当前浏览范围\t查看浏览器中的页面提示，再运行新任务；不会接管你的其他标签页。
FACEBOOK_MARKETPLACE_CATEGORY_UNAVAILABLE_TIMEOUT|当前商城没有找到所选分类\t检查当前地区的商城分类，调整组合后运行新任务；不会忽略分类设置。
FACEBOOK_NAVIGATION_REJECTED|页面跳转被浏览器中断或拒绝\t通常是网络波动或高并发加载超时所致；软件会自动重试恢复，若反复出现请降低并发数或检查代理。
FACEBOOK_NAVIGATION_DOWNLOAD_REJECTED|目标链接触发了下载，已中止跳转\t请检查该页面或链接状态后再重新运行任务。
FACEBOOK_TASK_DOCUMENT_ERROR_PAGE|页面加载落到浏览器网络错误页\t请检查网络或代理连接，降低同时运行的浏览器数量后重试。
KERNEL_READ_FENCED|浏览器会话切换导致本次读取中断\t软件会自动重新建立会话并继续执行；若反复发生请检查浏览器内存与并发数。
MATERIAL_EXHAUSTED|没有可用发帖资源\t补充本组合资源表或检查素材状态。
MATERIAL_NO_ELIGIBLE_RESOURCE|没有符合条件的可用资源\t本次发布步骤结束后继续独立后续步骤。检查已使用、占用及用途；补充资源后按保存的新版本启动。
RESOURCE_BACKGROUND_EXECUTOR_REQUIRED|彩贴背景暂不可执行\t选择支持的资源，或自行改为普通文字；软件不会静默替换彩贴。
RESOURCE_PURPOSE_MISMATCH|资源用途与任务不符\t检查该行用于帖子还是快拍；保存后按新资源版本启动。
`;
const REASON_RAW: Record<string, string> = {
  ...Object.fromEntries(
    REASON_LINES.trim()
      .split('\n')
      .map((line) => {
        const sep = line.indexOf('|');
        return [line.slice(0, sep), line.slice(sep + 1)];
      }),
  ),
  STORY_NATIVE_RESULT_CONFLICT: STORY_RES,
  STORY_ORIGINAL_OBSERVER_REQUIRED: STORY_RES,
  STORY_ORIGINAL_PAGE_REQUIRED: STORY_RES,
};
const lookupReason = (code: string) => {
  const raw = Object.hasOwn(REASON_RAW, code) ? REASON_RAW[code] : undefined;
  if (!raw) return undefined;
  const [summary = '', next = ''] = raw.split('\t');
  return { summary, next };
};
export function taskReasonDescription(reason: string) {
  if (reason.startsWith('POST_PREPARATION_TIMEOUT:'))
    return lookupReason('POST_PREPARATION_TIMEOUT');
  if (reason.startsWith('INITIAL_SESSION_FAILED:')) {
    const inner = reason.slice('INITIAL_SESSION_FAILED:'.length).trim();
    return (
      taskAdmissionIssue(inner) ??
      lookupReason(inner) ?? {
        summary: inner ? '启动任务页失败：' + inner : '启动任务页失败',
        next: '请检查该浏览器的连接与标签页状态，可直接重新点击启动。',
      }
    );
  }
  return taskAdmissionIssue(reason) ?? lookupReason(reason);
}
export const isErroredPausedPlan = (_plan: {
  state: string;
  controlConfirmed?: boolean;
  reason: string;
}): boolean => false;
export const isAccountHardBlockTaskReason = (reason: string): boolean =>
  /(?:ACCOUNT_(?:CHANGED|MISMATCH|VERIFICATION|RESTRICTED|LOGGED_OUT)|IDENTITY_REQUIRED|FACEBOOK_NATIVE_ACCOUNT_CHANGED)/.test(
    reason,
  );
export const stepFailureAllowsAutoContinuation = (reason: string): boolean =>
  Boolean(reason) &&
  !/^(?:USER_|MANUAL_|SCHEDULE_|CONCURRENCY_LIMIT|STARTUP_BACKOFF|OWNER|REVOKED|CONTROL_|LEASE_|SOFTWARE_RESTART)/.test(
    reason,
  ) &&
  !isAccountHardBlockTaskReason(reason);
