import type { z } from 'zod';
import type { TaskProgress, TaskStepBudget } from '../shared/task-contracts.js';

type Budget = z.infer<typeof TaskStepBudget>;
const duration = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function MiniBar({ max, value, label }: { max: number; value: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className="inline-block h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-slate-200"
    >
      <span className="block h-full rounded-full bg-[var(--brand)]" style={{ width: `${pct}%` }} />
    </span>
  );
}

export function TaskProgressView({
  type,
  friendAction,
  progress,
  budget,
  maxLikes,
  compact = false,
}: {
  type: 'feed' | 'video' | 'marketplace' | 'post' | 'friends';
  friendAction?: 'accept' | 'add_suggested' | undefined;
  progress: z.infer<typeof TaskProgress>;
  budget?: Budget;
  maxLikes?: number;
  compact?: boolean;
}) {
  if (type === 'friends') {
    const accepted = progress.accepted ?? 0;
    const maximum = budget?.kind === 'friends' ? budget.count : null;
    const isAdd = friendAction === 'add_suggested';
    const prefix = compact ? '' : isAdd ? '添加好友 ' : '确认好友 ';
    const unit = isAdd ? '人' : '个';
    const label =
      maximum !== null
        ? `${prefix}${accepted}/${maximum} ${unit}`
        : `${prefix}${accepted} ${unit}（全部）`;
    return (
      <span
        className={`task-progress flex items-center tabular-nums ${compact ? 'compact gap-1.5 text-[11px]' : 'gap-2'}`}
      >
        <span>{label}</span>
        {maximum !== null && !compact && <MiniBar max={maximum} value={accepted} label={label} />}
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
    <span
      className={`task-progress flex items-center tabular-nums ${compact ? 'compact gap-1.5 text-[11px]' : 'gap-2'}`}
    >
      <span>{label}</span>
      {maximum !== null && !compact && <MiniBar max={maximum} value={value} label={label} />}
    </span>
  );
}
