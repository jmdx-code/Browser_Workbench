import { CleanupDialog, RecordCleanupActions } from './data-cleanup-panel.js';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { Profile } from '../shared/contracts.js';
import type { TaskRecord, TaskRuntimeOverview } from '../shared/task-contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import { attentionPlans, taskAlertReason, taskReasonDescription } from './task-alerts.js';
import { taskTimingLabel } from '../shared/task-timing.js';
import { TaskProgressView } from './task-progress.js';
import { TEST_COMBINATION_NOTE } from '../shared/task-tests.js';
import { api, ApiError } from './api.js';
import { IconClose, IconDownload, IconSearch } from './icons.js';

declare const __WORKBENCH_VERSION__: string;

type Filter = 'all' | 'running' | 'completed' | 'failed' | 'attention';
const stepNames = {
  feed: '浏览首页',
  video: '浏览 Reels',
  post: '发布内容',
  marketplace: '浏览商城',
  friends: '接受好友请求',
};
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
// Main line: when it started (or was planned). Sub line: how long it took / has been running.
function stepTime(row: TaskRecord, now: number) {
  if (row.startedAt === null)
    return {
      main: '—',
      sub: '未开始',
      title: '任务创建于 ' + new Date(row.planCreatedAt).toLocaleString(),
    };
  if (row.finishedAt !== null)
    return {
      main: shortTime(row.startedAt),
      sub: '用时 ' + span(row.finishedAt - row.startedAt),
      title: `${new Date(row.startedAt).toLocaleString()} → ${new Date(row.finishedAt).toLocaleString()}`,
    };
  return {
    main: shortTime(row.startedAt),
    sub: row.status === 'ACTIVE' ? '已进行 ' + span(now - row.startedAt) : '未结束',
    title: new Date(row.startedAt).toLocaleString() + ' 开始',
  };
}
function isCurrentPlanStep(
  row: TaskRecord,
  plan?: z.infer<typeof TaskRuntimeOverview>['plans'][number],
) {
  return (
    row.status === 'ACTIVE' ||
    (row.status === 'PENDING' &&
      !['STOPPED', 'COMPLETED', 'FAILED'].includes(row.planState) &&
      (plan ? row.round === plan.round && row.position === plan.position : row.position === 0))
  );
}
function stepStatusBadge(
  row: TaskRecord,
  isCurrent: boolean,
  isAttention: boolean,
): { label: string; tone: string } {
  if (row.status === 'COMPLETED') return { label: '已完成', tone: 'ok' };
  if (row.status === 'FAILED') return { label: '失败', tone: 'err' };
  if (row.status === 'SKIPPED') return { label: '已跳过', tone: 'warn' };
  if (isCurrent) {
    if (isAttention || row.planState === 'REVIEW')
      return { label: planStatus[row.planState]?.label ?? '需处理', tone: 'warn' };
    return planStatus[row.planState] ?? { label: '执行中', tone: 'run' };
  }
  if (['STOPPED', 'COMPLETED', 'FAILED'].includes(row.planState))
    return { label: '未执行', tone: 'idle' };
  return { label: '待执行', tone: 'queue' };
}
export function TaskRecordsPage({
  runtime,
  profiles,
  inspections,
  loaded,
  filterId,
  onClearFilter,
  onOpen,
}: {
  runtime: z.infer<typeof TaskRuntimeOverview> | null;
  profiles: Profile[];
  inspections: Inspection[];
  loaded: boolean;
  filterId: string | null;
  onClearFilter: () => void;
  onOpen: (profileId: string, planId: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  const afterDelete = () => {
    setSelected(new Set());
    setRows([]);
    setRetry((v) => v + 1);
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
  const rowsRef = useRef<TaskRecord[]>([]);
  rowsRef.current = rows;
  const plans = runtime?.plans ?? [];
  const byPlan = new Map(plans.map((plan) => [plan.id, plan]));
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
  }, [scopeKey]);
  const scopeRef = useRef('');
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const viewRef = useRef<string | undefined>(undefined);
  const [recordsKey, setRecordsKey] = useState(runtimeKey);
  const latestKey = useRef(runtimeKey);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateKey = plans.map((p) => `${p.id}:${p.state}`).join('|');
  const previousStateKey = useRef(stateKey);
  useEffect(() => {
    latestKey.current = runtimeKey;
    if (stateKey !== previousStateKey.current) {
      previousStateKey.current = stateKey;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      setRecordsKey(runtimeKey);
    } else if (!refreshTimer.current) {
      // At most 250ms, even while progress/reason changes continuously.
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        setRecordsKey(latestKey.current);
      }, 250);
    }
  }, [runtimeKey, stateKey]);
  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );
  const now = Date.now();
  // Debounce typing so each keystroke does not hit the records endpoint.
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
          setRows(res.records);
          setNextCursor(res.nextCursor);
        } else {
          // Keep pages the user already loaded: refresh rows in place, prepend new ones.
          const fresh = new Map(res.records.map((row) => [row.stepId, row]));
          const known = new Set(previous.map((row) => row.stepId));
          setRows([
            ...res.records.filter((row) => !known.has(row.stepId)),
            ...previous.map((row) => fresh.get(row.stepId) ?? row),
          ]);
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
        setRows([]);
        setNextCursor(null);
        setRetry((value) => value + 1);
        setLoadError('记录已变化，正在重新读取。');
      } else setLoadError('加载更多失败，请再试一次。');
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered = filterId ? byProfile.get(filterId) : undefined;
  async function exportRows() {
    if (exporting || !rows.length) return;
    setExporting(true);
    try {
      const allRecords: TaskRecord[] = [];
      let cursor: string | undefined;
      while (true) {
        const res = await api.taskRecords({
          ...(filterId ? { profileId: filterId } : {}),
          status: apiStatus,
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(cursor ? { cursor } : {}),
          limit: 200,
        });
        allRecords.push(...res.records);
        if (!res.nextCursor) break;
        cursor = res.nextCursor;
      }
      const payload = {
        format: 'browser-workbench-task-records',
        version: 2,
        softwareVersion: __WORKBENCH_VERSION__,
        exportedAt: new Date().toISOString(),
        scope: { profileId: filterId, filter, query: query.trim() },
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
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = '任务记录-' + new Date().toISOString().replaceAll(':', '-') + '.json';
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
  return (
    <section className="records-page" aria-label="任务记录">
      <div className="section-head">
        <h2>
          任务记录
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
          <label className="search-field">
            <IconSearch />
            <input
              type="search"
              aria-label="搜索任务记录"
              placeholder="搜索组合或浏览器"
              value={searchText}
              onChange={(event) => setSearchText(event.target.value)}
            />
          </label>
          <button
            className={'btn btn-icon' + (exporting ? ' is-busy' : '')}
            title={exporting ? '正在导出…' : '导出当前筛选全部子任务记录（JSON）'}
            aria-label="导出任务记录"
            disabled={!rows.length || exporting}
            onClick={() => void exportRows()}
          >
            <IconDownload />
          </button>
        </div>
      </div>
      <RecordCleanupActions
        stepIds={[...selected]}
        {...(filterId ? { profileId: filterId } : {})}
        onDone={afterDelete}
      />
      {deleting && (
        <CleanupDialog
          selection={{ kind: 'records', scope: { stepIds: [deleting] } }}
          onClose={() => setDeleting(null)}
          onDone={afterDelete}
        />
      )}
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
            <span>{counts[key]}</span>
          </button>
        ))}
      </div>
      {loadError && (
        <p className="records-notice" role="status">
          {loadError}
        </p>
      )}
      {!loaded && !recordsLoaded ? (
        <p className="muted records-empty">正在读取任务记录…</p>
      ) : !rows.length ? (
        <div className="records-empty">
          <p>
            {filter === 'attention'
              ? '没有需要处理的任务。'
              : filtered
                ? '这个浏览器还没有相关记录。'
                : '还没有任务记录。勾选浏览器后在首页启动组合或子任务测试。'}
          </p>
        </div>
      ) : (
        <div className="records-table" role="table">
          <div className="records-row records-header" role="row">
            <span role="columnheader">
              <input
                type="checkbox"
                aria-label="选择当前已加载的已结束记录（最多1000条）"
                checked={
                  rows.some((r) => ['COMPLETED', 'FAILED', 'STOPPED'].includes(r.planState)) &&
                  rows
                    .filter((r) => ['COMPLETED', 'FAILED', 'STOPPED'].includes(r.planState))
                    .slice(0, 1000)
                    .every((r) => selected.has(r.stepId))
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? new Set(
                          rows
                            .filter((r) => ['COMPLETED', 'FAILED', 'STOPPED'].includes(r.planState))
                            .slice(0, 1000)
                            .map((r) => r.stepId),
                        )
                      : new Set(),
                  )
                }
              />{' '}
              时间
            </span>
            <span role="columnheader">浏览器</span>
            <span role="columnheader">任务</span>
            <span role="columnheader">状态</span>
            <span role="columnheader">说明</span>
          </div>
          {rows.map((row, index) => {
            const profile = byProfile.get(row.profileId);
            const plan = byPlan.get(row.planId);
            const inspection = inspections.find((item) => item.profileId === row.profileId);
            const fbId =
              (inspection?.state === 'OBSERVED' ? inspection.account.id : null) ??
              profile?.account.id;
            const isCurrent = isCurrentPlanStep(row, plan);
            const isAttention =
              isCurrent && (attention.has(row.planId) || row.planState === 'REVIEW');
            const status = stepStatusBadge(row, isCurrent, isAttention);
            const test =
              plan?.snapshot.note.startsWith(TEST_COMBINATION_NOTE) ||
              row.combinationName.startsWith('单项测试 · ');
            const name = row.combinationName.replace('单项测试 · ', '');
            const stepLabel = row.destination === 'story' ? '发布快拍' : stepNames[row.type];
            const stepCount = plan?.snapshot.steps.length;
            const continued = index > 0 && rows[index - 1]?.planId === row.planId;
            const time = stepTime(row, now);
            const reason =
              row.status === 'FAILED' || row.status === 'SKIPPED'
                ? row.outcome
                  ? taskReasonDescription(row.outcome.reason)
                  : null
                : isCurrent && plan
                  ? plan.state === 'STOPPED'
                    ? taskReasonDescription(plan.reason)
                    : plan.reason || isAttention || plan.state === 'FAILED'
                      ? taskAlertReason(plan, profile)
                      : null
                  : row.outcome
                    ? taskReasonDescription(row.outcome.reason)
                    : null;
            const hasProgress =
              !reason &&
              (row.progress.revision > 0 ||
                (row.status === 'ACTIVE' && row.planState === 'RUNNING'));
            return (
              <div
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.target === event.currentTarget)
                    onOpen(row.profileId, row.planId);
                }}
                className={
                  'records-row tone-' + status.tone + (continued ? ' is-continued' : ' is-first')
                }
                role="row"
                key={row.stepId}
                onClick={() => onOpen(row.profileId, row.planId)}
                title="查看详情与操作"
              >
                <span role="cell" className="cell-time" title={time.title}>
                  <label onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={
                        '选择记录 ' +
                        row.combinationName +
                        ' 第' +
                        row.round +
                        '轮 ' +
                        (row.position + 1)
                      }
                      disabled={
                        !['COMPLETED', 'FAILED', 'STOPPED'].includes(row.planState) ||
                        (!selected.has(row.stepId) && selected.size >= 1000)
                      }
                      checked={selected.has(row.stepId)}
                      onChange={(e) =>
                        setSelected((previous) => {
                          const next = new Set(previous);
                          if (e.target.checked) next.add(row.stepId);
                          else next.delete(row.stepId);
                          return next;
                        })
                      }
                    />{' '}
                    <strong>{time.main}</strong>
                  </label>
                  <small>{time.sub}</small>
                </span>
                <span role="cell" className="cell-browser">
                  {!continued && (
                    <>
                      <strong>{profile?.browserName ?? profile?.alias ?? '已移除的浏览器'}</strong>
                      {fbId && <code className="fb-id">{fbId}</code>}
                    </>
                  )}
                </span>
                <span role="cell" className="cell-task">
                  {!continued && (
                    <strong>
                      {test && <em className="tag">测试</em>}
                      {name}
                    </strong>
                  )}
                  <span className="step-line">
                    <i
                      className={
                        'type-dot type-' + (row.destination === 'story' ? 'story' : row.type)
                      }
                    />
                    <span className="step-name">{stepLabel}</span>
                    <span className="step-pos">
                      {row.round > 1 || (!!plan && plan.snapshot.loop.mode !== 'finite')
                        ? `第${row.round}轮 · `
                        : ''}
                      {row.position + 1}
                      {stepCount ? '/' + stepCount : ''}
                    </span>
                  </span>
                </span>
                <span role="cell">
                  <span className={'pill pill-' + status.tone}>
                    <i />
                    {status.label}
                  </span>
                </span>
                <span role="cell" className="cell-note">
                  {['COMPLETED', 'FAILED', 'STOPPED'].includes(row.planState) && (
                    <button
                      className="btn btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleting(row.stepId);
                      }}
                    >
                      删除
                    </button>
                  )}
                  {reason ? (
                    <span title={reason.next}>{reason.summary}</span>
                  ) : hasProgress ? (
                    <TaskProgressView
                      type={row.type}
                      progress={row.progress}
                      budget={row.budget}
                      compact
                    />
                  ) : row.status === 'ACTIVE' && row.planState === 'QUEUED' && plan?.timing ? (
                    taskTimingLabel(plan.timing)
                  ) : (
                    <span className="muted">—</span>
                  )}
                </span>
              </div>
            );
          })}
          <div className="records-foot">
            <span>
              已显示 {rows.length} / {total} 条
            </span>
            {nextCursor && (
              <button
                className="btn btn-sm records-more"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore
                  ? '正在加载…'
                  : `再显示 ${Math.min(100, Math.max(1, total - rows.length))} 条`}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
