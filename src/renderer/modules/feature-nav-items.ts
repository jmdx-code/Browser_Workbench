import type { FeatureNavItem } from './module-contracts.js';

export function buildFeatureNavItems({
  activeAccountRunningCount,
  groupInviterRunning,
  inviterRunningCount,
  groupBumperRunning,
  bumperRunningCount,
  pageBumperRunningCount = 0,
  groupPosterRunningCount = 0,
  attentionCount,
}: {
  activeAccountRunningCount: number;
  groupInviterRunning: boolean;
  inviterRunningCount: number;
  groupBumperRunning: boolean;
  bumperRunningCount: number;
  pageBumperRunningCount?: number;
  groupPosterRunningCount?: number;
  attentionCount: number;
}): FeatureNavItem[] {
  return [
    {
      id: 'active-accounts',
      group: 'automation',
      title: '活跃账号',
      icon: 'active-accounts',
      runningCount: activeAccountRunningCount,
    },
    {
      id: 'group-inviter',
      group: 'automation',
      title: '小组邀请人',
      icon: 'group-inviter',
      runningCount: groupInviterRunning ? Math.max(1, inviterRunningCount) : 0,
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
      id: 'group-poster',
      group: 'automation',
      title: '小组发帖',
      icon: 'group-poster',
      runningCount: groupPosterRunningCount,
    },
    {
      id: 'records',
      group: 'monitor',
      title: '执行记录',
      icon: 'records',
      badgeCount: attentionCount,
      badgeTone: 'err',
    },
  ];
}
