import { useRef, useState } from 'react';
import { hasPosterMaterialContent, type PosterState } from '../../shared/group-poster.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import {
  formatCreatedDate,
  PosterMaterialCardPreview,
  PosterMediaPreviewModal,
  taskStatusBadge,
} from './poster-material-modals.js';
import {
  posterRowBadge,
  useSerialVideoThumbnailGenerator,
} from './poster-material-thumbnail-cell.js';

export { formatCreatedDate, PosterMaterialCardPreview, taskStatusBadge };
export { PosterTaskDispatchModal } from './poster-task-dispatch-modal.js';
export { PosterMaterialDetailModal } from './poster-material-detail-modal.js';
export { PosterMaterialEditModal } from './poster-material-edit-modal.js';

export function PosterMaterialCardGrid({
  rows,
  state,
  persistedIds,
  pauseThumbnailGeneration,
  busy,
  onOpenDispatch,
  onOpenDetail,
  onEditCard,
  onAddCard,
  onAddLocalFiles,
  onDeleteCard,
  onBatchDeleteCards,
  onBatchUpdateCards,
  onOpenTableEditor,
  onCancelTask,
  onThumbnailSaved,
}: {
  rows: readonly MaterialDraft[];
  state: PosterState | null;
  persistedIds: ReadonlySet<string>;
  pauseThumbnailGeneration?: boolean | undefined;
  busy: boolean;
  onOpenDispatch: (row: MaterialDraft, initialTimingMode?: 'immediate' | 'scheduled') => void;
  onOpenDetail: (row: MaterialDraft) => void;
  onEditCard: (row: MaterialDraft) => void;
  onAddCard: () => void;
  onAddLocalFiles: (paths: string[]) => void;
  onDeleteCard: (id: string) => void;
  onBatchDeleteCards?: (ids: string[]) => void;
  onBatchUpdateCards?: (ids: string[], patch: Partial<MaterialDraft>) => void;
  onOpenTableEditor: () => void;
  onCancelTask: (taskId: string) => Promise<void>;
  onThumbnailSaved: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [previewRow, setPreviewRow] = useState<MaterialDraft | null>(null);
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const filesInputRef = useRef<HTMLInputElement>(null);

  const validRows = rows.filter(hasPosterMaterialContent);
  useSerialVideoThumbnailGenerator(validRows, onThumbnailSaved, {
    persistedIds,
    paused: pauseThumbnailGeneration,
  });

  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = validRows.filter((r) => {
    if (!normalizedQuery) return true;
    return (
      r.caption.toLowerCase().includes(normalizedQuery) ||
      r.mediaSource.toLowerCase().includes(normalizedQuery) ||
      (r.localFilePath ?? '').toLowerCase().includes(normalizedQuery)
    );
  });

  const selectedVisibleIds = visibleRows.filter((r) => selectedCardIds.has(r.id)).map((r) => r.id);
  const allVisibleSelected =
    visibleRows.length > 0 && selectedVisibleIds.length === visibleRows.length;
  const activeOrScheduledTasks = (state?.tasks ?? []).filter(
    (t) => t.status === 'running' || t.status === 'scheduled',
  );

  const handleBatchPatch = (val: string) => {
    if (!val || selectedVisibleIds.length === 0 || !onBatchUpdateCards) return;
    if (val === 'bg:color' || val === 'bg:plain') {
      onBatchUpdateCards(selectedVisibleIds, {
        background: val === 'bg:color' ? 'color' : 'plain',
      });
    } else if (val === 'ai:default' || val === 'ai:on' || val === 'ai:off') {
      const aiLabel = val === 'ai:on' ? 'on' : val === 'ai:off' ? 'off' : 'default';
      onBatchUpdateCards(selectedVisibleIds, { aiLabel });
    }
  };

  return (
    <div
      className="poster-cards-container"
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        const paths = files
          .map((f) => ((f as File & { path?: string }).path ?? '').trim())
          .filter(Boolean);
        if (paths.length > 0) onAddLocalFiles(paths);
      }}
    >
      <div className="poster-cards-toolbar">
        <div className="poster-cards-toolbar-left">
          <label className="poster-cards-select-all">
            <input
              type="checkbox"
              aria-label="全选贴文卡片"
              checked={allVisibleSelected}
              onChange={(e) => {
                const next = new Set(selectedCardIds);
                for (const r of visibleRows) {
                  if (e.target.checked) next.add(r.id);
                  else next.delete(r.id);
                }
                setSelectedCardIds(next);
              }}
            />
            <span>
              全选 ({selectedVisibleIds.length}/{visibleRows.length})
            </span>
          </label>
          <input
            type="search"
            aria-label="搜索贴文卡片"
            placeholder="搜索贴文文案、媒体或文件名…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy}
            onClick={onAddCard}
          >
            ＋ 新建贴文
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => filesInputRef.current?.click()}
            title="支持多选本机图片/视频批量新增贴文（也可直接把文件拖拽到下方区域）"
          >
            ＋ 批量添加本机图片/视频
          </button>
          <input
            ref={filesInputRef}
            type="file"
            multiple
            accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,image/*,video/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? [])
                .map((f) => ((f as File & { path?: string }).path ?? '').trim())
                .filter(Boolean);
              e.target.value = '';
              if (picked.length > 0) onAddLocalFiles(picked);
            }}
          />
          {selectedVisibleIds.length > 0 && (
            <>
              <select
                aria-label="批量修改已选贴文"
                value=""
                disabled={busy}
                onChange={(e) => {
                  handleBatchPatch(e.target.value);
                  e.target.value = '';
                }}
              >
                <option value="">批量设置已选 ({selectedVisibleIds.length})…</option>
                <option value="bg:color">文字背景：设为彩贴</option>
                <option value="bg:plain">文字背景：设为普通文字</option>
                <option value="ai:on">AI 声明：设为开启</option>
                <option value="ai:off">AI 声明：设为关闭</option>
                <option value="ai:default">AI 声明：设为默认</option>
              </select>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() => {
                  const ids = [...selectedVisibleIds];
                  setSelectedCardIds((prev) => {
                    const next = new Set(prev);
                    ids.forEach((id) => next.delete(id));
                    return next;
                  });
                  if (onBatchDeleteCards) onBatchDeleteCards(ids);
                  else ids.forEach((id) => onDeleteCard(id));
                }}
              >
                批量删除 ({selectedVisibleIds.length})
              </button>
            </>
          )}
        </div>
        <div className="poster-cards-toolbar-right">
          <button
            type="button"
            className="btn btn-sm"
            onClick={onOpenTableEditor}
            title="打开类 Excel 表格批量新增、粘贴或批量编辑贴文"
          >
            表格批量新增 / Excel粘贴
          </button>
        </div>
      </div>

      {activeOrScheduledTasks.length > 0 && (
        <div className="poster-tasks-banner" aria-label="当前进行中与定时发帖任务">
          <div className="poster-tasks-banner-title">
            <strong>进行中 / 定时发帖任务 ({activeOrScheduledTasks.length})</strong>
          </div>
          <div className="poster-tasks-banner-list">
            {activeOrScheduledTasks.map((t) => {
              const badge = taskStatusBadge(t.status);
              const matchedRow = validRows.find((r) => r.id === t.materialId);
              return (
                <div key={t.id} className={'poster-task-pill ' + badge.cls}>
                  <span className={'poster-task-badge ' + badge.cls}>{badge.label}</span>
                  <span className="poster-task-pill-caption" title={t.captionPreview}>
                    {t.captionPreview || '（媒体贴文）'}
                  </span>
                  <span className="poster-task-pill-meta">
                    {t.accountMode === 'all_online'
                      ? '全部在线账号'
                      : `${t.profileIds.length}个指定号`}{' '}
                    · 已发 {t.postedCount}/{t.totalGroups} 组
                    {t.scheduledAt && t.status === 'scheduled'
                      ? ` · 启动时间 ${new Date(t.scheduledAt).toLocaleString()}`
                      : ''}
                  </span>
                  <div className="poster-task-pill-actions">
                    {matchedRow && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => onOpenDetail(matchedRow)}
                      >
                        查看
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      onClick={() => void onCancelTask(t.id)}
                    >
                      {t.status === 'scheduled' ? '取消定时' : '停止'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {visibleRows.length === 0 ? (
        <div className="poster-materials-empty">
          {validRows.length === 0
            ? '暂无贴文素材，请点击上方「＋ 新建贴文」、「＋ 批量添加本机图片/视频」或「表格批量新增 / Excel粘贴」添加贴文'
            : '没有匹配的贴文卡片'}
        </div>
      ) : (
        <div className="poster-cards-grid">
          {visibleRows.map((row, index) => {
            const badge = posterRowBadge(row);
            const postedGroupIds = state?.postedGroupIdsByMaterial?.[row.id] ?? [];
            const postedCount = Math.max(postedGroupIds.length, row.usedCount ?? 0);
            const activeGroups = state?.activeGroupsByMaterial?.[row.id] ?? [];
            const postingCount = activeGroups.filter((a) => a.state === 'posting').length;
            const queuedCount = activeGroups.filter((a) => a.state === 'queued').length;
            const scheduledCount = (state?.tasks ?? []).filter(
              (t) => t.materialId === row.id && t.status === 'scheduled',
            ).length;
            const isCardChecked = selectedCardIds.has(row.id);

            return (
              <article
                key={row.id}
                className={'poster-rect-card' + (isCardChecked ? ' is-selected' : '')}
              >
                <div className="poster-rect-card-media-wrap">
                  <PosterMaterialCardPreview row={row} onPreview={setPreviewRow} />
                  <div className="poster-rect-card-top-badges">
                    <label className="poster-rect-card-check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`选择贴文 #${index + 1}`}
                        checked={isCardChecked}
                        onChange={(e) => {
                          const next = new Set(selectedCardIds);
                          if (e.target.checked) next.add(row.id);
                          else next.delete(row.id);
                          setSelectedCardIds(next);
                        }}
                      />
                      <span className="poster-rect-index-badge">#{index + 1}</span>
                    </label>
                    <div className="poster-rect-top-right-badges">
                      {row.aiLabel && row.aiLabel !== 'default' && (
                        <span className={'poster-ai-badge is-' + row.aiLabel}>
                          {row.aiLabel === 'on' ? 'AI声明:开' : 'AI声明:关'}
                        </span>
                      )}
                      <span className={'poster-cache-badge ' + badge.cls} title={badge.title}>
                        {badge.text}
                      </span>
                    </div>
                  </div>
                  {(activeGroups.length > 0 || scheduledCount > 0) && (
                    <div className="poster-rect-card-live-badges">
                      {activeGroups.length > 0 && (
                        <span className="poster-rect-live-pill is-running">
                          ▶ 正在发 {postingCount} · 排队 {queuedCount}
                        </span>
                      )}
                      {scheduledCount > 0 && (
                        <span className="poster-rect-live-pill is-scheduled">
                          ⏰ 定时任务 {scheduledCount}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="poster-rect-card-stats">
                  <button
                    type="button"
                    className="poster-rect-stat-btn"
                    title="点击查看该贴文已发小组、正在发小组与发帖链接"
                    onClick={() => onOpenDetail(row)}
                  >
                    已发小组：<strong>{postedCount}</strong>
                  </button>
                  <span className="poster-rect-date" title="创建日期">
                    {formatCreatedDate(row.createdAt)}
                  </span>
                </div>

                <div className="poster-rect-card-caption" title={row.caption || row.mediaSource}>
                  {row.caption.trim() ? (
                    row.caption
                  ) : (
                    <span className="muted">（仅画面媒体，无文字文案）</span>
                  )}
                </div>

                <div className="poster-rect-card-actions">
                  <button
                    type="button"
                    className="btn btn-sm btn-primary poster-card-post-btn"
                    disabled={busy}
                    onClick={() => onOpenDispatch(row, 'immediate')}
                  >
                    ▶ 发帖
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm poster-card-schedule-btn"
                    disabled={busy}
                    onClick={() => onOpenDispatch(row, 'scheduled')}
                  >
                    ⏰ 定时任务
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => onOpenDetail(row)}
                    title="查看该贴文的已发小组、正在发小组、发帖链接与发帖账号"
                  >
                    详情 ({postedCount})
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => onEditCard(row)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => onDeleteCard(row.id)}
                  >
                    删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {previewRow && (
        <PosterMediaPreviewModal row={previewRow} onClose={() => setPreviewRow(null)} />
      )}
    </div>
  );
}
