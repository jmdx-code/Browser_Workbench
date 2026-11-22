import type { FeatureNavItem } from './module-contracts.js';

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
};

export function buildFeatureNavItems({
  autoSchedulerRunningCount = 0,
  autoSchedulerEnabledCount = 0,
  activeAccountRunningCount,
  groupInviterRunning,
  inviterRunningCount,
  groupBumperRunning,
  bumperRunningCount,
  pageBumperRunningCount = 0,
  groupPosterRunningCount = 0,
  sheetsScheduleRunningCount = 0,
  sheetsScheduleEnabledCount = 0,
  sheetsRecordsRunningCount = 0,
  sheetsRecordsEnabledCount = 0,
  bluestacksActiveRunningCount = 0,
  bluestacksPosterRunningCount = 0,
  bluestacksBumperRunningCount = 0,
  bluestacksPageBumperRunningCount = 0,
  bluestacksInviterRunningCount = 0,
  attentionCount,
}: {
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
  return [
    // 1. 调度与监控（跨载体无人值守控制 + 全局任务对账）
    {
      id: 'auto-scheduler',
      group: 'control',
      title: '定时排班',
      tooltip: '定时排班 · Chrome 与蓝蝶跨端无人值守',
      icon: 'auto-scheduler',
      runningCount: autoSchedulerRunningCount,
      ...(autoSchedulerRunningCount === 0 && autoSchedulerEnabledCount > 0
        ? { badgeCount: autoSchedulerEnabledCount, badgeTone: 'ok' as const }
        : {}),
    },
    {
      id: 'records',
      group: 'control',
      title: '执行记录',
      tooltip: '执行记录 · 全局任务回执与异常对账',
      icon: 'records',
      badgeCount: attentionCount,
      badgeTone: 'err',
    },
    // 2. 浏览器自动化（按真实运营漏斗：养号 → 发帖 → 顶贴 → 邀人）
    {
      id: 'active-accounts',
      group: 'automation',
      title: '活跃账号',
      icon: 'active-accounts',
      runningCount: activeAccountRunningCount,
    },
    {
      id: 'group-poster',
      group: 'automation',
      title: '小组发帖',
      icon: 'group-poster',
      runningCount: groupPosterRunningCount,
    },
    {
      id: 'group-bumper',
      group: 'automation',
      title: '小组顶贴',
      icon: 'group-bumper',
      runningCount: groupBumperRunning ? Math.max(1, bumperRunningCount) : 0,
    },
    {
      id: 'page-bumper',
      group: 'automation',
      title: '专页顶贴',
      icon: 'page-bumper',
      runningCount: pageBumperRunningCount,
    },
    {
      id: 'group-inviter',
      group: 'automation',
      title: '小组邀请人',
      icon: 'group-inviter',
      runningCount: groupInviterRunning ? Math.max(1, inviterRunningCount) : 0,
    },
    // 3. 蓝蝶模拟器（紧邻浏览器自动化，构成双引擎全功能执行层：养号 → 发帖 → 顶贴 → 邀人）
    {
      id: 'bluestacks-active',
      group: 'bluestacks',
      title: '蓝蝶活跃账号',
      tooltip: '蓝蝶活跃账号 · FB Lite 刷首页/Reels/商城/好友/发帖/快拍',
      icon: 'bluestacks-active',
      runningCount: bluestacksActiveRunningCount,
    },
    {
      id: 'bluestacks-group-poster',
      group: 'bluestacks',
      title: '蓝蝶小组发帖',
      tooltip: '蓝蝶小组发帖 · 复用素材库向小组/时间线发布图文视频',
      icon: 'bluestacks-group-poster',
      runningCount: bluestacksPosterRunningCount,
    },
    {
      id: 'bluestacks-group-bumper',
      group: 'bluestacks',
      title: '蓝蝶小组顶贴',
      icon: 'bluestacks-group-bumper',
      runningCount: bluestacksBumperRunningCount,
    },
    {
      id: 'bluestacks-page-bumper',
      group: 'bluestacks',
      title: '蓝蝶专页顶贴',
      icon: 'bluestacks-page-bumper',
      runningCount: bluestacksPageBumperRunningCount,
    },
    {
      id: 'bluestacks-group-inviter',
      group: 'bluestacks',
      title: '蓝蝶小组邀请人',
      tooltip: '蓝蝶小组邀请人 · 个人号身份自动邀请好友加入小组',
      icon: 'bluestacks-group-inviter',
      runningCount: bluestacksInviterRunningCount,
    },
    // 4. 云表协同（跨端 / 多机云端协同层：高频作业表在前，基础资料库在后）
    {
      id: 'sheets-schedule',
      group: 'sheets',
      title: '排贴表',
      tooltip: '排贴表 · 云端排期自动分发发帖',
      icon: 'sheets-schedule',
      runningCount: sheetsScheduleRunningCount,
      ...(sheetsScheduleRunningCount === 0 && sheetsScheduleEnabledCount > 0
        ? { badgeCount: sheetsScheduleEnabledCount, badgeTone: 'ok' as const }
        : {}),
    },
    {
      id: 'sheets-records',
      group: 'sheets',
      title: '发帖记录',
      tooltip: '发帖记录 · 多机阶梯顶贴与赞评采集',
      icon: 'sheets-records',
      runningCount: sheetsRecordsRunningCount,
      ...(sheetsRecordsRunningCount === 0 && sheetsRecordsEnabledCount > 0
        ? { badgeCount: sheetsRecordsEnabledCount, badgeTone: 'ok' as const }
        : {}),
    },
    {
      id: 'sheets-groups',
      group: 'sheets',
      title: '小组表',
      tooltip: '小组表 · 与软件小组库双向同步',
      icon: 'sheets-groups',
    },
    {
      id: 'sheets-pages',
      group: 'sheets',
      title: '专页表',
      tooltip: '专页表 · 与软件专页库双向同步',
      icon: 'sheets-pages',
    },
  ];
}
