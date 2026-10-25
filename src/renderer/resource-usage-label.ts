import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';

export const resourceUsageTitle =
  '剩余是当前保存表中尚未标记已使用的行数，包含执行中及待核对项；原文件位置不变。任务允许重复，或手动清空使用记录后，可再次取用已使用资源。不同资源行不会因内容相同被强制拦截。';

export function resourceUsageLabel(summary: ResourceUsageSummaryValue | null, loaded: boolean) {
  if (!loaded) return '资源记录未读取';
  if (!summary) return '剩余 0 条 · 尚未设置资源';
  return [
    `剩余 ${summary.remaining} 条`,
    ...(summary.published ? [`已发 ${summary.published} 条`] : []),
    ...(summary.pendingAttempts ? [`${summary.pendingAttempts} 个执行中`] : []),
    ...(summary.reviewAttempts ? [`${summary.reviewAttempts} 个待核对`] : []),
    ...(summary.previousVersionPending ? [`其中旧资源 ${summary.previousVersionPending} 个`] : []),
    '待核验',
  ].join(' · ');
}
