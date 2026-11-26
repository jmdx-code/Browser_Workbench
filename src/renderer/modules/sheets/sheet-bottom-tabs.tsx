import { useRef, useState } from 'react';
import type { GoogleSheetLink } from '../../../shared/google-sheets.js';
import { Btn } from '../shared/module-ui.js';

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
  const committingRef = useRef(false);

  async function commitRename(id: string, currentTitle: string) {
    if (committingRef.current) return;
    committingRef.current = true;
    const trimmed = draftName.trim();
    setEditingId(null);
    try {
      if (trimmed && trimmed !== currentTitle) await onRename(id, trimmed);
    } finally {
      committingRef.current = false;
    }
  }

  return (
    <div
      className="gs-bottom-tabs flex shrink-0 items-center justify-between gap-2 rounded-xl border border-[var(--line)] bg-slate-100 px-2 py-1.5"
      role="tablist"
      aria-label="已连接工作表切换栏"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {links.map((link) => {
          const isActive = link.id === activeLinkId;
          const isEditing = editingId === link.id;
          const enabled =
            link.kind === 'post_schedule'
              ? Boolean(link.scheduleConfig?.enabled)
              : Boolean(link.recordsConfig?.enabled);
          const running = link.runtime.activeRunningCount > 0;
          const semi = link.kind === 'post_records' && link.runtime.pollingMode === 'semi_active';
          const dotTone = running
            ? 'bg-blue-600'
            : !enabled
              ? 'bg-slate-400'
              : semi
                ? 'bg-amber-500'
                : 'bg-emerald-600';
          const statusTip = running
            ? '执行中'
            : !enabled
              ? '自动托管已关闭'
              : link.kind === 'post_records'
                ? semi
                  ? `半积极顶贴 (${link.recordsConfig?.semiActivePollMinutes ?? 10}m)`
                  : `积极顶贴 (${link.recordsConfig?.activePollMinutes ?? 2}m)`
                : `自动排贴 (${link.scheduleConfig?.pollIntervalMinutes ?? 2}m)`;

          return (
            <div
              key={link.id}
              role="tab"
              tabIndex={0}
              aria-selected={isActive}
              className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 text-xs select-none ${isActive ? 'border-[var(--line)] bg-white font-semibold text-slate-900 shadow-2xs' : 'border-transparent text-[var(--text-2)] hover:bg-white/70'}`}
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
              <i className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${dotTone}`} />
              {isEditing ? (
                <input
                  type="text"
                  className="h-5 w-24 rounded border border-sky-400 bg-white px-1 text-xs"
                  autoFocus
                  value={draftName}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={() => void commitRename(link.id, link.title)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitRename(link.id, link.title);
                    }
                    if (e.key === 'Escape') {
                      committingRef.current = true;
                      setEditingId(null);
                      setTimeout(() => {
                        committingRef.current = false;
                      }, 0);
                    }
                  }}
                />
              ) : (
                <>
                  <span className="max-w-[140px] truncate">{link.title}</span>
                  {onDelete && (
                    <button
                      type="button"
                      className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
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
      <Btn className="shrink-0" onClick={onAdd} title={addLabel}>
        + {addLabel}
      </Btn>
    </div>
  );
}
