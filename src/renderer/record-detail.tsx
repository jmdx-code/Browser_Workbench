import { useEffect } from 'react';
import { profileDisplayName, type Profile, type Workspace } from '../shared/contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import type { Plan, TaskCommand } from '../shared/task-contracts.js';
import { IconClose, IconEdit, IconLayers } from './icons.js';
import {
  inspectionAvatarURL,
  inspectionDisplayName,
  inspectionPresentation,
} from './inspection-presentation.js';
import { Btn } from './modules/shared/module-ui.js';
import { ProfileAvatar } from './profile-avatar.js';
import { attentionPlans, isResourceTaskIssue, taskAlertReason } from './task-alerts.js';
import { TaskHistoryPanel } from './task-history.js';
import { UI_DANGER_TEXT, UI_MUTED } from './ui/primitives.js';

const RESULT_NAMES: Record<string, string> = {
  VERIFIED: '已核验',
  ACKNOWLEDGED: '已派发 · 待核验',
  UNKNOWN: '结果未确认（已防重）',
  FAILED: '失败',
  INTERRUPTED: '已中断',
  PREPARED: '等待执行',
  RUNNING: '执行中',
  DISPATCHING: '正在派发',
  CANCELLED: '已取消',
};
const DETAILS_CLS =
  'mt-3 rounded-xl border border-[var(--line)] bg-white [&>summary]:cursor-pointer [&>summary]:px-3.5 [&>summary]:py-3 [&>summary]:text-xs [&>summary]:font-semibold [&>summary]:text-slate-800 [&[open]>summary]:border-b [&[open]>summary]:border-[var(--line)] [&>:not(summary)]:mx-3.5 [&>:not(summary)]:my-3';

export function RecordDetailDrawer(p: {
  profile: Profile | undefined;
  planId: string;
  round?: number | undefined;
  plan: Plan | undefined;
  workspace: Workspace;
  inspection: Inspection | undefined;
  inspectionAvailable: boolean;
  inspectionError: string;
  busy: boolean;
  onClose: () => void;
  onCommand: (command: TaskCommand['command'], plans: TaskCommand['plans']) => void;
  onRename: (profile: Profile) => void;
  onReadInspections: () => void;
  onCheck: (ids: string[]) => void;
  onResources: (combinationId: string) => void;
}) {
  const { profile, plan, workspace, onClose } = p;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        !document.querySelector(
          'dialog[open], .modal-backdrop, .popover-panel, .topbar-concurrency-popover',
        )
      )
        onClose();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  const attention = plan && attentionPlans([plan], workspace.profiles).length > 0;
  const reason =
    plan && !['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state) && attention
      ? taskAlertReason(plan, profile)
      : null;
  const bridge = workspace.records.filter((row) => row.profileId === profile?.id);
  const status = profile
    ? inspectionPresentation(profile, p.inspection, p.inspectionAvailable)
    : null;
  const name = profile ? inspectionDisplayName(profile, p.inspection, p.inspectionAvailable) : null;
  const rows: [string, string][] = profile
    ? [
        [
          '上次检查',
          p.inspectionAvailable && p.inspection?.checkedAt != null
            ? new Date(p.inspection.checkedAt).toLocaleString()
            : '暂无可用结果',
        ],
        [
          '账号身份',
          profile.account.state === 'logged-in' && profile.account.id
            ? `${profile.account.id}（最近只读检查；执行前重新核验）`
            : '当前身份未确认',
        ],
        ['显示名称', name ?? '暂无有效的名称观察'],
        [
          '名称来源',
          name
            ? profile.account.state === 'logged-in'
              ? 'Facebook当前原生账号与首页创建入口一致'
              : '最近只读检查；仅供显示'
            : '尚未取得支持的来源',
        ],
        [
          '头像来源',
          inspectionAvatarURL(profile, p.inspection, p.inspectionAvailable)
            ? 'Facebook首页顶部个人主页入口；仅供显示'
            : '暂无有效的头像观察',
        ],
        ['浏览器插件', profile.extensionVersion ?? '离线'],
      ]
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-slate-900/35 backdrop-blur-[1px]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside
        role="dialog"
        aria-modal="true"
        className="flex h-full w-full max-w-[680px] flex-col border-l border-slate-200 bg-slate-50/40 shadow-2xl"
        aria-label="任务详情"
      >
        <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3.5">
          <h2 className="m-0 min-w-0 truncate text-[15px] font-semibold text-slate-900">
            {profile ? profileDisplayName(profile) : '任务详情'}
          </h2>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {profile && (
              <Btn onClick={() => p.onRename(profile)}>
                <IconEdit size={14} /> 别名
              </Btn>
            )}
            <Btn v="icon" aria-label="关闭" onClick={onClose}>
              <IconClose />
            </Btn>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 p-4">
          {reason && (
            <div
              className={`mb-3 grid justify-items-start gap-1.5 rounded-xl border px-3.5 py-3 text-xs ${
                attention
                  ? 'border-amber-200 bg-amber-50 text-amber-900'
                  : 'border-[var(--line)] bg-white text-[var(--text)]'
              }`}
            >
              <strong className="font-semibold">{reason.summary}</strong>
              <p className="m-0 leading-relaxed text-[var(--text-2)]">{reason.next}</p>
              {plan &&
                isResourceTaskIssue(plan.reason) &&
                plan.snapshot.steps.some(
                  (step) => step.type === 'post' && step.resourceMode === 'table',
                ) && (
                  <Btn disabled={p.busy} onClick={() => p.onResources(plan.combinationId)}>
                    <IconLayers size={14} /> 检查组合资源
                  </Btn>
                )}
            </div>
          )}
          {profile ? (
            <TaskHistoryPanel
              key={`${profile.id}:${p.planId}:${p.round ?? ''}`}
              profileId={profile.id}
              initialPlanId={p.planId}
              {...(p.round ? { initialRound: p.round } : {})}
              browserName={profileDisplayName(profile)}
              avatar={
                <ProfileAvatar
                  url={inspectionAvatarURL(profile, p.inspection, p.inspectionAvailable)}
                  online={Boolean(profile.online)}
                />
              }
              diagnosticContent={() => (
                <details className={DETAILS_CLS}>
                  <summary>桥接记录 · {bridge.length}</summary>
                  <p className={UI_MUTED}>桥接回执不代表业务完成。</p>
                  {bridge.map((row) => (
                    <article
                      className="mt-2 rounded-lg border border-[var(--line)] bg-slate-50/70 p-2.5 text-xs"
                      key={row.kind + row.id}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <time className="text-[11px] text-[var(--text-3)]">
                          {new Date(row.updatedAt).toLocaleString()}
                        </time>
                        <span className="font-semibold text-slate-800">
                          {RESULT_NAMES[row.status] ?? row.status}
                        </span>
                      </div>
                      <p className="mt-1 mb-0 text-[var(--text-2)]">{row.summary}</p>
                    </article>
                  ))}
                </details>
              )}
              busy={p.busy}
              onCommand={p.onCommand}
            />
          ) : (
            <p className={UI_MUTED}>这份浏览器已不在当前列表。</p>
          )}
          {profile && status && (
            <details className={DETAILS_CLS}>
              <summary>账号状态</summary>
              <section
                className="mb-3 rounded-lg border border-[var(--line)] bg-white p-3.5 text-xs"
                aria-label="Facebook检查详情"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="m-0 text-[13px] font-semibold text-slate-900">Facebook 状态</h3>
                  <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                    {status.title}
                  </span>
                </div>
                <p className="my-2.5 leading-relaxed wrap-anywhere text-[var(--text-2)]">
                  {status.detail}
                </p>
                <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                  {rows.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-[var(--text-3)]">{k}</dt>
                      <dd className="m-0 wrap-anywhere text-slate-800">{v}</dd>
                    </div>
                  ))}
                </dl>
                {p.inspectionError && (
                  <p className={`${UI_DANGER_TEXT} mt-2.5`} role="status">
                    {p.inspectionError}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Btn onClick={p.onReadInspections} disabled={p.busy}>
                    重新读取结果
                  </Btn>
                  <Btn
                    onClick={() => p.onCheck([profile.id])}
                    disabled={p.busy || !status.canCheck}
                  >
                    检查这份 FB 状态
                  </Btn>
                </div>
                <small className="mt-2.5 block leading-relaxed text-[var(--text-3)]">
                  连接就绪后自动检查一次；手动检查会创建专用 Facebook
                  页，读取后关闭。重新读取结果不打开页面。
                </small>
              </section>
            </details>
          )}
        </div>
      </aside>
    </div>
  );
}
