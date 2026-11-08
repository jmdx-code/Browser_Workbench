import { RecordCleanupActions } from './data-cleanup-panel.js';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import type { TaskRecord, TaskRuntimeOverview } from '../shared/task-contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import type { GroupInviteLogRow, GroupInviterState } from '../shared/group-inviter.js';
import type { BumperLog, BumperState } from '../shared/group-bumper.js';
import type { PosterLog, PosterState } from '../shared/group-poster.js';
import { attentionPlans, taskReasonDescription } from './task-alerts.js';
import { groupTaskRecords, endedTask } from '../domain/task-run-records.js';
import { isMarketplaceUnavailableSkip, isSuccessfulTaskStep } from '../shared/task-step-outcome.js';
import { runSummary, stepResultLabel } from './task-record-summary.js';
import { api, ApiError } from './api.js';
import { copyTextToClipboard } from './clipboard.js';
import { ProfileAvatar } from './profile-avatar.js';
import { inspectionAvatarURL } from './inspection-presentation.js';
import { IconClose, IconDownload, IconSearch } from './icons.js';
import {
  buildUnifiedActivityFeed,
  type ActivityRecordModuleFilter,
  type ActivityRecordStatusFilter,
  type UnifiedActivityItem,
} from './modules/unified-activity-records.js';

declare const __WORKBENCH_VERSION__: string;

type Filter = ActivityRecordStatusFilter;
export const planStatus: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: '排队中', tone: 'queue' },
  RUNNING: { label: '执行中', tone: 'run' },
  PAUSING: { label: '暂停中', tone: 'warn' },
  PAUSED: { label: '已暂停', tone: 'warn' },
  STOPPING: { label: '停止中', tone: 'warn' },
  REVIEW: { label: '待核对', tone: 'warn' },
  COMPLETED: { label: '已完成', tone: 'ok' },
  FAILED: { label: '失败', tone: 'err' },
  STOPPED: { label: '已停止', tone: 'idle' },
};

function shortTime(value: number) {
  const date = new Date(value);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === today.toDateString()
    ? time
    : `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${time}`;
}

function span(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return '不到 1 分钟';
  if (minutes < 60) return minutes + ' 分钟';
  return Math.floor(minutes / 60) + ' 小时' + (minutes % 60 ? ' ' + (minutes % 60) + ' 分' : '');
}

export function TaskRecordsPage({
  runtime,
  profiles,
  inspections,
  loaded,
  filterId,
  onClearFilter,
  onOpen,
  groupInviterState,
  groupBumperState,
  onGroupBumperState,
  groupPosterState,
  onNotify,
}: {
  runtime: z.infer<typeof TaskRuntimeOverview> | null;
  profiles: Profile[];
  inspections: Inspection[];
  loaded: boolean;
  filterId: string | null;
  onClearFilter: () => void;
  onOpen: (profileId: string, planId: string, round: number) => void;
  groupInviterState?: GroupInviterState | null | undefined;
  groupBumperState?: BumperState | null | undefined;
  onGroupBumperState?: ((next: BumperState) => void) | undefined;
  groupPosterState?: PosterState | null | undefined;
  onNotify?: ((msg: string) => void) | undefined;
}) {
  const [moduleTab, setModuleTab] = useState<ActivityRecordModuleFilter>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedBumperIds, setSelectedBumperIds] = useState<Set<string>>(new Set());
  const [inviterLogs, setInviterLogs] = useState<GroupInviteLogRow[]>([]);
  const [bumperLogs, setBumperLogs] = useState<BumperLog[]>([]);
  const [posterLogs, setPosterLogs] = useState<PosterLog[]>([]);
  const [bumperBusy, setBumperBusy] = useState(false);

  const deleting = useRef(new Set<string>());
  const afterDelete = (deletedStepIds?: Iterable<string>) => {
    setSelected(new Set());
    if (deletedStepIds) {
      const removed = new Set(deletedStepIds);
      setRows((previous) => previous.filter((row) => !removed.has(row.stepId)));
    }
    setRetry((v) => v + 1);
  };
  useEffect(() => {
    const handle = (event: Event) =>
      afterDelete((event as CustomEvent<{ stepIds?: string[] }>).detail?.stepIds);
    window.addEventListener('task-records-deleted', handle);
    return () => window.removeEventListener('task-records-deleted', handle);
  }, []);

  const quickDelete = async (ids: string[]) => {
    if (ids.some((id) => deleting.current.has(id))) return;
    for (const id of ids) deleting.current.add(id);
    const removed = new Set(ids);
    const previous = rowsRef.current.filter((row) => removed.has(row.stepId));
    setRows((rows) => rows.filter((row) => !removed.has(row.stepId)));
    try {
      const preview = await api.cleanupPreview({ kind: 'records', scope: { stepIds: ids } });
      if (!preview.eligible) throw Error('记录状态已变化，请重新读取后再删除');
      const result = await api.cleanupExecute(preview.token);
      if (result.protected) throw Error('部分记录状态已变化，已重新读取');
      window.dispatchEvent(new CustomEvent('task-records-deleted', { detail: { stepIds: ids } }));
    } catch (error) {
      setRows((rows) => {
        const known = new Set(rows.map((r) => r.stepId));
        return [...rows, ...previous.filter((r) => !known.has(r.stepId))];
      });
      setLoadError(error instanceof Error ? error.message : '删除失败，请重试');
      setRetry((v) => v + 1);
    } finally {
      for (const id of ids) deleting.current.delete(id);
    }
  };

  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<TaskRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<Record<Filter, number>>({
    all: 0,
    running: 0,
    completed: 0,
    failed: 0,
    attention: 0,
  });
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setRetry((v) => v + 1);
    }, 60000);
    return () => clearInterval(timer);
  }, []);

  // Load inviter, bumper & poster logs for cross-module center
  useEffect(() => {
    let active = true;
    void api
      .groupInviterLogs('')
      .then((list) => {
        if (active && Array.isArray(list)) setInviterLogs(list);
      })
      .catch(() => {});
    void api
      .bumperLogs('')
      .then((list) => {
        if (active && Array.isArray(list)) setBumperLogs(list);
      })
      .catch(() => {});
    void api
      .posterLogs('')
      .then((list) => {
        if (active && Array.isArray(list)) setPosterLogs(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [
    retry,
    groupInviterState?.running,
    groupInviterState?.finishedAt,
    groupBumperState?.running,
    groupBumperState?.pageBumperRunning,
    groupBumperState?.total,
    groupBumperState?.pageTotal,
    groupPosterState?.running,
    groupPosterState?.total,
  ]);

  const rowsRef = useRef<TaskRecord[]>([]);
  rowsRef.current = rows;
  const plans = runtime?.plans ?? [];
  const byInspection = new Map(inspections.map((i) => [i.profileId, i]));
  const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
  const attention = new Set(attentionPlans(plans, profiles).map((plan) => plan.id));
  const apiStatus = filter === 'attention' ? 'review' : filter;
  const runtimeKey = plans
    .map((plan) => `${plan.id}:${plan.state}:${plan.round}:${plan.position}:${plan.updatedAt}`)
    .join('|');
  const profileVersion = JSON.stringify(
    profiles.map((p) => [p.id, p.online, p.browserName, p.alias]),
  );
  const scopeKey = `${filterId ?? ''}|${apiStatus}|${query.trim()}`;
  useEffect(() => {
    setSelected(new Set());
    setSelectedBumperIds(new Set());
  }, [scopeKey, moduleTab]);
  const scopeRef = useRef('');
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const viewRef = useRef<string | undefined>(undefined);
  const [recordsKey, setRecordsKey] = useState(runtimeKey);
  const latestKey = useRef(runtimeKey);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateKey = plans.map((p) => `${p.id}:${p.state}:${p.round}:${p.position}`).join('|');
  const previousStateKey = useRef(stateKey);
  useEffect(() => {
    latestKey.current = runtimeKey;
    if (stateKey !== previousStateKey.current) {
      previousStateKey.current = stateKey;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      setRecordsKey(runtimeKey);
    } else if (filter === 'completed' || filter === 'failed') {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    } else if (!refreshTimer.current) {
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        setRecordsKey(latestKey.current);
      }, 1500);
    }
  }, [runtimeKey, stateKey, filter]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const now = Date.now();
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchText), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  useEffect(() => {
    const controller = new AbortController();
    const scopeChanged = scopeRef.current !== scopeKey;
    void api
      .taskRecords(
        {
          ...(filterId ? { profileId: filterId } : {}),
          status: apiStatus,
          ...(query.trim() ? { query: query.trim() } : {}),
          groupBy: 'run',
          limit: 100,
        },
        controller.signal,
      )
      .then((res) => {
        if (controller.signal.aborted) return;
        scopeRef.current = scopeKey;
        setTotal(res.total);
        setCounts({
          all: res.counts.all,
          running: res.counts.running,
          completed: res.counts.completed,
          failed: res.counts.failed,
          attention: res.counts.review,
        });
        const previous = rowsRef.current;
        if (
          scopeChanged ||
          viewRef.current !== res.viewVersion ||
          previous.length <= res.records.length
        ) {
          setRows(res.records.filter((r) => !deleting.current.has(r.stepId)));
          setNextCursor(res.nextCursor);
        } else {
          const fresh = new Map(res.records.map((row) => [row.stepId, row]));
          const known = new Set(previous.map((row) => row.stepId));
          setRows(
            [
              ...res.records.filter((row) => !known.has(row.stepId)),
              ...previous.map((row) => fresh.get(row.stepId) ?? row),
            ].filter((r) => !deleting.current.has(r.stepId)),
          );
        }
        viewRef.current = res.viewVersion;
        setLoadError('');
        setRecordsLoaded(true);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setLoadError('记录读取失败，正在自动重试；下面是上次读取的结果。');
        setRecordsLoaded(true);
      });
    return () => controller.abort();
  }, [scopeKey, recordsKey, profileVersion, retry]);

  useEffect(() => {
    if (!loadError) return;
    const timer = setTimeout(() => setRetry((value) => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [loadError, retry]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.taskRecords({
        ...(filterId ? { profileId: filterId } : {}),
        status: apiStatus,
        ...(query.trim() ? { query: query.trim() } : {}),
        cursor: nextCursor,
        groupBy: 'run',
        limit: 100,
      });
      if (currentScope.current !== scopeKey) return;
      setRows((prev) => {
        const known = new Set(prev.map((row) => row.stepId));
        return [...prev, ...res.records.filter((row) => !known.has(row.stepId))];
      });
      setNextCursor(res.nextCursor);
      setTotal(res.total);
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'RECORDS_VIEW_CHANGED') {
        viewRef.current = undefined;
        setNextCursor(null);
        setRetry((value) => value + 1);
        setLoadError('记录已变化，正在重新读取。');
      } else setLoadError('加载更多失败，请再试一次。');
    } finally {
      setLoadingMore(false);
    }
  }

  async function deleteBumperLogs(ids: string[], deleteAll = false) {
    if (bumperBusy) return;
    setBumperBusy(true);
    try {
      const next = await api.bumperAction('logs/delete', deleteAll ? { all: true } : { ids });
      onGroupBumperState?.(next);
      const refreshed = await api.bumperLogs('');
      if (Array.isArray(refreshed)) setBumperLogs(refreshed);
      setSelectedBumperIds(new Set());
      onNotify?.(deleteAll ? '已清空全部小组顶贴历史记录' : `已删除 ${ids.length} 条小组顶贴记录`);
    } catch (err) {
      onNotify?.(err instanceof Error ? err.message : '删除顶贴记录失败');
    } finally {
      setBumperBusy(false);
    }
  }

  const groups = groupTaskRecords(rows);
  const byGroupPlanRound = new Map(
    groups.map((g) => {
      const first = g.rows[0];
      return [first ? `${first.planId}:${first.round}` : g.key, g];
    }),
  );
  const eligibleIds = groups
    .filter((g) => endedTask(g.rows[0]?.planState ?? ''))
    .flatMap((g) => g.rows.map((r) => r.stepId));
  const filtered = filterId ? byProfile.get(filterId) : undefined;

  // Build unified cross-module feed
  const unifiedFeed = buildUnifiedActivityFeed({
    profiles,
    taskRecords: rows,
    attentionPlanIds: attention,
    inviterState: groupInviterState,
    inviterLogs,
    bumperState: groupBumperState,
    bumperLogs,
    posterState: groupPosterState,
    posterLogs,
    profileId: filterId,
    moduleFilter: moduleTab,
    statusFilter: filter,
    query,
    now,
  });

  const nonActiveTotal =
    unifiedFeed.moduleCounts['group-inviter'] +
    unifiedFeed.moduleCounts['group-bumper'] +
    unifiedFeed.moduleCounts['page-bumper'] +
    unifiedFeed.moduleCounts['group-poster'];

  // For moduleTab === 'active-accounts', use exact backend counts; for other tabs, use unifiedFeed.statusCounts
  const displayedStatusCounts: Record<Filter, number> =
    moduleTab === 'active-accounts'
      ? counts
      : {
          all: moduleTab === 'all' ? counts.all + nonActiveTotal : unifiedFeed.statusCounts.all,
          running:
            moduleTab === 'all'
              ? counts.running +
                unifiedFeed.items.filter(
                  (i) => i.moduleId !== 'active-accounts' && i.status === 'running',
                ).length
              : unifiedFeed.statusCounts.running,
          completed:
            moduleTab === 'all'
              ? counts.completed +
                unifiedFeed.items.filter(
                  (i) => i.moduleId !== 'active-accounts' && i.status === 'completed',
                ).length
              : unifiedFeed.statusCounts.completed,
          failed:
            moduleTab === 'all'
              ? counts.failed +
                unifiedFeed.items.filter(
                  (i) => i.moduleId !== 'active-accounts' && i.status === 'failed',
                ).length
              : unifiedFeed.statusCounts.failed,
          attention:
            moduleTab === 'all'
              ? counts.attention +
                unifiedFeed.items.filter(
                  (i) => i.moduleId !== 'active-accounts' && i.status === 'attention',
                ).length
              : unifiedFeed.statusCounts.attention,
        };

  async function exportRows() {
    if (exporting) return;
    setExporting(true);
    try {
      const allRecords: TaskRecord[] = [];
      if (moduleTab === 'all' || moduleTab === 'active-accounts') {
        let cursor: string | undefined;
        while (true) {
          const res = await api.taskRecords({
            ...(filterId ? { profileId: filterId } : {}),
            status: apiStatus,
            ...(query.trim() ? { query: query.trim() } : {}),
            ...(cursor ? { cursor } : {}),
            groupBy: 'run',
            limit: 200,
          });
          allRecords.push(...res.records);
          if (!res.nextCursor) break;
          cursor = res.nextCursor;
        }
      }
      const q = query.trim().toLowerCase();
      const visibleIds = new Set(unifiedFeed.items.map((i) => i.id));
      const payload = {
        format: 'browser-workbench-task-records',
        version: 2,
        softwareVersion: __WORKBENCH_VERSION__,
        exportedAt: new Date().toISOString(),
        scope: { profileId: filterId, module: moduleTab, filter, query: query.trim() },
        records: allRecords.map((row) => ({
          stepId: row.stepId,
          planId: row.planId,
          profileId: row.profileId,
          browser: byProfile.get(row.profileId)?.browserName ?? byProfile.get(row.profileId)?.alias,
          combination: row.combinationName,
          version: row.combinationVersion,
          round: row.round,
          position: row.position,
          type: row.type,
          destination: row.destination ?? null,
          status: row.status,
          planState: row.planState,
          planReason: row.planReason,
          progress: row.progress,
          budget: row.budget ?? null,
          outcome: row.outcome ?? null,
          startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
          finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
          planCreatedAt: new Date(row.planCreatedAt).toISOString(),
          planUpdatedAt: new Date(row.planUpdatedAt).toISOString(),
        })),
        inviterLogs:
          moduleTab === 'all' || moduleTab === 'group-inviter'
            ? inviterLogs.filter(
                (l) =>
                  (!filterId || l.profileId === filterId) &&
                  (visibleIds.has(`inviter-log:${l.id}`) ||
                    (!q && (filter === 'all' || filter === 'completed'))),
              )
            : [],
        bumperLogs:
          moduleTab === 'all' || moduleTab === 'group-bumper' || moduleTab === 'page-bumper'
            ? bumperLogs.filter(
                (l) =>
                  (!filterId || l.profileId === filterId) &&
                  (visibleIds.has(`bumper-log:${l.id}`) ||
                    (!q &&
                      (filter === 'all' || filter === 'completed') &&
                      (moduleTab === 'all' ||
                        (moduleTab === 'page-bumper'
                          ? l.sourceMode === 'page' || l.groupId === '-'
                          : l.sourceMode !== 'page' && l.groupId !== '-')))),
              )
            : [],
        posterLogs:
          moduleTab === 'all' || moduleTab === 'group-poster'
            ? posterLogs
                .filter(
                  (l) =>
                    (!filterId || l.profileId === filterId) &&
                    (visibleIds.has(`poster-log:${l.id}`) ||
                      (!q &&
                        (filter === 'all' ||
                          (filter === 'attention' && l.postId === 'pending_approval') ||
                          (filter === 'completed' && l.postId !== 'pending_approval')))),
                )
                .map(({ accountAvatar: _a, groupAvatar: _g, ...rest }) => rest)
            : [],
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '执行记录-' + new Date().toISOString().replaceAll(':', '-') + '.json';
      document.body.append(anchor);
      try {
        anchor.click();
      } finally {
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } finally {
      setExporting(false);
    }
  }

  const tabs: [Filter, string][] = [
    ['all', '全部'],
    ['running', '进行中'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['attention', '需处理'],
  ];

  const moduleTabs: [ActivityRecordModuleFilter, string, number][] = [
    ['all', '全部模块', counts.all + nonActiveTotal],
    ['active-accounts', '活跃账号', counts.all],
    ['group-inviter', '小组邀请人', unifiedFeed.moduleCounts['group-inviter']],
    ['group-bumper', '小组顶贴', unifiedFeed.moduleCounts['group-bumper']],
    ['page-bumper', '专页顶贴', unifiedFeed.moduleCounts['page-bumper']],
    ['group-poster', '小组发帖', unifiedFeed.moduleCounts['group-poster']],
  ];

  function renderActiveAccountGroupRow(
    group: ReturnType<typeof groupTaskRecords>[number],
    showModuleBadge: boolean,
  ) {
    const row = group.rows[0];
    if (!row) return null;
    const profile = byProfile.get(row.profileId);
    const inspection = byInspection.get(row.profileId);
    const state = attention.has(row.planId) && !endedTask(row.planState) ? 'REVIEW' : group.state;
    const status = planStatus[state] ?? planStatus.QUEUED;
    const ids = group.rows.map((r) => r.stepId);
    const ended = endedTask(row.planState);
    const reason = row.planReason ? taskReasonDescription(row.planReason)?.summary : null;
    const time = group.startedAt ?? row.planCreatedAt;
    return (
      <div
        className={'records-row run-record-row tone-' + status?.tone}
        role="row"
        key={'active-group-' + group.key}
        tabIndex={0}
        onClick={() => onOpen(row.profileId, row.planId, row.round)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.target === event.currentTarget)
            onOpen(row.profileId, row.planId, row.round);
        }}
      >
        <span role="cell" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={'选择任务 ' + row.combinationName + ' 第' + row.round + '轮'}
            disabled={
              !ended ||
              (!ids.every((id) => selected.has(id)) &&
                selected.size + ids.filter((id) => !selected.has(id)).length > 1000)
            }
            checked={ids.every((id) => selected.has(id))}
            onChange={(e) =>
              setSelected((previous) => {
                const next = new Set(previous);
                for (const id of ids) {
                  if (e.target.checked) next.add(id);
                  else next.delete(id);
                }
                return next;
              })
            }
          />
        </span>
        <span role="cell" className="cell-browser record-browser-avatar">
          <ProfileAvatar
            url={profile ? inspectionAvatarURL(profile, inspection, true) : null}
            online={Boolean(profile?.online)}
          />
          <span>
            <strong>
              {showModuleBadge && (
                <span className="record-module-tag module-active-accounts">活跃账号</span>
              )}
              {profile?.browserName ?? profile?.alias ?? '已移除的浏览器'}
            </strong>
            <small>
              {row.combinationName}
              {row.round > 1 ? ` · 第 ${row.round} 轮` : ''}
            </small>
            <small className="fb-id">
              {inspection?.state === 'OBSERVED' ? inspection.account.id : profile?.account.id}
            </small>
          </span>
        </span>
        <span role="cell">
          <span className={'pill pill-' + status?.tone}>
            {state === 'FAILED'
              ? '执行异常'
              : state === 'REVIEW'
                ? '需处理'
                : state === 'COMPLETED' &&
                    group.rows.some((s) =>
                      isMarketplaceUnavailableSkip(s.type, s.status, s.outcome),
                    )
                  ? '已完成（含正常跳过）'
                  : status?.label}
          </span>
          {state === 'STOPPED' && (
            <small>
              完成 {group.completed}/{ids.length}
            </small>
          )}
        </span>
        <span role="cell" className="run-step-pills">
          {group.rows.map((step) => {
            const tone = isSuccessfulTaskStep(step.type, step.status, step.outcome)
              ? 'ok'
              : step.status === 'FAILED'
                ? 'err'
                : step.status === 'ACTIVE' && !ended
                  ? 'run'
                  : 'idle';
            return (
              <span
                key={step.stepId}
                className={'run-step-pill pill-' + tone}
                title={stepResultLabel(step)}
              >
                {stepResultLabel(step)}
              </span>
            );
          })}
        </span>
        <span role="cell" className="cell-note">
          {(state === 'STOPPED' || state === 'FAILED') && (
            <strong>
              {state === 'STOPPED'
                ? `手动停止（已完成 ${group.completed}/${ids.length} 项）`
                : (reason ?? '执行异常，请查看步骤原因')}
            </strong>
          )}
          <span>{runSummary(group.rows)}</span>
        </span>
        <span role="cell" className="cell-time">
          <time title={new Date(time).toLocaleString()}>{shortTime(time)}</time>
          <small>
            {group.startedAt === null
              ? '未开始'
              : '用时 ' +
                span((group.finishedAt ?? (ended ? row.planUpdatedAt : now)) - group.startedAt)}
          </small>
          {ended && (
            <button
              className="btn btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                void quickDelete(ids);
              }}
            >
              删除
            </button>
          )}
        </span>
      </div>
    );
  }

  function renderUnifiedNonTaskRow(item: UnifiedActivityItem, showModuleBadge: boolean) {
    const profile = byProfile.get(item.profileId);
    const inspection = byInspection.get(item.profileId);
    const isBumperLog = Boolean(item.bumperLogId);
    const bumperId = item.bumperLogId ?? '';
    return (
      <div className={'records-row unified-module-row tone-' + item.tone} role="row" key={item.id}>
        <span role="cell" onClick={(e) => e.stopPropagation()}>
          {isBumperLog ? (
            <input
              type="checkbox"
              aria-label={'选择顶贴记录 ' + item.targetLabel}
              checked={selectedBumperIds.has(bumperId)}
              onChange={(e) =>
                setSelectedBumperIds((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(bumperId);
                  else next.delete(bumperId);
                  return next;
                })
              }
            />
          ) : (
            <span className="record-check-placeholder" />
          )}
        </span>
        <span role="cell" className="cell-browser record-browser-avatar">
          <ProfileAvatar
            url={profile ? inspectionAvatarURL(profile, inspection, true) : null}
            online={Boolean(profile?.online)}
          />
          <span>
            <strong>
              {showModuleBadge && (
                <span className={'record-module-tag module-' + item.moduleId}>
                  {item.moduleLabel}
                </span>
              )}
              {item.profileName}
            </strong>
            <small>{item.title}</small>
            <small className="fb-id">
              {inspection?.state === 'OBSERVED' ? inspection.account.id : profile?.account.id}
            </small>
          </span>
        </span>
        <span role="cell">
          <span className={'pill pill-' + item.tone}>{item.statusLabel}</span>
        </span>
        <span role="cell" className="run-step-pills">
          <span className={'run-step-pill pill-' + item.tone} title={item.targetLabel}>
            {item.targetLabel}
          </span>
        </span>
        <span role="cell" className="cell-note">
          <span>{item.detailText}</span>
        </span>
        <span role="cell" className="cell-time">
          <time title={new Date(item.timestamp).toLocaleString()}>{shortTime(item.timestamp)}</time>
          <div className="cell-time-actions">
            {item.postUrl && (
              <button
                className="btn btn-sm"
                title={item.postUrl}
                onClick={(e) => {
                  e.stopPropagation();
                  void copyTextToClipboard(item.postUrl ?? '')
                    .then(() => onNotify?.('已复制帖子链接'))
                    .catch(() => {});
                }}
              >
                复制链接
              </button>
            )}
            {bumperId && (
              <button
                className="btn btn-sm"
                disabled={bumperBusy}
                onClick={(e) => {
                  e.stopPropagation();
                  void deleteBumperLogs([bumperId]);
                }}
              >
                删除
              </button>
            )}
          </div>
        </span>
      </div>
    );
  }

  const bumperSelectableIds = unifiedFeed.items
    .map((item) => item.bumperLogId)
    .filter((id): id is string => Boolean(id));

  return (
    <section className="records-page" aria-label="执行记录">
      <div className="section-head">
        <h2>
          执行记录
          {filtered && (
            <span className="filter-tag">
              {filtered.browserName ?? filtered.alias}
              <button aria-label="取消浏览器筛选" title="取消筛选" onClick={onClearFilter}>
                <IconClose size={12} />
              </button>
            </span>
          )}
        </h2>
        <div className="section-tools">
          <div className="records-module-switcher" role="tablist" aria-label="按功能模块筛选">
            {moduleTabs.map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={moduleTab === key}
                className={'module-switch-btn' + (moduleTab === key ? ' active' : '')}
                onClick={() => setModuleTab(key)}
              >
                {label}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <label className="search-field">
            <IconSearch />
            <input
              type="search"
              aria-label="搜索任务记录"
              placeholder="搜索模块、组合、小组或浏览器"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>
          <button
            className={'btn btn-icon' + (exporting ? ' is-busy' : '')}
            title={exporting ? '正在导出…' : '导出当前筛选全部执行记录（JSON）'}
            aria-label="导出任务记录"
            disabled={
              (!rows.length && !inviterLogs.length && !bumperLogs.length && !posterLogs.length) ||
              exporting
            }
            onClick={() => void exportRows()}
          >
            <IconDownload />
          </button>
        </div>
      </div>

      {moduleTab === 'group-bumper' ? (
        <div className="records-toolbar">
          <div className="status-tabs" role="tablist">
            {tabs.map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={filter === key}
                className={'status-tab tab-' + key + (filter === key ? ' active' : '')}
                onClick={() => setFilter(key)}
              >
                {label}
                <span>{displayedStatusCounts[key]}</span>
              </button>
            ))}
          </div>
          <div className="records-cleanup-btns">
            {selectedBumperIds.size > 0 && (
              <button
                type="button"
                className="btn btn-sm danger"
                disabled={bumperBusy}
                onClick={() => void deleteBumperLogs([...selectedBumperIds])}
              >
                删除所选顶贴记录 ({selectedBumperIds.size})
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={bumperBusy || bumperLogs.length === 0 || Boolean(groupBumperState?.running)}
              onClick={() => {
                if (confirm('清空全部小组顶贴记录？清空后对应的历史防重和累计统计也会重置。')) {
                  void deleteBumperLogs([], true);
                }
              }}
            >
              清空顶贴记录
            </button>
          </div>
        </div>
      ) : (
        <RecordCleanupActions
          filters={
            <div className="status-tabs" role="tablist">
              {tabs.map(([key, label]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={filter === key}
                  className={'status-tab tab-' + key + (filter === key ? ' active' : '')}
                  onClick={() => setFilter(key)}
                >
                  {label}
                  <span>{displayedStatusCounts[key]}</span>
                </button>
              ))}
            </div>
          }
          stepIds={[...selected]}
          selectedCount={groups.filter((g) => g.rows.every((r) => selected.has(r.stepId))).length}
          {...(filterId ? { profileId: filterId } : {})}
          onDone={afterDelete}
        />
      )}

      {loadError && (
        <p className="records-notice" role="status">
          {loadError}
        </p>
      )}

      {!loaded && !recordsLoaded ? (
        <p className="muted records-empty">正在读取执行记录…</p>
      ) : moduleTab === 'active-accounts' ? (
        !rows.length ? (
          <div className="records-empty">
            <p>
              {filter === 'attention'
                ? '没有需要处理的任务。'
                : filtered
                  ? '这个浏览器还没有相关记录。'
                  : '还没有活跃账号任务记录。勾选浏览器后在「活跃账号」模块启动组合或功能测试。'}
            </p>
          </div>
        ) : (
          <div className="records-table" role="table">
            <div className="records-row run-record-row records-header" role="row">
              <span role="columnheader">
                <input
                  type="checkbox"
                  aria-label="选择当前已加载的已结束任务"
                  checked={eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(eligibleIds.slice(0, 1000)) : new Set())
                  }
                />
              </span>
              <span role="columnheader">浏览器 / 任务组合</span>
              <span role="columnheader">整体状态</span>
              <span role="columnheader">步骤执行明细</span>
              <span role="columnheader">成果与说明</span>
              <span role="columnheader">时间与操作</span>
            </div>
            {groups.map((group) => renderActiveAccountGroupRow(group, false))}
            <div className="records-foot">
              <span>
                已显示 {groups.length} / {total} 次任务
              </span>
              {nextCursor && (
                <button
                  className="btn btn-sm records-more"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore
                    ? '正在加载…'
                    : `再显示 ${Math.min(100, Math.max(1, total - groups.length))} 次任务`}
                </button>
              )}
            </div>
          </div>
        )
      ) : !unifiedFeed.items.length ? (
        <div className="records-empty">
          <p>
            {filter === 'attention'
              ? '没有需要处理的任务。'
              : filtered
                ? '这个浏览器在当前模块下还没有相关执行记录。'
                : '当前筛选条件下还没有执行记录。'}
          </p>
        </div>
      ) : (
        <div className="records-table" role="table">
          <div className="records-row run-record-row records-header" role="row">
            <span role="columnheader">
              {moduleTab === 'group-bumper' ? (
                <input
                  type="checkbox"
                  aria-label="全选当前顶贴记录"
                  checked={
                    bumperSelectableIds.length > 0 &&
                    bumperSelectableIds.every((id) => selectedBumperIds.has(id))
                  }
                  onChange={(e) =>
                    setSelectedBumperIds(
                      e.target.checked ? new Set(bumperSelectableIds) : new Set(),
                    )
                  }
                />
              ) : (
                <input
                  type="checkbox"
                  aria-label="选择当前已加载的已结束任务"
                  checked={eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(eligibleIds.slice(0, 1000)) : new Set())
                  }
                />
              )}
            </span>
            <span role="columnheader">浏览器 / 模块任务</span>
            <span role="columnheader">执行状态</span>
            <span role="columnheader">目标对象 / 步骤</span>
            <span role="columnheader">成果与说明</span>
            <span role="columnheader">时间与操作</span>
          </div>
          {unifiedFeed.items.map((item) => {
            if (item.moduleId === 'active-accounts' && item.planId !== undefined) {
              const group = byGroupPlanRound.get(`${item.planId}:${item.round ?? 1}`);
              if (group) return renderActiveAccountGroupRow(group, moduleTab === 'all');
            }
            return renderUnifiedNonTaskRow(item, moduleTab === 'all');
          })}
          <div className="records-foot">
            <span>已显示 {unifiedFeed.items.length} 条执行记录</span>
            {moduleTab === 'all' && nextCursor && (
              <button
                className="btn btn-sm records-more"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? '正在加载…' : '加载更多活跃账号记录'}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
