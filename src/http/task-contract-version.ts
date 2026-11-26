import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProductError } from '../domain/workspace.js';
import { TASK_CAPACITY_VERSION } from '../shared/task-policies.js';
export interface RouteBase {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  input?: unknown;
  json: (res: ServerResponse, status: number, body: unknown) => void;
}
export function needSvc<T>(v: T | undefined, code: string, msg: string): T {
  if (!v) throw new ProductError(code, msg, 409);
  return v;
}
export const TASK_CONTRACT_HEADER = 'x-workbench-task-contract';
const upgrade = (msg: string): never => {
  throw new ProductError('TASK_CONTRACT_UPGRADE_REQUIRED', msg, 409);
};
export function assertTaskCapacity(header: unknown, value: { maxConcurrentProfiles: number }) {
  if (value.maxConcurrentProfiles > 50 && header !== TASK_CAPACITY_VERSION)
    upgrade('超过50个浏览器的并发设置需要新版界面，请刷新软件页面');
}
export function assertTaskContract(
  header: string | string[] | undefined,
  steps: readonly {
    status: string;
    outcome?: unknown;
    spec?: { type: string; audience?: string; aiLabel?: string };
  }[],
  plans: readonly {
    snapshot: { steps: readonly { type: string; audience?: string; aiLabel?: string }[] };
  }[] = [],
) {
  if (
    header !== undefined &&
    (typeof header !== 'string' || !['1', '2', '3', '4', '5'].includes(header))
  )
    throw new ProductError('TASK_CONTRACT_UNSUPPORTED', '任务契约版本不兼容，请刷新软件页面', 409);
  const v = header ?? '';
  const reqPost = (fn: (s: { type: string; audience?: string; aiLabel?: string }) => boolean) =>
    steps.some((s) => s.spec?.type === 'post' && fn(s.spec)) ||
    plans.some((p) => p.snapshot.steps.some((s) => s.type === 'post' && fn(s)));
  if (!['4', '5'].includes(v) && reqPost((s) => s.aiLabel !== undefined))
    upgrade('AI 声明选项需要新版界面，请刷新软件页面');
  if (!['3', '4', '5'].includes(v) && reqPost((s) => s.audience === 'friends'))
    upgrade('快拍好友范围需要新版界面，请刷新软件页面');
  if (
    !['2', '3', '4', '5'].includes(v) &&
    (steps.some(
      (s) => s.status === 'FAILED' || s.status === 'SKIPPED' || s.outcome !== undefined,
    ) ||
      reqPost((s) => s.audience !== undefined))
  )
    upgrade('当前任务含新版步骤结果，请刷新软件页面');
  if (
    v !== '5' &&
    steps.some(
      (s) =>
        s.outcome !== null &&
        typeof s.outcome === 'object' &&
        'kind' in s.outcome &&
        s.outcome.kind === 'SKIPPED' &&
        'reason' in s.outcome &&
        s.outcome.reason === 'MARKETPLACE_UNAVAILABLE',
    )
  )
    upgrade('商城正常跳过结果需要新版界面，请刷新软件页面');
}
