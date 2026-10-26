import { ProfileAvatar } from './profile-avatar.js';
import { inspectionAvatarURL } from './inspection-presentation.js';
import { useEffect } from 'react';
import type { Profile, Workspace } from '../shared/contracts.js';
import type { Plan, TaskCommand } from '../shared/task-contracts.js';
import type { Inspection } from '../shared/profile-inspection.js';
import { TaskHistoryPanel } from './task-history.js';
import { ProfileInspectionPanel } from './profile-inspection-panel.js';
import { NativeReviewPanel } from './native-review-panel.js';
import { attentionPlans, isResourceTaskIssue, taskAlertReason } from './task-alerts.js';
import { resultNames } from './status-names.js';
import { IconClose, IconEdit, IconLayers } from './icons.js';

// Right-side drawer replacing the old per-browser records page.
export function RecordDetailDrawer({
  profile,
  planId,
  round,
  plan,
  workspace,
  inspection,
  inspectionAvailable,
  inspectionError,
  busy,
  onClose,
  onCommand,
  onRename,
  onReadInspections,
  onCheck,
  onResources,
}: {
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
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) onClose();
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
  return (
    <div
      className="drawer-layer"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="drawer drawer-wide" aria-label="任务详情">
        <header className="drawer-head">
          {profile && (
            <button className="btn btn-sm" onClick={() => onRename(profile)}>
              <IconEdit size={14} /> 别名
            </button>
          )}
          <button className="btn btn-icon btn-ghost" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div className="drawer-body">
          {reason && (
            <div className={'callout ' + (attention ? 'callout-warn' : 'callout-info')}>
              <strong>{reason.summary}</strong>
              <p>{reason.next}</p>
              {plan &&
                isResourceTaskIssue(plan.reason) &&
                plan.snapshot.steps.some(
                  (step) => step.type === 'post' && step.resourceMode === 'table',
                ) && (
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => onResources(plan.combinationId)}
                  >
                    <IconLayers size={14} /> 检查组合资源
                  </button>
                )}
            </div>
          )}
          {profile ? (
            <TaskHistoryPanel
              key={profile.id + ':' + planId + ':' + (round ?? '')}
              profileId={profile.id}
              initialPlanId={planId}
              {...(round ? { initialRound: round } : {})}
              browserName={profile.browserName ?? profile.alias}
              avatar={
                <ProfileAvatar
                  url={inspectionAvatarURL(profile, inspection, inspectionAvailable)}
                  online={Boolean(profile.online)}
                />
              }
              diagnosticContent={(requiresReview) => (
                <>
                  <details className="drawer-section" open={requiresReview}>
                    <summary>原生结果核对</summary>
                    <NativeReviewPanel key={'native-' + profile.id} profile={profile} />
                  </details>
                  <details className="drawer-section">
                    <summary>桥接记录 · {bridge.length}</summary>
                    <p className="muted">桥接回执不代表业务完成。</p>
                    {bridge.map((row) => (
                      <article className="record" key={row.kind + row.id}>
                        <time>{new Date(row.updatedAt).toLocaleString()}</time>
                        <span>{resultNames[row.status] ?? row.status}</span>
                        <p>{row.summary}</p>
                      </article>
                    ))}
                  </details>
                </>
              )}
              busy={busy}
              onCommand={onCommand}
            />
          ) : (
            <p className="muted">这份浏览器已不在当前列表。</p>
          )}
          {profile && (
            <details className="drawer-section">
              <summary>账号状态</summary>
              <ProfileInspectionPanel
                profile={profile}
                inspection={inspection}
                available={inspectionAvailable}
                error={inspectionError}
                busy={busy}
                onRead={onReadInspections}
                onCheck={() => onCheck([profile.id])}
              />
            </details>
          )}
        </div>
      </aside>
    </div>
  );
}
