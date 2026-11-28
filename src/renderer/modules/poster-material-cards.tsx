import { useRef, useState, type ReactNode } from 'react';
import {
  hasPosterMaterialContent,
  type PosterState,
  type PosterTask,
} from '../../shared/group-poster.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { IconClock, IconPlay } from '../icons.js';
import { parseElectronFilePaths, resolveElectronFilePath } from '../matrix-grid.js';
import { toggleSet } from '../selection.js';
import {
  formatCreatedDate,
  PosterMaterialCardPreview,
  PosterMediaPreviewModal,
  posterRowBadge,
  taskStatusBadge,
  useSerialVideoThumbnailGenerator,
} from './poster-material-modals.js';
import { Btn, Chk } from './shared/module-ui.js';
import { UI_CHECKBOX, UI_INPUT_SM, UI_ROW, UI_SELECT_SM } from '../ui/primitives.js';
export { PosterTaskDispatchModal, SharedPosterGroupsList } from './poster-task-dispatch-modal.js';
export { PendingReviewModal, PosterMaterialDetailModal } from './poster-material-detail-modal.js';
export { PosterMaterialEditModal } from './poster-material-modals.js';
const BATCH_OPTS = [
  ['bg:color', '文字背景：设为彩贴'],
  ['bg:plain', '文字背景：设为普通文字'],
  ['ai:on', 'AI 声明：设为开启'],
  ['ai:off', 'AI 声明：设为关闭'],
  ['ai:default', 'AI 声明：设为默认'],
] as const;
function PosterTaskBanner(p: {
  title: string;
  ariaLabel: string;
  tasks: readonly PosterTask[];
  validRows: readonly MaterialDraft[];
  onOpenDetail: (row: MaterialDraft) => void;
  renderAction: (task: PosterTask) => ReactNode;
}) {
  if (!p.tasks.length) return null;
  return (
    <div
      className="mb-1 flex flex-col gap-2 rounded-xl border border-[var(--line)] bg-slate-50/80 p-3 text-xs"
      aria-label={p.ariaLabel}
    >
      <strong className="text-xs font-semibold text-slate-800">
        {p.title} ({p.tasks.length})
      </strong>
      <div className="flex flex-col gap-1.5">
        {p.tasks.map((t) => {
          const badge = taskStatusBadge(t.status);
          const matched = p.validRows.find((r) => r.id === t.materialId);
          const desc =
            t.status === 'running' || t.status === 'scheduled'
              ? `${t.accountMode === 'all_online' ? '全部在线账号' : `${t.profileIds.length}个指定号`} · 已发 ${t.postedCount}/${t.totalGroups} 组${t.scheduledAt && t.status === 'scheduled' ? ` · 启动时间 ${new Date(t.scheduledAt).toLocaleString()}` : ''}`
              : `已发 ${t.postedCount}/${t.totalGroups} 组${t.statusReason ? ` · ${t.statusReason}` : ''}`;
          return (
            <div
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--line)] bg-white px-2.5 py-1.5"
            >
              <span
                className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${badge.cls}`}
              >
                {badge.label}
              </span>
              <span
                className="max-w-[240px] truncate font-medium text-slate-900"
                title={t.captionPreview}
              >
                {t.captionPreview || '（媒体贴文）'}
              </span>
              <span
                className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-3)]"
                title={t.statusReason}
              >
                {desc}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {matched && <Btn onClick={() => p.onOpenDetail(matched)}>查看</Btn>}
                {p.renderAction(t)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
export function PosterMaterialCardGrid(p: {
  rows: readonly MaterialDraft[];
  state: PosterState | null;
  persistedIds: ReadonlySet<string>;
  pauseThumbnailGeneration?: boolean | undefined;
  busy: boolean;
  selectedCardIds?: ReadonlySet<string> | undefined;
  onSelectedCardIdsChange?: ((next: Set<string>) => void) | undefined;
  onOpenDispatch: (row: MaterialDraft) => void;
  onOpenBatchDispatch?: ((rows: MaterialDraft[]) => void) | undefined;
  onQuickScheduleMaterial?: ((row: MaterialDraft) => void) | undefined;
  onOpenDetail: (row: MaterialDraft) => void;
  onEditCard: (row: MaterialDraft) => void;
  onAddCard: () => void;
  onAddLocalFiles: (paths: string[]) => void;
  onDeleteCard: (id: string) => void;
  onBatchDeleteCards?: (ids: string[]) => void;
  onBatchUpdateCards?: (ids: string[], patch: Partial<MaterialDraft>) => void;
  onOpenTableEditor: () => void;
  onCancelTask: (taskId: string) => Promise<void>;
  onDeleteTask?: (taskId: string) => Promise<void>;
  onThumbnailSaved: (id: string) => void;
}) {
  const {
    rows,
    state,
    busy,
    onOpenDispatch,
    onQuickScheduleMaterial,
    onOpenDetail,
    onEditCard,
    onDeleteCard,
    onBatchDeleteCards,
    onBatchUpdateCards,
    onCancelTask,
    onDeleteTask,
  } = p;
  const [query, setQuery] = useState('');
  const [previewRow, setPreviewRow] = useState<MaterialDraft | null>(null);
  const [uncontrolledIds, setUncontrolledIds] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; label: string } | null>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const selectedIds = p.selectedCardIds ?? uncontrolledIds;
  const setSelectedIds = (updater: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof updater === 'function' ? updater(new Set(selectedIds)) : updater;
    if (p.onSelectedCardIdsChange) p.onSelectedCardIdsChange(next);
    else setUncontrolledIds(next);
  };
  const validRows = rows.filter(hasPosterMaterialContent);
  useSerialVideoThumbnailGenerator(validRows, p.onThumbnailSaved, {
    persistedIds: p.persistedIds,
    paused: p.pauseThumbnailGeneration,
  });
  const q = query.trim().toLowerCase();
  const visibleRows = validRows.filter(
    (r) =>
      !q || `${r.caption}\n${r.mediaSource}\n${r.localFilePath ?? ''}`.toLowerCase().includes(q),
  );
  const selectedVisibleRows = visibleRows.filter((r) => selectedIds.has(r.id));
  const selectedVisibleIds = selectedVisibleRows.map((r) => r.id);
  const activeTasks = (state?.tasks ?? []).filter(
    (t) => t.status === 'running' || t.status === 'scheduled',
  );
  const issueTasks = (state?.tasks ?? [])
    .filter((t) => t.status === 'failed' || t.status === 'partial')
    .slice(0, 5);
  const handleBatchPatch = (val: string) => {
    if (!val || !selectedVisibleIds.length || !onBatchUpdateCards) return;
    if (val.startsWith('bg:'))
      onBatchUpdateCards(selectedVisibleIds, {
        background: val === 'bg:color' ? 'color' : 'plain',
      });
    else if (val.startsWith('ai:'))
      onBatchUpdateCards(selectedVisibleIds, {
        aiLabel: val === 'ai:on' ? 'on' : val === 'ai:off' ? 'off' : 'default',
      });
  };
  return (
    <div
      className="flex flex-col gap-3"
      onDragOver={(e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault()}
      onDrop={(e) => {
        const files = e.dataTransfer?.files;
        if (!files?.length) return;
        e.preventDefault();
        const paths = parseElectronFilePaths(files);
        if (paths.length) p.onAddLocalFiles(paths);
      }}
    >
      <div className="poster-cards-toolbar flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-slate-50/80 px-3 py-2">
        <div className={UI_ROW}>
          <Chk
            className="font-medium text-slate-700"
            label={`全选 (${selectedVisibleIds.length}/${visibleRows.length})`}
            checked={visibleRows.length > 0 && selectedVisibleIds.length === visibleRows.length}
            onChange={(c) =>
              setSelectedIds((prev) =>
                toggleSet(
                  prev,
                  visibleRows.map((r) => r.id),
                  c,
                ),
              )
            }
          />
          <input
            type="search"
            aria-label="搜索贴文卡片"
            className={`${UI_INPUT_SM} w-52`}
            placeholder="搜索贴文文案、媒体或文件名…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Btn v="primary" disabled={busy} onClick={p.onAddCard}>
            ＋ 新建贴文
          </Btn>
          <Btn
            disabled={busy}
            onClick={() => filesInputRef.current?.click()}
            title="支持多选本机图片/视频批量新增贴文（也可直接把文件拖拽到下方区域）"
          >
            ＋ 导入媒体
          </Btn>
          <input
            ref={filesInputRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,image/*,video/*"
            className="hidden"
            onChange={(e) => {
              const paths = Array.from(e.target.files ?? [])
                .map(resolveElectronFilePath)
                .filter(Boolean);
              e.target.value = '';
              if (paths.length) p.onAddLocalFiles(paths);
            }}
          />
          {selectedVisibleIds.length > 0 && (
            <>
              {p.onOpenBatchDispatch && (
                <Btn
                  v="primary"
                  disabled={busy}
                  onClick={() => p.onOpenBatchDispatch?.(selectedVisibleRows)}
                  title="为勾选的多条贴文素材批量创建并启动发帖任务"
                >
                  <IconPlay size={12} /> 批量发帖 ({selectedVisibleIds.length})
                </Btn>
              )}
              <select
                aria-label="批量修改已选贴文"
                className={UI_SELECT_SM}
                value=""
                disabled={busy}
                onChange={(e) => {
                  handleBatchPatch(e.target.value);
                  e.target.value = '';
                }}
              >
                <option value="">批量设置已选 ({selectedVisibleIds.length})…</option>
                {BATCH_OPTS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <Btn
                v="danger"
                disabled={busy}
                onClick={() =>
                  setConfirmDelete({
                    ids: [...selectedVisibleIds],
                    label: `所选的 ${selectedVisibleIds.length} 条贴文素材`,
                  })
                }
              >
                批量删除 ({selectedVisibleIds.length})
              </Btn>
            </>
          )}
        </div>
        <Btn onClick={p.onOpenTableEditor} title="打开类 Excel 表格批量新增、粘贴或批量编辑贴文">
          表格编辑
        </Btn>
      </div>
      <PosterTaskBanner
        title="进行中 / 定时发帖任务"
        ariaLabel="当前进行中与定时发帖任务"
        tasks={activeTasks}
        validRows={validRows}
        onOpenDetail={onOpenDetail}
        renderAction={(t) => (
          <Btn v="danger" disabled={busy} onClick={() => void onCancelTask(t.id)}>
            {t.status === 'scheduled' ? '取消定时' : '停止'}
          </Btn>
        )}
      />
      <PosterTaskBanner
        title="近期失败 / 部分成功任务"
        ariaLabel="近期异常或部分完成任务"
        tasks={issueTasks}
        validRows={validRows}
        onOpenDetail={onOpenDetail}
        renderAction={(t) =>
          onDeleteTask ? (
            <Btn disabled={busy} onClick={() => void onDeleteTask(t.id)}>
              忽略
            </Btn>
          ) : null
        }
      />
      {visibleRows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-xs text-[var(--text-3)]">
          {validRows.length === 0
            ? '暂无贴文素材，请点击上方「＋ 新建贴文」、「＋ 批量添加本机图片/视频」或「表格批量新增 / Excel粘贴」添加贴文'
            : '没有匹配的贴文卡片'}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(235px,1fr))] gap-3">
          {visibleRows.map((row, index) => {
            const badge = posterRowBadge(row),
              postedCount = Math.max(
                state?.postedGroupIdsByMaterial?.[row.id]?.length ?? 0,
                row.usedCount ?? 0,
              ),
              activeGroups = state?.activeGroupsByMaterial?.[row.id] ?? [],
              postingCount = activeGroups.filter((a) => a.state === 'posting').length,
              queuedCount = activeGroups.filter((a) => a.state === 'queued').length,
              scheduledCount = (state?.tasks ?? []).filter(
                (t) => t.materialId === row.id && t.status === 'scheduled',
              ).length,
              isChecked = selectedIds.has(row.id),
              pillCls =
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap shadow-2xs';
            return (
              <article
                key={row.id}
                className={`poster-rect-card flex flex-col overflow-hidden rounded-xl border bg-white shadow-xs transition-shadow hover:shadow-sm ${isChecked ? 'border-slate-900 ring-1 ring-slate-900' : 'border-[var(--line)]'}`}
              >
                <div className="relative h-40 w-full overflow-hidden bg-slate-100">
                  <PosterMaterialCardPreview row={row} onPreview={setPreviewRow} />
                  <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-1">
                    <label
                      className="pointer-events-auto inline-flex cursor-pointer items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold shadow-2xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className={UI_CHECKBOX}
                        aria-label={`选择贴文 #${index + 1}`}
                        checked={isChecked}
                        onChange={(e) =>
                          setSelectedIds((n0) => toggleSet(n0, row.id, e.target.checked))
                        }
                      />
                      <span>#{index + 1}</span>
                    </label>
                    <div className="flex flex-wrap items-center gap-1">
                      {row.aiLabel && row.aiLabel !== 'default' && (
                        <span
                          className={`${pillCls} ${row.aiLabel === 'on' ? 'bg-violet-100 text-violet-800' : 'bg-slate-200 text-slate-700'}`}
                        >
                          {row.aiLabel === 'on' ? 'AI声明:开' : 'AI声明:关'}
                        </span>
                      )}
                      <span
                        className={`poster-status-badge ${pillCls} ${badge.cls}`}
                        title={badge.title}
                      >
                        {badge.text}
                      </span>
                    </div>
                  </div>
                  {(activeGroups.length > 0 || scheduledCount > 0) && (
                    <div className="pointer-events-none absolute inset-x-2 bottom-2 flex flex-wrap gap-1">
                      {activeGroups.length > 0 && (
                        <span className="inline-flex items-center rounded-full bg-blue-600/90 px-2 py-0.5 text-[11px] font-semibold text-white">
                          ▶ 正在发 {postingCount} · 排队 {queuedCount}
                        </span>
                      )}
                      {scheduledCount > 0 && (
                        <span className="inline-flex items-center rounded-full bg-amber-600/90 px-2 py-0.5 text-[11px] font-semibold text-white">
                          ⏰ 定时任务 {scheduledCount}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between border-b border-slate-100 px-2.5 py-1.5 text-[11px] text-[var(--text-3)]">
                  <button
                    type="button"
                    className="cursor-pointer bg-transparent p-0 text-left text-[11px] text-slate-700 hover:underline"
                    title="点击查看该贴文已发小组、正在发小组与发帖链接"
                    onClick={() => onOpenDetail(row)}
                  >
                    已发小组：<strong>{postedCount}</strong>
                  </button>
                  <span title="创建日期">{formatCreatedDate(row.createdAt)}</span>
                </div>
                <div
                  className="line-clamp-3 min-h-[48px] flex-1 px-2.5 py-2 text-xs leading-relaxed text-slate-800"
                  title={row.caption || row.mediaSource}
                >
                  {row.caption.trim() || (
                    <span className="text-[var(--text-3)]">（仅画面媒体，无文字文案）</span>
                  )}
                </div>
                <div className="poster-rect-card-actions flex flex-wrap items-center gap-1 border-t border-slate-100 bg-slate-50/70 px-2 py-1.5">
                  <Btn
                    v="primary"
                    className="poster-card-post-btn"
                    disabled={busy}
                    onClick={() => onOpenDispatch(row)}
                  >
                    <IconPlay size={12} /> 发帖
                  </Btn>
                  <Btn
                    className="poster-card-schedule-btn"
                    disabled={busy || !onQuickScheduleMaterial}
                    title="将此贴文一键加入定时排班（支持单次或按周执行）"
                    onClick={() => onQuickScheduleMaterial?.(row)}
                  >
                    <IconClock size={13} /> 加入排班
                  </Btn>
                  <Btn
                    onClick={() => onOpenDetail(row)}
                    title="查看该贴文的已发小组、正在发小组、发帖链接与发帖账号"
                  >
                    详情 ({postedCount})
                  </Btn>
                  <Btn disabled={busy} onClick={() => onEditCard(row)}>
                    编辑
                  </Btn>
                  <Btn
                    v="ghost"
                    className="text-rose-700"
                    disabled={busy}
                    onClick={() =>
                      setConfirmDelete({
                        ids: [row.id],
                        label: row.caption.trim()
                          ? `贴文「${row.caption.trim().slice(0, 24)}」`
                          : `贴文 #${index + 1}`,
                      })
                    }
                  >
                    删除
                  </Btn>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {previewRow && (
        <PosterMediaPreviewModal row={previewRow} onClose={() => setPreviewRow(null)} />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="删除贴文素材"
          description={`确定要删除${confirmDelete.label}吗？删除后无法恢复。`}
          confirmText="确认删除"
          danger
          busy={busy}
          onConfirm={() => {
            const ids = confirmDelete.ids;
            setConfirmDelete(null);
            setSelectedIds((prev) => toggleSet(prev, ids, false));
            if (ids.length === 1 && ids[0]) onDeleteCard(ids[0]);
            else if (onBatchDeleteCards) onBatchDeleteCards(ids);
            else ids.forEach((id) => onDeleteCard(id));
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
