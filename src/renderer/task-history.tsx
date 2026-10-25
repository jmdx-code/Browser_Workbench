import { useEffect, useState } from 'react';
import type { History, TaskCommand } from '../shared/task-contracts.js';
import { api } from './api.js';
import { ArchiveManagementPanel } from './archive-management.js';
import { exportTaskHistory } from './task-history-export.js';
import { TaskProgressView } from './task-progress.js';
import { taskReasonDescription } from './task-alerts.js';
import { taskTimingLabel } from '../shared/task-timing.js';
import { taskHistoryNeedsPolling } from './task-history-polling.js';

declare const __WORKBENCH_VERSION__: string;

const states: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '执行中',
  PAUSING: '正在暂停',
  PAUSED: '已暂停',
  STOPPING: '正在停止',
  STOPPED: '已停止',
  REVIEW: '待核对',
  COMPLETED: '已完成',
  FAILED: '失败',
  PREPARED: '待发送',
  DISPATCHING: '发送中',
  ACKNOWLEDGED: '输入已接收',
  VERIFIED: '效果已核验',
  UNKNOWN: '结果未知',
  CANCELLED: '已取消',
};
const actions: Record<string, string> = {
  click: '点击控件',
  typeText: '填写正文',
  uploadMedia: '上传媒体',
  observe: '读取页面',
  activateTab: '激活任务页',
  browseNavigate: '打开浏览任务页',
  browsePlay: '播放当前视频',
  browseScroll: '滚动浏览页面',
  closeTab: '关闭任务页',
  createTaskTab: '创建任务页',
  createTab: '创建测试页',
  frameProbe: '读取页面结构',
  mediaClick: '点击媒体',
  windowState: '调整窗口',
};
const steps = {
  video: '浏览 Reels',
  feed: '浏览首页',
  post: '发布内容',
  marketplace: '浏览商城',
  friends: '接受好友请求',
};
const events: Record<string, string> = {
  ...states,
  ASSIGNED: '已分配任务',
  ROUND_CREATED: '已固定本轮顺序',
  CONTROL_CONFIRMED: '浏览器已确认停止控制',
  END_REQUESTED: '正在结束未确认任务',
  END_CONFIRMED: '当前控制已停，失败任务已结束',
  OPERATION_PREPARED: '操作已准备',
  OPERATION_DISPATCHING: '操作开始发送',
  OPERATION_BOUND: '已绑定当前浏览器会话',
  OPERATION_ACKNOWLEDGED: '浏览器已接收输入',
  OPERATION_RECONCILED: '原操作已核对',
  ENDED_SUBMISSION_BUSINESS_REVIEWED: '结束后已核对发布结果',
  OPERATION_VERIFIED: '操作效果已核验',
  OPERATION_FAILED: '操作失败',
  OPERATION_UNKNOWN: '操作结果未知',
  OPERATION_CANCELLED: '操作已取消',
  OPERATION_REVIEW_PENDING_CONTROL: '结果未知，等待停止确认',
  CHECKPOINT: '已保存进度',
  STEP_COMPLETED: '子任务完成',
  STEP_FAILED: '子任务失败',
  STEP_SKIPPED: '子任务已跳过',
  STEP_CONTINUATION_READY: '独立后续步骤已就绪',
  CHILD_PAGE_REQUESTED: '已登记结果子页用途',
  CHILD_PAGE_READY: '结果子页归属已核对',
  CHILD_PAGE_CLOSED: '结果子页关闭已确认',
  SCHEDULE_RELEASED: '计划已进入运行队列',
};
export function TaskHistoryPanel({
  profileId,
  initialPlanId,
  busy,
  onCommand,
}: {
  profileId: string;
  initialPlanId?: string;
  busy?: boolean;
  onCommand?: (command: TaskCommand['command'], plans: TaskCommand['plans']) => void;
}) {
  const [history, setHistory] = useState<History | null>(null);
  const [selected, setSelected] = useState<string | null>(initialPlanId ?? null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [exportNotice, setExportNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let poll = true;
    const load = async () => {
      if (pending || controller.signal.aborted || document.hidden) return;
      pending = true;
      setLoading(true);
      try {
        const value = await api.taskHistory(profileId, selected, controller.signal);
        if (value.profileId !== profileId || (selected && value.selectedPlanId !== selected))
          throw Error('TASK_HISTORY_SCOPE_CHANGED');
        if (!controller.signal.aborted) {
          setHistory(value);
          poll = taskHistoryNeedsPolling(value, selected);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted)
          setError('记录读取失败，下面保留的是上次读取结果。可重新读取。');
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (poll) void load();
    }, 5000);
    const visible = () => void load();
    document.addEventListener('visibilitychange', visible);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [profileId, selected, revision]);
  const plan = history?.plans.find((row) => row.id === history.selectedPlanId);
  const unresolved = history?.operations.filter((op) => op.status === 'UNKNOWN') ?? [];
  const controlPending =
    !!plan && ['PAUSING', 'STOPPING'].includes(plan.state) && !plan.controlConfirmed;
  return (
    <section className="task-history" aria-label="业务任务记录" aria-busy={loading}>
      <div className="task-history-heading">
        <h3>业务任务</h3>
        <button
          disabled={loading || !history || !!error}
          onClick={() => {
            if (!history) return;
            try {
              exportTaskHistory(history, __WORKBENCH_VERSION__);
              setExportNotice(
                '已发起导出，请在下载位置查看JSON文件。记录范围与当前页面一致；完整备份另行操作。',
              );
            } catch {
              setExportNotice('导出失败，请重新读取记录后再试。');
            }
          }}
        >
          导出记录
        </button>
        <button disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          重新读取
        </button>
      </div>
      {exportNotice && (
        <p className="muted" role="status">
          {exportNotice}
        </p>
      )}
      {error && (
        <p role="alert" className="task-history-warning">
          {error}
        </p>
      )}
      {!history && !error && <p className="muted">正在读取任务记录…</p>}
      {history?.plans.length === 0 && (
        <p className="muted">这份浏览器还没有业务任务。桥接测试不会计入业务完成。</p>
      )}
      {!!history?.plans.length && (
        <>
          <label className="task-history-select">
            查看任务
            <select
              value={selected ?? ''}
              onChange={(event) => setSelected(event.target.value || null)}
            >
              <option value="">最新任务</option>
              {history.plans.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name} · {new Date(row.createdAt).toLocaleString()} · {states[row.state]}
                </option>
              ))}
            </select>
          </label>
          {plan && (
            <>
              <div className="task-history-summary">
                <strong>{plan.name}</strong>
                <span className={'badge ' + (plan.state === 'REVIEW' ? 'orange' : 'gray')}>
                  {states[plan.state]}
                </span>
                <span>
                  版本 {plan.version} · 第 {plan.round} 轮 · 第 {plan.position + 1} 项
                </span>
              </div>
              {plan.timing && <p className="muted">{taskTimingLabel(plan.timing)}</p>}
              {plan.reason && (
                <details className="task-history-reason">
                  <summary>查看任务原因</summary>
                  <p>
                    {taskReasonDescription(plan.reason)?.summary ?? '查看诊断信息了解具体原因'} ·{' '}
                    {taskReasonDescription(plan.reason)?.next ?? '请根据当前任务状态继续或结束。'}
                  </p>
                  <code>{plan.reason}</code>
                </details>
              )}
              {onCommand && (
                <div className="task-history-heading" aria-label="当前任务控制">
                  <button
                    disabled={busy || !['RUNNING', 'QUEUED', 'PAUSING'].includes(plan.state)}
                    onClick={() =>
                      onCommand('pause', [
                        {
                          profileId,
                          planId: plan.id,
                          expectedState: plan.state,
                          expectedUpdatedAt: plan.updatedAt,
                        },
                      ])
                    }
                  >
                    {plan.state === 'PAUSING' ? '确认暂停' : '暂停'}
                  </button>
                  <button
                    disabled={busy || plan.state !== 'PAUSED'}
                    title={
                      plan.state === 'REVIEW' ? '先核对原操作，不能直接重发' : '沿原进度继续排队'
                    }
                    onClick={() =>
                      onCommand('resume', [
                        {
                          profileId,
                          planId: plan.id,
                          expectedState: plan.state,
                          expectedUpdatedAt: plan.updatedAt,
                        },
                      ])
                    }
                  >
                    继续
                  </button>
                  <button
                    disabled={busy || ['STOPPED', 'COMPLETED', 'FAILED'].includes(plan.state)}
                    onClick={() =>
                      onCommand('stop', [
                        {
                          profileId,
                          planId: plan.id,
                          expectedState: plan.state,
                          expectedUpdatedAt: plan.updatedAt,
                        },
                      ])
                    }
                  >
                    {controlPending ? '确认停止' : '停止'}
                  </button>
                </div>
              )}
              {controlPending && (
                <p className="muted" role="status">
                  正在等待浏览器停止确认。若连接已恢复仍未结束，可再次点击确认暂停／确认停止；只核对原停止请求，不重做任务。
                </p>
              )}
              {(unresolved.length > 0 || plan.state === 'REVIEW') && (
                <p className="task-history-warning">
                  {plan.controlConfirmed ? '浏览器控制已停止，' : '任务已停止派发新操作，'}
                  {unresolved.length > 0
                    ? `${unresolved.length} 个操作结果仍未知。`
                    : '素材或任务结果仍待核对。'}
                  {plan.state === 'FAILED' &&
                  ['PUBLISH_RESULT_UNCONFIRMED', 'OPERATION_RESULT_UNCONFIRMED'].includes(
                    plan.reason,
                  )
                    ? '本次任务已结束，浏览器可以执行其他任务。可能已提交的原内容保留防重复，不自动重发；原记录留作日志。'
                    : '可以停止并结束本次任务；确认当前控制已停后释放浏览器，保留原内容的必要防重复保护。未确认结果不自动重发。'}
                </p>
              )}
              <ArchiveManagementPanel key={plan.id} profileId={profileId} planId={plan.id} />
              <h4>本轮子任务</h4>
              <div className="task-history-steps">
                {history.steps.map((step) => (
                  <div key={step.id}>
                    <span>
                      {step.position + 1}.{' '}
                      {step.destination === 'story' ? '发布快拍' : steps[step.type]}
                    </span>
                    <span>
                      {step.status === 'COMPLETED'
                        ? '已完成'
                        : step.status === 'FAILED'
                          ? '本步骤失败'
                          : step.status === 'SKIPPED'
                            ? '已跳过'
                            : step.status === 'ACTIVE'
                              ? '当前任务'
                              : '等待执行'}
                    </span>
                    <small>
                      <TaskProgressView
                        type={step.type}
                        progress={step.progress}
                        budget={step.budget}
                      />
                    </small>
                    {step.outcome && (
                      <small>
                        {taskReasonDescription(step.outcome.reason)?.summary ?? step.outcome.reason}
                        {step.outcome.kind === 'FAILED' && step.outcome.businessResult === 'UNKNOWN'
                          ? ' · 发布结果未确认，原内容不会自动重发'
                          : ''}
                      </small>
                    )}
                  </div>
                ))}
              </div>
              <details open={unresolved.length > 0}>
                <summary>
                  操作记录 · {history.operations.length} 条
                  {history.truncated.operations ? '（最近100条）' : ''}
                </summary>
                <div className="task-history-operations">
                  {history.operations.map((op) => (
                    <div key={op.id}>
                      <time>{new Date(op.updatedAt).toLocaleString()}</time>
                      <span>{actions[op.kind] ?? op.kind}</span>
                      <span>{states[op.status] ?? op.status}</span>
                    </div>
                  ))}
                </div>
                {!history.operations.length && <p className="muted">尚未派发操作。</p>}
              </details>
              <details>
                <summary>
                  状态变化 · {history.events.length} 条
                  {history.truncated.events ? '（最近100条）' : ''}
                </summary>
                <div className="task-history-operations">
                  {history.events.map((event) => (
                    <div key={event.sequence}>
                      <time>{new Date(event.createdAt).toLocaleString()}</time>
                      <span>{events[event.type] ?? event.type}</span>
                    </div>
                  ))}
                </div>
              </details>
            </>
          )}
          {history.truncated.plans && <p className="muted">显示最近50份任务。</p>}
        </>
      )}
    </section>
  );
}
