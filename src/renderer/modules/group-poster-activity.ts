import type { BumperProfileStat } from '../../shared/group-bumper.js';
import type { GroupInviterProfileStat } from '../../shared/group-inviter.js';
import type { PosterProfileStat } from '../../shared/group-poster.js';
import type { ProfileActivityDescriptor } from './module-contracts.js';

export function extractPosterRunningIds(
  groupPoster:
    { running: boolean; profileCounts: Record<string, PosterProfileStat> } | null | undefined,
): string[] {
  if (!groupPoster?.running) return [];
  return Object.entries(groupPoster.profileCounts)
    .filter(([, stat]) => stat.running)
    .map(([id]) => id);
}

export function extractInviterRunningIds(
  groupInviter:
    { running: boolean; profileCounts: Record<string, GroupInviterProfileStat> } | null | undefined,
): string[] {
  if (!groupInviter?.running) return [];
  return Object.entries(groupInviter.profileCounts)
    .filter(
      ([, stat]) =>
        stat.running === true ||
        (stat.running !== false &&
          Boolean(
            stat.status &&
            !['已完成', '已停止'].includes(stat.status) &&
            !stat.status.startsWith('失败') &&
            !stat.status.startsWith('跳过'),
          )),
    )
    .map(([id]) => id);
}

export function projectGroupPosterProfileActivity(
  profileId: string,
  posterCounts: Record<string, PosterProfileStat> | undefined,
  posterRunning: boolean,
): ProfileActivityDescriptor | null {
  if (!posterCounts) return null;
  const stat = posterCounts[profileId];
  const running = Boolean(stat?.running || posterRunning);
  const statusText = stat?.status ?? '未运行';
  const isRestricted = Boolean(stat?.restricted || /受限|验证/.test(statusText));
  const tone: ProfileActivityDescriptor['tone'] = running
    ? 'run'
    : isRestricted || /中断|失败/.test(statusText)
      ? 'err'
      : /停止/.test(statusText)
        ? 'pause'
        : 'ok';
  return {
    moduleId: 'group-poster',
    moduleLabel: '小组发帖',
    running,
    tone,
    text: `今日 ${stat?.today ?? 0} · 本轮 ${stat?.session ?? 0} · ${statusText}`,
    tooltipLines: [
      `小组发帖：今日 ${stat?.today ?? 0} 贴 · 本轮 ${stat?.session ?? 0} 贴 · ${statusText}`,
    ],
  };
}

export function formatBumperStat(
  bumperModule: 'group-bumper' | 'page-bumper',
  stat: BumperProfileStat | undefined,
  running: boolean,
): ProfileActivityDescriptor {
  const bumperLabel = bumperModule === 'page-bumper' ? '专页顶贴' : '小组顶贴';
  const status = stat?.status ?? (running ? '运行中' : '未运行');
  const tone: ProfileActivityDescriptor['tone'] = running
    ? 'run'
    : /受限|验证|中断|失败|异常|未确认/.test(status)
      ? 'err'
      : /停止/.test(status)
        ? 'pause'
        : 'ok';
  return {
    moduleId: bumperModule,
    moduleLabel: bumperLabel,
    running,
    tone,
    text: `今日 ${stat?.today ?? 0} · 本轮 ${stat?.session ?? 0} · ${status}`,
    tooltipLines: [
      `${bumperLabel}：今日 ${stat?.today ?? 0} 次 · 本轮 ${stat?.session ?? 0} 次 · ${status}`,
    ],
  };
}

export function formatInviterStat(
  stat: GroupInviterProfileStat | undefined,
  running: boolean,
): ProfileActivityDescriptor {
  const statusText = stat?.status ?? '';
  const tone: ProfileActivityDescriptor['tone'] = running
    ? 'run'
    : /失败|未确认|不可|异常|离线/.test(statusText)
      ? 'err'
      : /停止/.test(statusText)
        ? 'pause'
        : 'ok';
  return {
    moduleId: 'group-inviter',
    moduleLabel: '小组邀请人',
    running,
    tone,
    className: 'group-inviter-profile-stat',
    text: `本次邀请 ${stat?.sessionInvited ?? 0} 人 · 累计 ${stat?.totalInvited ?? 0} 人${statusText ? ' · ' + statusText : ''}`,
    tooltipLines: [
      `小组邀请人：本次 ${stat?.sessionInvited ?? 0} 人 · 累计 ${stat?.totalInvited ?? 0} 人${statusText ? ' · ' + statusText : ''}`,
    ],
  };
}
