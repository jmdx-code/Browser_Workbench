import { DateTime } from 'luxon';
import type {
  AutoRunItemStatus,
  AutoSchedule,
  AutoScheduleCarrier,
  BluestacksPipelineStep,
  BrowserPipelineStep,
  SaveAutoScheduleInput,
} from '../shared/auto-scheduler.js';
import type { SavedCombination, Step } from '../shared/contracts.js';
import type { BumperTarget } from '../shared/group-bumper.js';
import type { InviterGroupRow } from '../shared/group-inviter.js';
import type { PosterMaterial } from '../shared/group-poster.js';
import type { UnifiedPickerItem } from './modules/shared/unified-target-picker.js';
export const MINI_SEG = 'inline-flex rounded-lg p-0.5 bg-[var(--surface-2)]';
export const MINI_SEG_BTN = (active: boolean) =>
  `rounded-md text-xs font-medium cursor-pointer border-0 px-2.5 py-1 transition-colors ${
    active
      ? 'bg-[var(--surface)] text-[var(--text)] shadow-xs'
      : 'bg-transparent text-[var(--text-2)] hover:bg-slate-900/5 hover:text-[var(--text)]'
  }`;
export const LINK_BTN =
  'text-xs cursor-pointer rounded-[5px] border-0 bg-transparent px-1.5 py-0.5 text-[var(--brand)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand-hover)]';
export const ADD_CHIP =
  'rounded-lg text-xs cursor-pointer bg-transparent px-[9px] py-1 text-[var(--text-2)] border border-dashed border-[var(--line-strong)] hover:border-[var(--brand)] hover:text-[var(--brand)] hover:bg-[var(--brand-soft)]';
export const CARD_BOX =
  'flex flex-col gap-2.5 rounded-[var(--r-md)] border border-[var(--line)] px-3.5 py-3';
export const asIds = (v: unknown): readonly string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const toPicker = (
  id: string,
  name: string | undefined,
  x: { avatarUrl?: string | null; folderId?: string | null; sortOrder?: number },
): UnifiedPickerItem => ({
  id,
  name: name || id,
  sub: id,
  avatarUrl: x.avatarUrl,
  folderId: x.folderId,
  sortOrder: x.sortOrder,
});
export const mapTargetItems = (list: readonly BumperTarget[]): UnifiedPickerItem[] =>
  list.map((x) => toPicker(x.id, x.name, x));
export function mergeInviterAndSharedGroups(
  inviterGroups: readonly InviterGroupRow[] | undefined,
  sharedGroups: readonly BumperTarget[],
): UnifiedPickerItem[] {
  const map = new Map<string, UnifiedPickerItem>();
  for (const g of inviterGroups ?? []) map.set(g.groupId, toPicker(g.groupId, g.groupName, g));
  for (const g of sharedGroups) if (!map.has(g.id)) map.set(g.id, toPicker(g.id, g.name, g));
  return [...map.values()];
}
export const mapPosterMaterialItems = (
  posterMaterials: readonly PosterMaterial[],
): UnifiedPickerItem[] =>
  posterMaterials.map((m, idx) => ({
    id: m.id,
    name: `${idx + 1}. ${m.caption.trim().slice(0, 60) || '[媒体贴文]'}`,
    avatarUrl:
      m.mediaKind === 'image' && m.cacheStatus === 'ready'
        ? `/api/workspace/group-poster/materials/media?id=${encodeURIComponent(m.id)}&v=${m.updatedAt ?? 0}`
        : m.hasThumbnail
          ? `/api/workspace/group-poster/materials/thumbnail?id=${encodeURIComponent(m.id)}&v=${m.updatedAt ?? 0}`
          : null,
    badge:
      m.mediaKind === 'image'
        ? '图片'
        : m.mediaKind === 'video'
          ? '视频'
          : m.background === 'color'
            ? '彩贴'
            : '纯文',
  }));
export const buildOncePresets = (zone: string) => {
  const at =
    (hour: number, addDays = 0) =>
    () => {
      const b = DateTime.now()
        .setZone(zone)
        .plus({ days: addDays })
        .set({ hour, minute: 0, second: 0, millisecond: 0 });
      return (addDays || b.toMillis() > Date.now() ? b : b.plus({ days: 1 })).toMillis();
    };
  return [
    { label: '30分钟后', ms: () => Date.now() + 30 * 60_000 },
    { label: '1小时后', ms: () => Date.now() + 60 * 60_000 },
    { label: '今晚 20:00', ms: at(20) },
    { label: '明早 09:00', ms: at(9, 1) },
  ];
};
export type AnyStep = BrowserPipelineStep | BluestacksPipelineStep;
export type StepMetaItem = { type: AnyStep['type']; label: string; needsDrawer?: boolean };
export const SMART_TIME_SLOTS = [
  '09:00',
  '14:00',
  '20:00',
  '11:30',
  '17:00',
  '22:00',
  '07:30',
  '12:30',
] as const;
export const BROWSER_STEP_META: readonly StepMetaItem[] = [
  { type: 'active-combination', label: '活跃组合' },
  { type: 'group-poster', label: '小组发帖', needsDrawer: true },
  { type: 'group-bumper', label: '小组顶贴', needsDrawer: true },
  { type: 'page-bumper', label: '专页顶贴', needsDrawer: true },
  { type: 'group-inviter', label: '小组邀人', needsDrawer: true },
];
export const BS_STEP_META: readonly StepMetaItem[] = [
  { type: 'bluestacks-health-check', label: '蓝蝶体检' },
  { type: 'bluestacks-active-combination', label: '蓝蝶活跃' },
  { type: 'bluestacks-group-poster', label: '蓝蝶发帖', needsDrawer: true },
  { type: 'bluestacks-group-bumper', label: '蓝蝶小组顶贴', needsDrawer: true },
  { type: 'bluestacks-page-bumper', label: '蓝蝶专页顶贴', needsDrawer: true },
  { type: 'bluestacks-group-inviter', label: '蓝蝶邀人', needsDrawer: true },
];
export const uid = () => crypto.randomUUID();
export const defaultOnceTimestamp = (nowMs = Date.now()) =>
  Math.ceil((nowMs + 30 * 60_000) / 60_000) * 60_000;
export function splitMillisInZone(ms: number, zone: string) {
  const dt = DateTime.fromMillis(ms).setZone(zone);
  return dt.isValid
    ? { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm') }
    : { date: DateTime.now().toFormat('yyyy-MM-dd'), time: '09:00' };
}
export function combineDateTimeInZone(dateStr: string, timeStr: string, zone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(timeStr))
    return null;
  const dt = DateTime.fromISO(`${dateStr}T${timeStr}:00`, { zone });
  return dt.isValid ? dt.toMillis() : null;
}
const isBsSupportedStep = (s: Step) =>
  s.type === 'feed' ||
  s.type === 'video' ||
  s.type === 'marketplace' ||
  (s.type === 'friends' && s.friendAction !== 'add_suggested');
export const isUnsupportedOnBluestacks = (combo: SavedCombination) => {
  const steps = combo.saved?.steps ?? [];
  return steps.length === 0 || !steps.some(isBsSupportedStep);
};
export function createStepFactory(deps: {
  defaultComboId: string | undefined;
  sharedGroups: readonly BumperTarget[];
  inviterGroups: readonly UnifiedPickerItem[];
  sharedPages: readonly BumperTarget[];
  posterMaterials: readonly PosterMaterial[];
}) {
  const allGroups = deps.sharedGroups.map((g) => g.id),
    allInviter = deps.inviterGroups.map((g) => g.id),
    allPages = deps.sharedPages.map((p) => p.id),
    selMats = deps.posterMaterials.filter((m) => m.selected).map((m) => m.id),
    mats = selMats.length ? selMats : deps.posterMaterials.map((m) => m.id),
    combinationId = deps.defaultComboId ?? '';
  return (type: AnyStep['type']): AnyStep => {
    const id = uid();
    switch (type) {
      case 'active-combination':
      case 'bluestacks-active-combination':
        return { id, type, combinationId };
      case 'group-bumper':
      case 'bluestacks-group-bumper':
        return { id, type, groupIds: allGroups, pageIds: allPages };
      case 'page-bumper':
      case 'bluestacks-page-bumper':
        return { id, type, pageIds: allPages };
      case 'group-poster':
      case 'bluestacks-group-poster':
        return {
          id,
          type,
          materialIds: mats,
          groupIds: allGroups,
          maxGroupsPerProfile: 3,
          materialsPerGroup: 1,
        };
      case 'group-inviter':
      case 'bluestacks-group-inviter':
        return {
          id,
          type,
          groupIds: type === 'group-inviter' ? allInviter : allGroups,
          invitesPerGroup: 5,
        };
      case 'bluestacks-health-check':
        return { id, type, autoInstallApk: false };
    }
  };
}
export function describeStepDrawer(
  step: AnyStep,
  totals: { pages: number; groups: number; inviterGroups: number },
): { text: string; needsAttention: boolean } | null {
  if (step.type === 'page-bumper' || step.type === 'bluestacks-page-bumper') {
    const n = step.pageIds.length;
    return {
      text: !n
        ? '选专页'
        : n === totals.pages && totals.pages > 0
          ? `全部专页 (${n})`
          : `${n} 专页`,
      needsAttention: !n,
    };
  }
  if (step.type === 'group-bumper' || step.type === 'bluestacks-group-bumper') {
    const g = asIds(step.groupIds).length,
      p = step.pageIds.length;
    return { text: !g || !p ? '选小组与主页' : `${g} 组 · ${p} 页`, needsAttention: !g || !p };
  }
  if (step.type === 'group-poster' || step.type === 'bluestacks-group-poster') {
    const m = step.materialIds.length,
      g = step.groupIds.length,
      needsGroup = step.type === 'group-poster' || !step.postToTimeline;
    return {
      text:
        !m || (needsGroup && !g)
          ? '选素材与小组'
          : step.type === 'bluestacks-group-poster' && step.postToTimeline && !g
            ? `${m} 素材 · 时间线`
            : `${m} 素材 · ${g} 组`,
      needsAttention: !m || (needsGroup && !g),
    };
  }
  if (step.type === 'group-inviter' || step.type === 'bluestacks-group-inviter') {
    const g = step.groupIds.length,
      total = step.type === 'bluestacks-group-inviter' ? totals.groups : totals.inviterGroups;
    return {
      text: !g ? '选小组' : g === total && total > 0 ? `全部小组 (${g})` : `${g} 小组`,
      needsAttention: !g,
    };
  }
  return null;
}
export function validateSteps(
  steps: readonly AnyStep[],
  savedCombos: readonly SavedCombination[],
): { stepId: string; message: string; openDrawer?: boolean } | null {
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (!s) continue;
    const lbl = `第 ${i + 1} 步`;
    if (s.type === 'active-combination' || s.type === 'bluestacks-active-combination') {
      const c = savedCombos.find((x) => x.id === s.combinationId);
      if (!c) return { stepId: s.id, message: `${lbl}请选择有效的活跃组合` };
      if (c.saved?.loop.mode === 'until-stopped')
        return { stepId: s.id, message: `${lbl}不能使用「无限循环」组合` };
      if (s.type === 'bluestacks-active-combination' && isUnsupportedOnBluestacks(c)) {
        const hasAddFriend = c.saved?.steps.some(
          (st) => st.type === 'friends' && st.friendAction === 'add_suggested',
        );
        return {
          stepId: s.id,
          message: hasAddFriend
            ? `${lbl}所选组合仅含「加推荐好友」，暂不支持蓝蝶`
            : `${lbl}所选组合仅含仅浏览器支持的步骤（发帖/快拍），暂不支持蓝蝶`,
        };
      }
    } else if (s.type === 'group-bumper' || s.type === 'bluestacks-group-bumper') {
      if (!asIds(s.groupIds).length || !s.pageIds.length)
        return {
          stepId: s.id,
          message: `${lbl}请选择至少 1 个目标小组和 1 个识别主页`,
          openDrawer: true,
        };
    } else if (
      (s.type === 'page-bumper' || s.type === 'bluestacks-page-bumper') &&
      !s.pageIds.length
    ) {
      return { stepId: s.id, message: `${lbl}请选择至少 1 个目标专页`, openDrawer: true };
    } else if (s.type === 'group-poster' || s.type === 'bluestacks-group-poster') {
      if (!s.materialIds.length)
        return { stepId: s.id, message: `${lbl}请至少选择 1 条发帖素材`, openDrawer: true };
      if (!s.groupIds.length && (s.type === 'group-poster' || !s.postToTimeline))
        return { stepId: s.id, message: `${lbl}请至少选择 1 个目标小组`, openDrawer: true };
    } else if (
      (s.type === 'group-inviter' || s.type === 'bluestacks-group-inviter') &&
      !s.groupIds.length
    ) {
      return { stepId: s.id, message: `${lbl}请至少选择 1 个目标小组`, openDrawer: true };
    }
  }
  return null;
}
export function moveItem<T>(list: readonly T[], index: number, dir: -1 | 1): T[] {
  const target = index + dir;
  if (target < 0 || target >= list.length) return [...list];
  const copy = [...list],
    [item] = copy.splice(index, 1);
  if (item !== undefined) copy.splice(target, 0, item);
  return copy;
}
export const ITEM_STATUS_BADGE: Record<AutoRunItemStatus, { label: string; cls: string }> = {
  running: { label: '运行中', cls: 'pill pill-run' },
  queued: { label: '排队', cls: 'pill pill-idle' },
  completed: { label: '完成', cls: 'pill pill-ok' },
  soft_warning: { label: '受限收尾', cls: 'pill pill-warn' },
  hard_blocked: { label: '账号异常', cls: 'pill pill-err' },
  watchdog_timeout: { label: '超时回收', cls: 'pill pill-warn' },
  skipped: { label: '跳过', cls: 'pill pill-idle' },
  stopped: { label: '已停', cls: 'pill pill-idle' },
};
export const isAbnormalRunItem = (s: AutoRunItemStatus) =>
  s === 'hard_blocked' || s === 'watchdog_timeout' || s === 'soft_warning';
export function formatRunDuration(startedAt: number, finishedAt: number | null): string {
  if (!finishedAt || finishedAt <= startedAt) return '';
  const sec = Math.max(1, Math.round((finishedAt - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60),
    s = sec % 60;
  return m < 60 ? (s > 0 ? `${m}m${s}s` : `${m}m`) : `${Math.floor(m / 60)}h${m % 60}m`;
}
export function buildAutoSchedulePayload(opts: {
  initial: AutoSchedule | null;
  name: string;
  enabled: boolean;
  carrier: AutoScheduleCarrier;
  selectorMode: 'groups' | 'explicit';
  liveGroups: string[];
  liveTargets: string[];
  triggerMode: 'weekly' | 'once';
  onceAtMs: number | null;
  weekdays: number[];
  times: string[];
  timeZone: string;
  closeWindowOnFinish: boolean;
  browserSteps: BrowserPipelineStep[];
  bsSteps: BluestacksPipelineStep[];
}): SaveAutoScheduleInput {
  const { initial, triggerMode, carrier } = opts;
  const base = {
    ...(initial ? { id: initial.id } : {}),
    name: opts.name,
    enabled: opts.enabled,
    targetSelector: {
      mode: opts.selectorMode,
      groupIds: opts.selectorMode === 'groups' ? opts.liveGroups : [],
      targetIds: opts.selectorMode === 'explicit' ? opts.liveTargets : [],
      skipAbnormalAccounts: initial?.targetSelector.skipAbnormalAccounts ?? true,
    },
    trigger: {
      mode: triggerMode,
      onceAt: triggerMode === 'once' ? opts.onceAtMs : null,
      weekdays: opts.weekdays.length > 0 ? opts.weekdays : [1, 2, 3, 4, 5, 6, 7],
      times: opts.times.length > 0 ? [...opts.times].sort() : ['09:00'],
      timeZone: opts.timeZone,
      misfireGraceMinutes: initial?.trigger.misfireGraceMinutes ?? 120,
    },
    closeWindowOnFinish: opts.closeWindowOnFinish,
    maxSafetyMinutesPerTarget: initial?.maxSafetyMinutesPerTarget ?? null,
  };
  return carrier === 'browser'
    ? { ...base, carrier: 'browser', steps: opts.browserSteps }
    : { ...base, carrier: 'bluestacks', steps: opts.bsSteps };
}
