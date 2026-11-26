import { useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { endedTask, groupTaskRecords } from '../domain/task-run-records.js';
import { profileDisplayName, type Profile } from '../shared/contracts.js';
import type { GoogleSheetsOverview } from '../shared/google-sheets.js';
import type { GroupInviteLogRow, GroupInviterState } from '../shared/group-inviter.js';
import type { Inspection } from '../shared/profile-inspection.js';
import type { TaskRecord, TaskRuntimeOverview } from '../shared/task-contracts.js';
import { api, ApiError } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { RecordCleanupActions } from './data-cleanup-panel.js';
import { IconClose, IconDownload, IconSearch } from './icons.js';
import { Btn, errMsg, NoticeBanner } from './modules/shared/module-ui.js';
import {
  buildUnifiedActivityFeed,
  type ActivityRecordModuleFilter,
  type ActivityRecordStatusFilter,
} from './modules/unified-activity-records.js';
import { toggleSet } from './selection.js';
import {
  ActiveAccountGroupRow,
  planStatus,
  RECORD_GRID_CLS,
  UnifiedNonTaskRow,
  type RunGroup,
} from './task-records-rows.js';
import { downloadJsonFile, EmptyState, UI_CHECKBOX, UI_INPUT } from './ui/primitives.js';

export { planStatus };
declare const __WORKBENCH_VERSION__: string;

const EMPTY_ATTENTION = new Set<string>();
type Filter = ActivityRecordStatusFilter;
const STATUS_TABS: [Filter, string][] = [
  ['all', '全部'],
  ['running', '进行中'],
  ['completed', '已完成'],
  ['failed', '失败'],
  ['attention', '需处理'],
];
const isoOrNull = (v?: number | null) => (v ? new Date(v).toISOString() : null);

export function TaskRecordsPage(p: {
  runtime: z.infer<typeof TaskRuntimeOverview> | null;
  profiles: Profile[];
  inspections: Inspection[];
  loaded: boolean;
  filterId: string | null;
  onClearFilter: () => void;
  onOpen: (profileId: string, planId: string, round: number) => void;
  groupInviterState?: GroupInviterState | null;
  googleSheetsOverview?: GoogleSheetsOverview | null;
  onOpenCleanupSettings?: () => void;
  onNotify?: (msg: string) => void;
  initialModule?: ActivityRecordModuleFilter;
  moduleKey?: number;
}) {
  const {
    runtime,
    profiles,
    inspections,
    loaded,
    filterId,
    onClearFilter,
    onOpen,
    groupInviterState,
    googleSheetsOverview,
    onOpenCleanupSettings,
    onNotify,
    initialModule,
    moduleKey = 0,
  } = p;
  const [moduleTab, setModuleTab] = useState<ActivityRecordModuleFilter>(initialModule ?? 'all');
  useEffect(() => {
    if (initialModule) setModuleTab(initialModule);
  }, [initialModule, moduleKey]);

  const [visibleLimit, setVisibleLimit] = useState(80);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inviterLogs, setInviterLogs] = useState<GroupInviteLogRow[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [pendingDelete, setPendingDelete] = useState<{
    kind: 'task';
    ids: string[];
    label: string;
  } | null>(null);
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

  const deleting = useRef(new Set<string>());
  const scopeGenRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);
  const rowsRef = useRef<TaskRecord[]>([]);
  rowsRef.current = rows;

  const afterDelete = (deletedStepIds?: Iterable<string>) => {
    setSelected(new Set());
    if (deletedStepIds) {
      const rem = new Set(deletedStepIds);
      setRows((prev) => prev.filter((r) => !rem.has(r.stepId)));
    }
    setRetry((v) => v + 1);
  };

  useEffect(() => {
    const handle = (e: Event) =>
      afterDelete((e as CustomEvent<{ stepIds?: string[] }>).detail?.stepIds);
    window.addEventListener('task-records-deleted', handle);
    const timer = setInterval(() => {
      if (!document.hidden) setRetry((v) => v + 1);
    }, 60_000);
    return () => {
      window.removeEventListener('task-records-deleted', handle);
      clearInterval(timer);
    };
  }, []);

  const inviterFetchedSigRef = useRef('');
  const inviterLogSig = `${retry}|${groupInviterState?.running ?? ''}|${groupInviterState?.finishedAt ?? ''}`;
  useEffect(() => {
    if (
      (inviterFetchedSigRef.current && moduleTab !== 'all' && moduleTab !== 'group-inviter') ||
      inviterFetchedSigRef.current === inviterLogSig
    )
      return;
    let active = true;
    void api
      .groupInviterLogs('')
      .then((list) => {
        if (active && Array.isArray(list)) {
          setInviterLogs(list);
          inviterFetchedSigRef.current = inviterLogSig;
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [moduleTab, inviterLogSig]);

  const plans = runtime?.plans ?? [];
  const byInspection = useMemo(
    () => new Map(inspections.map((i) => [i.profileId, i])),
    [inspections],
  );
  const byProfile = useMemo(() => new Map(profiles.map((pr) => [pr.id, pr])), [profiles]);
  const apiStatus = filter === 'attention' ? ('review' as const) : filter;
  const runtimeKey = plans
    .map((x) => `${x.id}:${x.state}:${x.round}:${x.position}:${x.updatedAt}`)
    .join('|');
  const profileVersion = JSON.stringify(
    profiles.map((x) => [x.id, x.online, x.browserName, x.alias]),
  );
  const scopeKey = `${filterId ?? ''}|${apiStatus}|${query.trim()}`;

  useEffect(() => setSelected(new Set()), [scopeKey, moduleTab]);
  const scopeRef = useRef('');
  const currentScope = useRef(scopeKey);
  const viewRef = useRef<string | undefined>(undefined);
  const latestKey = useRef(runtimeKey);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  currentScope.current = scopeKey;
  const [recordsKey, setRecordsKey] = useState(runtimeKey);
  const stateKey = plans.map((x) => `${x.id}:${x.state}:${x.round}:${x.position}`).join('|');
  const prevStateKey = useRef(stateKey);

  useEffect(() => {
    latestKey.current = runtimeKey;
    if (stateKey !== prevStateKey.current) {
      prevStateKey.current = stateKey;
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
      loadMoreAbortRef.current?.abort();
      exportAbortRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    scopeGenRef.current += 1;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = null;
  }, [scopeKey]);

  const now = Math.floor(Date.now() / 60_000) * 60_000;
  useEffect(() => {
    const t = setTimeout(() => setQuery(searchText), 300);
    return () => clearTimeout(t);
  }, [searchText]);

  const queryParams = (extra?: { cursor?: string; limit?: number }) => ({
    ...(filterId ? { profileId: filterId } : {}),
    status: apiStatus,
    ...(query.trim() ? { query: query.trim() } : {}),
    groupBy: 'run' as const,
    limit: 100,
    ...extra,
  });

  useEffect(() => {
    const ctrl = new AbortController();
    const scopeChanged = scopeRef.current !== scopeKey;
    void api.taskRecords(queryParams(), ctrl.signal).then(
      (res) => {
        if (ctrl.signal.aborted) return;
        scopeRef.current = scopeKey;
        setTotal(res.total);
        setCounts({
          all: res.counts.all,
          running: res.counts.running,
          completed: res.counts.completed,
          failed: res.counts.failed,
          attention: res.counts.review,
        });
        const prev = rowsRef.current;
        if (
          scopeChanged ||
          viewRef.current !== res.viewVersion ||
          prev.length <= res.records.length
        ) {
          setRows(res.records.filter((r) => !deleting.current.has(r.stepId)));
          setNextCursor(res.nextCursor);
        } else {
          const fresh = new Map(res.records.map((r) => [r.stepId, r]));
          const known = new Set(prev.map((r) => r.stepId));
          setRows(
            [
              ...res.records.filter((r) => !known.has(r.stepId)),
              ...prev.map((r) => fresh.get(r.stepId) ?? r),
            ].filter((r) => !deleting.current.has(r.stepId)),
          );
        }
        viewRef.current = res.viewVersion;
        setLoadError('');
        setRecordsLoaded(true);
      },
      () => {
        if (!ctrl.signal.aborted) {
          setLoadError('记录读取失败，正在自动重试；下面是上次读取的结果。');
          setRecordsLoaded(true);
        }
      },
    );
    return () => ctrl.abort();
  }, [scopeKey, recordsKey, profileVersion, retry]);

  useEffect(() => {
    if (!loadError) return;
    const t = setTimeout(() => setRetry((v) => v + 1), 5000);
    return () => clearTimeout(t);
  }, [loadError, retry]);
  const reportErr = (msg: string) => (onNotify ? onNotify(msg) : setLoadError(msg));

  const quickDelete = async (ids: string[]) => {
    if (ids.some((id) => deleting.current.has(id))) return;
    const deleteScope = currentScope.current;
    for (const id of ids) deleting.current.add(id);
    const removed = new Set(ids);
    const previous = rowsRef.current.filter((r) => removed.has(r.stepId));
    setRows((list) => list.filter((r) => !removed.has(r.stepId)));
    try {
      const preview = await api.cleanupPreview({ kind: 'records', scope: { stepIds: ids } });
      if (!preview.eligible) throw Error('记录状态已变化，请重新读取后再删除');
      const result = await api.cleanupExecute(preview.token);
      if (result.protected) throw Error('部分记录状态已变化，已重新读取');
      window.dispatchEvent(new CustomEvent('task-records-deleted', { detail: { stepIds: ids } }));
    } catch (err) {
      if (currentScope.current === deleteScope)
        setRows((list) => {
          const known = new Set(list.map((r) => r.stepId));
          return [...list, ...previous.filter((r) => !known.has(r.stepId))];
        });
      reportErr(errMsg(err, '删除失败，请重试'));
      setRetry((v) => v + 1);
    } finally {
      for (const id of ids) deleting.current.delete(id);
    }
  };

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    const gen = scopeGenRef.current;
    loadMoreAbortRef.current?.abort();
    const ctrl = new AbortController();
    loadMoreAbortRef.current = ctrl;
    setLoadingMore(true);
    try {
      const res = await api.taskRecords(queryParams({ cursor: nextCursor }), ctrl.signal);
      if (ctrl.signal.aborted || scopeGenRef.current !== gen || currentScope.current !== scopeKey)
        return;
      setRows((prev) => {
        const known = new Set(prev.map((r) => r.stepId));
        return [
          ...prev,
          ...res.records.filter((r) => !known.has(r.stepId) && !deleting.current.has(r.stepId)),
        ];
      });
      setNextCursor(res.nextCursor);
      setTotal(res.total);
    } catch (failure) {
      if (ctrl.signal.aborted || scopeGenRef.current !== gen) return;
      if (failure instanceof ApiError && failure.code === 'RECORDS_VIEW_CHANGED') {
        viewRef.current = undefined;
        setNextCursor(null);
        setRetry((v) => v + 1);
        setLoadError('记录已变化，正在重新读取。');
      } else setLoadError('加载更多失败，请再试一次。');
    } finally {
      if (loadMoreAbortRef.current === ctrl) loadMoreAbortRef.current = null;
      if (scopeGenRef.current === gen) setLoadingMore(false);
    }
  }

  const groups = useMemo(() => groupTaskRecords(rows), [rows]);
  const byGroupPlanRound = useMemo(
    () =>
      new Map(groups.map((g) => [g.rows[0] ? `${g.rows[0].planId}:${g.rows[0].round}` : g.key, g])),
    [groups],
  );
  const eligibleIds = useMemo(
    () =>
      groups
        .filter((g) => endedTask(g.rows[0]?.planState ?? ''))
        .flatMap((g) => g.rows.map((r) => r.stepId)),
    [groups],
  );
  const filtered = filterId ? byProfile.get(filterId) : undefined;
  const unifiedFeed = useMemo(
    () =>
      buildUnifiedActivityFeed({
        profiles,
        taskRecords: rows,
        attentionPlanIds: EMPTY_ATTENTION,
        inviterState: groupInviterState,
        inviterLogs,
        googleSheetsOverview,
        profileId: filterId,
        moduleFilter: moduleTab,
        statusFilter: filter,
        query,
        now,
      }),
    [
      profiles,
      rows,
      groupInviterState,
      inviterLogs,
      googleSheetsOverview,
      filterId,
      moduleTab,
      filter,
      query,
      now,
    ],
  );
  useEffect(() => setVisibleLimit(80), [moduleTab, filter, query, filterId]);

  const nonActiveTotal =
    unifiedFeed.moduleCounts['group-inviter'] + unifiedFeed.moduleCounts['google-sheets'];
  const displayedStatusCounts: Record<Filter, number> =
    moduleTab === 'active-accounts'
      ? counts
      : moduleTab === 'all'
        ? (Object.fromEntries(
            STATUS_TABS.map(([k]) => [k, counts[k] + unifiedFeed.nonActiveStatusCounts[k]]),
          ) as Record<Filter, number>)
        : unifiedFeed.statusCounts;

  async function exportRows() {
    if (exporting) return;
    exportAbortRef.current?.abort();
    const ctrl = new AbortController();
    exportAbortRef.current = ctrl;
    setExporting(true);
    try {
      const allRecords: TaskRecord[] = [];
      if (moduleTab === 'all' || moduleTab === 'active-accounts') {
        let cursor: string | undefined;
        while (!ctrl.signal.aborted) {
          const res = await api.taskRecords(
            queryParams({ ...(cursor ? { cursor } : {}), limit: 200 }),
            ctrl.signal,
          );
          if (ctrl.signal.aborted) return;
          allRecords.push(...res.records);
          if (!res.nextCursor) break;
          cursor = res.nextCursor;
        }
      }
      const visibleIds = new Set(unifiedFeed.items.map((i) => i.id));
      const q = query.trim().toLowerCase();
      downloadJsonFile(`执行记录-${new Date().toISOString().replaceAll(':', '-')}.json`, {
        format: 'browser-workbench-task-records',
        version: 2,
        softwareVersion: __WORKBENCH_VERSION__,
        exportedAt: new Date().toISOString(),
        scope: { profileId: filterId, module: moduleTab, filter, query: query.trim() },
        records: allRecords.map((r) => ({
          ...r,
          browser: byProfile.has(r.profileId)
            ? profileDisplayName(byProfile.get(r.profileId))
            : undefined,
          combination: r.combinationName,
          version: r.combinationVersion,
          startedAt: isoOrNull(r.startedAt),
          finishedAt: isoOrNull(r.finishedAt),
          planCreatedAt: new Date(r.planCreatedAt).toISOString(),
          planUpdatedAt: new Date(r.planUpdatedAt).toISOString(),
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
      });
    } catch (failure) {
      if (!ctrl.signal.aborted)
        reportErr(
          failure instanceof ApiError && failure.code === 'RECORDS_VIEW_CHANGED'
            ? '导出期间记录已更新，请重新点击导出'
            : `导出失败：${errMsg(failure, '请稍后重试')}`,
        );
    } finally {
      if (exportAbortRef.current === ctrl) exportAbortRef.current = null;
      setExporting(false);
    }
  }

  const moduleTabs: [ActivityRecordModuleFilter, string, number][] = [
    ['all', '全部模块', counts.all + nonActiveTotal],
    ['active-accounts', '活跃账号', counts.all],
    ['google-sheets', '云表协同', unifiedFeed.moduleCounts['google-sheets']],
    ['group-inviter', '小组邀请人', unifiedFeed.moduleCounts['group-inviter']],
  ];
  const toggleSelectedIds = (ids: string[], checked: boolean) =>
    setSelected((prev) => toggleSet(prev, ids, checked));
  const renderGroupRow = (g: RunGroup, showBadge: boolean) => (
    <ActiveAccountGroupRow
      key={'active-group-' + g.key}
      group={g}
      showModuleBadge={showBadge}
      byProfile={byProfile}
      byInspection={byInspection}
      selected={selected}
      now={now}
      onOpen={onOpen}
      onToggleSelected={toggleSelectedIds}
      onRequestDelete={setPendingDelete}
    />
  );

  const statusTabsNode = (
    <div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
      {STATUS_TABS.map(([key, label]) => {
        const act = filter === key;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={act}
            onClick={() => setFilter(key)}
            className={`inline-flex h-[30px] items-center gap-1.5 rounded-full border pr-2.5 pl-3 text-xs font-semibold transition-colors ${act ? 'border-blue-600/30 bg-[var(--brand-soft)] text-[var(--brand)]' : 'border-[var(--line)] bg-white text-[var(--text-2)] hover:border-slate-300'}`}
          >
            {label}
            <span
              className={`h-[18px] min-w-[20px] rounded-full px-1.5 text-center text-[11px] leading-[18px] tabular-nums ${act ? 'bg-blue-600/15 text-[var(--brand)]' : 'bg-[var(--surface-3)] text-[var(--text-3)]'}`}
            >
              {displayedStatusCounts[key]}
            </span>
          </button>
        );
      })}
    </div>
  );
  const emptyMessage =
    filter === 'attention'
      ? '没有需要处理的任务。'
      : moduleTab === 'active-accounts'
        ? filtered
          ? '这个浏览器还没有相关记录。'
          : '还没有活跃账号任务记录。勾选浏览器后在「活跃账号」模块启动组合或功能测试。'
        : filtered
          ? '这个浏览器在当前模块下还没有相关执行记录。'
          : '当前筛选条件下还没有执行记录。';
  const isEmpty = moduleTab === 'active-accounts' ? !rows.length : !unifiedFeed.items.length;
  const colHeaders =
    moduleTab === 'active-accounts'
      ? ['浏览器 / 任务组合', '整体状态', '步骤执行明细', '成果与说明', '时间与操作']
      : ['浏览器 / 模块任务', '执行状态', '目标对象 / 步骤', '成果与说明', '时间与操作'];

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="执行记录">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="m-0 flex flex-wrap items-center gap-2 text-base font-semibold text-slate-900">
          <span>执行记录</span>
          {filtered && (
            <span className="inline-flex h-[26px] items-center gap-1 rounded-full bg-[var(--brand-soft)] pr-1 pl-2.5 text-xs font-semibold text-[var(--brand)]">
              {profileDisplayName(filtered)}
              <button
                type="button"
                className="grid h-5 w-5 place-content-center rounded-full border-0 bg-transparent p-0 text-inherit hover:bg-blue-500/15"
                aria-label="取消浏览器筛选"
                title="取消筛选"
                onClick={onClearFilter}
              >
                <IconClose size={12} />
              </button>
            </span>
          )}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-[var(--line)] bg-slate-100 p-0.5"
            role="tablist"
            aria-label="按功能模块筛选"
          >
            {moduleTabs.map(([key, label, count]) => {
              const active = moduleTab === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`module-switch-btn inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                    active
                      ? 'bg-white font-semibold text-slate-900 shadow-2xs'
                      : 'bg-transparent font-medium text-slate-600 hover:text-slate-900'
                  }`}
                  onClick={() => setModuleTab(key)}
                >
                  <span>{label}</span>
                  <span className="rounded-full bg-slate-200/70 px-1.5 py-px text-[11px] font-semibold text-[var(--text-2)] tabular-nums">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
          <label className="relative flex items-center">
            <IconSearch
              size={14}
              className="pointer-events-none absolute left-2.5 text-[var(--text-3)]"
            />
            <input
              type="search"
              aria-label="搜索任务记录"
              placeholder="搜索组合、小组或浏览器"
              className={`${UI_INPUT} w-52 max-w-full pl-8`}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
            />
          </label>
          <Btn
            className={exporting ? 'opacity-70' : undefined}
            title={exporting ? '正在导出…' : '导出当前筛选全部执行记录（JSON）'}
            aria-label="导出任务记录"
            disabled={(!rows.length && !inviterLogs.length) || exporting}
            onClick={() => void exportRows()}
          >
            <IconDownload size={14} /> 导出
          </Btn>
          {onOpenCleanupSettings && (
            <Btn title="前往设置历史记录自动保留规则与数据库清理" onClick={onOpenCleanupSettings}>
              保留规则
            </Btn>
          )}
        </div>
      </div>

      {moduleTab === 'group-inviter' || moduleTab === 'google-sheets' ? (
        <div className="flex flex-wrap items-center justify-between gap-3">{statusTabsNode}</div>
      ) : (
        <RecordCleanupActions
          showRetention={false}
          filters={statusTabsNode}
          stepIds={[...selected]}
          selectedCount={groups.filter((g) => g.rows.every((r) => selected.has(r.stepId))).length}
          {...(filterId ? { profileId: filterId } : {})}
          onDone={afterDelete}
        />
      )}
      {pendingDelete && (
        <ConfirmDialog
          title="删除执行记录"
          description={`确定删除「${pendingDelete.label}」的执行记录吗？删除后无法恢复。`}
          label="确认删除"
          onClose={() => setPendingDelete(null)}
          onConfirm={() => quickDelete(pendingDelete.ids)}
        />
      )}
      {loadError && <NoticeBanner tone="err">{loadError}</NoticeBanner>}

      {!loaded && !recordsLoaded ? (
        <div className="rounded-xl border border-dashed border-[var(--line-strong)] bg-slate-50/70 px-4 py-12 text-center text-xs text-[var(--text-3)]">
          正在读取执行记录…
        </div>
      ) : isEmpty ? (
        <EmptyState title={emptyMessage} />
      ) : (
        <div
          className="records-table overflow-hidden rounded-xl border border-[var(--line)] bg-white shadow-xs"
          role="table"
        >
          <div
            className={`records-row records-header ${RECORD_GRID_CLS} border-b border-[var(--line)] bg-slate-50 text-[11px] font-semibold text-[var(--text-3)]`}
            role="row"
          >
            <span role="columnheader" className="flex items-center justify-center pt-0.5">
              {moduleTab === 'google-sheets' || moduleTab === 'group-inviter' ? (
                <span aria-hidden="true" />
              ) : (
                <input
                  type="checkbox"
                  className={UI_CHECKBOX}
                  aria-label="选择当前已加载的已结束任务"
                  checked={eligibleIds.length > 0 && eligibleIds.every((id) => selected.has(id))}
                  onChange={(e) =>
                    setSelected(e.target.checked ? new Set(eligibleIds.slice(0, 1000)) : new Set())
                  }
                />
              )}
            </span>
            {colHeaders.map((h) => (
              <span key={h} role="columnheader">
                {h}
              </span>
            ))}
          </div>
          {moduleTab === 'active-accounts'
            ? groups.map((g) => renderGroupRow(g, false))
            : unifiedFeed.items.slice(0, visibleLimit).map((item) => {
                if (item.moduleId === 'active-accounts' && item.planId !== undefined) {
                  const g = byGroupPlanRound.get(`${item.planId}:${item.round ?? 1}`);
                  if (g) return renderGroupRow(g, moduleTab === 'all');
                }
                return (
                  <UnifiedNonTaskRow
                    key={item.id}
                    item={item}
                    showModuleBadge={moduleTab === 'all'}
                    byProfile={byProfile}
                    byInspection={byInspection}
                    onNotify={onNotify}
                  />
                );
              })}
          <div className="flex min-h-[46px] flex-wrap items-center justify-between gap-3 bg-[var(--surface-2)] px-4 py-2 text-xs text-[var(--text-3)] tabular-nums">
            <span>
              {moduleTab === 'active-accounts'
                ? `已显示 ${groups.length} / ${total} 次任务`
                : `已显示 ${Math.min(visibleLimit, unifiedFeed.items.length)} / ${unifiedFeed.items.length} 条执行记录`}
            </span>
            {moduleTab !== 'active-accounts' && unifiedFeed.items.length > visibleLimit && (
              <Btn onClick={() => setVisibleLimit((v) => v + 80)}>
                展开更多（剩余 {unifiedFeed.items.length - visibleLimit} 条）
              </Btn>
            )}
            {(moduleTab === 'active-accounts' || moduleTab === 'all') && nextCursor && (
              <Btn disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore
                  ? '正在加载…'
                  : moduleTab === 'active-accounts'
                    ? `再显示 ${Math.min(100, Math.max(1, total - groups.length))} 次任务`
                    : '加载更多活跃账号记录'}
              </Btn>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
