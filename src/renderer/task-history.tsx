import { useEffect, useState, type ReactNode } from 'react';
import { endedTask } from '../domain/task-run-records.js';
import {
  TaskHistory as TaskHistorySchema,
  type History,
  type TaskCommand,
} from '../shared/task-contracts.js';
import { isMarketplaceUnavailableSkip } from '../shared/task-step-outcome.js';
import { taskTimingLabel } from '../shared/task-timing.js';
import { api } from './api.js';
import { CleanupDialog } from './data-cleanup-panel.js';
import { Btn, NoticeBanner } from './modules/shared/module-ui.js';
import { taskReasonDescription } from './task-alerts.js';
import { taskHistoryNeedsPolling } from './task-history-polling.js';
import { TaskProgressView } from './task-progress.js';
import { runSummary, stepName } from './task-record-summary.js';
import { downloadJsonFile, UI_CARD, UI_MUTED, UI_SELECT_SM } from './ui/primitives.js';

declare const __WORKBENCH_VERSION__: string;
const STATES: Record<string, string> = {
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
const ACTIONS: Record<string, string> = {
  click: '点击控件',
  typeText: '填写正文',
  uploadMedia: '上传媒体',
  observe: '读取页面',
  activateTab: '激活任务页',
  browseNavigate: '打开浏览任务页',
  browsePlay: '播放当前视频',
  browseScroll: '滚动浏览页面',
  closeTab: '关闭任务页',
  createTab: '创建测试页',
};
const EVENTS: Record<string, string> = {
  ...STATES,
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
  STEP_SKIP_INTENT: '当前身份无法执行此步骤，准备正常跳过',
  STEP_CONTINUATION_READY: '独立后续步骤已就绪',
  CHILD_PAGE_REQUESTED: '已登记结果子页用途',
  CHILD_PAGE_READY: '结果子页归属已核对',
  CHILD_PAGE_CLOSED: '结果子页关闭已确认',
  SCHEDULE_RELEASED: '计划已进入运行队列',
};
const stepStatusLabel = (status: string, ended: boolean, skipOk: boolean) =>
  skipOk
    ? '正常跳过（商城不可用）'
    : ({ COMPLETED: '已完成', FAILED: '本步骤失败', SKIPPED: '已跳过' }[status] ??
      (status === 'ACTIVE' ? (ended ? '已停止' : '进行中') : ended ? '未执行' : '等待执行'));
const ENDED_STATES = new Set(['STOPPED', 'COMPLETED', 'FAILED']);
const TH_WARN =
  'text-xs wrap-anywhere p-2.5 rounded-lg border border-amber-200 text-amber-800 bg-amber-50';
const TH_OPS =
  'max-h-[280px] overflow-auto [&>div]:flex [&>div]:items-baseline [&>div]:flex-wrap [&>div]:gap-2.5 [&>div]:text-xs [&>div]:py-1.5 [&>div]:border-b [&>div]:border-[var(--line)] [&_time]:text-[var(--text-3)]';

export function TaskHistoryPanel(p: {
  profileId: string;
  browserName?: string;
  avatar?: ReactNode;
  diagnosticContent?: (requiresReview: boolean) => ReactNode;
  initialRound?: number;
  initialPlanId?: string;
  busy?: boolean;
  onCommand?: (command: TaskCommand['command'], plans: TaskCommand['plans']) => void;
}) {
  const { profileId } = p;
  const [history, setHistory] = useState<History | null>(null),
    [selected, setSelected] = useState<string | null>(p.initialPlanId ?? null),
    [revision, setRevision] = useState(0),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false),
    [round, setRound] = useState(p.initialRound),
    [loading, setLoading] = useState(true),
    [exportNotice, setExportNotice] = useState('');

  useEffect(() => {
    const refresh = () => {
      setSelected(null);
      setRound(undefined);
      setHistory(null);
      setRevision((v) => v + 1);
    };
    window.addEventListener('task-records-deleted', refresh);
    return () => window.removeEventListener('task-records-deleted', refresh);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    let pending = false,
      poll = true;
    const load = async () => {
      if (pending || ctrl.signal.aborted || document.hidden) return;
      pending = true;
      setLoading(true);
      try {
        const value = await api.taskHistory(profileId, selected, ctrl.signal, round);
        if (value.profileId !== profileId || (selected && value.selectedPlanId !== selected))
          throw Error('TASK_HISTORY_SCOPE_CHANGED');
        if (!ctrl.signal.aborted) {
          setHistory(value);
          poll = taskHistoryNeedsPolling(value, selected);
          setError('');
        }
      } catch {
        if (!ctrl.signal.aborted) setError('记录读取失败，下面保留的是上次读取结果。可重新读取。');
      } finally {
        pending = false;
        if (!ctrl.signal.aborted) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => poll && void load(), 5000);
    document.addEventListener('visibilitychange', load);
    return () => {
      ctrl.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [profileId, selected, revision, round]);

  const plan = history?.plans.find((row) => row.id === history.selectedPlanId);
  const starts = history?.steps.flatMap((s) => (s.startedAt == null ? [] : [s.startedAt])) ?? [];
  const finishes =
    history?.steps.flatMap((s) => (s.finishedAt == null ? [] : [s.finishedAt])) ?? [];
  const startedAt = starts.length ? Math.min(...starts) : null;
  const finishedAt =
    finishes.length &&
    ((plan && endedTask(plan.state)) ||
      history?.steps.every((s) => ['COMPLETED', 'FAILED', 'SKIPPED'].includes(s.status)))
      ? Math.max(...finishes)
      : null;
  const unresolved = history?.operations.filter((op) => op.status === 'UNKNOWN') ?? [];

  return (
    <section
      className={`${UI_CARD} flex flex-col gap-2.5 p-4 [&_details]:mt-2 [&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:font-medium [&_summary]:text-[var(--text-2)]`}
      aria-label="业务任务记录"
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        {p.avatar}
        <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
          {p.browserName ?? '浏览器'}
          {plan ? ` · ${plan.name}` : ' · 任务记录'}
        </h3>
        <Btn
          disabled={loading || !history || !!error}
          onClick={() => {
            if (!history) return;
            try {
              const value = TaskHistorySchema.parse(history);
              downloadJsonFile(
                `任务记录-${value.profileId.slice(0, 8)}-${new Date().toISOString().replaceAll(':', '-')}.json`,
                {
                  format: 'browser-workbench-task-history',
                  version: 1,
                  softwareVersion: __WORKBENCH_VERSION__,
                  exportedAt: new Date().toISOString(),
                  history: value,
                },
              );
              setExportNotice(
                '已发起导出，请在下载位置查看JSON文件。记录范围与当前页面一致；完整备份另行操作。',
              );
            } catch {
              setExportNotice('导出失败，请重新读取记录后再试。');
            }
          }}
        >
          导出记录
        </Btn>
        <Btn disabled={loading} onClick={() => setRevision((v) => v + 1)}>
          重新读取
        </Btn>
      </div>
      {exportNotice && (
        <p className={UI_MUTED} role="status">
          {exportNotice}
        </p>
      )}
      {history?.detailsReclaimed && (
        <p className={UI_MUTED}>详细执行过程已按保留规则回收，最终结果与步骤状态仍保留。</p>
      )}
      {error && <NoticeBanner tone="err">{error}</NoticeBanner>}
      {!history && !error && <p className={UI_MUTED}>正在读取任务记录…</p>}
      {history?.plans.length === 0 && (
        <p className={UI_MUTED}>这份浏览器还没有业务任务。桥接测试不会计入业务完成。</p>
      )}

      {!!history?.plans.length && (
        <>
          {history.plans.length > 1 && (
            <label className="flex items-center gap-2 text-xs font-medium text-[var(--text-2)]">
              <span className="shrink-0">切换历史任务</span>
              <select
                className={`${UI_SELECT_SM} min-w-0 flex-1`}
                value={selected ?? ''}
                onChange={(e) => {
                  setSelected(e.target.value || null);
                  setRound(undefined);
                }}
              >
                <option value="">最新任务</option>
                {history.plans.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name} · {new Date(row.createdAt).toLocaleString()} · {STATES[row.state]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {plan && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-xs wrap-anywhere">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                    plan.state === 'COMPLETED'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : plan.state === 'FAILED'
                        ? 'border-rose-200 bg-rose-50 text-rose-700'
                        : 'border-slate-200 bg-slate-100 text-slate-700'
                  }`}
                >
                  {STATES[plan.state]}
                </span>
                <span className="text-[var(--text-2)]">
                  {(history.steps[0]?.round ?? plan.round) > 1
                    ? `第 ${history.steps[0]?.round ?? plan.round} 轮 · `
                    : ''}
                  {runSummary(history.steps)}
                </span>
              </div>
              <p className={UI_MUTED}>
                {startedAt === null
                  ? `尚未开始 · 创建于 ${new Date(plan.createdAt).toLocaleString()}`
                  : `${new Date(startedAt).toLocaleString()} → ${finishedAt === null ? '尚未结束' : new Date(finishedAt).toLocaleString()} · 用时 ${Math.max(0, Math.round(((finishedAt ?? Date.now()) - startedAt) / 60000))} 分钟`}
              </p>
              {endedTask(plan.state) && history.steps.length > 0 && (
                <div>
                  <Btn v="danger" onClick={() => setDeleting(true)}>
                    删除此条任务记录
                  </Btn>
                </div>
              )}
              {deleting && (
                <CleanupDialog
                  selection={{
                    kind: 'records',
                    scope: { stepIds: history.steps.map((s) => s.id) },
                  }}
                  onClose={() => setDeleting(false)}
                  onDone={() => setDeleting(false)}
                />
              )}
              {plan.timing && <p className={UI_MUTED}>{taskTimingLabel(plan.timing)}</p>}
              {plan.reason && (
                <details className="rounded-lg border border-[var(--line)] bg-slate-50/70 p-2.5 text-xs wrap-anywhere">
                  <summary>查看任务原因</summary>
                  <p className="mt-2 mb-1 text-[var(--text-2)]">
                    {taskReasonDescription(plan.reason)?.summary ?? '查看诊断信息了解具体原因'} ·{' '}
                    {taskReasonDescription(plan.reason)?.next ?? '请根据当前任务状态继续或结束。'}
                  </p>
                  <code className="font-mono text-[11px] text-slate-600">{plan.reason}</code>
                </details>
              )}
              {p.onCommand && !endedTask(plan.state) && (
                <div className="flex flex-wrap items-center gap-2" aria-label="当前任务控制">
                  <Btn
                    v="danger"
                    disabled={p.busy || ENDED_STATES.has(plan.state)}
                    onClick={() =>
                      p.onCommand?.('stop', [
                        {
                          profileId,
                          planId: plan.id,
                          expectedState: plan.state,
                          expectedUpdatedAt: plan.updatedAt,
                        },
                      ])
                    }
                  >
                    停止
                  </Btn>
                </div>
              )}
              <h4 className="m-0 pt-1 text-[13px] font-semibold text-slate-900">步骤执行成绩单</h4>
              <div className="flex flex-col gap-2">
                {history.steps.map((step) => {
                  const reasonDesc = step.outcome
                    ? taskReasonDescription(step.outcome.reason)
                    : undefined;
                  const target =
                    step.budget?.kind === 'time'
                      ? `${step.budget.milliseconds / 60000} 分钟`
                      : step.budget?.kind === 'posts'
                        ? `${step.budget.count} 条`
                        : step.budget?.kind === 'friends'
                          ? step.budget.count === null
                            ? '全部好友'
                            : `${step.budget.count} 人`
                          : '—';
                  return (
                    <div
                      key={step.id}
                      className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 rounded-lg border border-[var(--line)] bg-slate-50/50 p-3 text-xs"
                    >
                      <span className="font-semibold text-slate-900">
                        {step.position + 1}. {stepName(step)}
                      </span>
                      <span className="text-[var(--text-2)]">
                        {stepStatusLabel(
                          step.status,
                          endedTask(plan.state),
                          isMarketplaceUnavailableSkip(step.type, step.status, step.outcome),
                        )}
                      </span>
                      <small className="basis-full text-[11px] text-[var(--text-3)]">
                        目标 {target} → 实际{' '}
                        <TaskProgressView
                          type={step.type}
                          progress={step.progress}
                          budget={step.budget}
                        />
                      </small>
                      {step.status === 'PENDING' && endedTask(plan.state) && (
                        <small className="basis-full text-[11px] text-[var(--text-3)]">
                          未开始执行（任务已结束）
                        </small>
                      )}
                      {step.outcome && (
                        <small
                          className={`basis-full text-[11px] ${step.status === 'FAILED' ? TH_WARN : 'text-[var(--text-3)]'}`}
                        >
                          {reasonDesc?.summary ?? step.outcome.reason}
                          {reasonDesc?.next && <span> · {reasonDesc.next}</span>}
                          {step.outcome.kind === 'FAILED' &&
                          step.outcome.businessResult === 'UNKNOWN'
                            ? ' · 发布结果未确认，原内容不会自动重发'
                            : ''}
                        </small>
                      )}
                    </div>
                  );
                })}
              </div>
              <details className="border-t border-[var(--line)] pt-3" open={unresolved.length > 0}>
                <summary className="text-[var(--text-3)]">高级诊断日志（开发与排障用）</summary>
                {unresolved.length > 0 && (
                  <p className={`${TH_WARN} mt-2`}>
                    有 {unresolved.length} 个 UNKNOWN 操作待核对。
                  </p>
                )}
                {p.diagnosticContent?.(unresolved.length > 0)}
                <details className="mt-2">
                  <summary>
                    操作记录 · {history.operations.length} 条
                    {history.truncated.operations ? '（最近100条）' : ''}
                  </summary>
                  <div className={TH_OPS}>
                    {history.operations.map((op) => (
                      <div key={op.id}>
                        <time>{new Date(op.updatedAt).toLocaleString()}</time>
                        <span>{ACTIONS[op.kind] ?? op.kind}</span>
                        <span>{STATES[op.status] ?? op.status}</span>
                      </div>
                    ))}
                  </div>
                  {!history.operations.length && (
                    <p className={`${UI_MUTED} mt-1.5`}>尚未派发操作。</p>
                  )}
                </details>
                <details className="mt-2">
                  <summary>
                    状态变化 · {history.events.length} 条
                    {history.truncated.events ? '（最近100条）' : ''}
                  </summary>
                  <div className={TH_OPS}>
                    {history.events.map((event) => (
                      <div key={event.sequence}>
                        <time>{new Date(event.createdAt).toLocaleString()}</time>
                        <span>{EVENTS[event.type] ?? event.type}</span>
                      </div>
                    ))}
                  </div>
                </details>
              </details>
            </>
          )}
          {history.truncated.plans && <p className={UI_MUTED}>显示最近50份任务。</p>}
        </>
      )}
    </section>
  );
}
