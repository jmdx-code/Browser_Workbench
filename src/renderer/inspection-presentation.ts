import type { Profile } from '../shared/contracts.js';
import type { Inspection, InspectionReasonCode } from '../shared/profile-inspection.js';
import { isFacebookAvatarURL } from '../shared/account-display.js';

function hasRetainedDisplay(profile: Profile, row: Inspection | undefined, available: boolean) {
  return (
    available &&
    profile.online &&
    profile.synced &&
    !profile.unresolved &&
    row?.profileId === profile.id &&
    ((row.state === 'OBSERVED' && row.account.state === 'logged-in') ||
      (row.state === 'BLOCKED' && row.reason === 'INSPECTION_EXPIRED')) &&
    ['unknown', 'logged-in'].includes(profile.account.state)
  );
}

function hasCurrentDisplay(
  profile: Profile,
  row: Inspection | undefined,
  available: boolean,
  now = Date.now(),
): boolean {
  if (
    !available ||
    !profile.online ||
    !profile.synced ||
    profile.unresolved ||
    row?.profileId !== profile.id ||
    row.state !== 'OBSERVED' ||
    row.account.state !== 'unknown' ||
    row.checkedAt === null ||
    now < row.checkedAt ||
    now - row.checkedAt >= 30_000
  )
    return false;
  return true;
}

export function inspectionAvatarURL(
  profile: Profile,
  row: Inspection | undefined,
  available: boolean,
  now = Date.now(),
): string | null {
  if (
    ['logged-out', 'restricted', 'verification'].includes(profile.account.state) ||
    (row && ['logged-out', 'restricted', 'verification'].includes(row.account.state))
  )
    return null;
  if (
    profile.account.avatar &&
    isFacebookAvatarURL(profile.account.avatar) &&
    (!row || row.profileId === profile.id)
  )
    return profile.account.avatar;
  if (
    hasRetainedDisplay(profile, row, available) &&
    profile.account.avatar &&
    isFacebookAvatarURL(profile.account.avatar)
  )
    return profile.account.avatar;
  return hasCurrentDisplay(profile, row, available, now)
    ? (row?.avatarObservation?.url ?? null)
    : null;
}
export function inspectionDisplayName(
  profile: Profile,
  row: Inspection | undefined,
  available: boolean,
  now = Date.now(),
): string | null {
  if (
    !['logged-out', 'restricted', 'verification'].includes(profile.account.state) &&
    profile.account.name &&
    (!row || row.profileId === profile.id)
  )
    return profile.account.name;
  if (hasRetainedDisplay(profile, row, available)) return profile.account.name;
  return hasCurrentDisplay(profile, row, available, now)
    ? (row?.nameObservation?.name ?? row?.account.name ?? null)
    : null;
}

const reasons: Record<InspectionReasonCode, { title: string; detail: string }> = {
  ACTING_ACCOUNT_UNVERIFIED: {
    title: '页面已读取 · 操作身份待确认',
    detail: '检查完成，但无法可靠确认当前操作的账号。请在浏览器中核对个人账号或主页身份。',
  },
  VISIBLE_LOGIN_FORM: {
    title: 'Facebook 未登录',
    detail: '检查页显示登录表单。请在这份浏览器中登录，再检查状态。',
  },
  CHECKPOINT_ROUTE: {
    title: 'Facebook 需要验证',
    detail: '检查页进入了验证流程。请在浏览器中完成平台要求的验证。',
  },
  PROFILE_OFFLINE: {
    title: '浏览器未连接',
    detail: '请打开这份已安装桥接插件的浏览器，并保持本机软件运行。',
  },
  INSPECTION_EXTENSION_UPDATE_REQUIRED: {
    title: '桥接插件需要刷新',
    detail: '这份浏览器的插件缺少检查能力。请在扩展管理页刷新正式桥接插件。',
  },
  INSPECTION_PROFILE_NOT_IDLE: {
    title: '通道尚未就绪',
    detail: '请等待连接和停止处理完成，再手动检查。',
  },
  INSPECTION_PLAN_PENDING: {
    title: '已有任务 · 检查未开始',
    detail: '这份资料仍有未结束的计划，请先处理计划。',
  },
  INSPECTION_OPERATION_PENDING: {
    title: '有操作需要核对',
    detail: '存在结果未确认的操作。请先核对原操作，避免重复执行。',
  },
  INSPECTION_NATIVE_REVIEW_REQUIRED: {
    title: '原任务页需要核对',
    detail: '上次任务页归属尚未确认。不要删除记录或关闭其他页面来解除此状态。',
  },
  INSPECTION_CONNECTION_CHANGED: {
    title: '连接已变化 · 请重新检查',
    detail: '旧连接的结果已失效。当前浏览器连接就绪后可手动重新检查。',
  },
  INSPECTION_EXPIRED: {
    title: '检查已过期',
    detail:
      '实时登录状态已过期；同一连接内的名称和头像仅保留作显示。需要新状态时请手动检查，任务执行前会独立核验身份。',
  },
  INSPECTION_CANCELLED: {
    title: '检查已取消',
    detail: '停止或关闭服务撤销了这次检查。连接就绪后可手动重新检查。',
  },
  INSPECTION_RELEASE_PENDING: {
    title: '正在结束上次检查',
    detail: '请等待原检查结束。系统不会同时为同一份资料打开两个检查页。',
  },
  INSPECTION_DOCUMENT_NOT_READY: {
    title: '等待已打开的 Facebook 首页',
    detail: '请在这份浏览器打开并载入Facebook首页后检查；软件不会为了刷新头像反复新开页面。',
  },
  INSPECTION_DOCUMENT_CHANGED: {
    title: '页面或归属已变化',
    detail: '检查期间页面或归属发生变化，原结果没有采用。请先核对浏览器状态。',
  },
  INSPECTION_READ_RELEASE_UNCONFIRMED: {
    title: '检查页关闭未确认 · 需要核对',
    detail: '页面读取不代表检查已安全结束。原检查页关闭或停止回执尚未确认，请保留原记录。',
  },
  INSPECTION_TRANSPORT_UNCONFIRMED: {
    title: '检查回执未确认 · 需要核对',
    detail: '连接没有返回确定回执。不要重复发送原操作，请先核对连接和原检查。',
  },
  INSPECTION_CONTROL_INTERRUPTED: {
    title: '浏览器调试连接已中断',
    detail: '浏览器控制已中断。请核对浏览器中的调试提示及连接状态，保留原记录。',
  },
  INSPECTION_FAILED: {
    title: '检查失败',
    detail: '未取得可用结果。请核对浏览器和网络状态，再读取已有检查结果。',
  },
};
const reviewReasons = new Set<InspectionReasonCode>([
  'INSPECTION_PLAN_PENDING',
  'INSPECTION_OPERATION_PENDING',
  'INSPECTION_NATIVE_REVIEW_REQUIRED',
  'INSPECTION_READ_RELEASE_UNCONFIRMED',
  'INSPECTION_TRANSPORT_UNCONFIRMED',
  'INSPECTION_CONTROL_INTERRUPTED',
  'INSPECTION_RELEASE_PENDING',
]);
export function inspectionPresentation(
  profile: Profile,
  row: Inspection | undefined,
  available: boolean,
  now = Date.now(),
) {
  const matching = row?.profileId === profile.id ? row : undefined;
  const current =
    matching?.state === 'OBSERVED' &&
    matching.checkedAt !== null &&
    (now < matching.checkedAt || now - matching.checkedAt >= 30_000)
      ? { ...matching, reason: 'INSPECTION_EXPIRED' as const }
      : matching;
  const pending = current?.state === 'QUEUED' || current?.state === 'READING';
  const requiresReview = !!current?.reason && reviewReasons.has(current.reason);
  const canCheck =
    profile.online &&
    profile.synced &&
    profile.phase === 'PAUSED' &&
    profile.capabilities.includes('facebook-readonly-v2') &&
    profile.unresolved === 0 &&
    !pending &&
    !requiresReview;
  if (!profile.online) return { ...reasons.PROFILE_OFFLINE, canCheck: false };
  if (!available)
    return {
      title: '检查结果暂不可用',
      detail: '请先重新读取已有结果。此操作不会打开Facebook页面。',
      canCheck: false,
    };
  if (pending)
    return {
      title: current?.state === 'QUEUED' ? 'FB 检查排队中' : '正在读取 Facebook',
      detail: '请等待这次只读检查结束，浏览器选择和分组不会改变。',
      canCheck: false,
    };
  if (current?.reason) return { ...reasons[current.reason], canCheck };
  if (!profile.synced || profile.phase !== 'PAUSED')
    return { ...reasons.INSPECTION_PROFILE_NOT_IDLE, canCheck: false };
  if (!profile.capabilities.includes('facebook-readonly-v2'))
    return { ...reasons.INSPECTION_EXTENSION_UPDATE_REQUIRED, canCheck: false };
  if (profile.unresolved) return { ...reasons.INSPECTION_OPERATION_PENDING, canCheck: false };
  if (current?.state === 'OBSERVED' && current.account.state === 'logged-in')
    return {
      title: 'Facebook 已登录',
      detail: '最近只读检查已确认当前账号。任务执行前仍会独立核验身份。',
      canCheck,
    };
  return {
    title: '尚未检查 Facebook',
    detail: '连接就绪后自动检查一次，也可点击“检查这份FB状态”。只读检查不会点赞或发布内容。',
    canCheck,
  };
}
