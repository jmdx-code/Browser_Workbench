import { taskAdmissionIssue } from './task-admission-issues.js';
const REASON_LINES = `
WINDOW_LAYOUT_CAPACITY_EXCEEDED|所选屏幕放不下当前窗口布局\t在菜单→任务窗口布局扩大活动区域或更换屏幕。
WINDOW_LAYOUT_DISPLAY_MISSING|布局目标屏幕未连接\t在菜单→任务窗口布局重新选择屏幕，或关闭自动布局。
WINDOW_LAYOUT_EXTENSION_UPDATE_REQUIRED|桥接扩展需要更新\t手动刷新参与布局的浏览器扩展及任务页后运行新任务。
WINDOW_LAYOUT_NORMAL_WINDOW_REQUIRED|任务浏览器需要还原为普通窗口\t将最大化、最小化或全屏的任务浏览器还原，再重新整理。
WINDOW_LAYOUT_USER_CHANGED|旧版任务记录：窗口位置发生变化\t新版使用窗口当前位置；停止此旧任务后可重新启动，无需恢复原位置。
KERNEL_RPC_RESULT_UNKNOWN|浏览器控制回执超时\t页面可能已经执行操作；先确认当前控制已停止，不自动重发原操作。
KERNEL_RPC_CAPACITY_REJECTED|浏览器通信请求过多\t该请求未进入发送队列；保留原操作结果与停止保护，等待通道恢复后再处理任务。
RESOURCE_MATERIAL_BUDGET|素材读取或准备超时\t本次已暂停；检查文件和当前任务记录，软件不会因此重复上传或发布。
POST_AI_LABEL_CONFIGURATION_UNAVAILABLE|当前编辑器不能设置指定的 AI 声明\t本次发布步骤失败后继续独立后续步骤，不忽略指定设置。
POST_AI_LABEL_CHANGED|本次 AI 声明设置已变化\t结束当前发布步骤，不盲目反复切换或继续提交。
USER_STOP|用户请求停止任务\t以浏览器停止确认为准；原操作不会重放。
SOFTWARE_RESTART_STOPPED|软件重启，未完成任务已自动结束\t保留已完成的步骤进度与记录；不会自动重放中断操作。
SOFTWARE_RESTART|软件重启后任务已结束\t先核对浏览器和任务记录；不会自动重放中断操作。
FACEBOOK_CURRENT_CREATOR_UNCONFIRMED|当前页面发帖身份未确认\t保持浏览器连接，先确认本次控制已停止；不会沿用不明确的页面身份继续输入。
FACEBOOK_CURRENT_NATIVE_IDENTITY_UNCONFIRMED|当前页面账号身份未确认\t检查该资料是否仍正常登录，保留原任务和未确认操作。
PARTIAL_STEP_FAILURE|组合已结束，部分步骤失败或跳过\t查看各步骤结果；已完成步骤保留进度，未确认的发布内容不会自动重发。
RESOURCE_EXHAUSTED|发帖资源已耗尽，本步骤未达到目标数量\t保留已经确认的发布进度，本步骤结束后继续独立后续步骤。
FACEBOOK_BROWSE_FOREGROUND_REQUIRED|等待浏览页面可见\t恢复任务页可见后自动接续；等待期间不输入、不累计有效时间。
FACEBOOK_BROWSE_FOREGROUND_REQUIRED_TIMEOUT|浏览页面恢复可见超时，已请求停止控制\t恢复任务窗口和任务标签，检查当前控制状态后再继续；未确认的原操作不会自动重发，等待时间不计入浏览。
FACEBOOK_IDENTITY_NATIVE_REVIEW_REQUIRED|遗留检查页仍占用控制\t停止本次任务后，在测试工作台点击“结束遗留占用”，再新建测试。
FACEBOOK_TASK_NATIVE_REVIEW_REQUIRED|旧任务仍有控制占用\t先停止并处理原任务，再检查浏览器状态；不会自动重放旧操作。
KERNEL_PROFILE_NOT_IDLE|浏览器正在检查或停止中\t等待当前检查结束；其他浏览器可独立执行。
IDENTITY_REQUIRED|等待确认Facebook登录状态\t保持浏览器打开并登录，点击检查FB状态查看原因。
PUBLISH_RESULT_UNCONFIRMED|发布结果未确认\t本次失败已结束后可运行其他任务；原内容不自动重发，请查看原发布记录。
STORY_FRIENDS_AUDIENCE_UNAVAILABLE|当前身份不支持好友范围快拍，本次未发布\t本步骤已结束；如需使用原生现有范围，请选择保持当前后重新运行。
POST_SELF_AUDIENCE_UNAVAILABLE|当前身份不支持仅自己范围\t本步骤已结束，未更改为公开发布；请核对分享范围。
FACEBOOK_CURRENT_STORY_IDENTITY_UNCONFIRMED|未能确认当前快拍发布身份\t结束本次发布准备，不消费素材；请查看对应步骤记录。
STORY_TEXT_TOOL_NOT_READY|等待快拍文字工具\t保持当前快拍预览，软件尚未输入文案或提交。
STORY_TEXT_LIMIT_EXCEEDED|快拍叠字超过 200 个字符\t缩短叠字或先将完整文案合成进媒体；软件不会截断后发布。
BROWSE_EFFECT_TIMEOUT|未确认页面操作效果\t查看任务记录，停止并结束本次任务后再启动新的浏览任务。
FACEBOOK_NATIVE_ACCOUNT_CHANGED|浏览器中的账号已变化\t确认当前登录账号后重新检查资料，原任务不能沿用之前的账号身份。
MARKETPLACE_UNAVAILABLE|当前身份无法使用商城，已正常跳过\t其他步骤照常执行，不计为任务失败。
FACEBOOK_BROWSE_LOADING_OR_DIALOG_TIMEOUT|页面加载或弹窗等待超时\t处理浏览器中的页面提示，再根据任务当前状态继续或重新启动。
FACEBOOK_VIDEO_PLAYER_REQUIRED_TIMEOUT|没有找到可播放的 Reels\t检查视频页面是否可用，处理页面提示后再运行。
FACEBOOK_BROWSE_ROUTE_REQUIRED|正在切回可浏览的 Facebook 页面\t软件将自动导航回 Facebook 首页后继续执行。
FACEBOOK_IDENTITY_UNCONFIRMED|正在确认当前 Facebook 账号身份\t保持浏览器登录状态，确认账号后自动开始。
FACEBOOK_NAVIGATION_REJECTED|页面跳转被浏览器中断或拒绝\t通常是网络波动或高并发加载超时所致；软件会自动重试恢复，若反复出现请降低并发数或检查代理。
FACEBOOK_NAVIGATION_DOWNLOAD_REJECTED|页面跳转触发了下载，已拒绝以保护会话\t请检查目标网址或主页跳转；本次未下载任何文件。
FACEBOOK_TASK_DOCUMENT_ERROR_PAGE|页面加载落到浏览器网络错误页\t请检查网络或代理连接，降低同时运行的浏览器数量后重试。
KERNEL_READ_FENCED|浏览器会话切换导致本次读取中断\t软件会自动重新建立会话并继续执行；若反复发生请检查浏览器内存与并发数。
MATERIAL_EXHAUSTED|没有可用发帖资源\t补充本组合资源表或检查素材状态。
MATERIAL_NO_ELIGIBLE_RESOURCE|没有符合条件的可用资源\t本次发布步骤结束后继续独立后续步骤。检查已使用、占用及用途；补充资源后按保存的新版本启动。
`;
const REASON_RAW: Record<string, string> = Object.fromEntries(
  REASON_LINES.trim()
    .split('\n')
    .map((line) => {
      const sep = line.indexOf('|');
      return [line.slice(0, sep), line.slice(sep + 1)];
    }),
);
const lookupReason = (code: string) => {
  const raw = Object.hasOwn(REASON_RAW, code) ? REASON_RAW[code] : undefined;
  if (!raw) return undefined;
  const [summary = '', next = ''] = raw.split('\t');
  return { summary, next };
};
export function taskReasonDescription(reason: string) {
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
