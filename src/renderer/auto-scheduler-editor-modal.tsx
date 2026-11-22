import { useEffect, useMemo, useState } from 'react';
import {
  computeUpcomingRunsPreview,
  defaultTimeZone,
  estimatePipelineMinutes,
  isUserSavedCombination,
  type AutoSchedule,
  type AutoScheduleCarrier,
  type BluestacksPipelineStep,
  type BrowserPipelineStep,
  type SaveAutoScheduleInput,
} from '../shared/auto-scheduler.js';
import { bluestacksDisplayTitle, type BluestacksState } from '../shared/bluestacks.js';
import type { Group, Profile, SavedCombination } from '../shared/contracts.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import type { PosterMaterial } from '../shared/group-poster.js';
import { ControlledNumberInput } from './modules/shared/controlled-number-input.js';
import {
  UnifiedTargetPicker,
  type UnifiedPickerItem,
} from './modules/shared/unified-target-picker.js';

export function NumericInput(props: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  width?: number | undefined;
  ariaLabel?: string | undefined;
}) {
  const { value, min, max, onChange, width, ariaLabel } = props;
  return (
    <ControlledNumberInput
      value={value}
      min={min}
      max={max}
      defaultValue={value}
      ariaLabel={ariaLabel ?? '数值输入'}
      className="sched-num-input"
      style={width ? { width } : undefined}
      debounceMs={0}
      onChange={onChange}
    />
  );
}

export interface AutoSchedulerEditorModalProps {
  initial: AutoSchedule | null;
  browserConcurrency: number;
  bluestacksConcurrency: number;
  profiles: readonly Profile[];
  profileGroups: readonly Group[];
  selectedProfileIds: ReadonlySet<string>;
  combinations: readonly SavedCombination[];
  sharedGroups: readonly BumperTarget[];
  sharedPages: readonly BumperTarget[];
  posterMaterials: readonly PosterMaterial[];
  bluestacksState: BluestacksState | null;
  onSave: (payload: SaveAutoScheduleInput) => Promise<void>;
  onClose: () => void;
}

function uid(): string {
  return globalThis.crypto.randomUUID();
}

function subtractMinutesFromHhMm(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(':').map((x) => Number(x));
  const total = ((((h ?? 0) * 60 + (m ?? 0) - mins) % 1440) + 1440) % 1440;
  const nh = Math.floor(total / 60);
  const nm = total % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

const WEEKDAY_ITEMS = [
  { day: 1, short: '一', title: '周一' },
  { day: 2, short: '二', title: '周二' },
  { day: 3, short: '三', title: '周三' },
  { day: 4, short: '四', title: '周四' },
  { day: 5, short: '五', title: '周五' },
  { day: 6, short: '六', title: '周六' },
  { day: 7, short: '日', title: '周日' },
] as const;

export function AutoSchedulerEditorModal(props: AutoSchedulerEditorModalProps) {
  const {
    initial,
    browserConcurrency,
    bluestacksConcurrency,
    profiles,
    profileGroups,
    selectedProfileIds,
    combinations,
    sharedGroups,
    sharedPages,
    posterMaterials,
    bluestacksState,
    onSave,
    onClose,
  } = props;

  const savedCombos = useMemo(() => combinations.filter(isUserSavedCombination), [combinations]);

  const makeDefaultBrowserStep = (type: BrowserPipelineStep['type']): BrowserPipelineStep => {
    switch (type) {
      case 'quick-browse':
        return { id: uid(), type: 'quick-browse', target: 'feed', durationMinutes: 1 };
      case 'active-combination':
        return {
          id: uid(),
          type: 'active-combination',
          combinationId: savedCombos[0]?.id ?? uid(),
        };
      case 'page-bumper':
        return {
          id: uid(),
          type: 'page-bumper',
          pageIds: sharedPages.length <= 5 ? sharedPages.map((p) => p.id) : [],
        };
      case 'group-bumper':
        return {
          id: uid(),
          type: 'group-bumper',
          groupIds: sharedGroups.length <= 5 ? sharedGroups.map((g) => g.id) : [],
          pageIds: sharedPages.length <= 3 ? sharedPages.map((p) => p.id) : [],
        };
      case 'group-poster':
        return {
          id: uid(),
          type: 'group-poster',
          materialIds: posterMaterials[0] ? [posterMaterials[0].id] : [],
          groupIds: sharedGroups.length <= 5 ? sharedGroups.map((g) => g.id) : [],
          maxGroupsPerProfile: 3,
        };
    }
  };

  const makeDefaultBsStep = (type: BluestacksPipelineStep['type']): BluestacksPipelineStep => {
    switch (type) {
      case 'bluestacks-health-check':
        return { id: uid(), type: 'bluestacks-health-check', autoInstallApk: false };
      case 'bluestacks-quick-browse':
        return { id: uid(), type: 'bluestacks-quick-browse', target: 'feed', durationMinutes: 2 };
      case 'bluestacks-active-combination':
        return {
          id: uid(),
          type: 'bluestacks-active-combination',
          combinationId: savedCombos[0]?.id ?? uid(),
        };
      case 'bluestacks-group-poster':
        return {
          id: uid(),
          type: 'bluestacks-group-poster',
          materialIds: posterMaterials[0] ? [posterMaterials[0].id] : [],
          groupIds: sharedGroups.length <= 5 ? sharedGroups.map((g) => g.id) : [],
          maxGroupsPerProfile: 3,
          postToTimeline: false,
        };
      case 'bluestacks-group-inviter':
        return {
          id: uid(),
          type: 'bluestacks-group-inviter',
          groupIds: sharedGroups.length <= 5 ? sharedGroups.map((g) => g.id) : [],
          invitesPerGroup: 5,
        };
      case 'bluestacks-page-bumper':
        return {
          id: uid(),
          type: 'bluestacks-page-bumper',
          pageIds: sharedPages.length <= 5 ? sharedPages.map((p) => p.id) : [],
        };
      case 'bluestacks-group-bumper':
        return {
          id: uid(),
          type: 'bluestacks-group-bumper',
          groupIds: sharedGroups.length <= 5 ? sharedGroups.map((g) => g.id) : [],
          pageIds: sharedPages.length <= 3 ? sharedPages.map((p) => p.id) : [],
        };
    }
  };

  const [carrier, setCarrier] = useState<AutoScheduleCarrier>(initial?.carrier ?? 'browser');
  const [name, setName] = useState<string>(initial?.name ?? '早班自动顶贴');
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);

  // Trigger
  const [weekdays, setWeekdays] = useState<number[]>(
    initial?.trigger.weekdays
      ? [...initial.trigger.weekdays].sort((a, b) => a - b)
      : [1, 2, 3, 4, 5, 6, 7],
  );
  const [times, setTimes] = useState<string[]>(
    initial?.trigger.times.length ? [...initial.trigger.times].sort() : ['07:00'],
  );
  const [timeZone] = useState<string>(() => initial?.trigger.timeZone || defaultTimeZone());
  const [jitterMinutes, setJitterMinutes] = useState<number>(initial?.trigger.jitterMinutes ?? 0);
  const [misfireGraceMinutes, setMisfireGraceMinutes] = useState<number>(
    initial?.trigger.misfireGraceMinutes ?? 120,
  );

  // Target selector
  const initialSelectedArr = useMemo(() => [...selectedProfileIds], [selectedProfileIds]);
  const [selectorMode, setSelectorMode] = useState<'groups' | 'explicit'>(() => {
    if (initial) return initial.targetSelector.mode;
    return profileGroups.length > 0 ? 'groups' : 'explicit';
  });
  const [groupIds, setGroupIds] = useState<string[]>(() => {
    if (initial) return [...initial.targetSelector.groupIds];
    if (profileGroups.length > 0) return [profileGroups[0]?.id ?? ''].filter(Boolean);
    return [];
  });
  const [targetIds, setTargetIds] = useState<string[]>(() => {
    if (initial) return [...initial.targetSelector.targetIds];
    return initialSelectedArr;
  });
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(Math.min(30, Math.max(1, profiles.length)));
  const [skipAbnormalAccounts, setSkipAbnormalAccounts] = useState<boolean>(
    initial?.targetSelector.skipAbnormalAccounts ?? true,
  );

  // Prewarm (browser only)
  const [prewarmEnabled, setPrewarmEnabled] = useState<boolean>(
    initial?.carrier === 'browser' ? initial.prewarm.enabled : false,
  );
  const [prewarmLeadMinutes, setPrewarmLeadMinutes] = useState<number>(
    initial?.carrier === 'browser' ? initial.prewarm.leadMinutes : 90,
  );
  const [prewarmSteps, setPrewarmSteps] = useState<BrowserPipelineStep[]>(() => {
    if (initial?.carrier === 'browser' && initial.prewarm.steps.length > 0) {
      return [...initial.prewarm.steps];
    }
    if (savedCombos[0]) {
      return [{ id: uid(), type: 'active-combination', combinationId: savedCombos[0].id }];
    }
    return [{ id: uid(), type: 'quick-browse', target: 'feed', durationMinutes: 15 }];
  });

  // Main pipeline steps
  const [browserSteps, setBrowserSteps] = useState<BrowserPipelineStep[]>(() => {
    if (initial?.carrier === 'browser') return [...initial.steps];
    return [
      { id: uid(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
      makeDefaultBrowserStep('page-bumper'),
      { id: uid(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
    ];
  });

  const [bsSteps, setBsSteps] = useState<BluestacksPipelineStep[]>(() => {
    if (initial?.carrier === 'bluestacks') return [...initial.steps];
    return [makeDefaultBsStep('bluestacks-page-bumper')];
  });

  // Track which single step currently has its target drawer expanded (progressive disclosure!)
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  // Advanced guardrails
  const [closeWindowOnFinish, setCloseWindowOnFinish] = useState<boolean>(
    initial?.closeWindowOnFinish ?? true,
  );
  const [safetyMode, setSafetyMode] = useState<'auto' | 'custom'>(
    initial?.maxSafetyMinutesPerTarget ? 'custom' : 'auto',
  );
  const [customSafetyMinutes, setCustomSafetyMinutes] = useState<number>(
    initial?.maxSafetyMinutesPerTarget ?? 90,
  );

  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [saving, onClose]);

  // Available folders & targets based on carrier
  const activeGroupsPool = carrier === 'browser' ? profileGroups : (bluestacksState?.folders ?? []);
  const activeTargetsPool = useMemo(() => {
    if (carrier === 'browser') {
      return profiles.map((p, idx) => ({
        id: p.id,
        groupId: p.groupId,
        name: `${idx + 1}. ${p.alias?.trim() || p.browserName?.trim() || p.id.slice(0, 8)}`,
        sub: p.account.name || p.account.id || undefined,
        avatarUrl: p.account.avatar ?? null,
        badge: p.online ? '在线' : undefined,
      }));
    }
    return (bluestacksState?.instances ?? []).map((inst, idx) => ({
      id: inst.id,
      groupId: inst.folderId,
      name: `${idx + 1}. ${bluestacksDisplayTitle(inst)}`,
      sub: inst.accountName || inst.instanceKey,
      avatarUrl: inst.avatarUrl ?? null,
      badge: inst.online ? '在线' : undefined,
    }));
  }, [carrier, profiles, bluestacksState?.instances]);

  const matchedTargetCount = useMemo(() => {
    if (selectorMode === 'groups') {
      const gSet = new Set(groupIds);
      return activeTargetsPool.filter((t) => t.groupId && gSet.has(t.groupId)).length;
    }
    const tSet = new Set(targetIds);
    return activeTargetsPool.filter((t) => tSet.has(t.id)).length;
  }, [selectorMode, groupIds, targetIds, activeTargetsPool]);

  const comboMinutesMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of savedCombos) {
      if (!c.saved) continue;
      const mins = c.saved.steps.reduce(
        (acc, s) => acc + ('durationMinutes' in s ? s.durationMinutes : 3),
        0,
      );
      m.set(c.id, Math.max(1, mins * (c.saved.loop.mode === 'finite' ? c.saved.loop.rounds : 1)));
    }
    return m;
  }, [savedCombos]);

  const estimatedMainMinutes = useMemo(() => {
    const steps = carrier === 'browser' ? browserSteps : bsSteps;
    return estimatePipelineMinutes(steps, (id) => comboMinutesMap.get(id) ?? 10);
  }, [carrier, browserSteps, bsSteps, comboMinutesMap]);

  const upcomingPreview = useMemo(() => {
    if (weekdays.length === 0 || times.length === 0) return [];
    return computeUpcomingRunsPreview(
      {
        weekdays,
        times,
        timeZone,
        jitterMinutes,
        prewarmEnabled: carrier === 'browser' && prewarmEnabled && prewarmSteps.length > 0,
        prewarmLeadMinutes,
      },
      Date.now(),
      2,
    );
  }, [
    weekdays,
    times,
    timeZone,
    jitterMinutes,
    carrier,
    prewarmEnabled,
    prewarmSteps.length,
    prewarmLeadMinutes,
  ]);

  const pageTargetItems = useMemo<UnifiedPickerItem[]>(
    () =>
      sharedPages.map((p) => ({
        id: p.id,
        name: p.name || p.id,
        sub: p.id,
        avatarUrl: p.avatarUrl,
        folderId: p.folderId,
        sortOrder: p.sortOrder,
      })),
    [sharedPages],
  );

  const groupTargetItems = useMemo<UnifiedPickerItem[]>(
    () =>
      sharedGroups.map((g) => ({
        id: g.id,
        name: g.name || g.id,
        sub: g.id,
        avatarUrl: g.avatarUrl,
        folderId: g.folderId,
        sortOrder: g.sortOrder,
      })),
    [sharedGroups],
  );

  const posterMaterialItems = useMemo<UnifiedPickerItem[]>(
    () =>
      posterMaterials.map((m, idx) => {
        const avatarUrl =
          m.mediaKind === 'image' && m.cacheStatus === 'ready'
            ? `/api/workspace/group-poster/materials/media?id=${encodeURIComponent(m.id)}&v=${m.updatedAt ?? 0}`
            : m.hasThumbnail
              ? `/api/workspace/group-poster/materials/thumbnail?id=${encodeURIComponent(m.id)}&v=${m.updatedAt ?? 0}`
              : null;
        const badge =
          m.mediaKind === 'image'
            ? '图片'
            : m.mediaKind === 'video'
              ? '视频'
              : m.background === 'color'
                ? '彩贴'
                : '纯文';
        return {
          id: m.id,
          name: m.caption.trim()
            ? `${idx + 1}. ${m.caption.trim().slice(0, 60)}`
            : `${idx + 1}. [纯媒体贴文]`,
          avatarUrl,
          badge,
        };
      }),
    [posterMaterials],
  );

  function switchCarrier(next: AutoScheduleCarrier) {
    if (next === carrier) return;
    setCarrier(next);
    setExpandedStepId(null);
    const nextGroups = next === 'browser' ? profileGroups : (bluestacksState?.folders ?? []);
    const nextPoolLen =
      next === 'browser' ? profiles.length : (bluestacksState?.instances.length ?? 0);
    setRangeStart(1);
    setRangeEnd(Math.min(30, Math.max(1, nextPoolLen)));
    if (nextGroups.length > 0) {
      setSelectorMode('groups');
      setGroupIds([nextGroups[0]?.id ?? ''].filter(Boolean));
    } else {
      setSelectorMode('explicit');
      setTargetIds([]);
    }
  }

  function toggleWeekday(day: number) {
    setWeekdays((prev) => {
      if (prev.includes(day)) {
        if (prev.length <= 1) return prev;
        return prev.filter((d) => d !== day);
      }
      return [...prev, day].sort((a, b) => a - b);
    });
  }

  function appendNextSmartTime() {
    const candidates = ['12:00', '20:00', '09:00', '15:00', '22:00', '06:00', '18:00', '23:00'];
    setTimes((prev) => {
      if (prev.length >= 8) return prev;
      const pick = candidates.find((c) => !prev.includes(c));
      if (!pick) return prev;
      return [...prev, pick].sort();
    });
  }

  function updateBrowserStep(index: number, next: BrowserPipelineStep) {
    setBrowserSteps((prev) => prev.map((s, i) => (i === index ? next : s)));
  }

  function moveStep<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
    const target = index + dir;
    if (target < 0 || target >= list.length) return [...list];
    const copy = [...list];
    const a = copy[index];
    const b = copy[target];
    if (a === undefined || b === undefined) return copy;
    copy[index] = b;
    copy[target] = a;
    return copy;
  }

  function describeBrowserStepSummary(step: BrowserPipelineStep): {
    text: string;
    needsAttention: boolean;
    hasDrawer: boolean;
  } {
    switch (step.type) {
      case 'quick-browse':
        return { text: '', needsAttention: false, hasDrawer: false };
      case 'active-combination':
        return {
          text: savedCombos.length === 0 ? '需先创建活跃组合' : '',
          needsAttention: savedCombos.length === 0,
          hasDrawer: false,
        };
      case 'page-bumper': {
        const count = step.pageIds.length;
        return {
          text: count > 0 ? `已选 ${count} 个专页` : `选择专页 (0/${pageTargetItems.length})`,
          needsAttention: count === 0,
          hasDrawer: true,
        };
      }
      case 'group-bumper': {
        const gCount = step.groupIds.length;
        const pCount = step.pageIds.length;
        const empty = gCount === 0 || pCount === 0;
        return {
          text: empty
            ? `选择小组(${gCount})与主页(${pCount})`
            : `已选 ${gCount} 组 · ${pCount} 主页`,
          needsAttention: empty,
          hasDrawer: true,
        };
      }
      case 'group-poster': {
        const mCount = step.materialIds.length;
        const gCount = step.groupIds.length;
        const empty = mCount === 0 || gCount === 0;
        return {
          text: empty
            ? `选择帖文(${mCount})与小组(${gCount})`
            : `已选 ${mCount} 帖 · ${gCount} 小组`,
          needsAttention: empty,
          hasDrawer: true,
        };
      }
    }
  }

  async function handleSubmit() {
    setErrorText('');
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorText('请填写排班名称');
      return;
    }
    const liveGroupIdSet = new Set(activeGroupsPool.map((g) => g.id));
    const liveGroupIds = groupIds.filter((id) => liveGroupIdSet.has(id));
    if (selectorMode === 'groups' && liveGroupIds.length === 0) {
      setErrorText('请至少勾选一个有效分组（原选分组可能已被删除）');
      return;
    }
    if (selectorMode === 'explicit' && targetIds.length === 0) {
      setErrorText('请至少勾选一个执行账号/窗口');
      return;
    }

    if (carrier === 'browser') {
      for (let i = 0; i < browserSteps.length; i++) {
        const s = browserSteps[i];
        if (!s) continue;
        if (s.type === 'page-bumper' && s.pageIds.length === 0) {
          setExpandedStepId(s.id);
          setErrorText(`第 ${i + 1} 步「专页顶贴」尚未勾选任何专页，请在展开列表中勾选`);
          return;
        }
        if (s.type === 'group-bumper' && (s.groupIds.length === 0 || s.pageIds.length === 0)) {
          setExpandedStepId(s.id);
          setErrorText(`第 ${i + 1} 步「小组顶贴」请同时勾选目标小组与目标主页`);
          return;
        }
        if (s.type === 'group-poster' && (s.materialIds.length === 0 || s.groupIds.length === 0)) {
          setExpandedStepId(s.id);
          setErrorText(`第 ${i + 1} 步「小组发帖」请同时勾选发帖素材与目标小组`);
          return;
        }
        if (s.type === 'active-combination' && !savedCombos.some((c) => c.id === s.combinationId)) {
          setErrorText(`第 ${i + 1} 步尚未选择有效的「活跃账号」任务组合`);
          return;
        }
      }
      if (prewarmEnabled && prewarmSteps.length === 0) {
        setErrorText('开启提前预热时，请至少保留一个预热动作');
        return;
      }
      if (prewarmEnabled) {
        for (const ps of prewarmSteps) {
          if (
            ps.type === 'active-combination' &&
            !savedCombos.some((c) => c.id === ps.combinationId)
          ) {
            setErrorText('提前预热选择的「活跃账号」组合已被删除，请重新选择');
            return;
          }
        }
      }
    } else {
      for (let i = 0; i < bsSteps.length; i++) {
        const s = bsSteps[i];
        if (!s) continue;
        if (s.type === 'bluestacks-page-bumper' && s.pageIds.length === 0) {
          setExpandedStepId(s.id);
          setErrorText(`第 ${i + 1} 步「蓝蝶专页顶贴」请勾选至少一个目标专页`);
          return;
        }
        if (
          s.type === 'bluestacks-group-bumper' &&
          (s.groupIds.length === 0 || s.pageIds.length === 0)
        ) {
          setExpandedStepId(s.id);
          setErrorText(`第 ${i + 1} 步「蓝蝶小组顶贴」请同时勾选小组与主页`);
          return;
        }
        if (
          s.type === 'bluestacks-group-poster' &&
          (s.materialIds.length === 0 || (s.groupIds.length === 0 && !s.postToTimeline))
        ) {
          setExpandedStepId(s.id);
          setErrorText(`第 ${i + 1} 步「蓝蝶小组发帖」请勾选素材并至少选择小组或开启时间线`);
          return;
        }
        if (s.type === 'bluestacks-group-inviter' && s.groupIds.length === 0) {
          setExpandedStepId(s.id);
          setErrorText(`第 ${i + 1} 步「蓝蝶小组邀人」请至少勾选一个目标小组`);
          return;
        }
        if (
          s.type === 'bluestacks-active-combination' &&
          !savedCombos.some((c) => c.id === s.combinationId)
        ) {
          setErrorText(`第 ${i + 1} 步尚未选择有效的「活跃账号」任务组合`);
          return;
        }
      }
    }

    const basePayload = {
      ...(initial ? { id: initial.id } : {}),
      name: trimmedName,
      enabled,
      targetSelector: {
        mode: selectorMode,
        groupIds: selectorMode === 'groups' ? liveGroupIds : [],
        targetIds: selectorMode === 'explicit' ? targetIds : [],
        skipAbnormalAccounts,
      },
      trigger: {
        weekdays,
        times,
        timeZone,
        jitterMinutes,
        misfireGraceMinutes,
      },
      closeWindowOnFinish,
      maxSafetyMinutesPerTarget: safetyMode === 'custom' ? customSafetyMinutes : null,
    };

    const payload: SaveAutoScheduleInput =
      carrier === 'browser'
        ? {
            ...basePayload,
            carrier: 'browser',
            prewarm: {
              enabled: prewarmEnabled,
              leadMinutes: prewarmLeadMinutes,
              steps: prewarmEnabled ? prewarmSteps : [],
            },
            steps: browserSteps,
          }
        : {
            ...basePayload,
            carrier: 'bluestacks',
            prewarm: { enabled: false, leadMinutes: 90, steps: [] },
            steps: bsSteps,
          };

    setSaving(true);
    try {
      await onSave(payload);
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : '保存排班失败');
    } finally {
      setSaving(false);
    }
  }

  const concurrencyCap = carrier === 'browser' ? browserConcurrency : bluestacksConcurrency;
  const wavesCount = Math.max(
    1,
    Math.ceil(Math.max(1, matchedTargetCount) / Math.max(1, concurrencyCap)),
  );

  return (
    <div
      className="sched-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={initial ? '编辑定时排班' : '新建定时排班'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="sched-modal">
        {/* Header: Title + Carrier Switch + Close */}
        <header className="sched-modal-header">
          <div className="sched-modal-title-wrap">
            <h2>{initial ? '编辑定时排班' : '新建定时排班'}</h2>
            <div className="sched-carrier-seg" role="tablist" aria-label="运行载体">
              <button
                type="button"
                role="tab"
                aria-selected={carrier === 'browser'}
                className={'sched-seg-btn' + (carrier === 'browser' ? ' is-active' : '')}
                onClick={() => switchCarrier('browser')}
              >
                浏览器
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={carrier === 'bluestacks'}
                className={'sched-seg-btn' + (carrier === 'bluestacks' ? ' is-active' : '')}
                onClick={() => switchCarrier('bluestacks')}
              >
                蓝蝶模拟器
              </button>
            </div>
          </div>
          <button
            type="button"
            className="sched-modal-close"
            aria-label="关闭"
            disabled={saving}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="sched-modal-body">
          {/* Name row */}
          <div className="sched-name-bar">
            <label className="sched-name-field">
              <span>名称</span>
              <input
                type="text"
                maxLength={80}
                placeholder="例如：早班 30 号顶贴"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="sched-switch-inline">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              <span>保存后立即启用</span>
            </label>
          </div>

          {/* Block 1: 几点跑 */}
          <section className="sched-block">
            <div className="sched-block-head">
              <strong>执行时间</strong>
              {upcomingPreview[0] && (
                <span className="sched-block-sub">下次：{upcomingPreview[0].label}</span>
              )}
            </div>

            <div className="sched-time-main">
              <div className="sched-time-slots">
                {times.map((t, idx) => (
                  <span key={idx} className="sched-time-slot-pill">
                    <input
                      type="time"
                      aria-label={`执行时刻 ${idx + 1}`}
                      value={t}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)) return;
                        setTimes((prev) => {
                          if (prev.some((item, i) => i !== idx && item === v)) return prev;
                          return prev.map((item, i) => (i === idx ? v : item));
                        });
                      }}
                    />
                    {times.length > 1 && (
                      <button
                        type="button"
                        className="sched-time-remove-btn"
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
                    className="sched-add-slot-btn"
                    onClick={appendNextSmartTime}
                  >
                    + 加时刻
                  </button>
                )}
              </div>

              <div className="sched-weekday-bar">
                <div className="sched-weekday-pills" role="group" aria-label="重复星期">
                  {WEEKDAY_ITEMS.map((w) => {
                    const active = weekdays.includes(w.day);
                    return (
                      <button
                        key={w.day}
                        type="button"
                        title={w.title}
                        className={'sched-day-pill' + (active ? ' is-active' : '')}
                        onClick={() => toggleWeekday(w.day)}
                      >
                        {w.short}
                      </button>
                    );
                  })}
                </div>
                <div className="sched-weekday-quick">
                  <button
                    type="button"
                    className="sched-link-btn"
                    onClick={() => setWeekdays([1, 2, 3, 4, 5, 6, 7])}
                  >
                    每天
                  </button>
                  <button
                    type="button"
                    className="sched-link-btn"
                    onClick={() => setWeekdays([1, 2, 3, 4, 5])}
                  >
                    工作日
                  </button>
                </div>
              </div>
            </div>

            {carrier === 'browser' && (
              <div className="sched-prewarm-strip">
                <label className="sched-prewarm-toggle">
                  <input
                    type="checkbox"
                    checked={prewarmEnabled}
                    onChange={(e) => setPrewarmEnabled(e.target.checked)}
                  />
                  <span>提前独立预热</span>
                  <small>定点先活跃一轮关窗，到正点再开窗顶贴</small>
                </label>

                {prewarmEnabled && (
                  <div className="sched-prewarm-inline">
                    <span>提前</span>
                    <NumericInput
                      ariaLabel="提前预热分钟数"
                      value={prewarmLeadMinutes}
                      min={15}
                      max={720}
                      width={52}
                      onChange={setPrewarmLeadMinutes}
                    />
                    <span>
                      分钟（如 {subtractMinutesFromHhMm(times[0] ?? '07:00', prewarmLeadMinutes)}
                      ）执行：
                    </span>
                    {savedCombos.length > 0 ? (
                      <select
                        aria-label="预热执行动作"
                        className="sched-inline-select"
                        value={
                          prewarmSteps[0]?.type === 'active-combination'
                            ? `combo:${prewarmSteps[0].combinationId}`
                            : `browse:${prewarmSteps[0]?.type === 'quick-browse' ? prewarmSteps[0].target : 'feed'}`
                        }
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val.startsWith('combo:')) {
                            setPrewarmSteps([
                              {
                                id: prewarmSteps[0]?.id ?? uid(),
                                type: 'active-combination',
                                combinationId: val.slice(6),
                              },
                            ]);
                          } else {
                            setPrewarmSteps([
                              {
                                id: prewarmSteps[0]?.id ?? uid(),
                                type: 'quick-browse',
                                target: val === 'browse:video' ? 'video' : 'feed',
                                durationMinutes: 15,
                              },
                            ]);
                          }
                        }}
                      >
                        <optgroup label="活跃账号组合">
                          {(() => {
                            const ps0 = prewarmSteps[0];
                            if (
                              ps0?.type === 'active-combination' &&
                              !savedCombos.some((c) => c.id === ps0.combinationId)
                            ) {
                              return (
                                <option value={`combo:${ps0.combinationId}`} disabled>
                                  （原组合已删除，请重选）
                                </option>
                              );
                            }
                            return null;
                          })()}
                          {savedCombos.map((c) => (
                            <option key={c.id} value={`combo:${c.id}`}>
                              组合：{c.saved?.name || '未命名组合'}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="快捷浏览">
                          <option value="browse:feed">快捷浏览：Facebook 首页</option>
                          <option value="browse:video">快捷浏览：Reels 短视频</option>
                        </optgroup>
                      </select>
                    ) : (
                      <select
                        aria-label="预热浏览页面"
                        className="sched-inline-select"
                        value={
                          prewarmSteps[0]?.type === 'quick-browse' ? prewarmSteps[0].target : 'feed'
                        }
                        onChange={(e) =>
                          setPrewarmSteps([
                            {
                              id: prewarmSteps[0]?.id ?? uid(),
                              type: 'quick-browse',
                              target: e.target.value === 'video' ? 'video' : 'feed',
                              durationMinutes:
                                prewarmSteps[0]?.type === 'quick-browse'
                                  ? prewarmSteps[0].durationMinutes
                                  : 15,
                            },
                          ])
                        }
                      >
                        <option value="feed">浏览 Facebook 首页</option>
                        <option value="video">浏览 Reels 视频</option>
                      </select>
                    )}

                    {prewarmSteps[0]?.type === 'quick-browse' && (
                      <>
                        <NumericInput
                          ariaLabel="预热浏览分钟数"
                          value={prewarmSteps[0].durationMinutes}
                          min={1}
                          max={120}
                          width={48}
                          onChange={(mins) => {
                            const cur = prewarmSteps[0];
                            if (cur?.type === 'quick-browse') {
                              setPrewarmSteps([{ ...cur, durationMinutes: mins }]);
                            }
                          }}
                        />
                        <span>分钟</span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Block 2: 谁来跑 */}
          <section className="sched-block">
            <div className="sched-block-head">
              <div className="sched-block-head-left">
                <strong>执行账号</strong>
                <span className="sched-count-badge">
                  已选 {matchedTargetCount} 个{carrier === 'browser' ? '窗口' : '模拟器'}
                  {matchedTargetCount > concurrencyCap ? ` · 自动分 ${wavesCount} 批并发` : ''}
                </span>
              </div>
              <div className="sched-mini-seg">
                <button
                  type="button"
                  className={'sched-mini-seg-btn' + (selectorMode === 'groups' ? ' is-active' : '')}
                  onClick={() => setSelectorMode('groups')}
                >
                  按分组
                </button>
                <button
                  type="button"
                  className={
                    'sched-mini-seg-btn' + (selectorMode === 'explicit' ? ' is-active' : '')
                  }
                  onClick={() => setSelectorMode('explicit')}
                >
                  手动选号
                </button>
              </div>
            </div>

            {selectorMode === 'groups' ? (
              activeGroupsPool.length === 0 ? (
                <div className="sched-empty-inline">
                  暂无分组，请切换右侧「手动选号」直接选择账号。
                </div>
              ) : (
                <div className="sched-group-pills">
                  {activeGroupsPool.map((g) => {
                    const checked = groupIds.includes(g.id);
                    const count = activeTargetsPool.filter((t) => t.groupId === g.id).length;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        className={'sched-group-pill' + (checked ? ' is-active' : '')}
                        onClick={() =>
                          setGroupIds((prev) =>
                            prev.includes(g.id) ? prev.filter((x) => x !== g.id) : [...prev, g.id],
                          )
                        }
                      >
                        <span className="sched-group-check">{checked ? '✓' : '+'}</span>
                        <span>{g.name}</span>
                        <em>{count}</em>
                      </button>
                    );
                  })}
                </div>
              )
            ) : (
              <div className="sched-manual-target-box">
                <div className="sched-manual-summary">
                  <span>
                    已勾选 <strong>{matchedTargetCount}</strong> / {activeTargetsPool.length} 个账号
                  </span>
                  <div className="sched-manual-quick">
                    {activeTargetsPool.length > 1 && (
                      <span className="sched-range-picker">
                        <span>区间</span>
                        <NumericInput
                          ariaLabel="起始序号"
                          value={rangeStart}
                          min={1}
                          max={Math.max(1, activeTargetsPool.length)}
                          width={42}
                          onChange={setRangeStart}
                        />
                        <span>-</span>
                        <NumericInput
                          ariaLabel="结束序号"
                          value={rangeEnd}
                          min={1}
                          max={Math.max(1, activeTargetsPool.length)}
                          width={42}
                          onChange={setRangeEnd}
                        />
                        <button
                          type="button"
                          className="sched-link-btn"
                          onClick={() => {
                            const lo = Math.max(1, Math.min(rangeStart, rangeEnd));
                            const hi = Math.min(
                              activeTargetsPool.length,
                              Math.max(rangeStart, rangeEnd),
                            );
                            setTargetIds(activeTargetsPool.slice(lo - 1, hi).map((t) => t.id));
                          }}
                        >
                          套用区间
                        </button>
                      </span>
                    )}
                    <button
                      type="button"
                      className="sched-step-target-btn"
                      onClick={() => setManualPickerOpen((v) => !v)}
                    >
                      {manualPickerOpen ? '收起列表 ▴' : '展开勾选 ▾'}
                    </button>
                  </div>
                </div>

                {manualPickerOpen && (
                  <UnifiedTargetPicker
                    title="选择执行账号"
                    items={activeTargetsPool}
                    selectedIds={targetIds}
                    onChange={setTargetIds}
                    onDone={() => setManualPickerOpen(false)}
                  />
                )}
              </div>
            )}
          </section>

          {/* Block 3: 按顺序做什么 */}
          <section className="sched-block">
            <div className="sched-block-head">
              <div className="sched-block-head-left">
                <strong>执行流程</strong>
                <span className="sched-block-sub">
                  按顺序依次执行 · 预计单号约 {estimatedMainMinutes} 分钟
                </span>
              </div>
              {carrier === 'browser' && (
                <div className="sched-template-links">
                  <button
                    type="button"
                    className="sched-link-btn"
                    onClick={() => {
                      const mid = makeDefaultBrowserStep('page-bumper');
                      setBrowserSteps([
                        { id: uid(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
                        mid,
                        { id: uid(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
                      ]);
                      if (mid.type === 'page-bumper' && mid.pageIds.length === 0) {
                        setExpandedStepId(mid.id);
                      }
                    }}
                  >
                    预设：专页顶贴流
                  </button>
                  {savedCombos[0] && (
                    <button
                      type="button"
                      className="sched-link-btn"
                      onClick={() => {
                        const mid = makeDefaultBrowserStep('group-bumper');
                        setBrowserSteps([
                          {
                            id: uid(),
                            type: 'active-combination',
                            combinationId: savedCombos[0]?.id ?? uid(),
                          },
                          mid,
                          { id: uid(), type: 'quick-browse', target: 'feed', durationMinutes: 1 },
                        ]);
                      }}
                    >
                      预设：先活跃再顶贴
                    </button>
                  )}
                </div>
              )}
            </div>

            {carrier === 'browser' ? (
              <div className="sched-step-list">
                {browserSteps.map((step, idx) => {
                  const summary = describeBrowserStepSummary(step);
                  const isOpen = expandedStepId === step.id;
                  return (
                    <div key={step.id} className={'sched-step-item' + (isOpen ? ' is-open' : '')}>
                      <div className="sched-step-bar">
                        <span className="sched-step-num">{idx + 1}</span>
                        <select
                          aria-label={`第 ${idx + 1} 步动作类型`}
                          className="sched-step-type-select"
                          value={step.type}
                          onChange={(e) => {
                            const nextType = e.target.value as BrowserPipelineStep['type'];
                            const fresh = makeDefaultBrowserStep(nextType);
                            updateBrowserStep(idx, fresh);
                            setExpandedStepId(
                              nextType === 'page-bumper' ||
                                nextType === 'group-bumper' ||
                                nextType === 'group-poster'
                                ? fresh.id
                                : null,
                            );
                          }}
                        >
                          <option value="quick-browse">快捷浏览</option>
                          <option value="page-bumper">专页顶贴</option>
                          <option value="group-bumper">小组顶贴</option>
                          <option value="group-poster">小组发帖</option>
                          <option value="active-combination">活跃账号组合</option>
                        </select>

                        {/* Step inline controls */}
                        <div className="sched-step-inline-body">
                          {step.type === 'quick-browse' && (
                            <>
                              <select
                                aria-label="浏览目标页"
                                className="sched-inline-select"
                                value={step.target}
                                onChange={(e) =>
                                  updateBrowserStep(idx, {
                                    ...step,
                                    target: e.target.value === 'video' ? 'video' : 'feed',
                                  })
                                }
                              >
                                <option value="feed">Facebook 首页</option>
                                <option value="video">Reels 短视频</option>
                              </select>
                              <NumericInput
                                ariaLabel="浏览分钟数"
                                value={step.durationMinutes}
                                min={1}
                                max={120}
                                width={46}
                                onChange={(mins) =>
                                  updateBrowserStep(idx, { ...step, durationMinutes: mins })
                                }
                              />
                              <span className="sched-unit">分钟</span>
                            </>
                          )}

                          {step.type === 'active-combination' &&
                            (savedCombos.length > 0 ? (
                              <select
                                aria-label="选择活跃组合"
                                className="sched-inline-select"
                                value={step.combinationId}
                                onChange={(e) =>
                                  updateBrowserStep(idx, {
                                    ...step,
                                    combinationId: e.target.value,
                                  })
                                }
                              >
                                {!savedCombos.some((c) => c.id === step.combinationId) && (
                                  <option value={step.combinationId} disabled>
                                    （原组合已删除，请重选）
                                  </option>
                                )}
                                {savedCombos.map((c) => (
                                  <option key={c.id} value={c.id}>
                                    {c.saved?.name || '未命名组合'}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="sched-step-warn">
                                请先在「活跃账号」保存一个组合
                              </span>
                            ))}

                          {summary.hasDrawer && (
                            <button
                              type="button"
                              className={
                                'sched-step-target-btn' +
                                (summary.needsAttention ? ' is-attention' : '') +
                                (isOpen ? ' is-open' : '')
                              }
                              onClick={() => setExpandedStepId(isOpen ? null : step.id)}
                            >
                              {summary.text} {isOpen ? '▴' : '▾'}
                            </button>
                          )}

                          {step.type === 'group-poster' && (
                            <>
                              <span className="sched-unit">单号发</span>
                              <NumericInput
                                ariaLabel="单号发帖小组数"
                                value={step.maxGroupsPerProfile}
                                min={1}
                                max={50}
                                width={42}
                                onChange={(n) =>
                                  updateBrowserStep(idx, { ...step, maxGroupsPerProfile: n })
                                }
                              />
                              <span className="sched-unit">组</span>
                            </>
                          )}
                        </div>

                        <div className="sched-step-ops">
                          {browserSteps.length > 1 && (
                            <>
                              <button
                                type="button"
                                className="sched-icon-btn"
                                title="上移"
                                disabled={idx === 0}
                                onClick={() => setBrowserSteps((prev) => moveStep(prev, idx, -1))}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="sched-icon-btn"
                                title="下移"
                                disabled={idx === browserSteps.length - 1}
                                onClick={() => setBrowserSteps((prev) => moveStep(prev, idx, 1))}
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                className="sched-icon-btn is-danger"
                                title="移除此步"
                                onClick={() =>
                                  setBrowserSteps((prev) => prev.filter((_, i) => i !== idx))
                                }
                              >
                                ×
                              </button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Progressive disclosure drawer */}
                      {isOpen && step.type === 'page-bumper' && (
                        <UnifiedTargetPicker
                          title="选择目标专页"
                          listKind="bumper_pages"
                          showCodeSub
                          items={pageTargetItems}
                          selectedIds={step.pageIds}
                          onChange={(ids) => updateBrowserStep(idx, { ...step, pageIds: ids })}
                          onDone={() => setExpandedStepId(null)}
                        />
                      )}

                      {isOpen && step.type === 'group-bumper' && (
                        <div className="sched-dual-drawers">
                          <UnifiedTargetPicker
                            title="1. 选择目标小组"
                            listKind="shared_groups"
                            showCodeSub
                            items={groupTargetItems}
                            selectedIds={step.groupIds}
                            onChange={(ids) => updateBrowserStep(idx, { ...step, groupIds: ids })}
                          />
                          <UnifiedTargetPicker
                            title="2. 选择识别主页"
                            listKind="bumper_pages"
                            showCodeSub
                            items={pageTargetItems}
                            selectedIds={step.pageIds}
                            onChange={(ids) => updateBrowserStep(idx, { ...step, pageIds: ids })}
                            onDone={() => setExpandedStepId(null)}
                          />
                        </div>
                      )}

                      {isOpen && step.type === 'group-poster' && (
                        <div className="sched-dual-drawers">
                          <UnifiedTargetPicker
                            title="1. 选择发帖素材"
                            items={posterMaterialItems}
                            selectedIds={step.materialIds}
                            onChange={(ids) =>
                              updateBrowserStep(idx, { ...step, materialIds: ids })
                            }
                          />
                          <UnifiedTargetPicker
                            title="2. 选择目标小组"
                            listKind="shared_groups"
                            showCodeSub
                            items={groupTargetItems}
                            selectedIds={step.groupIds}
                            onChange={(ids) => updateBrowserStep(idx, { ...step, groupIds: ids })}
                            onDone={() => setExpandedStepId(null)}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}

                {browserSteps.length < 12 && (
                  <div className="sched-add-step-row">
                    <span>+ 添加步骤：</span>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() =>
                        setBrowserSteps((prev) => [...prev, makeDefaultBrowserStep('quick-browse')])
                      }
                    >
                      快捷浏览
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() => {
                        const s = makeDefaultBrowserStep('page-bumper');
                        setBrowserSteps((prev) => [...prev, s]);
                        if (s.type === 'page-bumper' && s.pageIds.length === 0)
                          setExpandedStepId(s.id);
                      }}
                    >
                      专页顶贴
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() => {
                        const s = makeDefaultBrowserStep('group-bumper');
                        setBrowserSteps((prev) => [...prev, s]);
                        setExpandedStepId(s.id);
                      }}
                    >
                      小组顶贴
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() => {
                        const s = makeDefaultBrowserStep('group-poster');
                        setBrowserSteps((prev) => [...prev, s]);
                        setExpandedStepId(s.id);
                      }}
                    >
                      小组发帖
                    </button>
                    {savedCombos.length > 0 && (
                      <button
                        type="button"
                        className="sched-add-chip"
                        onClick={() =>
                          setBrowserSteps((prev) => [
                            ...prev,
                            makeDefaultBrowserStep('active-combination'),
                          ])
                        }
                      >
                        活跃组合
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="sched-step-list">
                {bsSteps.map((step, idx) => {
                  const isOpen = expandedStepId === step.id;
                  const updateBsStep = (nextStep: BluestacksPipelineStep) =>
                    setBsSteps((prev) => prev.map((s, i) => (i === idx ? nextStep : s)));

                  let hasDrawer = false;
                  let needsTarget = false;
                  let summaryLabel = '';
                  if (step.type === 'bluestacks-page-bumper') {
                    hasDrawer = true;
                    needsTarget = step.pageIds.length === 0;
                    summaryLabel =
                      step.pageIds.length > 0
                        ? `已选 ${step.pageIds.length} 个专页`
                        : `选择专页 (0/${pageTargetItems.length})`;
                  } else if (step.type === 'bluestacks-group-bumper') {
                    hasDrawer = true;
                    needsTarget = step.groupIds.length === 0 || step.pageIds.length === 0;
                    summaryLabel = needsTarget
                      ? `选择小组(${step.groupIds.length})与主页(${step.pageIds.length})`
                      : `已选 ${step.groupIds.length} 组 · ${step.pageIds.length} 主页`;
                  } else if (step.type === 'bluestacks-group-poster') {
                    hasDrawer = true;
                    needsTarget =
                      step.materialIds.length === 0 ||
                      (step.groupIds.length === 0 && !step.postToTimeline);
                    summaryLabel = needsTarget
                      ? `选择素材(${step.materialIds.length})与小组(${step.groupIds.length})`
                      : `已选 ${step.materialIds.length} 帖 · ${step.groupIds.length} 组${step.postToTimeline ? ' +时间线' : ''}`;
                  } else if (step.type === 'bluestacks-group-inviter') {
                    hasDrawer = true;
                    needsTarget = step.groupIds.length === 0;
                    summaryLabel = needsTarget
                      ? `选择小组 (0/${groupTargetItems.length})`
                      : `已选 ${step.groupIds.length} 个小组`;
                  }

                  return (
                    <div key={step.id} className={'sched-step-item' + (isOpen ? ' is-open' : '')}>
                      <div className="sched-step-bar">
                        <span className="sched-step-num">{idx + 1}</span>
                        <select
                          aria-label={`第 ${idx + 1} 步蓝蝶动作`}
                          className="sched-step-type-select"
                          value={step.type}
                          onChange={(e) => {
                            const nextType = e.target.value as BluestacksPipelineStep['type'];
                            const fresh = makeDefaultBsStep(nextType);
                            setBsSteps((prev) => prev.map((s, i) => (i === idx ? fresh : s)));
                            setExpandedStepId(
                              nextType === 'bluestacks-health-check' ||
                                nextType === 'bluestacks-quick-browse' ||
                                nextType === 'bluestacks-active-combination'
                                ? null
                                : fresh.id,
                            );
                          }}
                        >
                          <option value="bluestacks-health-check">蓝蝶健康体检</option>
                          <option value="bluestacks-quick-browse">蓝蝶快捷浏览</option>
                          <option value="bluestacks-active-combination">蓝蝶活跃组合</option>
                          <option value="bluestacks-group-poster">蓝蝶小组发帖</option>
                          <option value="bluestacks-page-bumper">蓝蝶专页顶贴</option>
                          <option value="bluestacks-group-bumper">蓝蝶小组顶贴</option>
                          <option value="bluestacks-group-inviter">蓝蝶小组邀人</option>
                        </select>

                        <div className="sched-step-inline-body">
                          {step.type === 'bluestacks-health-check' && (
                            <label
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                                fontSize: 12,
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={Boolean(step.autoInstallApk)}
                                onChange={(e) =>
                                  updateBsStep({ ...step, autoInstallApk: e.target.checked })
                                }
                              />
                              <span>缺 FB Lite 时自动装包修复</span>
                            </label>
                          )}

                          {step.type === 'bluestacks-quick-browse' && (
                            <>
                              <select
                                aria-label="蓝蝶浏览页面"
                                className="sched-inline-select"
                                value={step.target}
                                onChange={(e) =>
                                  updateBsStep({
                                    ...step,
                                    target: e.target.value === 'video' ? 'video' : 'feed',
                                  })
                                }
                              >
                                <option value="feed">首页 Feed</option>
                                <option value="video">Reels 短视频</option>
                              </select>
                              <NumericInput
                                ariaLabel="蓝蝶浏览分钟数"
                                value={step.durationMinutes}
                                min={1}
                                max={60}
                                width={48}
                                onChange={(n) => updateBsStep({ ...step, durationMinutes: n })}
                              />
                              <span className="sched-unit">分钟</span>
                            </>
                          )}

                          {step.type === 'bluestacks-active-combination' && (
                            <select
                              aria-label="选择蓝蝶活跃组合"
                              className="sched-inline-select"
                              value={step.combinationId}
                              onChange={(e) =>
                                updateBsStep({ ...step, combinationId: e.target.value })
                              }
                            >
                              {savedCombos.length === 0 ? (
                                <option value="">请先在活跃账号创建组合</option>
                              ) : (
                                <>
                                  {!savedCombos.some((c) => c.id === step.combinationId) && (
                                    <option value={step.combinationId} disabled>
                                      （原组合已删除，请重选）
                                    </option>
                                  )}
                                  {savedCombos.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.saved?.name || '未命名组合'}
                                    </option>
                                  ))}
                                </>
                              )}
                            </select>
                          )}

                          {hasDrawer && (
                            <button
                              type="button"
                              className={
                                'sched-step-target-btn' +
                                (needsTarget ? ' is-attention' : '') +
                                (isOpen ? ' is-open' : '')
                              }
                              onClick={() => setExpandedStepId(isOpen ? null : step.id)}
                            >
                              {summaryLabel} {isOpen ? '▴' : '▾'}
                            </button>
                          )}

                          {step.type === 'bluestacks-group-poster' && (
                            <>
                              <span className="sched-unit">单号发</span>
                              <NumericInput
                                ariaLabel="单号蓝蝶发帖小组数"
                                value={step.maxGroupsPerProfile}
                                min={1}
                                max={50}
                                width={42}
                                onChange={(n) => updateBsStep({ ...step, maxGroupsPerProfile: n })}
                              />
                              <span className="sched-unit">组</span>
                              <label
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  fontSize: 12,
                                  marginLeft: 6,
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={Boolean(step.postToTimeline)}
                                  onChange={(e) =>
                                    updateBsStep({ ...step, postToTimeline: e.target.checked })
                                  }
                                />
                                <span>发时间线</span>
                              </label>
                            </>
                          )}

                          {step.type === 'bluestacks-group-inviter' && (
                            <>
                              <span className="sched-unit">每群邀</span>
                              <NumericInput
                                ariaLabel="每群邀请人数"
                                value={step.invitesPerGroup}
                                min={1}
                                max={50}
                                width={42}
                                onChange={(n) => updateBsStep({ ...step, invitesPerGroup: n })}
                              />
                              <span className="sched-unit">人</span>
                            </>
                          )}
                        </div>

                        <div className="sched-step-ops">
                          <button
                            type="button"
                            className="sched-icon-btn"
                            title="上移此步"
                            aria-label="上移此步"
                            disabled={idx === 0}
                            onClick={() => setBsSteps((prev) => moveStep(prev, idx, -1))}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="sched-icon-btn"
                            title="下移此步"
                            aria-label="下移此步"
                            disabled={idx === bsSteps.length - 1}
                            onClick={() => setBsSteps((prev) => moveStep(prev, idx, 1))}
                          >
                            ↓
                          </button>
                          {bsSteps.length > 1 && (
                            <button
                              type="button"
                              className="sched-icon-btn is-danger"
                              title="移除此步"
                              onClick={() => setBsSteps((prev) => prev.filter((_, i) => i !== idx))}
                            >
                              ×
                            </button>
                          )}
                        </div>
                      </div>

                      {isOpen && step.type === 'bluestacks-page-bumper' && (
                        <UnifiedTargetPicker
                          title="选择蓝蝶顶贴专页"
                          listKind="bumper_pages"
                          showCodeSub
                          items={pageTargetItems}
                          selectedIds={step.pageIds}
                          onChange={(ids) => updateBsStep({ ...step, pageIds: ids })}
                          onDone={() => setExpandedStepId(null)}
                        />
                      )}

                      {isOpen && step.type === 'bluestacks-group-bumper' && (
                        <div className="sched-dual-drawers">
                          <UnifiedTargetPicker
                            title="1. 选择目标小组"
                            listKind="shared_groups"
                            showCodeSub
                            items={groupTargetItems}
                            selectedIds={step.groupIds}
                            onChange={(ids) => updateBsStep({ ...step, groupIds: ids })}
                          />
                          <UnifiedTargetPicker
                            title="2. 选择识别主页"
                            listKind="bumper_pages"
                            showCodeSub
                            items={pageTargetItems}
                            selectedIds={step.pageIds}
                            onChange={(ids) => updateBsStep({ ...step, pageIds: ids })}
                            onDone={() => setExpandedStepId(null)}
                          />
                        </div>
                      )}

                      {isOpen && step.type === 'bluestacks-group-poster' && (
                        <div className="sched-dual-drawers">
                          <UnifiedTargetPicker
                            title="1. 选择发帖素材"
                            items={posterMaterialItems}
                            selectedIds={step.materialIds}
                            onChange={(ids) => updateBsStep({ ...step, materialIds: ids })}
                          />
                          <UnifiedTargetPicker
                            title="2. 选择目标小组"
                            listKind="shared_groups"
                            showCodeSub
                            items={groupTargetItems}
                            selectedIds={step.groupIds}
                            onChange={(ids) => updateBsStep({ ...step, groupIds: ids })}
                            onDone={() => setExpandedStepId(null)}
                          />
                        </div>
                      )}

                      {isOpen && step.type === 'bluestacks-group-inviter' && (
                        <UnifiedTargetPicker
                          title="选择邀人目标小组"
                          listKind="shared_groups"
                          showCodeSub
                          items={groupTargetItems}
                          selectedIds={step.groupIds}
                          onChange={(ids) => updateBsStep({ ...step, groupIds: ids })}
                          onDone={() => setExpandedStepId(null)}
                        />
                      )}
                    </div>
                  );
                })}

                {bsSteps.length < 8 && (
                  <div className="sched-add-step-row">
                    <span>+ 添加步骤：</span>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() =>
                        setBsSteps((prev) => [
                          ...prev,
                          makeDefaultBsStep('bluestacks-health-check'),
                        ])
                      }
                    >
                      蓝蝶健康体检
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() =>
                        setBsSteps((prev) => [
                          ...prev,
                          makeDefaultBsStep('bluestacks-quick-browse'),
                        ])
                      }
                    >
                      蓝蝶快捷浏览
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() => {
                        const s = makeDefaultBsStep('bluestacks-page-bumper');
                        setBsSteps((prev) => [...prev, s]);
                        setExpandedStepId(s.id);
                      }}
                    >
                      蓝蝶专页顶贴
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() => {
                        const s = makeDefaultBsStep('bluestacks-group-bumper');
                        setBsSteps((prev) => [...prev, s]);
                        setExpandedStepId(s.id);
                      }}
                    >
                      蓝蝶小组顶贴
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() => {
                        const s = makeDefaultBsStep('bluestacks-group-poster');
                        setBsSteps((prev) => [...prev, s]);
                        setExpandedStepId(s.id);
                      }}
                    >
                      蓝蝶小组发帖
                    </button>
                    <button
                      type="button"
                      className="sched-add-chip"
                      onClick={() => {
                        const s = makeDefaultBsStep('bluestacks-group-inviter');
                        setBsSteps((prev) => [...prev, s]);
                        setExpandedStepId(s.id);
                      }}
                    >
                      蓝蝶小组邀人
                    </button>
                    {savedCombos.length > 0 && (
                      <button
                        type="button"
                        className="sched-add-chip"
                        onClick={() =>
                          setBsSteps((prev) => [
                            ...prev,
                            makeDefaultBsStep('bluestacks-active-combination'),
                          ])
                        }
                      >
                        蓝蝶活跃组合
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Collapsible Advanced Options */}
          <details className="sched-adv-details">
            <summary>
              <span>高级选项</span>
              <small>
                {closeWindowOnFinish ? '跑完自动关窗' : '跑完保留窗口'} ·{' '}
                {skipAbnormalAccounts ? '异常号自动跳过' : '不跳过异常号'} · 智能防卡死保护
              </small>
            </summary>
            <div className="sched-adv-body">
              <label className="sched-check-row">
                <input
                  type="checkbox"
                  checked={closeWindowOnFinish}
                  onChange={(e) => setCloseWindowOnFinish(e.target.checked)}
                />
                <span>
                  跑完、封号或超时后自动关闭窗口，立刻释放并发槽位给下一轮账号（强烈建议开启）
                </span>
              </label>
              <label className="sched-check-row">
                <input
                  type="checkbox"
                  checked={skipAbnormalAccounts}
                  onChange={(e) => setSkipAbnormalAccounts(e.target.checked)}
                />
                <span>自动跳过已标记为封号 / 需验证 / 退出登录的异常账号</span>
              </label>

              <div className="sched-adv-grid">
                <label className="sched-adv-field">
                  <span>随机延后浮动（0–30 分钟）</span>
                  <NumericInput
                    ariaLabel="随机延后浮动分钟"
                    value={jitterMinutes}
                    min={0}
                    max={30}
                    width={64}
                    onChange={setJitterMinutes}
                  />
                </label>
                <label className="sched-adv-field">
                  <span>断电/重启补跑窗口（分钟）</span>
                  <NumericInput
                    ariaLabel="错过补跑有效窗分钟"
                    value={misfireGraceMinutes}
                    min={5}
                    max={360}
                    width={64}
                    onChange={setMisfireGraceMinutes}
                  />
                </label>
                <label className="sched-adv-field">
                  <span>单号总时长安全兜底</span>
                  <div className="sched-adv-inline">
                    <select
                      value={safetyMode}
                      onChange={(e) =>
                        setSafetyMode(e.target.value === 'custom' ? 'custom' : 'auto')
                      }
                    >
                      <option value="auto">智能自动推算</option>
                      <option value="custom">手动指定上限</option>
                    </select>
                    {safetyMode === 'custom' && (
                      <>
                        <NumericInput
                          ariaLabel="自定义单号安全分钟上限"
                          value={customSafetyMinutes}
                          min={10}
                          max={720}
                          width={60}
                          onChange={setCustomSafetyMinutes}
                        />
                        <span>分钟</span>
                      </>
                    )}
                  </div>
                </label>
              </div>
            </div>
          </details>

          {errorText && (
            <div className="sched-error-alert" role="alert">
              {errorText}
            </div>
          )}
        </div>

        <footer className="sched-modal-footer">
          <span className="sched-footer-hint">
            当前全局并发：{concurrencyCap} 窗（可在顶部工具栏随时调整）
          </span>
          <div className="sched-footer-btns">
            <button type="button" className="btn" disabled={saving} onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving}
              onClick={() => void handleSubmit()}
            >
              {saving ? '保存中…' : '保存排班'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
