import type { Profile } from '../../shared/contracts.js';
import type { TaskRecord } from '../../shared/task-contracts.js';
import type { GroupInviteLogRow, GroupInviterState } from '../../shared/group-inviter.js';
import type { BumperLog, BumperState } from '../../shared/group-bumper.js';
import type { PosterLog, PosterState } from '../../shared/group-poster.js';
import { endedTask, groupTaskRecords } from '../../domain/task-run-records.js';
import { runSummary, stepResultLabel } from '../task-record-summary.js';
import { taskReasonDescription } from '../../shared/task-issues.js';

export type ActivityRecordModuleId =
  'active-accounts' | 'group-inviter' | 'group-bumper' | 'page-bumper' | 'group-poster';
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
  profileId?: string | null | undefined;
  moduleFilter?: ActivityRecordModuleFilter | undefined;
  statusFilter?: ActivityRecordStatusFilter | undefined;
  query?: string | undefined;
  now?: number | undefined;
}

export interface UnifiedActivityFeedResult {
  items: UnifiedActivityItem[];
  statusCounts: Record<ActivityRecordStatusFilter, number>;
  moduleCounts: Record<ActivityRecordModuleFilter, number>;
}

function resolveProfileName(byProfile: ReadonlyMap<string, Profile>, profileId: string): string {
  const profile = byProfile.get(profileId);
  return profile?.browserName ?? profile?.alias ?? profileId;
}

function pushBumperProfileCounts(
  allItems: UnifiedActivityItem[],
  byProfile: ReadonlyMap<string, Profile>,
  counts: BumperState['profileCounts'] | undefined,
  moduleId: 'group-bumper' | 'page-bumper',
  moduleLabel: string,
  now: number,
) {
  if (!counts) return;
  for (const [pid, stat] of Object.entries(counts)) {
    const statusStr = stat.status.trim();
    const detailText = `本轮顶贴 ${stat.session} 次 · 今日累计 ${stat.today} 次`;
    if (stat.running) {
      allItems.push({
        moduleId,
        moduleLabel,
        id: `${moduleId}-live:${pid}`,
        profileId: pid,
        profileName: resolveProfileName(byProfile, pid),
        title: `${moduleLabel} · 实时任务`,
        targetLabel: statusStr || '正在浏览与顶贴',
        detailText,
        status: 'running',
        statusLabel: '顶贴中',
        tone: 'run',
        timestamp: now,
      });
    } else if (statusStr && /受限|失败|异常|拦截|频繁/.test(statusStr)) {
      allItems.push({
        moduleId,
        moduleLabel,
        id: `${moduleId}-err:${pid}`,
        profileId: pid,
        profileName: resolveProfileName(byProfile, pid),
        title: `${moduleLabel} · 执行异常`,
        targetLabel: statusStr,
        detailText,
        status: 'failed',
        statusLabel: '顶贴异常',
        tone: 'err',
        timestamp: now - 1000,
      });
    } else if (statusStr && stat.session === 0 && /0\s*次|未匹配|跳过/.test(statusStr)) {
      allItems.push({
        moduleId,
        moduleLabel,
        id: `${moduleId}-warn:${pid}`,
        profileId: pid,
        profileName: resolveProfileName(byProfile, pid),
        title: `${moduleLabel} · 0 次原因说明`,
        targetLabel: statusStr,
        detailText,
        status: 'attention',
        statusLabel: '需留意',
        tone: 'warn',
        timestamp: now - 2000,
      });
    }
  }
}

export function buildUnifiedActivityFeed(
  input: UnifiedActivityFeedInput,
): UnifiedActivityFeedResult {
  const byProfile = new Map(input.profiles.map((p) => [p.id, p]));
  const now = input.now ?? Date.now();
  const allItems: UnifiedActivityItem[] = [];

  // 1. Active Accounts
  for (const group of groupTaskRecords([...(input.taskRecords ?? [])])) {
    const first = group.rows[0];
    if (!first) continue;
    const isAttention =
      (input.attentionPlanIds?.has(first.planId) ?? false) && !endedTask(first.planState);
    const rawState = isAttention ? 'REVIEW' : group.state;

    let status: ActivityRecordStatus = 'running';
    let statusLabel = '执行中';
    let tone: UnifiedActivityItem['tone'] = 'run';
    if (rawState === 'FAILED') {
      status = 'failed';
      statusLabel = '执行异常';
      tone = 'err';
    } else if (rawState === 'REVIEW' || rawState === 'PAUSED' || rawState === 'PAUSING') {
      status = 'attention';
      statusLabel = rawState === 'REVIEW' ? '需处理' : '已暂停';
      tone = 'warn';
    } else if (rawState === 'COMPLETED') {
      status = 'completed';
      statusLabel = '已完成';
      tone = 'ok';
    } else if (rawState === 'STOPPED') {
      status = 'completed';
      statusLabel = `已停止 (${group.completed}/${group.rows.length})`;
      tone = 'idle';
    } else if (rawState === 'QUEUED') {
      status = 'running';
      statusLabel = '排队中';
      tone = 'queue';
    } else if (rawState === 'STOPPING') {
      status = 'running';
      statusLabel = '停止中';
      tone = 'warn';
    }

    const reasonText = first.planReason
      ? taskReasonDescription(first.planReason)?.summary
      : undefined;
    const summaryText = runSummary(group.rows);
    allItems.push({
      moduleId: 'active-accounts',
      moduleLabel: '活跃账号',
      id: `active:${group.key}`,
      profileId: first.profileId,
      profileName: resolveProfileName(byProfile, first.profileId),
      title: first.combinationName + (first.round > 1 ? ` · 第 ${first.round} 轮` : ''),
      targetLabel: group.rows.map((step) => stepResultLabel(step)).join(' · '),
      detailText:
        rawState === 'FAILED' && reasonText ? `${reasonText} · ${summaryText}` : summaryText,
      status,
      statusLabel,
      tone,
      timestamp: group.finishedAt ?? group.startedAt ?? first.planUpdatedAt,
      planId: first.planId,
      round: first.round,
    });
  }

  // 2. Group Inviter
  const inviterGroupNames = new Map(
    (input.inviterState?.groups ?? []).map((g) => [g.groupId, g.groupName]),
  );
  if (input.inviterState) {
    for (const [pid, stat] of Object.entries(input.inviterState.profileCounts)) {
      const statusStr = stat.status?.trim() ?? '';
      if (!statusStr) continue;
      const isEnded = statusStr === '已完成' || statusStr === '已停止';
      const isFailed = statusStr.startsWith('失败');
      const isSkipped = statusStr.startsWith('跳过');
      const isRunning =
        (Boolean(stat.running) || input.inviterState.running) &&
        !isEnded &&
        !isFailed &&
        !isSkipped;
      const detailText = `本轮已邀请 ${stat.sessionInvited} 人 · 历史累计 ${stat.totalInvited} 人`;
      if (isRunning || isFailed || isSkipped) {
        allItems.push({
          moduleId: 'group-inviter',
          moduleLabel: '小组邀请人',
          id: `inviter-${isRunning ? 'live' : isFailed ? 'fail' : 'skip'}:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: `小组邀请人 · ${isRunning ? '实时任务' : isFailed ? '执行异常' : '跳过提醒'}`,
          targetLabel: statusStr,
          detailText,
          status: isRunning ? 'running' : isFailed ? 'failed' : 'attention',
          statusLabel: isRunning ? '邀请中' : isFailed ? '邀请异常' : '已跳过',
          tone: isRunning ? 'run' : isFailed ? 'err' : 'warn',
          timestamp: isRunning
            ? (input.inviterState.startedAt ?? now)
            : (input.inviterState.finishedAt ?? input.inviterState.startedAt ?? now),
        });
      }
    }
  }
  for (const log of input.inviterLogs ?? []) {
    const groupName = inviterGroupNames.get(log.groupId);
    allItems.push({
      moduleId: 'group-inviter',
      moduleLabel: '小组邀请人',
      id: `inviter-log:${log.id}`,
      profileId: log.profileId,
      profileName: resolveProfileName(byProfile, log.profileId),
      title: '邀请好友加入小组',
      targetLabel: groupName ? `${groupName} (${log.groupId})` : `小组 ${log.groupId}`,
      detailText: `已邀请好友 ${log.friendName || log.friendId}（执行账号 ${log.accountId}）`,
      status: 'completed',
      statusLabel: '已邀请',
      tone: 'ok',
      timestamp: log.invitedAt,
    });
  }

  // 3 & 4. Group Bumper & Page Bumper
  if (input.bumperState) {
    pushBumperProfileCounts(
      allItems,
      byProfile,
      input.bumperState.profileCounts,
      'group-bumper',
      '小组顶贴',
      now,
    );
    pushBumperProfileCounts(
      allItems,
      byProfile,
      input.bumperState.pageBumperProfileCounts,
      'page-bumper',
      '专页顶贴',
      now,
    );
    for (const op of input.bumperState.pendingReviewOperations ?? []) {
      const isPage = op.groupId === '-';
      const modId: 'group-bumper' | 'page-bumper' = isPage ? 'page-bumper' : 'group-bumper';
      const modLabel = isPage ? '专页顶贴' : '小组顶贴';
      if (
        allItems.some(
          (i) => i.moduleId === modId && i.profileId === op.profileId && i.status === 'attention',
        )
      ) {
        continue;
      }
      allItems.push({
        moduleId: modId,
        moduleLabel: modLabel,
        id: `bumper-op:${op.id}`,
        profileId: op.profileId,
        profileName: resolveProfileName(byProfile, op.profileId),
        title: `${modLabel} · 待核对记录`,
        targetLabel: isPage
          ? `${op.pageName || op.pageId}`
          : `${op.groupName || op.groupId} · ${op.pageName || op.pageId}`,
        detailText: `${op.actionKind === 'comment' ? '评论' : '点赞'}结果未确认（帖子 ${op.postId}${op.reason ? ` · ${op.reason}` : ''}）`,
        status: 'attention',
        statusLabel: '待核对',
        tone: 'warn',
        timestamp: op.updatedAt,
      });
    }
  }
  for (const log of input.bumperLogs ?? []) {
    const isPage = log.sourceMode === 'page' || log.groupId === '-';
    const modId: 'group-bumper' | 'page-bumper' = isPage ? 'page-bumper' : 'group-bumper';
    const modLabel = isPage ? '专页顶贴' : '小组顶贴';
    const actionLabel =
      [log.liked ? '👍 点赞' : '', log.commentText ? '💬 评论' : ''].filter(Boolean).join(' + ') ||
      modLabel;
    allItems.push({
      moduleId: modId,
      moduleLabel: modLabel,
      id: `bumper-log:${log.id}`,
      profileId: log.profileId,
      profileName: resolveProfileName(byProfile, log.profileId),
      title: actionLabel,
      targetLabel: isPage
        ? `${log.pageName || log.pageId}`
        : `${log.groupName || log.groupId} · ${log.pageName || log.pageId}`,
      detailText: log.commentText
        ? `评论：「${log.commentText}」（帖子 ${log.postId} · 账号 ${log.accountId}）`
        : `已点赞目标贴（帖子 ${log.postId} · 账号 ${log.accountId}）`,
      status: 'completed',
      statusLabel: '已顶贴',
      tone: 'ok',
      timestamp: log.bumpedAt,
      postUrl: log.postUrl,
      bumperLogId: log.id,
    });
  }

  // 5. Group Poster
  if (input.posterState) {
    for (const [pid, stat] of Object.entries(input.posterState.profileCounts)) {
      const statusStr = stat.status.trim();
      const isReview = Boolean(statusStr && /待核对|未确认|PENDING_REVIEW/i.test(statusStr));
      const isErr = Boolean(statusStr && /受限|失败|异常|拦截|频繁/.test(statusStr));
      if (stat.running || isReview || isErr) {
        allItems.push({
          moduleId: 'group-poster',
          moduleLabel: '小组发帖',
          id: `poster-${stat.running ? 'live' : isReview ? 'review' : 'err'}:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: `小组发帖 · ${stat.running ? '实时任务' : isReview ? '待核对记录' : '执行异常'}`,
          targetLabel: statusStr || '正在执行小组发帖',
          detailText: `本轮已发 ${stat.session} 贴 · 今日累计 ${stat.today} 贴`,
          status: stat.running ? 'running' : isReview ? 'attention' : 'failed',
          statusLabel: stat.running ? '发帖中' : isReview ? '待核对' : '发帖异常',
          tone: stat.running ? 'run' : isReview ? 'warn' : 'err',
          timestamp: stat.running ? now : now - (isReview ? 500 : 1000),
        });
      }
    }
    for (const op of input.posterState.pendingReviewOperations ?? []) {
      if (
        allItems.some(
          (i) =>
            i.moduleId === 'group-poster' &&
            i.profileId === op.profileId &&
            i.status === 'attention',
        )
      ) {
        continue;
      }
      allItems.push({
        moduleId: 'group-poster',
        moduleLabel: '小组发帖',
        id: `poster-op:${op.id}`,
        profileId: op.profileId,
        profileName: resolveProfileName(byProfile, op.profileId),
        title: '小组发帖 · 待核对记录',
        targetLabel: op.groupName || op.groupId,
        detailText: `发帖提交结果未确认${op.reason ? `（${op.reason}）` : ''}`,
        status: 'attention',
        statusLabel: '待核对',
        tone: 'warn',
        timestamp: op.updatedAt,
      });
    }
  }
  for (const log of input.posterLogs ?? []) {
    const isPending = log.postId === 'pending_approval';
    allItems.push({
      moduleId: 'group-poster',
      moduleLabel: '小组发帖',
      id: `poster-log:${log.id}`,
      profileId: log.profileId,
      profileName: resolveProfileName(byProfile, log.profileId),
      title: isPending ? '小组发帖（待群管审核）' : '小组发帖',
      targetLabel: `${log.groupName || log.groupId}`,
      detailText: `${log.captionPreview || '无文案媒体贴'}（身份 ${log.accountName || log.accountId}）`,
      status: isPending ? 'attention' : 'completed',
      statusLabel: isPending ? '待审核' : '已发帖',
      tone: isPending ? 'warn' : 'ok',
      timestamp: log.postedAt,
      postUrl: log.postUrl,
      posterLogId: log.id,
    });
  }

  const profileFiltered = input.profileId
    ? allItems.filter((item) => item.profileId === input.profileId)
    : allItems;
  const q = (input.query ?? '').trim().toLowerCase();
  const queryFiltered = q
    ? profileFiltered.filter(
        (item) =>
          item.profileName.toLowerCase().includes(q) ||
          item.profileId.toLowerCase().includes(q) ||
          item.title.toLowerCase().includes(q) ||
          item.targetLabel.toLowerCase().includes(q) ||
          item.detailText.toLowerCase().includes(q) ||
          item.moduleLabel.toLowerCase().includes(q),
      )
    : profileFiltered;

  const moduleCounts: Record<ActivityRecordModuleFilter, number> = {
    all: queryFiltered.length,
    'active-accounts': 0,
    'group-inviter': 0,
    'group-bumper': 0,
    'page-bumper': 0,
    'group-poster': 0,
  };
  for (const item of queryFiltered) moduleCounts[item.moduleId] += 1;

  const moduleFilter = input.moduleFilter ?? 'all';
  const moduleFiltered =
    moduleFilter === 'all'
      ? queryFiltered
      : queryFiltered.filter((item) => item.moduleId === moduleFilter);

  const statusCounts: Record<ActivityRecordStatusFilter, number> = {
    all: moduleFiltered.length,
    running: 0,
    completed: 0,
    failed: 0,
    attention: 0,
  };
  for (const item of moduleFiltered) statusCounts[item.status] += 1;

  const statusFilter = input.statusFilter ?? 'all';
  const finalItems =
    statusFilter === 'all'
      ? moduleFiltered
      : moduleFiltered.filter((item) => item.status === statusFilter);
  finalItems.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.timestamp - a.timestamp;
  });

  return { items: finalItems, statusCounts, moduleCounts };
}
