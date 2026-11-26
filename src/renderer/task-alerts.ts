import type { Plan } from '../shared/task-contracts.js';
import type { Profile } from '../shared/contracts.js';
import { taskReasonDescription } from '../shared/task-issues.js';
export { taskReasonDescription } from '../shared/task-issues.js';

export function isResourceTaskIssue(reason: string) {
  return (
    reason === 'MATERIAL_EXHAUSTED' ||
    reason === 'MATERIAL_NO_ELIGIBLE_RESOURCE' ||
    reason.startsWith('RESOURCE_')
  );
}
export function taskAlertReason(
  plan: Pick<Plan, 'state' | 'reason'>,
  profile?: Pick<Profile, 'online'>,
) {
  if (!profile?.online && !['FAILED', 'STOPPED', 'COMPLETED'].includes(plan.state))
    return { summary: '浏览器未连接', next: '打开这份浏览器并等待自动连接，再查看任务状态。' };
  const known = taskReasonDescription(plan.reason);
  if (known) return known;
  return {
    summary: plan.state === 'FAILED' ? '任务失败' : '任务已停止',
    next: '查看原任务记录中的具体原因。',
  };
}
export function attentionPlans(_plans: Plan[], _profiles: Profile[]) {
  return [];
}
