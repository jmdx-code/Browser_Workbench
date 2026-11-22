import { useState } from 'react';
import type { GoogleSheetLink } from '../../../shared/google-sheets.js';

export function SheetBottomTabs({
  links,
  activeLinkId,
  addLabel,
  onSelect,
  onAdd,
  onRename,
  onDelete,
}: {
  links: readonly GoogleSheetLink[];
  activeLinkId: string | null;
  addLabel: string;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, nextTitle: string) => Promise<void>;
  onDelete?: (link: GoogleSheetLink) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  async function commitRename(id: string) {
    const trimmed = draftName.trim();
    setEditingId(null);
    if (!trimmed) return;
    await onRename(id, trimmed);
  }

  return (
    <div className="gs-bottom-tabs" role="tablist" aria-label="已连接工作表切换栏">
      <div className="gs-bottom-tabs-scroll">
        {links.map((link) => {
          const isActive = link.id === activeLinkId;
          const isEditing = editingId === link.id;
          const enabled =
            link.kind === 'post_schedule'
              ? Boolean(link.scheduleConfig?.enabled)
              : Boolean(link.recordsConfig?.enabled);
          const dotClass =
            link.runtime.activeRunningCount > 0
              ? 'tone-run'
              : !enabled
                ? 'tone-idle'
                : link.kind === 'post_records' && link.runtime.pollingMode === 'semi_active'
                  ? 'tone-warn'
                  : 'tone-ok';
          const statusTip =
            link.runtime.activeRunningCount > 0
              ? '执行中'
              : !enabled
                ? '自动托管已关闭'
                : link.kind === 'post_records'
                  ? link.runtime.pollingMode === 'semi_active'
                    ? `半积极顶贴 (${link.recordsConfig?.semiActivePollMinutes ?? 10}m)`
                    : `积极顶贴 (${link.recordsConfig?.activePollMinutes ?? 2}m)`
                  : `自动排贴 (${link.scheduleConfig?.pollIntervalMinutes ?? 2}m)`;

          return (
            <div
              key={link.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              className={'gs-sheet-tab' + (isActive ? ' is-active' : '')}
              title={`${link.title}（${link.spreadsheetTitle} / ${link.sheetName} · ${statusTip} · 双击重命名）`}
              onClick={() => onSelect(link.id)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !isEditing) {
                  e.preventDefault();
                  onSelect(link.id);
                }
              }}
              onDoubleClick={() => {
                setEditingId(link.id);
                setDraftName(link.title);
              }}
            >
              <i className={'gs-tab-dot ' + dotClass} />
              {isEditing ? (
                <input
                  type="text"
                  className="gs-tab-rename-input"
                  autoFocus
                  value={draftName}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => void commitRename(link.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(link.id);
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <>
                  <span className="gs-tab-title">{link.title}</span>
                  {onDelete && (
                    <button
                      type="button"
                      className="gs-tab-close"
                      title={`移除「${link.title}」连接`}
                      aria-label={`移除 ${link.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(link);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      <button type="button" className="gs-tab-add-btn" onClick={onAdd} title={addLabel}>
        + {addLabel}
      </button>
    </div>
  );
}
