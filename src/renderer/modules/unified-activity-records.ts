import type { Profile } from '../../shared/contracts.js';
import type { TaskRecord } from '../../shared/task-contracts.js';
import type { GroupInviteLogRow, GroupInviterState } from '../../shared/group-inviter.js';
import type { BumperLog, BumperState } from '../../shared/group-bumper.js';
import { endedTask, groupTaskRecords } from '../../domain/task-run-records.js';
import { runSummary, stepResultLabel } from '../task-record-summary.js';
import { taskReasonDescription } from '../../shared/task-issues.js';

export type ActivityRecordModuleId = 'active-accounts' | 'group-inviter' | 'group-bumper';
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
}

export interface UnifiedActivityFeedInput {
  profiles: readonly Profile[];
  taskRecords?: readonly TaskRecord[] | undefined;
  attentionPlanIds?: ReadonlySet<string> | undefined;
  inviterState?: GroupInviterState | null | undefined;
  inviterLogs?: readonly GroupInviteLogRow[] | undefined;
  bumperState?: BumperState | null | undefined;
  bumperLogs?: readonly BumperLog[] | undefined;
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

export function buildUnifiedActivityFeed(
  input: UnifiedActivityFeedInput,
): UnifiedActivityFeedResult {
  const byProfile = new Map(input.profiles.map((p) => [p.id, p]));
  const now = input.now ?? Date.now();
  const allItems: UnifiedActivityItem[] = [];

  // 1. Active Accounts (日常养号与组合任务)
  const taskGroups = groupTaskRecords([...(input.taskRecords ?? [])]);
  for (const group of taskGroups) {
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
    const detailText =
      rawState === 'FAILED' && reasonText ? `${reasonText} · ${summaryText}` : summaryText;

    allItems.push({
      moduleId: 'active-accounts',
      moduleLabel: '活跃账号',
      id: `active:${group.key}`,
      profileId: first.profileId,
      profileName: resolveProfileName(byProfile, first.profileId),
      title: first.combinationName + (first.round > 1 ? ` · 第 ${first.round} 轮` : ''),
      targetLabel: group.rows.map((step) => stepResultLabel(step)).join(' · '),
      detailText,
      status,
      statusLabel,
      tone,
      timestamp: group.finishedAt ?? group.startedAt ?? first.planUpdatedAt,
      planId: first.planId,
      round: first.round,
    });
  }

  // 2. Group Inviter (小组邀请人)
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
      const isRunning = input.inviterState.running && !isEnded && !isFailed && !isSkipped;

      if (isRunning) {
        allItems.push({
          moduleId: 'group-inviter',
          moduleLabel: '小组邀请人',
          id: `inviter-live:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: '小组邀请人 · 实时任务',
          targetLabel: statusStr,
          detailText: `本轮已邀请 ${stat.sessionInvited} 人 · 历史累计 ${stat.totalInvited} 人`,
          status: 'running',
          statusLabel: '邀请中',
          tone: 'run',
          timestamp: input.inviterState.startedAt ?? now,
        });
      } else if (isFailed) {
        allItems.push({
          moduleId: 'group-inviter',
          moduleLabel: '小组邀请人',
          id: `inviter-fail:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: '小组邀请人 · 执行异常',
          targetLabel: statusStr,
          detailText: `本轮已邀请 ${stat.sessionInvited} 人 · 历史累计 ${stat.totalInvited} 人`,
          status: 'failed',
          statusLabel: '邀请异常',
          tone: 'err',
          timestamp: input.inviterState.finishedAt ?? input.inviterState.startedAt ?? now,
        });
      } else if (isSkipped) {
        allItems.push({
          moduleId: 'group-inviter',
          moduleLabel: '小组邀请人',
          id: `inviter-skip:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: '小组邀请人 · 跳过提醒',
          targetLabel: statusStr,
          detailText: `本轮已邀请 ${stat.sessionInvited} 人 · 历史累计 ${stat.totalInvited} 人`,
          status: 'attention',
          statusLabel: '已跳过',
          tone: 'warn',
          timestamp: input.inviterState.finishedAt ?? input.inviterState.startedAt ?? now,
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

  // 3. Group Bumper (小组顶贴)
  if (input.bumperState) {
    for (const [pid, stat] of Object.entries(input.bumperState.profileCounts)) {
      const statusStr = stat.status.trim();
      if (stat.running) {
        allItems.push({
          moduleId: 'group-bumper',
          moduleLabel: '小组顶贴',
          id: `bumper-live:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: '小组顶贴 · 实时任务',
          targetLabel: statusStr || '正在浏览与顶贴',
          detailText: `本轮顶贴 ${stat.session} 次 · 今日累计 ${stat.today} 次`,
          status: 'running',
          statusLabel: '顶贴中',
          tone: 'run',
          timestamp: now,
        });
      } else if (statusStr && /受限|失败|异常|拦截|频繁/.test(statusStr)) {
        allItems.push({
          moduleId: 'group-bumper',
          moduleLabel: '小组顶贴',
          id: `bumper-err:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: '小组顶贴 · 执行异常',
          targetLabel: statusStr,
          detailText: `本轮顶贴 ${stat.session} 次 · 今日累计 ${stat.today} 次`,
          status: 'failed',
          statusLabel: '顶贴异常',
          tone: 'err',
          timestamp: now - 1000,
        });
      } else if (statusStr && stat.session === 0 && /0\s*次|未匹配|跳过/.test(statusStr)) {
        allItems.push({
          moduleId: 'group-bumper',
          moduleLabel: '小组顶贴',
          id: `bumper-warn:${pid}`,
          profileId: pid,
          profileName: resolveProfileName(byProfile, pid),
          title: '小组顶贴 · 0 次原因说明',
          targetLabel: statusStr,
          detailText: `本轮顶贴 ${stat.session} 次 · 今日累计 ${stat.today} 次`,
          status: 'attention',
          statusLabel: '需留意',
          tone: 'warn',
          timestamp: now - 2000,
        });
      }
    }
  }
  for (const log of input.bumperLogs ?? []) {
    const actionLabel =
      [log.liked ? '👍 点赞' : '', log.commentText ? '💬 评论' : ''].filter(Boolean).join(' + ') ||
      '小组顶贴';
    allItems.push({
      moduleId: 'group-bumper',
      moduleLabel: '小组顶贴',
      id: `bumper-log:${log.id}`,
      profileId: log.profileId,
      profileName: resolveProfileName(byProfile, log.profileId),
      title: actionLabel,
      targetLabel: `${log.groupName || log.groupId} · ${log.pageName || log.pageId}`,
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

  // Filter by profileId first
  const profileFiltered = input.profileId
    ? allItems.filter((item) => item.profileId === input.profileId)
    : allItems;

  // Filter by search query
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

  // Compute module counts before moduleFilter
  const moduleCounts: Record<ActivityRecordModuleFilter, number> = {
    all: queryFiltered.length,
    'active-accounts': 0,
    'group-inviter': 0,
    'group-bumper': 0,
  };
  for (const item of queryFiltered) {
    moduleCounts[item.moduleId] += 1;
  }

  // Filter by moduleFilter
  const moduleFilter = input.moduleFilter ?? 'all';
  const moduleFiltered =
    moduleFilter === 'all'
      ? queryFiltered
      : queryFiltered.filter((item) => item.moduleId === moduleFilter);

  // Compute status counts for the active moduleFilter
  const statusCounts: Record<ActivityRecordStatusFilter, number> = {
    all: moduleFiltered.length,
    running: 0,
    completed: 0,
    failed: 0,
    attention: 0,
  };
  for (const item of moduleFiltered) {
    statusCounts[item.status] += 1;
  }

  // Filter by statusFilter
  const statusFilter = input.statusFilter ?? 'all';
  const finalItems =
    statusFilter === 'all'
      ? moduleFiltered
      : moduleFiltered.filter((item) => item.status === statusFilter);

  // Sort: running items first, then descending timestamp
  finalItems.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (b.status === 'running' && a.status !== 'running') return 1;
    return b.timestamp - a.timestamp;
  });

  return {
    items: finalItems,
    statusCounts,
    moduleCounts,
  };
}
