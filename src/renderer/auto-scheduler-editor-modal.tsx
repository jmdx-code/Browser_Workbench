import { useMemo, useRef, useState } from 'react';
import {
  computeUpcomingRunsPreview,
  defaultTimeZone,
  isUserSavedCombination,
  type AutoSchedule,
  type AutoScheduleCarrier,
  type BluestacksPipelineStep,
  type BrowserPipelineStep,
  type QuickScheduleSeed,
  type SaveAutoScheduleInput,
} from '../shared/auto-scheduler.js';
import { bluestacksDisplayTitle, type BluestacksState } from '../shared/bluestacks.js';
import {
  profileDisplayName,
  type Group,
  type Profile,
  type SavedCombination,
} from '../shared/contracts.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import type { InviterGroupRow } from '../shared/group-inviter.js';
import type { PosterMaterial } from '../shared/group-poster.js';
import { AutoSchedulerStepCard, type StepCardCtx } from './auto-scheduler-step-card.js';
import {
  ADD_CHIP,
  BROWSER_STEP_META,
  BS_STEP_META,
  CARD_BOX,
  LINK_BTN,
  MINI_SEG,
  MINI_SEG_BTN,
  SMART_TIME_SLOTS,
  buildAutoSchedulePayload,
  buildOncePresets,
  combineDateTimeInZone,
  createStepFactory,
  defaultOnceTimestamp,
  mapPosterMaterialItems,
  mapTargetItems,
  mergeInviterAndSharedGroups,
  splitMillisInZone,
  uid,
  validateSteps,
  type AnyStep,
} from './auto-scheduler-step-helpers.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import { BackdropModal, Btn, errMsg, useEscapeKey } from './modules/shared/module-ui.js';
import { UnifiedTargetPicker } from './modules/shared/unified-target-picker.js';
import { DayPillGroup, UI_INPUT, UI_INPUT_SM, UiSegmented, UiSwitch } from './ui/primitives.js';

export interface AutoSchedulerEditorModalProps {
  initial: AutoSchedule | null;
  seed?: QuickScheduleSeed | null | undefined;
  browserConcurrency: number;
  bluestacksConcurrency: number;
  profiles: readonly Profile[];
  profileGroups: readonly Group[];
  selectedProfileIds: ReadonlySet<string>;
  combinations: readonly SavedCombination[];
  sharedGroups: readonly BumperTarget[];
  sharedPages: readonly BumperTarget[];
  inviterGroups?: readonly InviterGroupRow[] | undefined;
  posterMaterials: readonly PosterMaterial[];
  bluestacksState: BluestacksState | null;
  onSave: (payload: SaveAutoScheduleInput) => Promise<void>;
  onClose: () => void;
}

const DT_CLS = `${UI_INPUT_SM} font-medium tabular-nums`;

export function MiniSegTabs<T extends string>(p: {
  ariaLabel?: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div className={MINI_SEG} role="tablist" aria-label={p.ariaLabel}>
      {p.options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={p.value === v}
          className={MINI_SEG_BTN(p.value === v)}
          onClick={() => p.onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function AutoSchedulerEditorModal(p: AutoSchedulerEditorModalProps) {
  const { initial, seed } = p;
  const savedCombos = useMemo(
    () => p.combinations.filter(isUserSavedCombination),
    [p.combinations],
  );
  const defaultComboId = useMemo(
    () => savedCombos.find((c) => c.saved?.loop.mode !== 'until-stopped')?.id,
    [savedCombos],
  );
  const inviterGroupTargetItems = useMemo(
    () => mergeInviterAndSharedGroups(p.inviterGroups, p.sharedGroups),
    [p.inviterGroups, p.sharedGroups],
  );
  const makeStep = useMemo(
    () =>
      createStepFactory({
        defaultComboId,
        sharedGroups: p.sharedGroups,
        inviterGroups: inviterGroupTargetItems,
        sharedPages: p.sharedPages,
        posterMaterials: p.posterMaterials,
      }),
    [defaultComboId, p.sharedGroups, inviterGroupTargetItems, p.sharedPages, p.posterMaterials],
  );

  const [carrier, setCarrier] = useState<AutoScheduleCarrier>(
    initial?.carrier ?? seed?.carrier ?? 'browser',
  );
  const [name, setName] = useState(initial?.name ?? seed?.name ?? '定时养号');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [triggerMode, setTriggerMode] = useState<'weekly' | 'once'>(
    () => initial?.trigger.mode ?? (seed ? 'once' : 'weekly'),
  );
  const [timeZone] = useState(() => initial?.trigger.timeZone || defaultTimeZone());
  const initOnce = splitMillisInZone(initial?.trigger.onceAt ?? defaultOnceTimestamp(), timeZone);
  const [onceDate, setOnceDate] = useState(initOnce.date);
  const [onceTime, setOnceTime] = useState(initOnce.time);
  const [weekdays, setWeekdays] = useState<number[]>(
    initial?.trigger.weekdays.length
      ? [...initial.trigger.weekdays].sort((a, b) => a - b)
      : [1, 2, 3, 4, 5, 6, 7],
  );
  const [times, setTimes] = useState<string[]>(
    initial?.trigger.times.length ? [...initial.trigger.times].sort() : ['09:00'],
  );
  const [closeWindowOnFinish, setCloseWindowOnFinish] = useState(
    initial?.closeWindowOnFinish ?? true,
  );
  const [selectorMode, setSelectorMode] = useState<'groups' | 'explicit'>(() =>
    initial
      ? initial.targetSelector.mode
      : seed
        ? seed.targetIds.length > 0
          ? 'explicit'
          : 'groups'
        : p.profileGroups.length > 0
          ? 'groups'
          : 'explicit',
  );
  const [groupIds, setGroupIds] = useState<string[]>(() =>
    initial
      ? [...initial.targetSelector.groupIds]
      : seed?.groupIds?.length
        ? [...seed.groupIds]
        : p.profileGroups[0]?.id
          ? [p.profileGroups[0].id]
          : [],
  );
  const [targetIds, setTargetIds] = useState<string[]>(() =>
    initial
      ? [...initial.targetSelector.targetIds]
      : seed
        ? [...seed.targetIds]
        : [...p.selectedProfileIds],
  );
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(Math.min(30, Math.max(1, p.profiles.length)));
  const [browserSteps, setBrowserSteps] = useState<BrowserPipelineStep[]>(() =>
    initial?.carrier === 'browser'
      ? [...initial.steps]
      : seed?.carrier === 'browser' && seed.steps.length > 0
        ? [...(seed.steps as BrowserPipelineStep[])]
        : defaultComboId
          ? [{ id: uid(), type: 'active-combination', combinationId: defaultComboId }]
          : [{ id: uid(), type: 'group-bumper', groupIds: [], pageIds: [] }],
  );
  const [bsSteps, setBsSteps] = useState<BluestacksPipelineStep[]>(() =>
    initial?.carrier === 'bluestacks'
      ? [...initial.steps]
      : seed?.carrier === 'bluestacks' && seed.steps.length > 0
        ? [...(seed.steps as BluestacksPipelineStep[])]
        : defaultComboId
          ? [{ id: uid(), type: 'bluestacks-active-combination', combinationId: defaultComboId }]
          : [{ id: uid(), type: 'bluestacks-health-check', autoInstallApk: false }],
  );
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [paramOpenStepId, setParamOpenStepId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [errorText, setErrorText] = useState('');

  useEscapeKey(!saving, () => {
    if (!document.querySelector('dialog[open], .select-by-ids-modal')) p.onClose();
  });

  const activeGroupsPool =
    carrier === 'browser' ? p.profileGroups : (p.bluestacksState?.folders ?? []);
  const activeTargetsPool = useMemo(
    () =>
      carrier === 'browser'
        ? p.profiles.map((r, i) => ({
            id: r.id,
            groupId: r.groupId,
            name: `${i + 1}. ${profileDisplayName(r)}`,
            sub: r.account.name || r.account.id || undefined,
            avatarUrl: r.account.avatar ?? null,
            badge: r.online ? '在线' : undefined,
          }))
        : (p.bluestacksState?.instances ?? []).map((inst, i) => ({
            id: inst.id,
            groupId: inst.folderId,
            name: `${i + 1}. ${bluestacksDisplayTitle(inst)}`,
            sub: inst.accountName || inst.instanceKey,
            avatarUrl: inst.avatarUrl ?? null,
            badge: inst.online ? '在线' : undefined,
          })),
    [carrier, p.profiles, p.bluestacksState?.instances],
  );
  const matchedTargetCount = useMemo(() => {
    const set = new Set(selectorMode === 'groups' ? groupIds : targetIds);
    return activeTargetsPool.filter((t) =>
      selectorMode === 'groups' ? Boolean(t.groupId && set.has(t.groupId)) : set.has(t.id),
    ).length;
  }, [selectorMode, groupIds, targetIds, activeTargetsPool]);
  const onceAtMs = useMemo(
    () => combineDateTimeInZone(onceDate, onceTime, timeZone),
    [onceDate, onceTime, timeZone],
  );
  const upcomingPreview = useMemo(() => {
    if (triggerMode === 'once' ? !onceAtMs : !weekdays.length || !times.length) return [];
    return computeUpcomingRunsPreview(
      {
        ...(initial?.id ? { id: initial.id } : {}),
        mode: triggerMode,
        onceAt: triggerMode === 'once' ? onceAtMs : null,
        weekdays,
        times,
        timeZone,
        jitterMinutes: 0,
        prewarmEnabled: false,
        prewarmLeadMinutes: 90,
      },
      Date.now(),
      1,
    );
  }, [initial?.id, triggerMode, onceAtMs, weekdays, times, timeZone]);

  const pageTargetItems = useMemo(() => mapTargetItems(p.sharedPages), [p.sharedPages]);
  const groupTargetItems = useMemo(() => mapTargetItems(p.sharedGroups), [p.sharedGroups]);
  const posterMaterialItems = useMemo(
    () => mapPosterMaterialItems(p.posterMaterials),
    [p.posterMaterials],
  );

  function switchCarrier(next: AutoScheduleCarrier) {
    if (next === carrier) return;
    setCarrier(next);
    setExpandedStepId(null);
    const nextGroups = next === 'browser' ? p.profileGroups : (p.bluestacksState?.folders ?? []);
    const nextLen =
      next === 'browser' ? p.profiles.length : (p.bluestacksState?.instances.length ?? 0);
    setRangeStart(1);
    setRangeEnd(Math.min(30, Math.max(1, nextLen)));
    setTargetIds([]);
    setSelectorMode(nextGroups[0]?.id ? 'groups' : 'explicit');
    setGroupIds(nextGroups[0]?.id ? [nextGroups[0].id] : []);
  }

  const activeSteps: readonly AnyStep[] = carrier === 'browser' ? browserSteps : bsSteps;
  const stepMeta = carrier === 'browser' ? BROWSER_STEP_META : BS_STEP_META;
  const maxSteps = carrier === 'browser' ? 12 : 8;
  const setSteps = (updater: (prev: AnyStep[]) => AnyStep[]) =>
    carrier === 'browser'
      ? setBrowserSteps((prev) => updater(prev) as BrowserPipelineStep[])
      : setBsSteps((prev) => updater(prev) as BluestacksPipelineStep[]);
  const updateStep = (index: number, next: AnyStep) =>
    setSteps((prev) => prev.map((s, i) => (i === index ? next : s)));

  async function handleSubmit() {
    if (savingRef.current || saving) return;
    setErrorText('');
    const trimmedName = name.trim();
    if (!trimmedName) return setErrorText('请填写名称');
    if (triggerMode === 'once' && (!onceAtMs || onceAtMs <= Date.now()))
      return setErrorText('单次定时请选择未来的执行日期与时间');
    const liveGroups = groupIds.filter((id) => activeGroupsPool.some((g) => g.id === id));
    const liveTargets = targetIds.filter((id) => activeTargetsPool.some((t) => t.id === id));
    if (selectorMode === 'groups' && !liveGroups.length) return setErrorText('请至少选择一个分组');
    if (selectorMode === 'explicit' && !liveTargets.length)
      return setErrorText('请至少选择一个账号');
    const issue = validateSteps(activeSteps, savedCombos);
    if (issue) {
      if (issue.openDrawer) setExpandedStepId(issue.stepId);
      return setErrorText(issue.message);
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await p.onSave(
        buildAutoSchedulePayload({
          initial,
          name: trimmedName,
          enabled,
          carrier,
          selectorMode,
          liveGroups,
          liveTargets,
          triggerMode,
          onceAtMs,
          weekdays,
          times,
          timeZone,
          closeWindowOnFinish,
          browserSteps,
          bsSteps,
        }),
      );
    } catch (err) {
      setErrorText(errMsg(err, '保存失败'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const concurrencyCap = carrier === 'browser' ? p.browserConcurrency : p.bluestacksConcurrency;
  const wavesCount = Math.max(
    1,
    Math.ceil(Math.max(1, matchedTargetCount) / Math.max(1, concurrencyCap)),
  );
  const stepCtx: StepCardCtx = {
    saving,
    stepMeta,
    savedCombos,
    pageTargetItems,
    groupTargetItems,
    inviterGroupTargetItems,
    posterMaterialItems,
    makeStep,
    updateStep,
    setSteps,
    setExpandedStepId,
    setParamOpenStepId,
  };

  return (
    <BackdropModal
      label={initial ? '编辑排班' : '新建排班'}
      backdropClass="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-[2px]"
      modalClass="contents"
      busy={saving}
      blockEscape
      onClose={p.onClose}
    >
      <div className="modal flex max-h-[calc(100vh-32px)] w-[min(680px,100%)] flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-white text-[var(--text)] shadow-2xl">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--line)] px-[18px] py-[14px]">
          <div className="flex items-center gap-3">
            <h2 className="m-0 text-base font-bold">{initial ? '编辑排班' : '新建排班'}</h2>
            <MiniSegTabs
              ariaLabel="运行载体"
              value={carrier}
              options={[
                ['browser', '浏览器'],
                ['bluestacks', '蓝蝶'],
              ]}
              onChange={switchCarrier}
            />
          </div>
          <div className="flex items-center gap-3">
            <UiSwitch
              checked={enabled}
              label="启用"
              ariaLabel="启用排班"
              onCheckedChange={setEnabled}
            />
            <Btn v="icon" aria-label="关闭" onClick={p.onClose}>
              ×
            </Btn>
          </div>
        </header>

        <div className="flex flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] py-4">
          <input
            aria-label="排班名称"
            className={`${UI_INPUT} w-full`}
            value={name}
            maxLength={80}
            placeholder="排班名称，如：早班日常养号"
            onChange={(e) => setName(e.target.value)}
          />

          <section className={CARD_BOX}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <strong className="text-[13px] font-semibold">时间</strong>
                {upcomingPreview[0]?.label && (
                  <span className="text-xs text-[var(--text-3)]">
                    下次 {upcomingPreview[0].label}
                  </span>
                )}
              </div>
              <UiSegmented
                ariaLabel="定时触发模式"
                value={triggerMode}
                options={[
                  { value: 'weekly', label: '按周循环' },
                  { value: 'once', label: '单次定时' },
                ]}
                onChange={setTriggerMode}
              />
            </div>
            {triggerMode === 'weekly' ? (
              <div className="flex flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-[7px]">
                  {times.map((t, idx) => (
                    <span
                      key={idx}
                      className="inline-flex items-center gap-[3px] rounded-lg border border-[var(--line)] bg-[var(--surface-2)] px-2 py-[3px]"
                    >
                      <input
                        type="time"
                        aria-label={`执行时刻 ${idx + 1}`}
                        className="border-0 bg-transparent text-[13.5px] font-semibold tabular-nums outline-none"
                        value={t}
                        disabled={saving}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))
                            setTimes((prev) =>
                              prev.some((item, i) => i !== idx && item === v)
                                ? prev
                                : prev.map((item, i) => (i === idx ? v : item)),
                            );
                        }}
                        onBlur={() => setTimes((prev) => [...prev].sort())}
                      />
                      {times.length > 1 && (
                        <button
                          type="button"
                          className="cursor-pointer border-0 bg-transparent px-0.5 text-[var(--text-3)]"
                          aria-label={`移除时刻 ${t}`}
                          onClick={() => setTimes((prev) => prev.filter((_, i) => i !== idx))}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                  {times.length < 8 && (
                    <button
                      type="button"
                      className={ADD_CHIP}
                      onClick={() =>
                        setTimes((prev) => {
                          const pick = SMART_TIME_SLOTS.find((c) => !prev.includes(c));
                          return pick ? [...prev, pick].sort() : prev;
                        })
                      }
                    >
                      + 时刻
                    </button>
                  )}
                </div>
                <DayPillGroup weekdays={weekdays} disabled={saving} onChange={setWeekdays} />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="date"
                    className={DT_CLS}
                    aria-label="单次执行日期"
                    value={onceDate}
                    disabled={saving}
                    onChange={(e) => setOnceDate(e.target.value)}
                  />
                  <input
                    type="time"
                    className={DT_CLS}
                    aria-label="单次执行时间"
                    value={onceTime}
                    disabled={saving}
                    onChange={(e) => setOnceTime(e.target.value)}
                  />
                  <span className="text-xs text-[var(--text-3)]">执行一次后自动停用</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {buildOncePresets(timeZone).map((pr) => (
                    <button
                      key={pr.label}
                      type="button"
                      className={LINK_BTN}
                      onClick={() => {
                        const sp = splitMillisInZone(pr.ms(), timeZone);
                        setOnceDate(sp.date);
                        setOnceTime(sp.time);
                      }}
                    >
                      {pr.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>

          <section className={CARD_BOX}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <strong className="text-[13px] font-semibold">对象</strong>
                <span className="text-xs text-[var(--text-3)]">
                  {matchedTargetCount} {carrier === 'browser' ? '窗' : '台'} · {concurrencyCap}并发
                  · 约{wavesCount}波
                </span>
              </div>
              <MiniSegTabs
                value={selectorMode}
                options={[
                  ['groups', '按分组'],
                  ['explicit', '手动选'],
                ]}
                onChange={setSelectorMode}
              />
            </div>
            {selectorMode === 'groups' ? (
              activeGroupsPool.length === 0 ? (
                <div className="text-[12.5px] text-[var(--text-3)]">暂无分组，可切换「手动选」</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {activeGroupsPool.map((g) => {
                    const checked = groupIds.includes(g.id),
                      count = activeTargetsPool.filter((t) => t.groupId === g.id).length;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        className={`inline-flex items-center gap-1.5 rounded-lg text-[12.5px] cursor-pointer px-2.5 py-[5px] border transition-colors ${checked ? 'border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand-hover)]' : 'border-[var(--line)] bg-[var(--surface)] text-[var(--text)] hover:bg-[var(--surface-2)]'}`}
                        onClick={() =>
                          setGroupIds((prev) =>
                            prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id],
                          )
                        }
                      >
                        <span>{checked ? '✓' : '+'}</span>
                        <span>{g.name}</span>
                        <em className="not-italic text-[11px] text-[var(--text-3)]">{count}</em>
                      </button>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                  <span>
                    已选 <strong>{matchedTargetCount}</strong> / {activeTargetsPool.length}
                  </span>
                  <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                    {activeTargetsPool.length > 1 && (
                      <span className="flex flex-wrap items-center gap-2 text-[12.5px]">
                        {(
                          [
                            ['起始序号', rangeStart, setRangeStart],
                            ['结束序号', rangeEnd, setRangeEnd],
                          ] as const
                        ).map(([aria, v, setV], i) => (
                          <span key={aria} className="inline-flex items-center gap-2">
                            {i === 1 && <span>-</span>}
                            <ControlledNumberInput
                              ariaLabel={aria}
                              className={`${UI_INPUT_SM} w-[60px] px-1.5 text-center`}
                              debounceMs={0}
                              value={v}
                              defaultValue={v}
                              min={1}
                              max={Math.max(1, activeTargetsPool.length)}
                              onChange={setV}
                            />
                          </span>
                        ))}
                        <button
                          type="button"
                          className={LINK_BTN}
                          onClick={() => {
                            const lo = Math.max(1, Math.min(rangeStart, rangeEnd)),
                              hi = Math.min(
                                activeTargetsPool.length,
                                Math.max(rangeStart, rangeEnd),
                              );
                            setTargetIds(activeTargetsPool.slice(lo - 1, hi).map((t) => t.id));
                          }}
                        >
                          套用
                        </button>
                      </span>
                    )}
                    <Btn onClick={() => setManualPickerOpen((v) => !v)}>
                      {manualPickerOpen ? '收起 ▴' : '勾选 ▾'}
                    </Btn>
                  </div>
                </div>
                {manualPickerOpen && (
                  <UnifiedTargetPicker
                    title="选择账号"
                    items={activeTargetsPool}
                    selectedIds={targetIds}
                    onChange={setTargetIds}
                    onDone={() => setManualPickerOpen(false)}
                  />
                )}
              </div>
            )}
          </section>

          <section className={CARD_BOX}>
            <div className="flex items-center justify-between gap-2">
              <strong className="text-[13px] font-semibold">步骤</strong>
              <span className="text-xs text-[var(--text-3)]">{activeSteps.length} 步</span>
            </div>
            <div className="flex flex-col gap-[7px]">
              {activeSteps.map((step, idx) => (
                <AutoSchedulerStepCard
                  key={step.id}
                  step={step}
                  idx={idx}
                  totalSteps={activeSteps.length}
                  isOpen={expandedStepId === step.id}
                  isParamOpen={paramOpenStepId === step.id}
                  ctx={stepCtx}
                />
              ))}
              {activeSteps.length < maxSteps && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {stepMeta.map((m) => (
                    <button
                      key={m.type}
                      type="button"
                      className={ADD_CHIP}
                      onClick={() => {
                        const fresh = makeStep(m.type);
                        setSteps((prev) => [...prev, fresh]);
                        if (m.needsDrawer) setExpandedStepId(fresh.id);
                      }}
                    >
                      + {m.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {errorText && (
          <div
            className="mx-[18px] mb-2.5 shrink-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12.5px] text-red-700"
            role="alert"
          >
            {errorText}
          </div>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] bg-slate-50 px-[18px] py-3">
          <UiSwitch
            checked={closeWindowOnFinish}
            label="跑完自动关窗"
            ariaLabel="跑完自动关窗"
            onCheckedChange={setCloseWindowOnFinish}
          />
          <div className="flex items-center gap-2">
            <Btn sm={false} disabled={saving} onClick={p.onClose}>
              取消
            </Btn>
            <Btn v="primary" sm={false} disabled={saving} onClick={() => void handleSubmit()}>
              {saving ? '保存中…' : '保存'}
            </Btn>
          </div>
        </footer>
      </div>
    </BackdropModal>
  );
}
