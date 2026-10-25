import { ProductError } from '../domain/workspace.js';
import { TASK_CAPACITY_VERSION } from '../shared/task-capacity.js';

export function assertTaskCapacity(header: unknown, value: { maxConcurrentProfiles: number }) {
  if (value.maxConcurrentProfiles > 50 && header !== TASK_CAPACITY_VERSION)
    throw new ProductError(
      'TASK_CONTRACT_UPGRADE_REQUIRED',
      '超过50个浏览器的并发设置需要新版界面，请刷新软件页面',
      409,
    );
}

export const TASK_CONTRACT_HEADER = 'x-workbench-task-contract';
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
    (typeof header !== 'string' || !['1', '2', '3', '4'].includes(header))
  )
    throw new ProductError('TASK_CONTRACT_UNSUPPORTED', '任务契约版本不兼容，请刷新软件页面', 409);
  if (
    header !== '4' &&
    (steps.some((step) => step.spec?.type === 'post' && step.spec.aiLabel !== undefined) ||
      plans.some((plan) =>
        plan.snapshot.steps.some((step) => step.type === 'post' && step.aiLabel !== undefined),
      ))
  )
    throw new ProductError(
      'TASK_CONTRACT_UPGRADE_REQUIRED',
      'AI 声明选项需要新版界面，请刷新软件页面',
      409,
    );
  if (
    header !== '3' &&
    header !== '4' &&
    (steps.some((step) => step.spec?.type === 'post' && step.spec.audience === 'friends') ||
      plans.some((plan) =>
        plan.snapshot.steps.some((step) => step.type === 'post' && step.audience === 'friends'),
      ))
  )
    throw new ProductError(
      'TASK_CONTRACT_UPGRADE_REQUIRED',
      '快拍好友范围需要新版界面，请刷新软件页面',
      409,
    );
  if (
    header !== '2' &&
    header !== '3' &&
    header !== '4' &&
    (steps.some(
      (step) => step.status === 'FAILED' || step.status === 'SKIPPED' || step.outcome !== undefined,
    ) ||
      plans.some((plan) =>
        plan.snapshot.steps.some((step) => step.type === 'post' && step.audience !== undefined),
      ))
  )
    throw new ProductError(
      'TASK_CONTRACT_UPGRADE_REQUIRED',
      '当前任务含新版步骤结果，请刷新软件页面',
      409,
    );
}
