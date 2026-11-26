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
import { bluestacksDisplayTitle, type BluestacksState } from '../shared/bluestacks.js';
import {
  profileDisplayName,
  type Group,
  type Profile,
  type SavedCombination,
} from '../shared/contracts.js';
import type { BumperState } from '../shared/group-bumper.js';
import type { InviterGroupRow } from '../shared/group-inviter.js';
import type { PosterState } from '../shared/group-poster.js';
import { api } from './api.js';
import { AutoSchedulerEditorModal, MiniSegTabs } from './auto-scheduler-editor-modal.js';
import {
  ITEM_STATUS_BADGE,
  LINK_BTN,
  formatRunDuration,
  isAbnormalRunItem,
} from './auto-scheduler-step-helpers.js';
import { ConfirmDialog } from './confirm-dialog.js';
import {
  IconChevronDown,
  IconClose,
  IconCopy,
  IconEdit,
  IconMore,
  IconPlus,
  IconSettings,
} from './icons.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import { Btn, DataTbl, errMsg, useDropdownDismiss } from './modules/shared/module-ui.js';
import { PopoverMenu } from './popover-menu.js';
import { toggleSet } from './selection.js';
import { UI_INPUT_SM, UI_MUTED, UiSwitch } from './ui/primitives.js';

const PILL_BASE =
  'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap';
const RUN_STATUS_PILL: Record<AutoRunItemStatus, string> = {
  running: `${PILL_BASE} bg-[var(--brand-soft)] text-[var(--brand)]`,
  queued: `${PILL_BASE} bg-slate-100 text-slate-600`,
  completed: `${PILL_BASE} bg-emerald-50 text-emerald-700`,
  soft_warning: `${PILL_BASE} bg-amber-50 text-amber-700`,
  hard_blocked: `${PILL_BASE} bg-rose-50 text-rose-700`,
  watchdog_timeout: `${PILL_BASE} bg-amber-50 text-amber-700`,
  skipped: `${PILL_BASE} bg-slate-100 text-slate-600`,
  stopped: `${PILL_BASE} bg-slate-100 text-slate-600`,
};

export interface AutoSchedulerPageProps {
  state: AutoSchedulerState | null;
  onState: (next: AutoSchedulerState) => void;
  profiles: readonly Profile[];
  profileGroups: readonly Group[];
  selectedProfileIds: ReadonlySet<string>;
  combinations: readonly SavedCombination[];
  bumperState: BumperState | null;
  posterState: PosterState | null;
  inviterState?: { groups: readonly InviterGroupRow[] } | null | undefined;
  inviterGroups?: readonly InviterGroupRow[] | undefined;
  bluestacksState: BluestacksState | null;
  defaultCarrier?: 'browser' | 'bluestacks' | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
  onMessage: (msg: string) => void;
}

const fmtDate = (ms: number, opt: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleString('zh-CN', opt);

export function AutoSchedulerPage(p: AutoSchedulerPageProps) {
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
  } = p;
  const resolvedInviterGroups = p.inviterGroups ?? p.inviterState?.groups ?? [];
  const [editing, setEditing] = useState<AutoSchedule | 'create' | null>(null);
  const [guardOpen, setGuardOpen] = useState(false);
  const guardRef = useRef<HTMLDivElement>(null);
  const [staggerSec, setStaggerSec] = useState(state?.settings.launchStaggerSeconds ?? 3);
  const [watchdogMin, setWatchdogMin] = useState(state?.settings.idleWatchdogMinutes ?? 5);
  const [preventSleep, setPreventSleep] = useState(state?.settings.preventSystemSleep ?? true);
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(new Set());
  const [runFilterById, setRunFilterById] = useState<Record<string, 'all' | 'issues'>>({});
  const [deletingSchedule, setDeletingSchedule] = useState<AutoSchedule | null>(null);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [busyAction, setBusyAction] = useState(false);

  useEffect(() => {
    if (!state || guardOpen) return;
    setStaggerSec(state.settings.launchStaggerSeconds);
    setWatchdogMin(state.settings.idleWatchdogMinutes);
    setPreventSleep(state.settings.preventSystemSleep);
  }, [
    guardOpen,
    state?.settings.launchStaggerSeconds,
    state?.settings.idleWatchdogMinutes,
    state?.settings.preventSystemSleep,
  ]);

  useDropdownDismiss(guardOpen, guardRef, () => setGuardOpen(false));

  const comboNameById = new Map(
    combinations
      .filter((c) => isUserSavedCombination(c) && c.saved)
      .map((c) => [c.id, c.saved?.name ?? '']),
  );
  const profileById = new Map(profiles.map((pr) => [pr.id, pr]));
  const bsById = new Map((bluestacksState?.instances ?? []).map((inst) => [inst.id, inst]));
  const groupNameById = new Map<string, string>([
    ...profileGroups.map((g): [string, string] => [g.id, g.name]),
    ...(bluestacksState?.folders ?? []).map((f): [string, string] => [f.id, f.name]),
  ]);

  function describeTargets(s: AutoSchedule, n: number): string {
    const unit = s.carrier === 'browser' ? '窗' : '台';
    if (s.targetSelector.mode !== 'groups') return `${n}${unit}`;
    const gids = s.targetSelector.groupIds;
    return `${gids
      .slice(0, 2)
      .map((id) => groupNameById.get(id) || '分组')
      .join('、')}${gids.length > 2 ? ` +${gids.length - 2}` : ''} (${n}${unit})`;
  }

  async function runAction(
    action: Parameters<typeof api.autoSchedulerAction>[0],
    payload: unknown,
    okMsg: string,
  ) {
    setBusyAction(true);
    try {
      onState(await api.autoSchedulerAction(action, payload));
      onMessage(okMsg);
      return true;
    } catch (err) {
      onMessage(errMsg(err, '操作失败'));
      return false;
    } finally {
      setBusyAction(false);
    }
  }

  const toggleExpandRun = (runId: string) => setExpandedRunIds((prev) => toggleSet(prev, runId));
  const schedules = state?.schedules ?? [],
    activeRuns = state?.activeRuns ?? [],
    recentRuns = state?.recentRuns ?? [],
    enabledCount = schedules.filter((v) => v.enabled).length;

  function renderRunItems(run: AutoScheduleRun) {
    const filter = runFilterById[run.id] ?? 'all',
      items = run.items ?? [],
      abnormalCount = items.filter((it) => isAbnormalRunItem(it.status)).length,
      shown = filter === 'issues' ? items.filter((it) => isAbnormalRunItem(it.status)) : items;
    return (
      <div className="flex flex-col gap-2 border-t border-[var(--line)] px-3 pb-2.5 pt-2">
        <div className="flex items-center justify-between text-xs text-[var(--text-3)]">
          <span>
            {items.length} 目标{abnormalCount > 0 ? ` · ${abnormalCount} 异常/跳过` : ''}
          </span>
          <MiniSegTabs
            value={filter}
            options={[
              ['all', '全部'],
              ['issues', `异常 (${abnormalCount})`],
            ]}
            onChange={(val) => setRunFilterById((prev) => ({ ...prev, [run.id]: val }))}
          />
        </div>
        {shown.length === 0 ? (
          <p className="m-0 text-xs text-[var(--text-3)]">无记录</p>
        ) : (
          <DataTbl
            wrapClass="max-h-[240px] overflow-auto rounded-lg border border-[var(--line)] bg-white"
            headers={['账号', '状态', '说明', '耗时']}
            rows={shown}
            empty="无记录"
            renderRow={(it) => {
              const badge = ITEM_STATUS_BADGE[it.status];
              const bsInst = run.carrier === 'bluestacks' ? bsById.get(it.targetId) : undefined;
              const label =
                run.carrier === 'browser'
                  ? profileDisplayName(profileById.get(it.targetId), it.targetName)
                  : bsInst
                    ? bluestacksDisplayTitle(bsInst)
                    : it.targetName;
              return (
                <tr key={it.targetId} className="hover:bg-slate-50/70">
                  <td className="px-2.5 py-1.5 whitespace-nowrap">
                    <strong>{label}</strong>
                  </td>
                  <td className="px-2.5 py-1.5 whitespace-nowrap">
                    <span className={RUN_STATUS_PILL[it.status]}>{badge.label}</span>
                  </td>
                  <td className="max-w-[260px] truncate px-2.5 py-1.5 text-[var(--text-2)]">
                    {it.hardBlockReason || it.summary || it.currentStep || '—'}
                  </td>
                  <td className="px-2.5 py-1.5 whitespace-nowrap tabular-nums text-[var(--text-2)]">
                    {it.startedAt
                      ? formatRunDuration(it.startedAt, it.finishedAt ?? Date.now())
                      : '—'}
                  </td>
                </tr>
              );
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex max-w-[960px] flex-col gap-3.5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <h1 className="m-0 text-[19px] font-bold tracking-[-0.02em]">定时排班</h1>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full text-xs font-medium px-[9px] py-[3px] ${activeRuns.length > 0 ? 'bg-[var(--brand-soft)] text-[var(--brand)]' : enabledCount > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-[var(--surface-2)] text-[var(--text-3)]'}`}
          >
            <i
              className={`w-1.5 h-1.5 rounded-full ${activeRuns.length > 0 ? 'bg-blue-500' : enabledCount > 0 ? 'bg-emerald-500' : 'bg-slate-400'}`}
            />
            {activeRuns.length > 0
              ? `运行中 ${activeRuns.length}`
              : enabledCount > 0
                ? `${enabledCount} 已启用`
                : '未启用'}
          </span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="relative" ref={guardRef}>
            <Btn
              title="全局守护设置"
              aria-label="守护设置"
              disabled={!state}
              onClick={() => setGuardOpen((v) => !v)}
            >
              <IconSettings size={14} />
            </Btn>
            {guardOpen && (
              <div
                className="absolute right-0 top-[calc(100%+6px)] z-40 flex w-[262px] flex-col gap-2.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] px-3.5 py-3 shadow-xl"
                role="dialog"
                aria-label="守护设置"
              >
                <div className="flex items-center justify-between gap-2 border-b border-[var(--line)] pb-2 text-[12.5px]">
                  <strong>全局守护设置</strong>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-[var(--text-3)]">
                    全排班共用
                  </span>
                </div>
                {(
                  [
                    ['错峰启动', '错峰启动间隔秒', '秒', staggerSec, 0, 30, setStaggerSec],
                    ['卡死超时', '无进展看门狗分钟', '分', watchdogMin, 2, 60, setWatchdogMin],
                  ] as const
                ).map(([title, aria, unit, val, min, max, set]) => (
                  <label
                    key={aria}
                    className="flex items-center justify-between gap-2 text-[12.5px] text-[var(--text-2)]"
                  >
                    <span>{title}</span>
                    <div className="inline-flex items-center gap-[5px]">
                      <ControlledNumberInput
                        ariaLabel={aria}
                        className={`${UI_INPUT_SM} w-[54px] px-1.5 text-center`}
                        debounceMs={0}
                        value={val}
                        defaultValue={val}
                        min={min}
                        max={max}
                        onChange={set}
                      />
                      <span className="min-w-[14px] text-[11.5px] text-[var(--text-3)]">
                        {unit}
                      </span>
                    </div>
                  </label>
                ))}
                <UiSwitch
                  className="whitespace-nowrap text-[12.5px] text-[var(--text-2)]"
                  ariaLabel="排班期间防休眠"
                  label="排班期间防休眠"
                  checked={preventSleep}
                  onCheckedChange={setPreventSleep}
                />
                <div className="flex justify-end gap-1.5 border-t border-[var(--line)] pt-2">
                  <Btn onClick={() => setGuardOpen(false)}>取消</Btn>
                  <Btn
                    v="primary"
                    disabled={busyAction}
                    onClick={async () => {
                      if (
                        state &&
                        (await runAction(
                          'settings',
                          {
                            ...state.settings,
                            launchStaggerSeconds: staggerSec,
                            idleWatchdogMinutes: watchdogMin,
                            preventSystemSleep: preventSleep,
                          },
                          '已保存',
                        ))
                      )
                        setGuardOpen(false);
                    }}
                  >
                    保存
                  </Btn>
                </div>
              </div>
            )}
          </div>
          <Btn v="primary" sm={false} onClick={() => setEditing('create')}>
            <IconPlus /> 新建排班
          </Btn>
        </div>
      </header>

      {activeRuns.length > 0 && (
        <section className="flex flex-col gap-2" aria-label="正在运行">
          {activeRuns.map((run) => {
            const runningCount =
              run.items?.filter((it) => it.status === 'running').length ??
              (run.carrier === 'browser'
                ? (state?.activeBrowserWorkers ?? 0)
                : (state?.activeBluestacksWorkers ?? 0));
            const expanded = expandedRunIds.has(run.id);
            return (
              <div
                key={run.id}
                className="flex flex-col gap-2 rounded-[var(--r-md)] border border-blue-200 bg-white px-3.5 py-2.5 shadow-2xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`${PILL_BASE} bg-[var(--brand-soft)] text-[var(--brand)]`}>
                      运行中
                    </span>
                    <strong className="text-[13.5px]">{run.scheduleName}</strong>
                    <span className="text-xs tabular-nums text-[var(--text-2)]">
                      运行 <b>{runningCount}</b> · 完成 <b>{run.completedCount}</b> /{' '}
                      {run.totalTargets}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.onOpenLiveRuns && (
                      <Btn onClick={p.onOpenLiveRuns} title="打开实时任务队列查看完整进度">
                        查看队列
                      </Btn>
                    )}
                    <Btn onClick={() => toggleExpandRun(run.id)}>{expanded ? '收起' : '明细'}</Btn>
                    <Btn
                      v="danger"
                      disabled={busyAction}
                      onClick={() =>
                        void runAction('stop', { runId: run.id, keepWindowsOpen: false }, '已停止')
                      }
                    >
                      停止
                    </Btn>
                  </div>
                </div>
                {expanded && renderRunItems(run)}
              </div>
            );
          })}
        </section>
      )}

      {state === null || schedules.length === 0 ? (
        <section className="flex flex-col items-center gap-3 rounded-[var(--r-lg)] border border-dashed border-[var(--line-strong)] bg-[var(--surface)] px-6 py-10 text-center">
          {state === null ? (
            <p className={UI_MUTED}>读取中…</p>
          ) : (
            <>
              <h2 className="m-0 text-[15px] font-semibold text-[var(--text-2)]">还没有定时排班</h2>
              <Btn v="primary" sm={false} onClick={() => setEditing('create')}>
                <IconPlus /> 新建排班
              </Btn>
            </>
          )}
        </section>
      ) : (
        <section className="flex flex-col gap-2.5" aria-label="排班列表">
          {schedules.map((s) => {
            const isOnce = s.trigger.mode === 'once' && s.trigger.onceAt;
            const onceDisplay =
              isOnce && s.trigger.onceAt
                ? fmtDate(s.trigger.onceAt, {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                  })
                : null;
            const primaryTime =
              isOnce && s.trigger.onceAt
                ? fmtDate(s.trigger.onceAt, { hour: '2-digit', minute: '2-digit', hour12: false })
                : (s.trigger.times[0] ?? '09:00');
            const extraTimes = isOnce ? [] : s.trigger.times.slice(1);
            const isRunning = activeRuns.some((r) => r.scheduleId === s.id && r.phase === 'main');
            const stepCls = `text-xs rounded-md whitespace-nowrap px-[7px] py-0.5 bg-[var(--surface-2)] border border-[var(--line)] text-[var(--text-2)]${!s.enabled ? ' opacity-75' : ''}`;
            return (
              <article
                key={s.id}
                className={`flex items-center justify-between gap-4 rounded-xl border border-[var(--line)] px-4 py-3.5 transition-all hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-1)] has-[.popover-panel]:relative has-[.popover-panel]:z-[6] max-[760px]:flex-col max-[760px]:items-stretch ${!s.enabled ? 'bg-[var(--surface-2)]' : 'bg-[var(--surface)]'}`}
              >
                <div
                  className="grid min-w-0 flex-1 cursor-pointer grid-cols-[112px_minmax(0,1fr)] items-center gap-4 outline-none max-[760px]:grid-cols-1 max-[760px]:gap-2.5"
                  role="button"
                  tabIndex={0}
                  title="点击编辑"
                  onClick={() => setEditing(s)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setEditing(s);
                    }
                  }}
                >
                  <div className="flex flex-col gap-[3px] border-r border-[var(--line)] pr-[14px] max-[760px]:border-r-0 max-[760px]:border-b max-[760px]:pr-0 max-[760px]:pb-2">
                    <div className="flex items-baseline gap-[5px]">
                      <span
                        className={`text-[24px] font-bold leading-[1.05] tracking-[-0.03em] tabular-nums${!s.enabled ? ' text-[var(--text-3)]' : ''}`}
                      >
                        {primaryTime}
                      </span>
                      {extraTimes.length > 0 && (
                        <span
                          className="rounded-full bg-[var(--brand-soft)] px-[5px] py-[1px] text-[11px] font-semibold text-[var(--brand)]"
                          title={s.trigger.times.join(' · ')}
                        >
                          +{extraTimes.length}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-[var(--text-3)]">
                      {onceDisplay
                        ? `单次 · ${onceDisplay.split(' ')[0] ?? ''}`
                        : formatWeekdaysLabel(s.trigger.weekdays)}
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="m-0 text-[14.5px] font-semibold">{s.name}</h3>
                      <span className="whitespace-nowrap rounded-md bg-[var(--surface-2)] px-[7px] py-[2px] text-[11.5px] text-[var(--text-2)]">
                        {s.carrier === 'browser' ? '浏览器' : '蓝蝶'} ·{' '}
                        {describeTargets(s, s.resolvedTargetCount)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-[5px]">
                      {s.steps.map((step, idx) => (
                        <Fragment key={step.id}>
                          {idx > 0 && <span className="text-[11px] text-[var(--text-3)]">→</span>}
                          <span className={stepCls}>
                            {step.type === 'active-combination' ||
                            step.type === 'bluestacks-active-combination'
                              ? (comboNameById.get(step.combinationId) ?? '活跃组合')
                              : formatStepShortLabel(step)}
                          </span>
                        </Fragment>
                      ))}
                      {s.closeWindowOnFinish && (
                        <>
                          <span className="text-[11px] text-[var(--text-3)]">→</span>
                          <span
                            className={`text-xs rounded-md whitespace-nowrap px-[7px] py-0.5 border border-blue-200 bg-sky-50 text-sky-700${!s.enabled ? ' opacity-75' : ''}`}
                          >
                            关窗
                          </span>
                        </>
                      )}
                    </div>
                    {s.enabled && s.nextRun.label && (
                      <div className="text-xs font-medium text-emerald-700">
                        下次 {s.nextRun.label}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <UiSwitch
                    checked={s.enabled}
                    disabled={busyAction}
                    ariaLabel={`启用排班 ${s.name}`}
                    onCheckedChange={(checked) =>
                      void runAction(
                        'schedules/toggle',
                        { id: s.id, enabled: checked },
                        checked ? '已启用' : '已关闭',
                      )
                    }
                  />
                  <Btn
                    disabled={busyAction || isRunning}
                    onClick={() => void runAction('run-now', { id: s.id, phase: 'main' }, '已启动')}
                  >
                    {isRunning ? '运行中' : '运行'}
                  </Btn>
                  <PopoverMenu
                    label="更多操作"
                    trigger={<IconMore />}
                    items={[
                      { label: '编辑', icon: <IconEdit />, onSelect: () => setEditing(s) },
                      {
                        label: '复制',
                        icon: <IconCopy />,
                        disabled: busyAction,
                        onSelect: () =>
                          void runAction('schedules/duplicate', { id: s.id }, '已复制'),
                      },
                      {
                        label: '删除',
                        icon: <IconClose />,
                        danger: true,
                        disabled: busyAction,
                        onSelect: () => setDeletingSchedule(s),
                      },
                    ]}
                  />
                </div>
              </article>
            );
          })}
        </section>
      )}

      {recentRuns.length > 0 && (
        <details className="rounded-xl border border-[var(--line)] bg-white px-3.5 py-3 shadow-xs [&>summary::-webkit-details-marker]:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between text-[13px] font-semibold text-[var(--text-2)]">
            <span>执行记录 ({recentRuns.length})</span>
            <button
              type="button"
              className={LINK_BTN}
              disabled={busyAction}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setConfirmClearHistory(true);
              }}
            >
              清空
            </button>
          </summary>
          <div className="mt-2.5 flex flex-col gap-1.5">
            {recentRuns.map((run) => {
              const expanded = expandedRunIds.has(run.id),
                dur = formatRunDuration(run.startedAt, run.finishedAt),
                errTotal = run.hardBlockedCount + run.watchdogTimeoutCount;
              return (
                <div
                  key={run.id}
                  className="overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--surface-2)]"
                >
                  <div
                    className="flex cursor-pointer flex-wrap items-center gap-2.5 px-2.5 py-[7px] text-[12.5px]"
                    onClick={() => toggleExpandRun(run.id)}
                  >
                    <span className="tabular-nums text-[var(--text-3)]">
                      {fmtDate(run.startedAt, {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <strong>{run.scheduleName}</strong>
                    <span className="flex flex-1 flex-wrap items-center gap-1.5 tabular-nums text-[var(--text-2)]">
                      <span
                        className={`${PILL_BASE} ${errTotal > 0 ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-700'}`}
                      >
                        {run.completedCount}/{run.totalTargets}
                      </span>
                      {run.skippedCount > 0 && (
                        <span className={`${PILL_BASE} bg-amber-50 text-amber-700`}>
                          跳过 {run.skippedCount}
                        </span>
                      )}
                      {errTotal > 0 && (
                        <span className={`${PILL_BASE} bg-rose-50 text-rose-700`}>
                          异常 {errTotal}
                        </span>
                      )}
                      {run.status === 'stopped' && (
                        <span className={`${PILL_BASE} bg-slate-100 text-slate-600`}>已停</span>
                      )}
                      {dur && <span className="text-[11.5px] text-[var(--text-3)]">{dur}</span>}
                    </span>
                    <span className="inline-flex items-center justify-center text-[var(--text-2)]">
                      <IconChevronDown
                        size={14}
                        className={`transition-transform duration-150${expanded ? ' rotate-180' : ''}`}
                      />
                    </span>
                  </div>
                  {expanded && renderRunItems(run)}
                </div>
              );
            })}
          </div>
        </details>
      )}

      {(deletingSchedule || confirmClearHistory) && (
        <ConfirmDialog
          title={deletingSchedule ? '删除排班' : '清空记录'}
          description={
            deletingSchedule
              ? `确定删除「${deletingSchedule.name}」吗？`
              : '确定清空定时排班历史记录吗？'
          }
          label={deletingSchedule ? '删除' : '清空'}
          onClose={() => {
            setDeletingSchedule(null);
            setConfirmClearHistory(false);
          }}
          onConfirm={async () => {
            const ok = deletingSchedule
              ? await runAction('schedules/delete', { id: deletingSchedule.id }, '已删除')
              : await runAction('clear-history', {}, '已清空');
            if (!ok) throw new Error(deletingSchedule ? '删除失败' : '清空失败');
          }}
        />
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
          inviterGroups={resolvedInviterGroups}
          posterMaterials={posterState?.materials ?? []}
          bluestacksState={bluestacksState}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            onState(await api.autoSchedulerAction('schedules/save', payload));
            setEditing(null);
            onMessage(editing === 'create' ? '已创建排班' : '已保存');
          }}
        />
      )}
    </div>
  );
}
