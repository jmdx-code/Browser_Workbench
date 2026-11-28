import { useEffect, useRef, useState, type ReactNode } from 'react';
import { profileDisplayName, type Profile } from '../../shared/contracts.js';
import {
  isPendingApprovalPostId,
  stripAnsi,
  type PendingOperationResolution,
  type PosterLog,
  type PosterState,
} from '../../shared/group-poster.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import { api } from '../api.js';
import { copyTextToClipboard } from '../clipboard.js';
import {
  PosterMaterialSummaryBox,
  PosterMediaPreviewModal,
  posterRowBadge,
  taskStatusBadge,
} from './poster-material-modals.js';
import { BackdropModal, Btn, DataTbl, errMsg, ModalHeading } from './shared/module-ui.js';
import { UI_CARD, UI_HINT, UI_ROW, UI_ROW_BT, UI_ROW_SM } from '../ui/primitives.js';
const TD = 'px-2.5 py-2 align-middle';
const SectionCard = ({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) => (
  <div className={`${UI_CARD} flex flex-col gap-2 p-3`}>
    <div className={UI_ROW_BT}>
      <strong className="text-xs font-semibold text-slate-900">{title}</strong>
      {right}
    </div>
    {children}
  </div>
);
const EmptyMsg = ({ text }: { text: string }) => (
  <div className="py-3 text-center text-xs text-[var(--text-3)]">{text}</div>
);
export function PosterMaterialDetailModal({
  material,
  state,
  profiles,
  busy,
  blockEscape = false,
  onClose,
  onCancelTask,
  onDeleteTask,
  onOpenRecords,
  onOpenPendingReview,
  onMessage,
}: {
  material: MaterialDraft;
  state: PosterState | null;
  profiles: readonly Profile[];
  busy: boolean;
  blockEscape?: boolean;
  onClose: () => void;
  onCancelTask: (taskId: string) => Promise<void>;
  onDeleteTask: (taskId: string) => Promise<void>;
  onOpenRecords?: (() => void) | undefined;
  onOpenPendingReview?: (() => void) | undefined;
  onMessage: (text: string) => void;
}) {
  const [latestLog, setLatestLog] = useState<PosterLog | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const reqSeqRef = useRef(0);
  const lastTotalRef = useRef<number | undefined>(state?.total);
  const activeGroups = state?.activeGroupsByMaterial?.[material.id] ?? [];
  const materialTasks = (state?.tasks ?? []).filter((t) => t.materialId === material.id);
  const postedGroupIds = state?.postedGroupIdsByMaterial?.[material.id] ?? [];
  const pendingOps = (state?.pendingReviewOperations ?? []).filter(
    (op) => op.materialId === material.id,
  );
  const sentCount = Math.max(postedGroupIds.length, material.usedCount ?? 0);
  const failedOrSkippedCount = materialTasks.reduce(
    (acc, t) =>
      acc +
      t.skippedCount +
      (t.status === 'failed' ? Math.max(1, t.totalGroups - t.postedCount) : 0),
    0,
  );
  const latestTaskIssue = materialTasks
    .filter((t) => t.status === 'failed' || t.status === 'partial')
    .map((t) => stripAnsi(t.statusReason ?? '').trim())
    .find(Boolean);
  const latestPendingReason = pendingOps
    .map((op) => stripAnsi(op.reason ?? '').trim())
    .find(Boolean);
  const sanitizedError = latestPendingReason || latestTaskIssue || '';
  const loadLatestSummary = async () => {
    const seq = ++reqSeqRef.current;
    setLoadingLatest(true);
    try {
      const rows = await api.posterLogs('', undefined, undefined, material.id);
      if (reqSeqRef.current === seq) setLatestLog(rows[0] ?? null);
    } catch (e) {
      if (reqSeqRef.current === seq) onMessage(errMsg(e, String(e)));
    } finally {
      if (reqSeqRef.current === seq) setLoadingLatest(false);
    }
  };
  useEffect(() => {
    lastTotalRef.current = state?.total;
    void loadLatestSummary();
  }, [material.id]);
  useEffect(() => {
    if (state?.total !== undefined && state.total !== lastTotalRef.current) {
      lastTotalRef.current = state.total;
      void loadLatestSummary();
    }
  }, [state?.total]);
  return (
    <>
      <BackdropModal
        label="贴文发帖详情"
        modalClass="!gap-0 !p-0 flex max-h-[88vh] w-[min(860px,95vw)] flex-col overflow-hidden"
        blockEscape={previewOpen || blockEscape}
        onClose={() => {
          if (!document.querySelector('dialog[open]')) onClose();
        }}
      >
        <ModalHeading title="贴文发帖详情" closeText="×" onClose={onClose} />
        <PosterMaterialSummaryBox
          row={material}
          badge={posterRowBadge(material)}
          onPreview={() => setPreviewOpen(true)}
          className="flex gap-3 border-b border-[var(--line)] bg-slate-50/70 px-4 py-3"
          metaRow={
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>
                已发小组数：<strong>{sentCount}</strong> 个
              </span>
              <span>
                正在发/排队：<strong>{activeGroups.length}</strong> 个
              </span>
              {pendingOps.length > 0 && (
                <span className="font-semibold text-amber-700">
                  待核对：<strong>{pendingOps.length}</strong> 项
                </span>
              )}
            </div>
          }
        />
        <div
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.stopPropagation();
          }}
        >
          <SectionCard
            title="执行摘要"
            right={
              <div className={UI_ROW_SM}>
                {pendingOps.length > 0 && onOpenPendingReview && (
                  <Btn onClick={onOpenPendingReview}>查看待核对 ({pendingOps.length})</Btn>
                )}
                {onOpenRecords && (
                  <Btn
                    v="primary"
                    onClick={() => {
                      onClose();
                      onOpenRecords();
                    }}
                  >
                    前往「数据与记录」查看完整明细
                  </Btn>
                )}
              </div>
            }
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {(
                [
                  [
                    'border-emerald-200 bg-emerald-50/60 text-emerald-700 text-emerald-900',
                    '已发确认',
                    sentCount,
                  ],
                  [
                    'border-amber-200 bg-amber-50/60 text-amber-700 text-amber-900',
                    '待核对',
                    pendingOps.length,
                  ],
                  [
                    'border-rose-200 bg-rose-50/60 text-rose-700 text-rose-900',
                    '失败 / 跳过',
                    failedOrSkippedCount,
                  ],
                ] as const
              ).map(([cls, lbl, val]) => {
                const [b, bg, t1, t2] = cls.split(' ');
                return (
                  <div key={lbl} className={`rounded-lg border ${b} ${bg} px-3 py-2 text-xs`}>
                    <div className={`text-[11px] ${t1}`}>{lbl}</div>
                    <strong className={`text-base font-semibold ${t2} tabular-nums`}>{val}</strong>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--line)] bg-slate-50/70 px-3 py-2 text-xs">
              <div className={UI_ROW_BT}>
                <span className="font-medium text-slate-700">最新发帖回执</span>
                {loadingLatest ? (
                  <span className={UI_HINT}>正在读取…</span>
                ) : latestLog ? (
                  <span className={UI_HINT}>
                    {latestLog.groupName || latestLog.groupId} ·{' '}
                    {new Date(latestLog.postedAt).toLocaleString()}
                  </span>
                ) : (
                  <span className={UI_HINT}>暂无发帖记录</span>
                )}
              </div>
              {latestLog && (
                <div className={UI_ROW}>
                  {isPendingApprovalPostId(latestLog.postId) && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                      已提交待群管审核
                    </span>
                  )}
                  {/^https?:\/\//i.test(latestLog.postUrl) ? (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[11px] text-slate-600">
                        {latestLog.postUrl}
                      </span>
                      <Btn
                        onClick={() =>
                          void copyTextToClipboard(latestLog.postUrl)
                            .then(() => onMessage('已复制发帖链接'))
                            .catch((e) => onMessage(String(e)))
                        }
                      >
                        复制链接
                      </Btn>
                      <a
                        href={latestLog.postUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-[var(--line-strong)] bg-white px-2.5 text-xs font-medium whitespace-nowrap text-[var(--text)] no-underline transition-colors hover:border-slate-300 hover:bg-slate-100"
                      >
                        打开链接
                      </a>
                    </>
                  ) : (
                    <span className={UI_HINT}>无直链（移动端或待审核回执）</span>
                  )}
                </div>
              )}
              {sanitizedError && (
                <div
                  className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900"
                  role="note"
                >
                  最近提示：{sanitizedError}
                </div>
              )}
            </div>
          </SectionCard>
          <SectionCard title={`正在发 / 排队中的小组 (${activeGroups.length})`}>
            {!activeGroups.length ? (
              <EmptyMsg text="当前没有正在发送或排队中的小组" />
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {activeGroups.map((item) => {
                  const prof = profiles.find((pr) => pr.id === item.profileId);
                  const acct = prof
                    ? profileDisplayName(prof, prof.account.name || prof.id)
                    : (item.profileId ?? '等待空闲账号领取');
                  return (
                    <div
                      key={item.groupId}
                      className={`flex flex-col gap-1 rounded-lg border p-2 text-xs ${item.state === 'posting' ? 'border-blue-200 bg-blue-50/60' : 'border-amber-200 bg-amber-50/50'}`}
                    >
                      <div className={UI_ROW_SM}>
                        <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-semibold">
                          {item.state === 'posting' ? '▶ 正在发帖' : '⏳ 排队待发'}
                        </span>
                        <strong>{item.groupName}</strong>
                        <small className="text-[var(--text-3)]">({item.groupId})</small>
                      </div>
                      <div className="text-[11px] text-[var(--text-2)]">
                        执行账号：{acct}
                        {item.statusText ? ` · ${item.statusText}` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
          <SectionCard title={`该贴文的任务与定时记录 (${materialTasks.length})`}>
            {!materialTasks.length ? (
              <EmptyMsg text="暂无该贴文的任务记录" />
            ) : (
              <DataTbl
                headers={['状态', '执行时间', '账号模式', '完成进度', '状态说明', '操作']}
                rows={materialTasks}
                empty="暂无任务记录"
                renderRow={(t) => {
                  const tb = taskStatusBadge(t.status);
                  return (
                    <tr key={t.id}>
                      <td className={TD}>
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${tb.cls}`}
                        >
                          {tb.label}
                        </span>
                      </td>
                      <td className={TD}>
                        {`${t.scheduledAt ? '定时' : '立即'}：${new Date(t.scheduledAt ?? t.createdAt).toLocaleString()}`}
                      </td>
                      <td className={TD}>
                        {t.accountMode === 'all_online'
                          ? '🌐 全部在线账号'
                          : `👤 指定 ${t.profileIds.length} 个账号`}
                      </td>
                      <td className={TD}>
                        已发 <strong>{t.postedCount}</strong> / {t.totalGroups} 组
                        {t.skippedCount > 0 ? `（跳过 ${t.skippedCount} 组）` : ''}
                      </td>
                      <td className={TD}>{stripAnsi(t.statusReason ?? '')}</td>
                      <td className={TD}>
                        {t.status === 'scheduled' || t.status === 'running' ? (
                          <Btn v="danger" disabled={busy} onClick={() => void onCancelTask(t.id)}>
                            {t.status === 'scheduled' ? '取消定时' : '停止任务'}
                          </Btn>
                        ) : (
                          <Btn disabled={busy} onClick={() => void onDeleteTask(t.id)}>
                            删除记录
                          </Btn>
                        )}
                      </td>
                    </tr>
                  );
                }}
              />
            )}
          </SectionCard>
        </div>
      </BackdropModal>
      {previewOpen && (
        <PosterMediaPreviewModal row={material} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  );
}
export interface PendingReviewDisplayItem {
  id: string;
  targetLabel: string;
  accountLabel: string;
  actionLabel?: string;
  updatedAt: number;
  reviewReason: string;
}
export function PendingReviewModal({
  title,
  items,
  busy,
  error,
  onResolve,
  onClose,
}: {
  title: string;
  items: readonly PendingReviewDisplayItem[];
  busy: boolean;
  error?: string;
  onResolve: (operationId: string, resolution: PendingOperationResolution) => Promise<void>;
  onClose: () => void;
}) {
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !resolvingId) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [busy, resolvingId, onClose]);
  const handleAction = async (id: string, resolution: PendingOperationResolution) => {
    setResolvingId(id);
    try {
      await onResolve(id, resolution);
    } finally {
      setResolvingId(null);
    }
  };
  return (
    <BackdropModal
      label={title}
      modalClass="!gap-0 !p-0 flex max-h-[86vh] w-[min(780px,94vw)] flex-col overflow-hidden"
      busy={busy || Boolean(resolvingId)}
      blockEscape
      onClose={onClose}
    >
      <ModalHeading
        title={`${title} (${items.length})`}
        subtitle="提交后未收到明确成功/失败回执的操作已锁定防重，请人工核对实际页面后再选择处理。"
        disabled={busy || Boolean(resolvingId)}
        closeText="×"
        onClose={onClose}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
        {error && (
          <p
            className="m-0 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700"
            role="alert"
          >
            {error}
          </p>
        )}
        {!items.length ? (
          <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-xs text-[var(--text-3)]">
            当前没有待核对的操作
          </div>
        ) : (
          items.map((item) => {
            const itemBusy = busy || resolvingId === item.id;
            const cleanReason = stripAnsi(item.reviewReason).trim();
            return (
              <div
                key={item.id}
                className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50/40 p-3 text-xs"
              >
                <div className={UI_ROW_BT}>
                  <div className={UI_ROW}>
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-amber-900">
                      {item.id}
                    </span>
                    {item.actionLabel && (
                      <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700">
                        {item.actionLabel}
                      </span>
                    )}
                    <strong className="text-slate-900">{item.targetLabel}</strong>
                  </div>
                  <span className={UI_HINT}>{new Date(item.updatedAt).toLocaleString()}</span>
                </div>
                <div className="text-[11px] text-[var(--text-2)]">
                  执行账号：{item.accountLabel}
                </div>
                <div className="rounded-lg border border-amber-200/80 bg-white px-2.5 py-1.5 text-[11px] leading-relaxed text-slate-700">
                  原因：{cleanReason || '未能确认发布回执，请核对目标页面是否已有对应内容'}
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Btn
                    disabled={itemBusy}
                    onClick={() => void handleAction(item.id, 'not_applied')}
                  >
                    确认未发，解锁重试
                  </Btn>
                  <Btn
                    v="primary"
                    disabled={itemBusy}
                    onClick={() => void handleAction(item.id, 'confirmed')}
                  >
                    确认已发
                  </Btn>
                </div>
              </div>
            );
          })
        )}
      </div>
    </BackdropModal>
  );
}
