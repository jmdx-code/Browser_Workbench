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
  if (['PAUSING', 'STOPPING'].includes(plan.state))
    return { summary: '等待浏览器停止确认', next: '保持浏览器连接；需要处理时请打开该任务记录。' };
  const known = taskReasonDescription(plan.reason);
  if (known) return known;
  if (plan.state === 'REVIEW')
    return {
      summary: '任务结果需要核对',
      next: '查看记录；可以停止并结束本次任务，原可能已提交内容不自动重发。',
    };
  return {
    summary: plan.state === 'FAILED' ? '任务失败' : '任务已暂停',
    next: '查看原任务记录中的具体原因，再决定继续或结束。',
  };
}
export function attentionPlans(plans: Plan[], profiles: Profile[]) {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return plans
    .filter(
      (plan) =>
        plan.state === 'REVIEW' ||
        ['PAUSING', 'STOPPING'].includes(plan.state) ||
        (plan.state === 'PAUSED' && !!plan.reason && !/^(USER_|MANUAL_)/.test(plan.reason)) ||
        (plan.state === 'QUEUED' && !byId.get(plan.profileId)?.online),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
