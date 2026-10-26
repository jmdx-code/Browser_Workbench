import type { TaskRecord } from '../shared/task-contracts.js';
import { endedTask } from '../domain/task-run-records.js';
import { taskReasonDescription } from './task-alerts.js';

type Step = Pick<TaskRecord, 'type' | 'destination' | 'status' | 'progress' | 'budget' | 'outcome'>;
export const stepName = (step: Pick<Step, 'type' | 'destination'>) =>
  step.destination === 'story'
    ? '发布快拍'
    : {
        feed: '浏览首页',
        video: '浏览 Reels',
        marketplace: '浏览商城',
        post: '发布内容',
        friends: '接受好友',
      }[step.type];
const minutes = (ms: number) => `${Number((ms / 60000).toFixed(1))}m`;
export function stepResultLabel(step: Step & { planState?: string }): string {
  const name = stepName(step);
  if (step.status === 'FAILED')
    return `✕ ${name} · ${step.outcome ? (taskReasonDescription(step.outcome.reason)?.summary ?? step.outcome.reason) : '执行失败'}`;
  if (step.status === 'PENDING' || step.status === 'SKIPPED') return `— ${name}`;
  const current = step.status === 'ACTIVE' && !endedTask(step.planState ?? 'RUNNING');
  const progress =
    step.type === 'post'
      ? `${step.progress.published}/${step.budget?.kind === 'posts' ? step.budget.count : '?'} 条`
      : step.type === 'friends'
        ? `${step.progress.accepted ?? 0} 人`
        : `${minutes(step.progress.effectiveMilliseconds)}${current && step.budget?.kind === 'time' ? '/' + minutes(step.budget.milliseconds) : ''}${step.progress.likes ? ' · 赞' + step.progress.likes : ''}`;
  return `${step.status === 'COMPLETED' ? '✓' : current ? '●' : '—'} ${name} ${progress}`;
}
export function runSummary(rows: readonly Step[]): string {
  const browsing = rows.reduce((n, r) => n + r.progress.effectiveMilliseconds, 0);
  const likes = rows.reduce((n, r) => n + r.progress.likes, 0);
  const accepted = rows.reduce((n, r) => n + (r.progress.accepted ?? 0), 0);
  const published = rows.reduce((n, r) => n + r.progress.published, 0);
  return (
    [
      browsing ? `共浏览 ${Number((browsing / 60000).toFixed(1))} 分钟` : '',
      likes ? `点赞 ${likes}` : '',
      accepted ? `加好友 ${accepted}` : '',
      published ? `发布 ${published} 条` : '',
    ]
      .filter(Boolean)
      .join(' · ') || '暂无完成成果'
  );
}
