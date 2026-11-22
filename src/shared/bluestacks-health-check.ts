import { z } from 'zod';
import { Id } from './contracts.js';

export const BluestacksHealthCategory = z.enum([
  'healthy',
  'logged-out',
  'verification',
  'restricted',
  'missing-app',
  'landscape',
  'launch-failed',
  'skipped',
  'stopped',
]);
export type BluestacksHealthCategory = z.infer<typeof BluestacksHealthCategory>;

export const BluestacksHealthCheckItemStatus = z.enum(['queued', 'running', 'done']);
export type BluestacksHealthCheckItemStatus = z.infer<typeof BluestacksHealthCheckItemStatus>;

export const StartBluestacksHealthCheckInput = z
  .object({
    instanceIds: z.array(Id).min(1, '请至少选择一个蓝蝶窗口').max(200),
    maxConcurrency: z.number().int().min(1).max(10).default(3),
    autoLaunch: z.boolean().default(true),
    autoInstallApk: z.boolean().default(false),
    closeOnFinish: z.boolean().default(true),
  })
  .strict();
export type StartBluestacksHealthCheckInput = z.infer<typeof StartBluestacksHealthCheckInput>;

export interface BluestacksHealthCheckItem {
  instanceId: string;
  instanceName: string;
  resolution: string;
  status: BluestacksHealthCheckItemStatus;
  category: BluestacksHealthCategory | null;
  stepText: string;
  error?: string | undefined;
  fbLiteVersion?: string | null | undefined;
  androidSdk?: number | null | undefined;
  identityType?: 'unknown' | 'personal' | 'page' | undefined;
  accountName?: string | undefined;
  numericAccountId?: string | undefined;
  managedPageCount?: number | undefined;
  autoRepaired?: boolean | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
}

export interface BluestacksHealthCheckState {
  runId: string;
  running: boolean;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  completed: number;
  healthy: number;
  loggedOut: number;
  verification: number;
  restricted: number;
  missingApp: number;
  landscape: number;
  launchFailed: number;
  skipped: number;
  stopped: number;
  autoRepaired: number;
  statusText: string;
  items: BluestacksHealthCheckItem[];
}

export function healthCategoryLabel(category: BluestacksHealthCategory | null): string {
  switch (category) {
    case 'healthy':
      return '健康正常';
    case 'logged-out':
      return '未登录';
    case 'verification':
      return '需安全验证';
    case 'restricted':
      return '已受限/封禁';
    case 'missing-app':
      return '未装 FB Lite';
    case 'landscape':
      return '横屏需调整';
    case 'launch-failed':
      return '启动/检测失败';
    case 'skipped':
      return '忙线跳过';
    case 'stopped':
      return '已手动停止';
    default:
      return '检测中';
  }
}

export function classifyHealthErrorMessage(
  message: string,
  fallbackAccountState?: string | null,
): BluestacksHealthCategory {
  if (/横屏/i.test(message)) return 'landscape';
  if (/未安装\s*FB\s*Lite/i.test(message)) return 'missing-app';
  if (/未登录|退出登录|logged-out/i.test(message)) return 'logged-out';
  if (/Checkpoint|安全验证|身份验证|手机验证/i.test(message)) return 'verification';
  if (/受限|停用|封禁|封号/i.test(message)) return 'restricted';
  if (fallbackAccountState === 'verification') return 'verification';
  if (fallbackAccountState === 'restricted') return 'restricted';
  if (fallbackAccountState === 'logged-out') return 'logged-out';
  if (fallbackAccountState === 'missing-app') return 'missing-app';
  return 'launch-failed';
}

export function formatBluestacksHealthReportText(state: BluestacksHealthCheckState): string {
  const header = [
    `【蓝蝶批量健康体检报表】`,
    `总计: ${state.total} | 已完成: ${state.completed} | 健康: ${state.healthy} | 未登录: ${state.loggedOut} | 待验证: ${state.verification} | 受限: ${state.restricted} | 缺App: ${state.missingApp} | 横屏: ${state.landscape} | 失败: ${state.launchFailed}${state.autoRepaired > 0 ? ` | 自动装包修复: ${state.autoRepaired}` : ''}`,
    '---',
  ];
  const lines = state.items.map((item) => {
    const cat = healthCategoryLabel(item.category);
    const acct = item.accountName
      ? `${item.accountName}${item.numericAccountId ? ` (ID:${item.numericAccountId})` : ''}`
      : '-';
    const ver = item.fbLiteVersion ? `v${item.fbLiteVersion}` : '-';
    const repairTag = item.autoRepaired ? ' [已自动装包]' : '';
    return `${item.instanceName} | ${cat}${repairTag} | ${acct} | ${item.resolution} | FB Lite ${ver} | ${item.stepText}`;
  });
  return [...header, ...lines].join('\n');
}
