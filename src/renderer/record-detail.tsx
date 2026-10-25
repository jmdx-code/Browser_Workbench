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
  const reason = plan && (attention || plan.reason) ? taskAlertReason(plan, profile) : null;
  const bridge = workspace.records.filter((row) => row.profileId === profile?.id);
  return (
    <div
      className="drawer-layer"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <aside className="drawer drawer-wide" aria-label="任务详情">
        <header className="drawer-head">
          <div>
            <h2>{profile?.browserName ?? profile?.alias ?? '浏览器'}</h2>
            <p className="muted">
              {plan ? plan.snapshot.name + ' · v' + plan.version : '任务详情'}
              {profile?.account.id ? ' · ' + profile.account.id : ''}
            </p>
          </div>
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
              key={profile.id + ':' + planId}
              profileId={profile.id}
              initialPlanId={planId}
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
          {profile && (
            <details className="drawer-section">
              <summary>原生结果核对</summary>
              <NativeReviewPanel key={'native-' + profile.id} profile={profile} />
            </details>
          )}
          {profile && (
            <details className="drawer-section">
              <summary>桥接记录 · {bridge.length}</summary>
              <p className="muted">以下记录来自桥接验证，不代表 Facebook 业务完成。</p>
              <div className="record-list">
                {bridge.map((row) => (
                  <article className="record" key={row.kind + row.id}>
                    <time>{new Date(row.updatedAt).toLocaleString()}</time>
                    <span className="pill pill-idle">{resultNames[row.status] ?? row.status}</span>
                    <p>{row.summary}</p>
                  </article>
                ))}
                {!bridge.length && <p className="muted">暂无桥接记录</p>}
              </div>
            </details>
          )}
        </div>
      </aside>
    </div>
  );
}
