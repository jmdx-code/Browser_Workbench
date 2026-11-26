import type { z } from 'zod';
import type { Combination, Step } from '../../shared/contracts.js';
import type { Progress, TaskCommand, TaskStepBudget } from '../../shared/task-contracts.js';

export type FeatureModuleId =
  | 'auto-scheduler'
  | 'active-accounts'
  | 'group-inviter'
  | 'group-bumper'
  | 'page-bumper'
  | 'group-poster'
  | 'sheets-groups'
  | 'sheets-pages'
  | 'sheets-schedule'
  | 'sheets-records'
  | 'bluestacks-active'
  | 'bluestacks-group-poster'
  | 'bluestacks-group-bumper'
  | 'bluestacks-page-bumper'
  | 'bluestacks-group-inviter'
  | 'window-layout'
  | 'records';

export type SheetsModuleId =
  'sheets-schedule' | 'sheets-records' | 'sheets-groups' | 'sheets-pages';

export type StepBudget = z.infer<typeof TaskStepBudget>;

export interface ProfileActivityDescriptor {
  moduleId: FeatureModuleId;
  moduleLabel: string;
  running: boolean;
  tone: 'run' | 'ok' | 'warn' | 'err' | 'idle' | 'queue' | 'pause';
  text: string;
  tooltipLines: string[];
  className?: string | undefined;
  progressView?:
    | {
        type: Step['type'];
        friendAction?: 'accept' | 'add_suggested' | undefined;
        progress: Progress;
        budget?: StepBudget | undefined;
        maxLikes?: number | undefined;
      }
    | undefined;
}

export interface FeatureNavItem {
  id: FeatureModuleId;
  group: 'control' | 'automation' | 'bluestacks' | 'sheets' | 'monitor';
  title: string;
  tooltip?: string | undefined;
  icon: FeatureModuleId;
  runningCount?: number | undefined;
  badgeCount?: number | undefined;
  badgeTone?: 'run' | 'warn' | 'err' | 'ok' | undefined;
}

export interface SelectionControlSummary {
  pausableTargets: TaskCommand['plans'];
  resumableTargets: TaskCommand['plans'];
  stoppableTargets: TaskCommand['plans'];
  stoppableModuleProfileIds: string[];
  totalStoppableCount: number;
  isProfileBusy: (profileId: string) => boolean;
}

export const MODULE_LABELS: Record<string, string> = {
  'group-poster': '小组发帖',
  'group-bumper': '小组顶贴',
  'page-bumper': '专页顶贴',
  'group-inviter': '小组邀请人',
};

export const BREADCRUMB_LABELS: Record<string, string> = {
  home: '活跃账号',
  edit: '活跃账号 · 编辑组合',
  'auto-scheduler': '定时排班',
  'group-inviter': '小组邀请人',
  'group-bumper': '小组顶贴',
  'page-bumper': '专页顶贴',
  'group-poster': '小组发帖',
  'sheets-groups': '云表协同 · 小组表',
  'sheets-pages': '云表协同 · 专页表',
  'sheets-schedule': '云表协同 · 排贴表',
  'sheets-records': '云表协同 · 发帖记录',
  'bluestacks-active': '蓝蝶活跃账号',
  'bluestacks-group-poster': '蓝蝶小组发帖',
  'bluestacks-group-bumper': '蓝蝶小组顶贴',
  'bluestacks-page-bumper': '蓝蝶专页顶贴',
  'bluestacks-group-inviter': '蓝蝶小组邀请人',
  'window-layout': '窗口排版',
};

export function buildFeatureNavItems(p: {
  carrier?: 'browser' | 'bluestacks';
  activeSheetsModule?: SheetsModuleId;
  autoSchedulerRunningCount?: number;
  autoSchedulerEnabledCount?: number;
  activeAccountRunningCount: number;
  groupInviterRunning: boolean;
  inviterRunningCount: number;
  groupBumperRunning: boolean;
  bumperRunningCount: number;
  pageBumperRunningCount?: number;
  groupPosterRunningCount?: number;
  sheetsScheduleRunningCount?: number;
  sheetsScheduleEnabledCount?: number;
  sheetsRecordsRunningCount?: number;
  sheetsRecordsEnabledCount?: number;
  bluestacksActiveRunningCount?: number;
  bluestacksPosterRunningCount?: number;
  bluestacksBumperRunningCount?: number;
  bluestacksPageBumperRunningCount?: number;
  bluestacksInviterRunningCount?: number;
  attentionCount: number;
}): FeatureNavItem[] {
  const isBs = p.carrier === 'bluestacks';
  const activeId: FeatureModuleId = isBs ? 'bluestacks-active' : 'active-accounts';
  const posterId: FeatureModuleId = isBs ? 'bluestacks-group-poster' : 'group-poster';
  const bumperId: FeatureModuleId = isBs ? 'bluestacks-group-bumper' : 'group-bumper';
  const pageBumperId: FeatureModuleId = isBs ? 'bluestacks-page-bumper' : 'page-bumper';
  const inviterId: FeatureModuleId = isBs ? 'bluestacks-group-inviter' : 'group-inviter';
  const schedRun = p.autoSchedulerRunningCount ?? 0;
  const schedEn = p.autoSchedulerEnabledCount ?? 0;
  const sheetsRun = (p.sheetsScheduleRunningCount ?? 0) + (p.sheetsRecordsRunningCount ?? 0);
  const sheetsEn = (p.sheetsScheduleEnabledCount ?? 0) + (p.sheetsRecordsEnabledCount ?? 0);

  return [
    {
      id: 'auto-scheduler',
      group: 'control',
      title: '定时排班',
      tooltip: '定时排班 · 浏览器与蓝蝶跨端统一调度',
      icon: 'auto-scheduler',
      runningCount: schedRun,
      ...(schedRun === 0 && schedEn > 0 ? { badgeCount: schedEn, badgeTone: 'ok' as const } : {}),
    },
    {
      id: 'records',
      group: 'control',
      title: '发帖顶贴记录',
      tooltip: '发帖与顶贴记录 · 统一表头与一键复制',
      icon: 'records',
      badgeCount: p.attentionCount,
      badgeTone: 'err',
    },
    {
      id: 'window-layout',
      group: 'control',
      title: '窗口排版',
      tooltip: '窗口排版 · 多屏平铺、堆叠与一键整理',
      icon: 'window-layout',
    },
    {
      id: activeId,
      group: 'automation',
      title: '活跃账号',
      tooltip: isBs
        ? '蓝蝶活跃账号 · FB Lite 养号与动作组合'
        : '浏览器活跃账号 · 任务组合与批量养号',
      icon: activeId,
      runningCount: isBs ? (p.bluestacksActiveRunningCount ?? 0) : p.activeAccountRunningCount,
    },
    {
      id: posterId,
      group: 'automation',
      title: '小组发帖',
      tooltip: isBs ? '蓝蝶小组发帖 · 向小组/时间线发布素材' : '浏览器小组发帖 · 素材库与多组分发',
      icon: posterId,
      runningCount: isBs ? (p.bluestacksPosterRunningCount ?? 0) : (p.groupPosterRunningCount ?? 0),
    },
    {
      id: bumperId,
      group: 'automation',
      title: '小组顶贴',
      tooltip: isBs ? '蓝蝶小组顶贴' : '浏览器小组顶贴',
      icon: bumperId,
      runningCount: isBs
        ? (p.bluestacksBumperRunningCount ?? 0)
        : p.groupBumperRunning
          ? Math.max(1, p.bumperRunningCount)
          : 0,
    },
    {
      id: pageBumperId,
      group: 'automation',
      title: '专页顶贴',
      tooltip: isBs ? '蓝蝶专页顶贴' : '浏览器专页顶贴',
      icon: pageBumperId,
      runningCount: isBs
        ? (p.bluestacksPageBumperRunningCount ?? 0)
        : (p.pageBumperRunningCount ?? 0),
    },
    {
      id: inviterId,
      group: 'automation',
      title: '小组邀请人',
      tooltip: isBs ? '蓝蝶小组邀请人 · 自动邀请好友进群' : '浏览器小组邀请人 · 自动邀请好友进群',
      icon: inviterId,
      runningCount: isBs
        ? (p.bluestacksInviterRunningCount ?? 0)
        : p.groupInviterRunning
          ? Math.max(1, p.inviterRunningCount)
          : 0,
    },
    {
      id: p.activeSheetsModule ?? 'sheets-schedule',
      group: 'sheets',
      title: '云表协同',
      tooltip: '云表协同 · 排贴表 / 发帖记录 / 小组表 / 专页表',
      icon: 'sheets-schedule',
      runningCount: sheetsRun,
      ...(sheetsRun === 0 && sheetsEn > 0
        ? { badgeCount: sheetsEn, badgeTone: 'ok' as const }
        : {}),
    },
  ];
}

export const ACTIVE_CLOSE_BROWSER_STORAGE_KEY = 'wb.activeAccounts.closeBrowserOnFinish';

export function readStoredCloseBrowserOnFinish(): boolean {
  try {
    return window.localStorage.getItem(ACTIVE_CLOSE_BROWSER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const normalizeCombinationResources = (value: Combination): Combination => ({
  ...value,
  steps: value.steps.map((s) =>
    s.type === 'post' ? { ...s, resourceMode: 'table' as const, resourceDirectory: '' } : s,
  ),
});

export const newPostStep = (id: string, destination: 'post' | 'story' = 'post'): Step => ({
  id,
  type: 'post',
  destination,
  ...(destination === 'story' ? { audience: 'preserve-current' as const } : {}),
  count: 1,
  resourceDirectory: '',
  resourceMode: 'table',
  allowRepeat: false,
  forbidSameAccountRepeat: true,
  archivePublished: false,
});

export function newCombination(destination?: 'post' | 'story'): Combination {
  return {
    name:
      destination === 'story' ? '新快拍组合' : destination === 'post' ? '新发帖组合' : '新任务组合',
    note: '',
    steps: destination
      ? [newPostStep(crypto.randomUUID(), destination)]
      : [
          {
            id: crypto.randomUUID(),
            type: 'video',
            durationMinutes: 15,
            maxLikes: 0,
            minLikeCount: 500,
          },
        ],
    randomOrder: false,
    loop: { mode: 'finite', rounds: 1 },
  };
}
