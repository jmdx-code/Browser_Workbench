import type { z } from 'zod';
import type { TaskProgress, TaskStepBudget } from '../shared/task-contracts.js';

type Budget = z.infer<typeof TaskStepBudget>;
const duration = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};
export function TaskProgressView({
  type,
  progress,
  budget,
  maxLikes,
  compact = false,
}: {
  type: 'feed' | 'video' | 'marketplace' | 'post' | 'friends';
  progress: z.infer<typeof TaskProgress>;
  budget?: Budget;
  maxLikes?: number;
  compact?: boolean;
}) {
  if (type === 'friends') {
    const accepted = progress.accepted ?? 0;
    const maximum = budget?.kind === 'friends' ? budget.count : null;
    const label =
      maximum !== null
        ? `${compact ? '' : '确认好友 '}${accepted}/${maximum} 个`
        : `${compact ? '' : '确认好友 '}${accepted} 个（全部）`;
    return (
      <span className={'task-progress' + (compact ? ' compact' : '')}>
        <span>{label}</span>
        {maximum !== null && (
          <progress max={maximum} value={Math.min(accepted, maximum)} aria-label={label} />
        )}
      </span>
    );
  }
  const post = type === 'post';
  const maximum = post
    ? budget?.kind === 'posts'
      ? budget.count
      : null
    : budget?.kind === 'time'
      ? budget.milliseconds
      : null;
  const value = post ? progress.published : progress.effectiveMilliseconds;
  const showLikes = !post && ((maxLikes !== undefined && maxLikes > 0) || progress.likes > 0);
  const likesSuffix = showLikes
    ? ` · 赞 ${progress.likes}${maxLikes && maxLikes > 0 ? '/' + maxLikes : ''}`
    : '';
  const label = post
    ? `${compact ? '' : '确认发布 '}${value}${maximum !== null ? '/' + maximum : ''} 条`
    : `${compact ? '' : '有效浏览 '}${duration(value)}${maximum !== null ? ' / ' + duration(maximum) : ''}${likesSuffix}`;
  return (
    <span className={'task-progress' + (compact ? ' compact' : '')}>
      <span>{label}</span>
      {maximum !== null && (
        <progress max={maximum} value={Math.min(value, maximum)} aria-label={label} />
      )}
    </span>
  );
}
