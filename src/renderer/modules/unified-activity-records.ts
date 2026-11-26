import { endedTask, groupTaskRecords } from '../../domain/task-run-records.js';
import { profileDisplayName, type Profile } from '../../shared/contracts.js';
import type { GoogleSheetsOverview } from '../../shared/google-sheets.js';
import type { BumperLog, BumperState } from '../../shared/group-bumper.js';
import type { GroupInviteLogRow, GroupInviterState } from '../../shared/group-inviter.js';
import {
  isPendingApprovalPostId,
  type PosterLog,
  type PosterState,
} from '../../shared/group-poster.js';
import type { TaskRecord } from '../../shared/task-contracts.js';
import { taskReasonDescription } from '../../shared/task-issues.js';
import { runSummary, stepResultLabel } from '../task-record-summary.js';

export type ActivityRecordModuleId =
  | 'active-accounts'
  | 'group-inviter'
  | 'group-bumper'
  | 'page-bumper'
  | 'group-poster'
  | 'google-sheets';
export type ActivityRecordModuleFilter = 'all' | ActivityRecordModuleId;
export type ActivityRecordStatus = 'running' | 'completed' | 'failed' | 'attention';
export type ActivityRecordStatusFilter = 'all' | ActivityRecordStatus;

export interface UnifiedActivityItem {
  moduleId: ActivityRecordModuleId;
  moduleLabel: string;
  id: string;
  profileId: string;
  profileName: string;
  title: string;
  targetLabel: string;
  detailText: string;
  status: ActivityRecordStatus;
  statusLabel: string;
  tone: 'run' | 'ok' | 'warn' | 'err' | 'idle' | 'queue';
  timestamp: number;
  planId?: string | undefined;
  round?: number | undefined;
  postUrl?: string | undefined;
  bumperLogId?: string | undefined;
  posterLogId?: string | undefined;
}

export interface UnifiedActivityFeedInput {
  profiles: readonly Profile[];
  taskRecords?: readonly TaskRecord[] | undefined;
  attentionPlanIds?: ReadonlySet<string> | undefined;
  inviterState?: GroupInviterState | null | undefined;
  inviterLogs?: readonly GroupInviteLogRow[] | undefined;
  bumperState?: BumperState | null | undefined;
  bumperLogs?: readonly BumperLog[] | undefined;
  posterState?: PosterState | null | undefined;
  posterLogs?: readonly PosterLog[] | undefined;
  googleSheetsOverview?: GoogleSheetsOverview | null | undefined;
  profileId?: string | null | undefined;
  moduleFilter?: ActivityRecordModuleFilter | undefined;
  statusFilter?: ActivityRecordStatusFilter | undefined;
  query?: string | undefined;
  now?: number | undefined;
}

export interface UnifiedActivityFeedResult {
  items: UnifiedActivityItem[];
  statusCounts: Record<ActivityRecordStatusFilter, number>;
  nonActiveStatusCounts: Record<ActivityRecordStatusFilter, number>;
  moduleCounts: Record<ActivityRecordModuleFilter, number>;
}

const MODULE_LABELS: Record<ActivityRecordModuleId, string> = {
  'active-accounts': '活跃账号',
  'group-inviter': '小组邀请人',
  'group-bumper': '小组顶贴',
  'page-bumper': '专页顶贴',
  'group-poster': '小组发帖',
  'google-sheets': '云表协同',
};
const ACTIVE_STATE_META: Record<
  string,
  { status: ActivityRecordStatus; statusLabel: string; tone: UnifiedActivityItem['tone'] }
> = {
  FAILED: { status: 'failed', statusLabel: '执行异常', tone: 'err' },
  REVIEW: { status: 'attention', statusLabel: '需处理', tone: 'warn' },
  PAUSED: { status: 'attention', statusLabel: '已暂停', tone: 'warn' },
  PAUSING: { status: 'attention', statusLabel: '已暂停', tone: 'warn' },
  COMPLETED: { status: 'completed', statusLabel: '已完成', tone: 'ok' },
  QUEUED: { status: 'running', statusLabel: '排队中', tone: 'queue' },
  STOPPING: { status: 'running', statusLabel: '停止中', tone: 'warn' },
};
const emptyStatusCounts = (): Record<ActivityRecordStatusFilter, number> => ({
  all: 0,
  running: 0,
  completed: 0,
  failed: 0,
  attention: 0,
});

export function buildUnifiedActivityFeed(
  input: UnifiedActivityFeedInput,
): UnifiedActivityFeedResult {
  const byProfile = new Map(input.profiles.map((p) => [p.id, p]));
  const profName = (pid: string) => profileDisplayName(byProfile.get(pid), pid);
  const now = input.now ?? Date.now();
  const allItems: UnifiedActivityItem[] = [];
  const push = (
    moduleId: ActivityRecordModuleId,
    item: Omit<UnifiedActivityItem, 'moduleId' | 'moduleLabel' | 'profileName'>,
    explicitName?: string,
  ) =>
    allItems.push({
      moduleId,
      moduleLabel: MODULE_LABELS[moduleId],
      profileName: explicitName ?? profName(item.profileId),
      ...item,
    });
  const hasAttention = (mod: ActivityRecordModuleId, pid: string) =>
    allItems.some((i) => i.moduleId === mod && i.profileId === pid && i.status === 'attention');

  for (const group of groupTaskRecords([...(input.taskRecords ?? [])])) {
    const first = group.rows[0];
    if (!first) continue;
    const rawState =
      (input.attentionPlanIds?.has(first.planId) ?? false) && !endedTask(first.planState)
        ? 'REVIEW'
        : group.state;
    const meta =
      rawState === 'STOPPED'
        ? {
            status: 'completed' as const,
            statusLabel: `已停止 (${group.completed}/${group.rows.length})`,
            tone: 'idle' as const,
          }
        : (ACTIVE_STATE_META[rawState] ?? {
            status: 'running' as const,
            statusLabel: '执行中',
            tone: 'run' as const,
          });
    const reasonText = first.planReason
      ? taskReasonDescription(first.planReason)?.summary
      : undefined;
    const summaryText = runSummary(group.rows);
    push('active-accounts', {
      id: `active:${group.key}`,
      profileId: first.profileId,
      title: first.combinationName + (first.round > 1 ? ` · 第 ${first.round} 轮` : ''),
      targetLabel: group.rows.map(stepResultLabel).join(' · '),
      detailText:
        rawState === 'FAILED' && reasonText ? `${reasonText} · ${summaryText}` : summaryText,
      ...meta,
      timestamp: group.finishedAt ?? group.startedAt ?? first.planUpdatedAt,
      planId: first.planId,
      round: first.round,
    });
  }

  const inviterGroupNames = new Map(
    (input.inviterState?.groups ?? []).map((g) => [g.groupId, g.groupName]),
  );
  for (const [pid, stat] of Object.entries(input.inviterState?.profileCounts ?? {})) {
    const s = stat.status?.trim() ?? '';
    if (!s || s === '已完成' || s === '已停止') continue;
    const isFailed = s.startsWith('失败'),
      isSkipped = s.startsWith('跳过'),
      isRunning =
        (Boolean(stat.running) || Boolean(input.inviterState?.running)) && !isFailed && !isSkipped;
    if (!isRunning && !isFailed && !isSkipped) continue;
    push('group-inviter', {
      id: `inviter-${isRunning ? 'live' : isFailed ? 'fail' : 'skip'}:${pid}`,
      profileId: pid,
      title: `小组邀请人 · ${isRunning ? '实时任务' : isFailed ? '执行异常' : '跳过提醒'}`,
      targetLabel: s,
      detailText: `本轮已邀请 ${stat.sessionInvited} 人 · 历史累计 ${stat.totalInvited} 人`,
      status: isRunning ? 'running' : isFailed ? 'failed' : 'attention',
      statusLabel: isRunning ? '邀请中' : isFailed ? '邀请异常' : '已跳过',
      tone: isRunning ? 'run' : isFailed ? 'err' : 'warn',
      timestamp: isRunning
        ? (input.inviterState?.startedAt ?? now)
        : (input.inviterState?.finishedAt ?? input.inviterState?.startedAt ?? now),
    });
  }
  for (const log of input.inviterLogs ?? []) {
    const gName = inviterGroupNames.get(log.groupId);
    push('group-inviter', {
      id: `inviter-log:${log.id}`,
      profileId: log.profileId,
      title: '邀请好友加入小组',
      targetLabel: gName ? `${gName} (${log.groupId})` : `小组 ${log.groupId}`,
      detailText: `已邀请好友 ${log.friendName || log.friendId}（执行账号 ${log.accountId}）`,
      status: 'completed',
      statusLabel: '已邀请',
      tone: 'ok',
      timestamp: log.invitedAt,
    });
  }

  for (const [mod, counts] of [
    ['group-bumper', input.bumperState?.profileCounts],
    ['page-bumper', input.bumperState?.pageBumperProfileCounts],
  ] as const) {
    for (const [pid, stat] of Object.entries(counts ?? {})) {
      const s = stat.status.trim();
      const mode:
        | readonly [
            string,
            string,
            ActivityRecordStatus,
            string,
            UnifiedActivityItem['tone'],
            number,
            string,
          ]
        | null = stat.running
        ? ['live', '实时任务', 'running', '顶贴中', 'run', now, s || '正在浏览与顶贴']
        : s && /受限|失败|异常|拦截|频繁/.test(s)
          ? ['err', '执行异常', 'failed', '顶贴异常', 'err', now - 1000, s]
          : s && stat.session === 0 && /0\s*次|未匹配|跳过/.test(s)
            ? ['warn', '0 次原因说明', 'attention', '需留意', 'warn', now - 2000, s]
            : null;
      if (mode)
        push(mod, {
          id: `${mod}-${mode[0]}:${pid}`,
          profileId: pid,
          title: `${MODULE_LABELS[mod]} · ${mode[1]}`,
          targetLabel: mode[6],
          detailText: `本轮顶贴 ${stat.session} 次 · 今日累计 ${stat.today} 次`,
          status: mode[2],
          statusLabel: mode[3],
          tone: mode[4],
          timestamp: mode[5],
        });
    }
  }
  for (const op of input.bumperState?.pendingReviewOperations ?? []) {
    const isPage = op.groupId === '-',
      mod: ActivityRecordModuleId = isPage ? 'page-bumper' : 'group-bumper';
    if (hasAttention(mod, op.profileId)) continue;
    const act =
      op.actionKind === 'comment' ? '评论' : op.actionKind === 'story_share' ? '分享快拍' : '点赞';
    push(mod, {
      id: `bumper-op:${op.id}`,
      profileId: op.profileId,
      title: `${MODULE_LABELS[mod]} · 待核对记录`,
      targetLabel: isPage
        ? op.pageName || op.pageId
        : `${op.groupName || op.groupId} · ${op.pageName || op.pageId}`,
      detailText: `${act}结果未确认（帖子 ${op.postId}${op.reason ? ` · ${op.reason}` : ''}）`,
      status: 'attention',
      statusLabel: '待核对',
      tone: 'warn',
      timestamp: op.updatedAt,
    });
  }
  for (const log of input.bumperLogs ?? []) {
    const isPage = log.sourceMode === 'page' || log.groupId === '-',
      mod: ActivityRecordModuleId = isPage ? 'page-bumper' : 'group-bumper';
    const actions = [
      log.liked ? '👍 点赞' : '',
      log.commentText ? '💬 评论' : '',
      log.storyShared ? '📖 分享快拍' : '',
    ].filter(Boolean);
    const details = [
      log.liked ? '已点赞' : '',
      log.commentText ? `评论：「${log.commentText}」` : '',
      log.storyShared ? '已分享到快拍' : '',
    ].filter(Boolean);
    push(mod, {
      id: `bumper-log:${log.id}`,
      profileId: log.profileId,
      title: actions.join(' + ') || MODULE_LABELS[mod],
      targetLabel: isPage
        ? log.pageName || log.pageId
        : `${log.groupName || log.groupId} · ${log.pageName || log.pageId}`,
      detailText: `${details.join(' · ') || '已互动目标贴'}（帖子 ${log.postId} · 账号 ${log.accountId}）`,
      status: 'completed',
      statusLabel: '已顶贴',
      tone: 'ok',
      timestamp: log.bumpedAt,
      postUrl: log.postUrl,
      bumperLogId: log.id,
    });
  }

  for (const [pid, stat] of Object.entries(input.posterState?.profileCounts ?? {})) {
    const s = stat.status.trim(),
      isReview = Boolean(s && /待核对|未确认|PENDING_REVIEW/i.test(s)),
      isErr = Boolean(s && /受限|失败|异常|拦截|频繁/.test(s));
    if (!stat.running && !isReview && !isErr) continue;
    push('group-poster', {
      id: `poster-${stat.running ? 'live' : isReview ? 'review' : 'err'}:${pid}`,
      profileId: pid,
      title: `小组发帖 · ${stat.running ? '实时任务' : isReview ? '待核对记录' : '执行异常'}`,
      targetLabel: s || '正在执行小组发帖',
      detailText: `本轮已发 ${stat.session} 贴 · 今日累计 ${stat.today} 贴`,
      status: stat.running ? 'running' : isReview ? 'attention' : 'failed',
      statusLabel: stat.running ? '发帖中' : isReview ? '待核对' : '发帖异常',
      tone: stat.running ? 'run' : isReview ? 'warn' : 'err',
      timestamp: stat.running ? now : now - (isReview ? 500 : 1000),
    });
  }
  for (const op of input.posterState?.pendingReviewOperations ?? []) {
    if (hasAttention('group-poster', op.profileId)) continue;
    push('group-poster', {
      id: `poster-op:${op.id}`,
      profileId: op.profileId,
      title: '小组发帖 · 待核对记录',
      targetLabel: op.groupName || op.groupId,
      detailText: `发帖提交结果未确认${op.reason ? `（${op.reason}）` : ''}`,
      status: 'attention',
      statusLabel: '待核对',
      tone: 'warn',
      timestamp: op.updatedAt,
    });
  }
  for (const log of input.posterLogs ?? []) {
    const pending = isPendingApprovalPostId(log.postId);
    push('group-poster', {
      id: `poster-log:${log.id}`,
      profileId: log.profileId,
      title: pending ? '小组发帖（待群管审核）' : '小组发帖',
      targetLabel: log.groupName || log.groupId,
      detailText: `${log.captionPreview || '无文案媒体贴'}（身份 ${log.accountName || log.accountId}）`,
      status: pending ? 'attention' : 'completed',
      statusLabel: pending ? '待审核' : '已发帖',
      tone: pending ? 'warn' : 'ok',
      timestamp: log.postedAt,
      postUrl: log.postUrl,
      posterLogId: log.id,
    });
  }

  if (input.googleSheetsOverview) {
    const linkTitles = new Map(input.googleSheetsOverview.links.map((l) => [l.id, l.title]));
    for (const a of input.googleSheetsOverview.activeProfiles ?? []) {
      push('google-sheets', {
        id: `gs-live:${a.linkId}:${a.profileId}`,
        profileId: a.profileId,
        title:
          a.kind === 'post_schedule'
            ? '云表排贴 · 实时发布'
            : a.kind === 'metrics'
              ? '云表记录 · 采集赞评'
              : '云表顶贴 · 实时执行',
        targetLabel: a.title || linkTitles.get(a.linkId) || '云表协同',
        detailText: a.status || '正在执行云表任务',
        status: 'running',
        statusLabel: '执行中',
        tone: 'run',
        timestamp: now,
      });
    }
    for (const log of input.googleSheetsOverview.logs ?? []) {
      const sheetTitle = log.linkId ? (linkTitles.get(log.linkId) ?? '云表') : '云表全局',
        isErr = log.level === 'error' || /失败|异常/.test(log.summary),
        isWarn =
          !isErr && (log.level === 'warn' || /部分完成|跳过|暂无|未找到|需在线/.test(log.summary));
      const actionTitle =
        (
          [
            ['schedule_', '云表排贴'],
            ['records_', '云表顶贴'],
            ['metrics_', '云表采赞评'],
            ['library_', '云表库同步'],
          ] as const
        ).find(([p]) => log.action.startsWith(p))?.[1] ?? '云表协同';
      push(
        'google-sheets',
        {
          id: `gs-log:${log.id}`,
          profileId: '__google_sheets__',
          title: actionTitle,
          targetLabel: sheetTitle,
          detailText: log.summary,
          status: isErr ? 'failed' : isWarn ? 'attention' : 'completed',
          statusLabel: isErr ? '失败' : isWarn ? '需留意' : '已完成',
          tone: isErr ? 'err' : isWarn ? 'warn' : 'ok',
          timestamp: log.createdAt,
        },
        sheetTitle,
      );
    }
  }

  const q = (input.query ?? '').trim().toLowerCase();
  const queryFiltered = allItems.filter(
    (it) =>
      (!input.profileId || it.profileId === input.profileId) &&
      (!q ||
        [
          it.profileName,
          it.profileId,
          it.title,
          it.targetLabel,
          it.detailText,
          it.moduleLabel,
        ].some((s) => s.toLowerCase().includes(q))),
  );
  const moduleCounts: Record<ActivityRecordModuleFilter, number> = {
    all: queryFiltered.length,
    'active-accounts': 0,
    'group-inviter': 0,
    'group-bumper': 0,
    'page-bumper': 0,
    'group-poster': 0,
    'google-sheets': 0,
  };
  for (const it of queryFiltered) moduleCounts[it.moduleId] += 1;

  const modFilter = input.moduleFilter ?? 'all';
  const moduleFiltered =
    modFilter === 'all' ? queryFiltered : queryFiltered.filter((i) => i.moduleId === modFilter);
  const statusCounts = { ...emptyStatusCounts(), all: moduleFiltered.length },
    nonActiveStatusCounts = emptyStatusCounts();
  for (const it of moduleFiltered) {
    statusCounts[it.status] += 1;
    if (it.moduleId !== 'active-accounts') {
      nonActiveStatusCounts.all += 1;
      nonActiveStatusCounts[it.status] += 1;
    }
  }
  const statusFilter = input.statusFilter ?? 'all';
  const items = (
    statusFilter === 'all'
      ? moduleFiltered
      : moduleFiltered.filter((i) => i.status === statusFilter)
  )
    .slice()
    .sort((a, b) =>
      a.status === 'running' && b.status !== 'running'
        ? -1
        : b.status === 'running' && a.status !== 'running'
          ? 1
          : b.timestamp - a.timestamp,
    );
  return { items, statusCounts, nonActiveStatusCounts, moduleCounts };
}
