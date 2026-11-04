import type { MaterialDraft } from '../../domain/poster-material-table.js';

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
