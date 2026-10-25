import type { Plan } from '../shared/task-contracts.js';

const liveNames: Partial<Record<Plan['state'], string>> = {
  RUNNING: '执行中',
  QUEUED: '排队',
  PAUSING: '正在暂停',
  STOPPING: '正在停止',
  REVIEW: '待核对',
  PAUSED: '暂停',
};
const endedNames: Partial<Record<Plan['state'], string>> = {
  COMPLETED: '完成',
  FAILED: '失败',
  STOPPED: '停止',
};
export function combinationActivity(plans: Plan[], combinationId: string, version: number) {
  const rows = plans.filter((plan) => plan.combinationId === combinationId);
  const live = rows.filter((plan) => liveNames[plan.state]);
  const latest = rows
    .filter((plan) => plan.version === version)
    .reduce<Plan | undefined>(
      (previous, plan) =>
        !previous ||
        plan.createdAt > previous.createdAt ||
        (plan.createdAt === previous.createdAt && plan.updatedAt > previous.updatedAt)
          ? plan
          : previous,
      undefined,
    );
  const selected = live.length
    ? rows.filter((plan) =>
        live.some((active) => active.batchId === plan.batchId && active.version === plan.version),
      )
    : latest
      ? rows.filter((plan) => plan.version === version && plan.batchId === latest.batchId)
      : [];
  const names = live.length ? { ...liveNames, ...endedNames } : endedNames;
  const label = Object.entries(names)
    .flatMap(([state, name]) => {
      const count = selected.filter((plan) => plan.state === state).length;
      return count ? [`${count} 份${name}`] : [];
    })
    .join(' · ');
  return {
    label: label ? (live.length ? label : '上次：' + label) : '未执行',
    tone: selected.some((plan) => ['FAILED', 'REVIEW'].includes(plan.state))
      ? 'orange'
      : selected.some((plan) => plan.state === 'RUNNING')
        ? 'blue'
        : 'gray',
  };
}
