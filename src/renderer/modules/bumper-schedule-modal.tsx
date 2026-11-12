import { useState } from 'react';
import type { BumperScheduledTask, BumperTaskStatus } from '../../shared/group-bumper.js';

function toLocalDateTimeInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function bumperTaskBadge(status: BumperTaskStatus): { label: string; cls: string } {
  switch (status) {
    case 'scheduled':
      return { label: '⏰ 定时待启动', cls: 'is-scheduled' };
    case 'running':
      return { label: '▶ 正在顶贴', cls: 'is-running' };
    case 'completed':
      return { label: '✓ 已完成', cls: 'is-completed' };
    case 'failed':
      return { label: '✕ 失败', cls: 'is-failed' };
    case 'cancelled':
      return { label: '■ 已取消', cls: 'is-cancelled' };
  }
}

export function BumperScheduleModal({
  mode,
  profileIds,
  offlineSelectedCount,
  groupIds,
  pageIds,
  busy,
  onClose,
  onSubmit,
}: {
  mode: 'group-bumper' | 'page-bumper';
  profileIds: readonly string[];
  offlineSelectedCount: number;
  groupIds: readonly string[];
  pageIds: readonly string[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (scheduledAt: number) => Promise<boolean>;
}) {
  const pageMode = mode === 'page-bumper';
  const [scheduledDateTime, setScheduledDateTime] = useState<string>(() =>
    toLocalDateTimeInputValue(Date.now() + 30 * 60_000),
  );
  const [localError, setLocalError] = useState('');

  const applyQuickOffset = (minutesFromNow: number) => {
    setScheduledDateTime(toLocalDateTimeInputValue(Date.now() + minutesFromNow * 60_000));
  };

  const applyFixedHour = (daysAhead: number, hour: number) => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, 0, 0, 0);
    if (d.getTime() <= Date.now()) {
      d.setDate(d.getDate() + 1);
    }
    setScheduledDateTime(toLocalDateTimeInputValue(d.getTime()));
  };

  const handleConfirm = async () => {
    setLocalError('');
    if (profileIds.length === 0) {
      setLocalError('请先在左侧列表勾选至少 1 个浏览器账号');
      return;
    }
    if (!pageMode && groupIds.length === 0) {
      setLocalError('请先选择至少 1 个目标小组');
      return;
    }
    if (pageIds.length === 0) {
      setLocalError(pageMode ? '请先选择至少 1 个目标专页' : '请先选择至少 1 个目标主页');
      return;
    }
    const parsedMs = new Date(scheduledDateTime).getTime();
    if (!Number.isFinite(parsedMs) || parsedMs <= Date.now()) {
      setLocalError('请选择未来的定时开始时间');
      return;
    }
    const ok = await onSubmit(parsedMs);
    if (ok) onClose();
  };

  const title = pageMode ? '创建专页顶贴定时任务' : '创建小组顶贴定时任务';

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal bumper-modal" style={{ maxWidth: '520px', width: '92vw' }}>
        <div className="bumper-modal-heading">
          <h2>{title}</h2>
          <button type="button" className="btn" aria-label="关闭弹窗" onClick={onClose}>
            ×
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', padding: '4px 0' }}>
          <div className="poster-mode-hint-box">
            <p style={{ margin: 0 }}>
              本次定时将使用已勾选的 <strong>{profileIds.length}</strong> 个浏览器账号
              {offlineSelectedCount > 0
                ? `（含当前离线 ${offlineSelectedCount} 个，到点自动启动连接）`
                : ''}
              ，执行{' '}
              {pageMode ? (
                <>
                  <strong>{pageIds.length}</strong> 个目标专页顶贴
                </>
              ) : (
                <>
                  <strong>{groupIds.length}</strong> 个小组 × <strong>{pageIds.length}</strong>{' '}
                  个主页顶贴
                </>
              )}
              。
            </p>
          </div>

          <div className="poster-schedule-box">
            <label className="poster-schedule-field">
              <span>预定开始时间：</span>
              <input
                type="datetime-local"
                aria-label="预定开始顶贴时间"
                value={scheduledDateTime}
                onChange={(e) => setScheduledDateTime(e.target.value)}
              />
            </label>
            <div className="poster-schedule-presets">
              <span>快捷：</span>
              {[15, 30, 60, 120].map((mins) => (
                <button
                  key={mins}
                  type="button"
                  className="btn btn-sm"
                  onClick={() => applyQuickOffset(mins)}
                >
                  {mins >= 60 ? `${mins / 60}小时后` : `${mins}分钟后`}
                </button>
              ))}
              <button type="button" className="btn btn-sm" onClick={() => applyFixedHour(0, 20)}>
                20:00
              </button>
              <button type="button" className="btn btn-sm" onClick={() => applyFixedHour(1, 9)}>
                明天 09:00
              </button>
            </div>
            <p className="poster-schedule-note">
              • 到点后将按当前保存的顶贴策略参数自动执行本轮任务；
              <br />•
              若所选已装插件浏览器处于离线关闭状态，到点时将按正常启动参数自动唤醒打开并等待连接就绪后开始顶贴。
            </p>
          </div>

          {localError && (
            <p className="form-error" role="alert" style={{ margin: 0 }}>
              {localError}
            </p>
          )}
        </div>

        <div className="bumper-modal-footer">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleConfirm()}
          >
            {busy ? '正在提交…' : '⏰ 确认创建定时任务'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BumperScheduledTasksBar({
  mode,
  tasks,
  busy,
  onCancelTask,
  onDeleteTask,
}: {
  mode: 'group-bumper' | 'page-bumper';
  tasks: readonly BumperScheduledTask[];
  busy: boolean;
  onCancelTask: (taskId: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const modeTasks = tasks.filter((t) => t.mode === mode);
  const activeTasks = modeTasks.filter((t) => t.status === 'scheduled' || t.status === 'running');
  const finishedTasks = modeTasks
    .filter((t) => t.status !== 'scheduled' && t.status !== 'running')
    .slice(0, 6);

  if (activeTasks.length === 0 && finishedTasks.length === 0) return null;

  const visibleTasks = showHistory ? [...activeTasks, ...finishedTasks] : activeTasks;
  if (visibleTasks.length === 0 && !showHistory) {
    return (
      <div
        className="poster-tasks-banner"
        style={{ margin: '0 0 10px 0', padding: '6px 12px' }}
        aria-label="最近定时顶贴记录"
      >
        <div
          className="poster-tasks-banner-title"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span className="muted" style={{ fontSize: '12px' }}>
            暂无待执行的定时顶贴任务（最近已完成/结束 {finishedTasks.length} 条）
          </span>
          <button type="button" className="btn btn-sm" onClick={() => setShowHistory(true)}>
            查看最近定时记录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="poster-tasks-banner"
      style={{ margin: '0 0 10px 0' }}
      aria-label={mode === 'page-bumper' ? '专页顶贴定时任务' : '小组顶贴定时任务'}
    >
      <div
        className="poster-tasks-banner-title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <strong>
          {mode === 'page-bumper' ? '专页顶贴定时任务' : '小组顶贴定时任务'} ({activeTasks.length}{' '}
          待跑/运行中)
        </strong>
        {finishedTasks.length > 0 && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowHistory((prev) => !prev)}
          >
            {showHistory ? '收起历史' : `历史记录 (${finishedTasks.length})`}
          </button>
        )}
      </div>
      <div className="poster-tasks-banner-list">
        {visibleTasks.map((t) => {
          const badge = bumperTaskBadge(t.status);
          const scopeLabel =
            t.mode === 'page-bumper'
              ? `${t.profileIds.length}号 × ${t.pageIds.length}专页`
              : `${t.profileIds.length}号 × ${t.groupIds.length}组 × ${t.pageIds.length}主页`;
          return (
            <div key={t.id} className={'poster-task-pill ' + badge.cls}>
              <span className={'poster-task-badge ' + badge.cls}>{badge.label}</span>
              <span className="poster-task-pill-caption">{scopeLabel}</span>
              <span className="poster-task-pill-meta">
                预定 {new Date(t.scheduledAt).toLocaleString()}
                {t.statusReason ? ` · ${t.statusReason}` : ''}
              </span>
              <div className="poster-task-pill-actions">
                {t.status === 'scheduled' || t.status === 'running' ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={busy}
                    onClick={() => void onCancelTask(t.id)}
                  >
                    {t.status === 'scheduled' ? '取消定时' : '停止'}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => void onDeleteTask(t.id)}
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
