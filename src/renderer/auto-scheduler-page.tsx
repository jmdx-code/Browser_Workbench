import { Fragment, useEffect, useRef, useState } from 'react';
import {
  formatStepShortLabel,
  formatWeekdaysLabel,
  isUserSavedCombination,
  type AutoRunItemStatus,
  type AutoSchedule,
  type AutoScheduleRun,
  type AutoSchedulerState,
} from '../shared/auto-scheduler.js';
import type { BluestacksState } from '../shared/bluestacks.js';
import type { Group, Profile, SavedCombination } from '../shared/contracts.js';
import type { BumperState } from '../shared/group-bumper.js';
import type { PosterState } from '../shared/group-poster.js';
import { api } from './api.js';
import { AutoSchedulerEditorModal, NumericInput } from './auto-scheduler-editor-modal.js';
import './auto-scheduler.css';

export interface AutoSchedulerPageProps {
  state: AutoSchedulerState | null;
  onState: (next: AutoSchedulerState) => void;
  profiles: readonly Profile[];
  profileGroups: readonly Group[];
  selectedProfileIds: ReadonlySet<string>;
  combinations: readonly SavedCombination[];
  bumperState: BumperState | null;
  posterState: PosterState | null;
  bluestacksState: BluestacksState | null;
  onMessage: (text: string) => void;
}

function itemStatusBadge(status: AutoRunItemStatus): { label: string; cls: string } {
  switch (status) {
    case 'running':
      return { label: '运行中', cls: 'sched-pill sched-pill-run' };
    case 'queued':
      return { label: '排队中', cls: 'sched-pill sched-pill-idle' };
    case 'completed':
      return { label: '已完成', cls: 'sched-pill sched-pill-ok' };
    case 'soft_warning':
      return { label: '软受限收尾', cls: 'sched-pill sched-pill-warn' };
    case 'hard_blocked':
      return { label: '封号/异常', cls: 'sched-pill sched-pill-err' };
    case 'watchdog_timeout':
      return { label: '超时回收', cls: 'sched-pill sched-pill-warn' };
    case 'skipped':
      return { label: '已跳过', cls: 'sched-pill sched-pill-idle' };
    case 'stopped':
      return { label: '已停止', cls: 'sched-pill sched-pill-idle' };
  }
}

function isAbnormalRunItem(status: AutoRunItemStatus): boolean {
  return (
    status === 'hard_blocked' ||
    status === 'watchdog_timeout' ||
    status === 'soft_warning' ||
    status === 'skipped'
  );
}

function subtractMinutesLabel(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  const total = ((((h ?? 0) * 60 + (m ?? 0) - mins) % 1440) + 1440) % 1440;
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

function formatDurationText(startedAt: number, finishedAt: number | null): string {
  if (!finishedAt || finishedAt <= startedAt) return '';
  const totalSec = Math.max(1, Math.round((finishedAt - startedAt) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return s > 0 ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h${remM}m`;
}

export function AutoSchedulerPage(props: AutoSchedulerPageProps) {
  const {
    state,
    onState,
    profiles,
    profileGroups,
    selectedProfileIds,
    combinations,
    bumperState,
    posterState,
    bluestacksState,
    onMessage,
  } = props;

  const [editing, setEditing] = useState<AutoSchedule | 'create' | null>(null);
  const [guardPopoverOpen, setGuardPopoverOpen] = useState(false);
  const guardWrapRef = useRef<HTMLDivElement>(null);

  const [staggerSec, setStaggerSec] = useState<number>(state?.settings.launchStaggerSeconds ?? 3);
  const [watchdogMin, setWatchdogMin] = useState<number>(state?.settings.idleWatchdogMinutes ?? 5);
  const [preventSleep, setPreventSleep] = useState<boolean>(
    state?.settings.preventSystemSleep ?? true,
  );

  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const [runFilterById, setRunFilterById] = useState<Record<string, 'all' | 'issues'>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  // Sync guard form only when popover opens or while closed — never overwrite active user edits on background poll!
  useEffect(() => {
    if (!state || guardPopoverOpen) return;
    setStaggerSec(state.settings.launchStaggerSeconds);
    setWatchdogMin(state.settings.idleWatchdogMinutes);
    setPreventSleep(state.settings.preventSystemSleep);
  }, [
    guardPopoverOpen,
    state?.settings.launchStaggerSeconds,
    state?.settings.idleWatchdogMinutes,
    state?.settings.preventSystemSleep,
  ]);

  useEffect(() => {
    if (!guardPopoverOpen) return;
    const onDown = (e: MouseEvent) => {
      if (guardWrapRef.current && !guardWrapRef.current.contains(e.target as Node)) {
        setGuardPopoverOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGuardPopoverOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [guardPopoverOpen]);

  const comboNameById = new Map<string, string>();
  for (const c of combinations) {
    if (isUserSavedCombination(c) && c.saved) {
      comboNameById.set(c.id, c.saved.name);
    }
  }

  const groupNameById = new Map<string, string>();
  for (const g of profileGroups) groupNameById.set(g.id, g.name);
  for (const f of bluestacksState?.folders ?? []) groupNameById.set(f.id, f.name);

  function describeTargetPool(s: AutoSchedule, matchedCount: number): string {
    const unit = s.carrier === 'browser' ? '号' : '窗';
    if (s.targetSelector.mode === 'groups') {
      const names = s.targetSelector.groupIds
        .map((id) => groupNameById.get(id) || '未命名分组')
        .slice(0, 2);
      const extra =
        s.targetSelector.groupIds.length > 2 ? ` 等${s.targetSelector.groupIds.length}组` : '';
      return `${names.join('、')}${extra} (${matchedCount}${unit})`;
    }
    return `手动指定 (${matchedCount}${unit})`;
  }

  async function saveGuardSettings() {
    if (!state) return;
    setBusyAction(true);
    try {
      const next = await api.autoSchedulerAction('settings', {
        ...state.settings,
        launchStaggerSeconds: staggerSec,
        idleWatchdogMinutes: watchdogMin,
        preventSystemSleep: preventSleep,
      });
      onState(next);
      setGuardPopoverOpen(false);
      onMessage('已保存排班守护参数');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    try {
      const next = await api.autoSchedulerAction('schedules/toggle', { id, enabled });
      onState(next);
      onMessage(enabled ? '已启用定时排班' : '已暂停该定时排班');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '切换失败');
    }
  }

  async function handleDuplicate(id: string) {
    setBusyAction(true);
    try {
      const next = await api.autoSchedulerAction('schedules/duplicate', { id });
      onState(next);
      onMessage('已复制排班（默认关闭，修改时间后开启即可）');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '复制失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleDelete(id: string) {
    setBusyAction(true);
    try {
      const next = await api.autoSchedulerAction('schedules/delete', { id });
      onState(next);
      setConfirmDeleteId(null);
      onMessage('已删除定时排班');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '删除失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleRunNow(id: string, phase: 'main' | 'prewarm' = 'main') {
    setBusyAction(true);
    try {
      const next = await api.autoSchedulerAction('run-now', { id, phase });
      onState(next);
      onMessage(phase === 'prewarm' ? '已启动提前预热场' : '已启动排班任务');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '启动失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleStopRun(runId?: string, keepWindowsOpen = false) {
    setBusyAction(true);
    try {
      const next = await api.autoSchedulerAction('stop', {
        ...(runId ? { runId } : {}),
        keepWindowsOpen,
      });
      onState(next);
      onMessage('已停止排班运行');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '停止失败');
    } finally {
      setBusyAction(false);
    }
  }

  async function handleClearHistory() {
    setBusyAction(true);
    try {
      const next = await api.autoSchedulerAction('clear-history', {});
      onState(next);
      setConfirmClearHistory(false);
      onMessage('已清空历史执行记录');
    } catch (err) {
      onMessage(err instanceof Error ? err.message : '清空失败');
    } finally {
      setBusyAction(false);
    }
  }

  function toggleExpandRun(runId: string) {
    setExpandedRunIds((prev) => {
      const copy = new Set(prev);
      if (copy.has(runId)) copy.delete(runId);
      else copy.add(runId);
      return copy;
    });
  }

  const schedules = state?.schedules ?? [];
  const activeRuns = state?.activeRuns ?? [];
  const recentRuns = state?.recentRuns ?? [];
  const enabledCount = schedules.filter((v) => v.enabled).length;

  function renderRunItemsTable(run: AutoScheduleRun) {
    const filterMode = runFilterById[run.id] ?? 'all';
    const items = run.items ?? [];
    const abnormalCount = items.filter((it) => isAbnormalRunItem(it.status)).length;
    const shown =
      filterMode === 'issues' ? items.filter((it) => isAbnormalRunItem(it.status)) : items;

    return (
      <div className="sched-run-detail-box">
        <div className="sched-run-detail-bar">
          <span>
            共 {items.length} 个目标 · 异常/跳过 {abnormalCount} 个
          </span>
          <div className="sched-mini-seg">
            <button
              type="button"
              className={'sched-mini-seg-btn' + (filterMode === 'all' ? ' is-active' : '')}
              onClick={() => setRunFilterById((prev) => ({ ...prev, [run.id]: 'all' }))}
            >
              全部 ({items.length})
            </button>
            <button
              type="button"
              className={'sched-mini-seg-btn' + (filterMode === 'issues' ? ' is-active' : '')}
              onClick={() => setRunFilterById((prev) => ({ ...prev, [run.id]: 'issues' }))}
            >
              仅异常 ({abnormalCount})
            </button>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="sched-muted-line">无匹配记录</p>
        ) : (
          <div className="sched-items-scroll">
            <table className="sched-items-table">
              <thead>
                <tr>
                  <th>账号 / 窗口</th>
                  <th>状态</th>
                  <th>进度说明</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((it) => {
                  const badge = itemStatusBadge(it.status);
                  return (
                    <tr key={it.targetId}>
                      <td>
                        <strong>{it.targetName}</strong>
                      </td>
                      <td>
                        <span className={badge.cls}>{badge.label}</span>
                      </td>
                      <td className="sched-td-reason">
                        {it.hardBlockReason || it.summary || it.currentStep || '—'}
                      </td>
                      <td>
                        {it.startedAt
                          ? formatDurationText(it.startedAt, it.finishedAt ?? Date.now())
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="sched-page">
      {/* Minimalist Top Bar */}
      <header className="sched-header">
        <div className="sched-header-left">
          <h1>定时排班</h1>
          <span
            className={
              'sched-daemon-badge' +
              (activeRuns.length > 0 ? ' is-running' : enabledCount > 0 ? ' is-armed' : '')
            }
          >
            <i />
            {activeRuns.length > 0
              ? `正在执行 (${activeRuns.length} 场)`
              : enabledCount > 0
                ? `守护中 · ${enabledCount} 个排班已启用`
                : '暂无启用的排班'}
          </span>
        </div>

        <div className="sched-header-right">
          <div className="sched-guard-wrap" ref={guardWrapRef}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setGuardPopoverOpen((v) => !v)}
            >
              ⚙ 守护设置
            </button>
            {guardPopoverOpen && (
              <div className="sched-guard-popover" role="dialog" aria-label="无人值守守护设置">
                <div className="sched-guard-title">无人值守全局守护（一般保持默认即可）</div>
                <label className="sched-guard-row">
                  <span>错峰启动间隔（秒）</span>
                  <NumericInput
                    ariaLabel="错峰启动间隔秒"
                    value={staggerSec}
                    min={0}
                    max={30}
                    width={56}
                    onChange={setStaggerSec}
                  />
                </label>
                <label className="sched-guard-row">
                  <span>无进展防卡死看门狗（分钟）</span>
                  <NumericInput
                    ariaLabel="无进展看门狗分钟"
                    value={watchdogMin}
                    min={2}
                    max={60}
                    width={56}
                    onChange={setWatchdogMin}
                  />
                </label>
                <label className="sched-check-row">
                  <input
                    type="checkbox"
                    checked={preventSleep}
                    onChange={(e) => setPreventSleep(e.target.checked)}
                  />
                  <span>有启用排班时阻止电脑自动休眠</span>
                </label>
                <div className="sched-guard-foot">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setGuardPopoverOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={busyAction}
                    onClick={() => void saveGuardSettings()}
                  >
                    保存
                  </button>
                </div>
              </div>
            )}
          </div>

          <button type="button" className="btn btn-primary" onClick={() => setEditing('create')}>
            + 新建排班
          </button>
        </div>
      </header>

      {/* Live Running Banner (Only shown when active) */}
      {activeRuns.length > 0 && (
        <section className="sched-live-section" aria-label="正在运行的排班">
          {activeRuns.map((run) => {
            const doneCount =
              run.completedCount +
              run.softIssueCount +
              run.hardBlockedCount +
              run.watchdogTimeoutCount +
              run.skippedCount;
            const runningItemsCount =
              run.items?.filter((it) => it.status === 'running').length ??
              (run.carrier === 'browser'
                ? (state?.activeBrowserWorkers ?? 0)
                : (state?.activeBluestacksWorkers ?? 0));
            const queuedItemsCount = Math.max(0, run.totalTargets - doneCount - runningItemsCount);
            const pct =
              run.totalTargets > 0
                ? Math.min(100, Math.round((doneCount / run.totalTargets) * 100))
                : 0;
            const expanded = expandedRunIds.has(run.id);
            return (
              <div key={run.id} className="sched-live-card">
                <div className="sched-live-top">
                  <div className="sched-live-info">
                    <span className="sched-pill sched-pill-run">
                      {run.phase === 'prewarm' ? '预热运行中' : '正点运行中'}
                    </span>
                    <strong>{run.scheduleName}</strong>
                    <span className="sched-live-stats">
                      运行中 <b>{runningItemsCount}</b> · 排队 <b>{queuedItemsCount}</b> · 已完成{' '}
                      <b>{run.completedCount + run.softIssueCount}</b>
                      {run.hardBlockedCount + run.watchdogTimeoutCount > 0
                        ? ` · 异常回收 ${run.hardBlockedCount + run.watchdogTimeoutCount}`
                        : ''}{' '}
                      / 共 {run.totalTargets}
                    </span>
                  </div>
                  <div className="sched-live-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => toggleExpandRun(run.id)}
                    >
                      {expanded ? '收起明细' : '查看明细'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busyAction}
                      onClick={() => void handleStopRun(run.id, false)}
                    >
                      停止并关窗
                    </button>
                  </div>
                </div>
                <div className="sched-progress-track">
                  <div className="sched-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                {expanded && renderRunItemsTable(run)}
              </div>
            );
          })}
        </section>
      )}

      {/* Main Alarm Cards List */}
      {state === null ? (
        <section className="sched-empty-card">
          <p className="muted">正在读取定时排班…</p>
        </section>
      ) : schedules.length === 0 ? (
        <section className="sched-empty-card">
          <div className="sched-empty-icon" aria-hidden="true">
            ⏰
          </div>
          <h2>还没有定时排班</h2>
          <p>
            像设闹钟一样设定时间与账号分组，到点自动分批打开窗口执行活跃、发帖或顶贴，跑完自动关窗。
          </p>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('create')}>
            + 新建第一个定时排班
          </button>
        </section>
      ) : (
        <section className="sched-alarm-list" aria-label="排班列表">
          {schedules.map((s) => {
            const primaryTime = s.trigger.times[0] ?? '07:00';
            const extraTimes = s.trigger.times.slice(1);
            const prewarmOn = s.carrier === 'browser' && s.prewarm.enabled;
            const prewarmClock = prewarmOn
              ? subtractMinutesLabel(primaryTime, s.prewarm.leadMinutes)
              : null;

            return (
              <article
                key={s.id}
                className={'sched-alarm-card' + (!s.enabled ? ' is-disabled' : '')}
              >
                {/* Left: Clock & Weekdays */}
                <div className="sched-alarm-clock-col">
                  <div className="sched-alarm-time-row">
                    <span className="sched-alarm-clock">{primaryTime}</span>
                    {extraTimes.length > 0 && (
                      <span
                        className="sched-extra-times-badge"
                        title={`全部时刻：${s.trigger.times.join('、')}`}
                      >
                        +{extraTimes.length}
                      </span>
                    )}
                  </div>
                  <div className="sched-alarm-days">{formatWeekdaysLabel(s.trigger.weekdays)}</div>
                  {prewarmClock && (
                    <span
                      className="sched-prewarm-badge"
                      title={`提前 ${s.prewarm.leadMinutes} 分钟独立预热完先关窗`}
                    >
                      {prewarmClock} 预热
                    </span>
                  )}
                </div>

                {/* Middle: Name + Target + 1-line Flow */}
                <div className="sched-alarm-main-col">
                  <div className="sched-alarm-title-row">
                    <h3>{s.name}</h3>
                    <span className="sched-carrier-tag">
                      {s.carrier === 'browser' ? '浏览器' : '蓝蝶'} ·{' '}
                      {describeTargetPool(s, s.resolvedTargetCount)}
                    </span>
                  </div>

                  <div className="sched-flow-chain">
                    {s.steps.map((step, idx) => (
                      <Fragment key={step.id}>
                        {idx > 0 && <span className="sched-flow-arrow">→</span>}
                        <span className="sched-flow-step">
                          {step.type === 'active-combination'
                            ? `活跃组合：${comboNameById.get(step.combinationId) ?? '已选组合'}`
                            : formatStepShortLabel(step)}
                        </span>
                      </Fragment>
                    ))}
                    {s.closeWindowOnFinish && (
                      <>
                        <span className="sched-flow-arrow">→</span>
                        <span className="sched-flow-step is-close">自动关窗</span>
                      </>
                    )}
                  </div>

                  <div className="sched-alarm-sub-row">
                    {s.enabled && s.nextRun.label ? (
                      <span className="sched-next-label">下次执行：{s.nextRun.label}</span>
                    ) : (
                      <span className="sched-next-label is-muted">已关闭定时触发</span>
                    )}
                    <span className="sched-dot">·</span>
                    <span className="sched-est-label">
                      单号约 {s.estimatedMainMinutesPerTarget} 分钟
                    </span>
                  </div>
                </div>

                {/* Right: Switch + Clean Actions */}
                <div className="sched-alarm-ops-col">
                  <label
                    className="sched-ios-switch"
                    title={s.enabled ? '点击关闭排班' : '点击启用排班'}
                  >
                    <input
                      type="checkbox"
                      aria-label={`启用排班 ${s.name}`}
                      checked={s.enabled}
                      onChange={(e) => void handleToggle(s.id, e.target.checked)}
                    />
                    <span className="sched-ios-slider" />
                  </label>

                  <div className="sched-card-btns">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyAction}
                      onClick={() => void handleRunNow(s.id, 'main')}
                    >
                      立即运行
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyAction}
                      onClick={() => setEditing(s)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busyAction}
                      title="复制一份排班快速改出午班/晚班"
                      onClick={() => void handleDuplicate(s.id)}
                    >
                      复制
                    </button>
                    {confirmDeleteId === s.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={busyAction}
                          onClick={() => void handleDelete(s.id)}
                        >
                          确认删
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          取消
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="sched-del-btn"
                        title="删除排班"
                        disabled={busyAction}
                        onClick={() => setConfirmDeleteId(s.id)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* Collapsible History (Hidden completely when empty!) */}
      {recentRuns.length > 0 && (
        <details className="sched-history-details">
          <summary>
            <span>最近执行记录（{recentRuns.length} 场）</span>
            {confirmClearHistory ? (
              <span
                className="sched-clear-confirm"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busyAction}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleClearHistory();
                  }}
                >
                  确认清空
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setConfirmClearHistory(false);
                  }}
                >
                  取消
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="sched-link-btn"
                onClick={(e) => {
                  e.preventDefault();
                  setConfirmClearHistory(true);
                }}
              >
                清空记录
              </button>
            )}
          </summary>

          <div className="sched-history-list">
            {recentRuns.map((run) => {
              const expanded = expandedRunIds.has(run.id);
              const dur = formatDurationText(run.startedAt, run.finishedAt);
              const okTotal = run.completedCount + run.softIssueCount;
              const errTotal = run.hardBlockedCount + run.watchdogTimeoutCount;
              return (
                <div key={run.id} className="sched-history-row-wrap">
                  <div className="sched-history-row" onClick={() => toggleExpandRun(run.id)}>
                    <span className="sched-history-time">
                      {new Date(run.startedAt).toLocaleString('zh-CN', {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <strong>{run.scheduleName}</strong>
                    {run.phase === 'prewarm' && <span className="sched-prewarm-badge">预热场</span>}
                    <span className="sched-history-summary">
                      完成 {okTotal}/{run.totalTargets}
                      {errTotal > 0 ? ` · 异常回收 ${errTotal}` : ''}
                      {dur ? ` · 耗时 ${dur}` : ''}
                    </span>
                    <span className="sched-history-expand">{expanded ? '收起 ▴' : '明细 ▾'}</span>
                  </div>
                  {expanded && renderRunItemsTable(run)}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {editing !== null && (
        <AutoSchedulerEditorModal
          initial={editing === 'create' ? null : editing}
          browserConcurrency={state?.settings.browserConcurrency ?? 15}
          bluestacksConcurrency={state?.settings.bluestacksConcurrency ?? 5}
          profiles={profiles}
          profileGroups={profileGroups}
          selectedProfileIds={selectedProfileIds}
          combinations={combinations}
          sharedGroups={bumperState?.groups ?? []}
          sharedPages={bumperState?.pages ?? []}
          posterMaterials={posterState?.materials ?? []}
          bluestacksState={bluestacksState}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            const next = await api.autoSchedulerAction('schedules/save', payload);
            onState(next);
            setEditing(null);
            onMessage(editing === 'create' ? '已创建定时排班' : '已保存排班修改');
          }}
        />
      )}
    </div>
  );
}
