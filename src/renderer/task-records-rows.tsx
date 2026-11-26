import type { KeyboardEvent, ReactNode } from 'react';
import { endedTask, type groupTaskRecords } from '../domain/task-run-records.js';
import type { Profile } from '../shared/contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import { isMarketplaceUnavailableSkip, isSuccessfulTaskStep } from '../shared/task-step-outcome.js';
import { copyTextToClipboard } from './clipboard.js';
import { inspectionAvatarURL } from './inspection-presentation.js';
import { Btn } from './modules/shared/module-ui.js';
import type { UnifiedActivityItem } from './modules/unified-activity-records.js';
import { ProfileAvatar } from './profile-avatar.js';
import { taskReasonDescription } from './task-alerts.js';
import { runSummary, stepResultLabel } from './task-record-summary.js';
import { UI_CHECKBOX } from './ui/primitives.js';

export type RunGroup = ReturnType<typeof groupTaskRecords>[number];

export const RECORD_GRID_CLS =
  'grid grid-cols-[28px_minmax(170px,1.4fr)_110px_minmax(150px,1.2fr)_minmax(180px,1.6fr)_130px] items-start gap-3 px-3.5 py-2.5 max-[1080px]:grid-cols-[28px_minmax(140px,1fr)_96px_minmax(130px,1fr)_110px] max-[1080px]:[&>:nth-child(5)]:hidden max-[760px]:grid-cols-[24px_minmax(0,1fr)_auto] max-[760px]:[&>:nth-child(4)]:hidden max-[760px]:[&>:nth-child(5)]:hidden max-[760px]:[&>:nth-child(6)]:hidden';

const ROW_BORDER_TONE: Record<string, string> = {
  ok: 'border-l-emerald-500',
  err: 'border-l-rose-500',
  run: 'border-l-blue-500',
  queue: 'border-l-amber-400',
  idle: 'border-l-slate-300',
};

const PILL_TONE: Record<string, string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  err: 'border-rose-200 bg-rose-50 text-rose-700',
  run: 'border-blue-200 bg-blue-50 text-blue-700',
  queue: 'border-amber-200 bg-amber-50 text-amber-800',
  idle: 'border-slate-200 bg-slate-100 text-slate-600',
};

const MODULE_BADGE_TONE: Record<string, string> = {
  'active-accounts': 'border-blue-200 bg-blue-50 text-blue-700',
  'google-sheets': 'border-emerald-200 bg-emerald-50 text-emerald-700',
  'group-inviter': 'border-violet-200 bg-violet-50 text-violet-700',
};

export const planStatus: Record<string, { label: string; tone: string }> = {
  QUEUED: { label: '排队中', tone: 'queue' },
  RUNNING: { label: '执行中', tone: 'run' },
  COMPLETED: { label: '已完成', tone: 'ok' },
  FAILED: { label: '失败', tone: 'err' },
  STOPPED: { label: '已停止', tone: 'idle' },
};

const shortTime = (value: number) => {
  const d = new Date(value),
    t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? t
    : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${t}`;
};

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1
    ? '不到 1 分钟'
    : m < 60
      ? `${m} 分钟`
      : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}`;
};

function RecordRowFrame(p: {
  rowClass: string;
  tone: string;
  clickable?: boolean;
  tabIndex?: number;
  onClick?: () => void;
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void;
  checkCell: ReactNode;
  profile?: Profile;
  inspection?: Inspection;
  profileName: string;
  moduleBadge?: { id: string; label: string };
  subTitle: string;
  statusTone: string;
  statusLabel: string;
  statusExtra?: ReactNode;
  pillsCell: ReactNode;
  noteHeading?: string;
  noteText: string;
  timestamp: number;
  timeSub?: string;
  timeAction?: ReactNode;
}) {
  const borderTone = ROW_BORDER_TONE[p.tone] ?? ROW_BORDER_TONE.idle;
  const pillCls = PILL_TONE[p.statusTone] ?? PILL_TONE.idle;
  const fbId = p.inspection?.state === 'OBSERVED' ? p.inspection.account.id : p.profile?.account.id;
  return (
    <div
      className={`${p.rowClass} ${RECORD_GRID_CLS} border-b border-slate-100 border-l-[3px] ${borderTone} text-xs transition-colors hover:bg-slate-50/80 ${p.clickable ? 'cursor-pointer focus-visible:bg-blue-50/40 focus-visible:outline-none' : ''}`}
      role="row"
      tabIndex={p.tabIndex}
      onClick={p.onClick}
      onKeyDown={p.onKeyDown}
    >
      <span
        role="cell"
        className="flex items-center justify-center pt-0.5"
        onClick={(e) => e.stopPropagation()}
      >
        {p.checkCell}
      </span>
      <span role="cell" className="flex min-w-0 items-start gap-2.5">
        <ProfileAvatar
          url={p.profile ? inspectionAvatarURL(p.profile, p.inspection, true) : null}
          online={Boolean(p.profile?.online)}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <strong className="flex min-w-0 items-center gap-1.5 font-semibold text-slate-900">
            {p.moduleBadge && (
              <span
                className={`inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] font-semibold ${MODULE_BADGE_TONE[p.moduleBadge.id] ?? 'border-slate-200 bg-slate-100 text-slate-700'}`}
              >
                {p.moduleBadge.label}
              </span>
            )}
            <span className="truncate" title={p.profileName}>
              {p.profileName}
            </span>
          </strong>
          <small className="truncate text-[11px] text-[var(--text-2)]">{p.subTitle}</small>
          {fbId && (
            <small className="max-w-full truncate font-mono text-[10px] text-[var(--text-3)]">
              {fbId}
            </small>
          )}
        </span>
      </span>
      <span role="cell" className="flex flex-col items-start gap-1">
        <span
          className={`pill pill-${p.statusTone} inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${pillCls}`}
        >
          {p.statusLabel}
        </span>
        {p.statusExtra}
      </span>
      <span role="cell" className="flex min-w-0 flex-wrap gap-1">
        {p.pillsCell}
      </span>
      <span role="cell" className="flex min-w-0 flex-col gap-0.5 text-[var(--text-2)]">
        {p.noteHeading && <strong className="font-semibold text-slate-900">{p.noteHeading}</strong>}
        <span className="leading-relaxed break-words">{p.noteText}</span>
      </span>
      <span role="cell" className="flex flex-col items-end gap-0.5 text-right tabular-nums">
        <time className="font-medium text-slate-900" title={new Date(p.timestamp).toLocaleString()}>
          {shortTime(p.timestamp)}
        </time>
        {p.timeSub && (
          <small className="truncate text-[11px] text-[var(--text-3)]">{p.timeSub}</small>
        )}
        {p.timeAction && <div className="mt-0.5">{p.timeAction}</div>}
      </span>
    </div>
  );
}

export function ActiveAccountGroupRow(p: {
  group: RunGroup;
  showModuleBadge: boolean;
  byProfile: ReadonlyMap<string, Profile>;
  byInspection: ReadonlyMap<string, Inspection>;
  selected: ReadonlySet<string>;
  now: number;
  onOpen: (profileId: string, planId: string, round: number) => void;
  onToggleSelected: (ids: string[], checked: boolean) => void;
  onRequestDelete: (payload: { kind: 'task'; ids: string[]; label: string }) => void;
}) {
  const row = p.group.rows[0];
  if (!row) return null;
  const profile = p.byProfile.get(row.profileId),
    state = p.group.state,
    status = planStatus[state] ?? planStatus.QUEUED;
  const ids = p.group.rows.map((r) => r.stepId),
    ended = endedTask(row.planState),
    reason = row.planReason ? taskReasonDescription(row.planReason)?.summary : null;
  const statusLabel =
    state === 'FAILED'
      ? '执行异常'
      : state === 'COMPLETED' &&
          p.group.rows.some((s) => isMarketplaceUnavailableSkip(s.type, s.status, s.outcome))
        ? '已完成（含正常跳过）'
        : (status?.label ?? '');
  const profileLabel = profile?.browserName ?? profile?.alias ?? '已移除的浏览器';
  const tone = status?.tone ?? 'queue';

  return (
    <RecordRowFrame
      rowClass={`records-row run-record-row tone-${tone}`}
      tone={tone}
      clickable
      tabIndex={0}
      onClick={() => p.onOpen(row.profileId, row.planId, row.round)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget)
          p.onOpen(row.profileId, row.planId, row.round);
      }}
      checkCell={
        <input
          type="checkbox"
          className={UI_CHECKBOX}
          aria-label={`选择任务 ${row.combinationName} 第${row.round}轮`}
          disabled={
            !ended ||
            (!ids.every((id) => p.selected.has(id)) &&
              p.selected.size + ids.filter((id) => !p.selected.has(id)).length > 1000)
          }
          checked={ids.every((id) => p.selected.has(id))}
          onChange={(e) => p.onToggleSelected(ids, e.target.checked)}
        />
      }
      profile={profile}
      inspection={p.byInspection.get(row.profileId)}
      profileName={profileLabel}
      moduleBadge={p.showModuleBadge ? { id: 'active-accounts', label: '活跃账号' } : undefined}
      subTitle={`${row.combinationName}${row.round > 1 ? ` · 第 ${row.round} 轮` : ''}`}
      statusTone={tone}
      statusLabel={statusLabel}
      statusExtra={
        state === 'STOPPED' ? (
          <small className="text-[11px] text-[var(--text-3)]">
            完成 {p.group.completed}/{ids.length}
          </small>
        ) : undefined
      }
      pillsCell={p.group.rows.map((step) => {
        const stepTone = isSuccessfulTaskStep(step.type, step.status, step.outcome)
          ? 'ok'
          : step.status === 'FAILED'
            ? 'err'
            : step.status === 'ACTIVE' && !ended
              ? 'run'
              : 'idle';
        return (
          <span
            key={step.stepId}
            className={`run-step-pill pill-${stepTone} inline-flex max-w-full items-center truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${PILL_TONE[stepTone] ?? PILL_TONE.idle}`}
            title={stepResultLabel(step)}
          >
            {stepResultLabel(step)}
          </span>
        );
      })}
      noteHeading={
        state === 'STOPPED'
          ? `手动停止（已完成 ${p.group.completed}/${ids.length} 项）`
          : state === 'FAILED'
            ? (reason ?? '执行异常，请查看步骤原因')
            : undefined
      }
      noteText={runSummary(p.group.rows)}
      timestamp={p.group.startedAt ?? row.planCreatedAt}
      timeSub={
        p.group.startedAt === null
          ? '未开始'
          : '用时 ' +
            span((p.group.finishedAt ?? (ended ? row.planUpdatedAt : p.now)) - p.group.startedAt)
      }
      timeAction={
        ended ? (
          <Btn
            onClick={(e) => {
              e.stopPropagation();
              p.onRequestDelete({
                kind: 'task',
                ids,
                label: `${profile?.browserName ?? profile?.alias ?? '该浏览器'} · ${row.combinationName}`,
              });
            }}
          >
            删除
          </Btn>
        ) : undefined
      }
    />
  );
}

export function UnifiedNonTaskRow(p: {
  item: UnifiedActivityItem;
  showModuleBadge: boolean;
  byProfile: ReadonlyMap<string, Profile>;
  byInspection: ReadonlyMap<string, Inspection>;
  onNotify?: (msg: string) => void;
}) {
  const { item } = p;
  return (
    <RecordRowFrame
      rowClass={`records-row run-record-row unified-module-row tone-${item.tone}`}
      tone={item.tone}
      checkCell={<span className="inline-block h-4 w-4" aria-hidden="true" />}
      profile={p.byProfile.get(item.profileId)}
      inspection={p.byInspection.get(item.profileId)}
      profileName={item.profileName}
      moduleBadge={p.showModuleBadge ? { id: item.moduleId, label: item.moduleLabel } : undefined}
      subTitle={item.title}
      statusTone={item.tone}
      statusLabel={item.statusLabel}
      pillsCell={
        <span
          className={`run-step-pill pill-${item.tone} inline-flex max-w-full items-center truncate rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${PILL_TONE[item.tone] ?? PILL_TONE.idle}`}
          title={item.targetLabel}
        >
          {item.targetLabel}
        </span>
      }
      noteText={item.detailText}
      timestamp={item.timestamp}
      timeAction={
        item.postUrl ? (
          <div className="flex justify-end gap-1.5">
            <Btn
              title={item.postUrl}
              onClick={(e) => {
                e.stopPropagation();
                void copyTextToClipboard(item.postUrl ?? '').then(
                  () => p.onNotify?.('已复制帖子链接'),
                  () => p.onNotify?.('复制失败，请检查剪贴板权限'),
                );
              }}
            >
              复制链接
            </Btn>
          </div>
        ) : undefined
      }
    />
  );
}
