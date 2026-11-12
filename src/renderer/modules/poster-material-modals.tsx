import { canPosterMaterialUseColorBackground, type PosterTask } from '../../shared/group-poster.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';

export function formatCreatedDate(ts?: number | null): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '刚刚创建';
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

export function taskStatusBadge(status: PosterTask['status']): { label: string; cls: string } {
  switch (status) {
    case 'scheduled':
      return { label: '⏰ 定时待启动', cls: 'is-scheduled' };
    case 'running':
      return { label: '▶ 正在发送', cls: 'is-running' };
    case 'completed':
      return { label: '✓ 已完成', cls: 'is-completed' };
    case 'partial':
      return { label: '◑ 部分成功', cls: 'is-partial' };
    case 'failed':
      return { label: '✕ 失败', cls: 'is-failed' };
    case 'cancelled':
      return { label: '■ 已停止', cls: 'is-cancelled' };
  }
}

export function PosterMaterialCardPreview({
  row,
  onPreview,
}: {
  row: MaterialDraft;
  onPreview: (row: MaterialDraft) => void;
}) {
  const hasMedia = row.mediaSource.trim().length > 0;
  const thumbUrl = `/api/workspace/group-poster/materials/thumbnail?id=${encodeURIComponent(row.id)}&v=${row.updatedAt ?? 0}`;
  const mediaUrl = `/api/workspace/group-poster/materials/media?id=${encodeURIComponent(row.id)}&v=${row.updatedAt ?? 0}`;

  if (hasMedia) {
    const isReadyVideo = row.mediaKind === 'video' && row.cacheStatus === 'ready';
    const isReadyImage = row.mediaKind === 'image' && row.cacheStatus === 'ready';
    const imgSrc = isReadyImage ? mediaUrl : !isReadyVideo && row.hasThumbnail ? thumbUrl : null;

    return (
      <div
        className="poster-rect-card-preview is-media"
        role="button"
        tabIndex={0}
        title="点击放大预览画面"
        onClick={() => onPreview(row)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPreview(row);
          }
        }}
      >
        {isReadyVideo ? (
          <video
            src={`${mediaUrl}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            className="poster-rect-card-img"
          />
        ) : imgSrc ? (
          <img
            loading="lazy"
            decoding="async"
            src={imgSrc}
            alt=""
            className="poster-rect-card-img"
          />
        ) : (
          <div className="poster-rect-card-placeholder">
            <span className="poster-rect-card-placeholder-icon">
              {row.mediaKind === 'video' ? '🎬' : '🖼️'}
            </span>
            <span>
              {row.cacheStatus === 'downloading'
                ? '正在下载缓存媒体…'
                : row.cacheStatus === 'error'
                  ? (row.cacheError ?? '媒体加载失败')
                  : row.mediaKind === 'video'
                    ? '视频素材'
                    : '图片素材'}
            </span>
          </div>
        )}
        {row.mediaKind === 'video' && (
          <span className="poster-rect-video-play" aria-hidden="true">
            ▶ 视频
          </span>
        )}
      </div>
    );
  }

  const isColor = canPosterMaterialUseColorBackground(row);
  return (
    <div
      className={'poster-rect-card-preview ' + (isColor ? 'is-color-post' : 'is-plain-post')}
      onClick={() => onPreview(row)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPreview(row);
        }
      }}
    >
      <div className="poster-rect-text-canvas">{row.caption.trim() || '（未填写发帖文案）'}</div>
    </div>
  );
}

export interface PosterContextMenuState {
  x: number;
  y: number;
}

export function PosterMaterialContextMenu({
  menu,
  onClose,
  onInsertAbove,
  onInsertBelow,
  onToggleSelected,
  onCopy,
  onPaste,
  onClearRange,
  onDeleteRows,
}: {
  menu: PosterContextMenuState | null;
  onClose: () => void;
  onInsertAbove: () => void;
  onInsertBelow: () => void;
  onToggleSelected: (checked: boolean) => void;
  onCopy: () => void;
  onPaste: () => void;
  onClearRange: () => void;
  onDeleteRows: () => void;
}) {
  if (!menu) return null;
  return (
    <div
      className="popover-menu poster-context-menu"
      role="menu"
      aria-label="素材表格右键菜单"
      style={{
        position: 'fixed',
        left: Math.min(menu.x, (globalThis.innerWidth || 1200) - 200),
        top: Math.min(menu.y, (globalThis.innerHeight || 800) - 260),
        zIndex: 1200,
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onInsertAbove();
          onClose();
        }}
      >
        上方插入 1 行
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onInsertBelow();
          onClose();
        }}
      >
        下方插入 1 行
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onToggleSelected(true);
          onClose();
        }}
      >
        勾选所涉行
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onToggleSelected(false);
          onClose();
        }}
      >
        取消勾选所涉行
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCopy();
          onClose();
        }}
      >
        复制
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onPaste();
          onClose();
        }}
      >
        粘贴
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClearRange();
          onClose();
        }}
      >
        清空选区
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={() => {
          onDeleteRows();
          onClose();
        }}
      >
        删除所涉整行
      </button>
    </div>
  );
}

export function PosterMediaPreviewModal({
  row,
  onClose,
}: {
  row: MaterialDraft | null;
  onClose: () => void;
}) {
  if (!row) return null;
  const mediaUrl = `/api/workspace/group-poster/materials/media?id=${encodeURIComponent(row.id)}`;
  const thumbUrl = `/api/workspace/group-poster/materials/thumbnail?id=${encodeURIComponent(row.id)}&v=${row.updatedAt ?? 0}`;
  const canStreamMedia = row.cacheStatus === 'ready' && Boolean(row.localFilePath);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="预览贴文素材媒体"
      onClick={onClose}
    >
      <div
        className="modal bumper-modal poster-media-preview-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="bumper-modal-heading">
          <h2>预览素材媒体</h2>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            关闭
          </button>
        </div>
        <div
          className="poster-media-preview-body"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
            padding: '16px',
          }}
        >
          {canStreamMedia ? (
            row.mediaKind === 'video' ? (
              <video
                controls
                autoPlay
                src={mediaUrl}
                style={{ maxWidth: '100%', maxHeight: '70vh', borderRadius: '6px' }}
              />
            ) : (
              <img
                src={mediaUrl}
                alt={row.caption || row.mediaSource}
                style={{
                  maxWidth: '100%',
                  maxHeight: '70vh',
                  objectFit: 'contain',
                  borderRadius: '6px',
                }}
              />
            )
          ) : row.hasThumbnail ? (
            <img
              src={thumbUrl}
              alt={row.caption || row.mediaSource}
              style={{
                maxWidth: '100%',
                maxHeight: '70vh',
                objectFit: 'contain',
                borderRadius: '6px',
              }}
            />
          ) : (
            <p className="muted">当前媒体尚未缓存就绪，保存或发帖时会自动准备。</p>
          )}
          <small className="muted" style={{ wordBreak: 'break-all' }}>
            {row.mediaSource}
          </small>
        </div>
      </div>
    </div>
  );
}
