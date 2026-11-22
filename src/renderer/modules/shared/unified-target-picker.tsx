import { useEffect, useMemo, useRef, useState } from 'react';
import type { TargetFolder, TargetListKind } from '../../../shared/target-list.js';
import { api } from '../../api.js';
import { orderedFinderItems, rangeFinderSelection } from '../../finder-list-model.js';
import { FinderAvatar, FinderCheck } from '../../finder-target-list.js';
import { buildTargetCandidates, SelectByIdsDialog } from '../../select-by-ids-dialog.js';

export interface UnifiedPickerItem {
  id: string;
  name: string;
  sub?: string | undefined;
  avatarUrl?: string | null | undefined;
  badge?: string | undefined;
  folderId?: string | null | undefined;
  sortOrder?: number | undefined;
}

export function UnifiedTargetPicker({
  title,
  listKind,
  items,
  selectedIds,
  onChange,
  onDone,
  emptyHint = '当前列表为空，请先在对应功能模块添加目标',
  showCodeSub = false,
}: {
  title: string;
  listKind?: TargetListKind | undefined;
  items: readonly UnifiedPickerItem[];
  selectedIds: readonly string[];
  onChange: (nextIds: string[]) => void;
  onDone?: (() => void) | undefined;
  emptyHint?: string | undefined;
  showCodeSub?: boolean | undefined;
}) {
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const anchorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!listKind) {
      setFolders([]);
      return;
    }
    let alive = true;
    void api
      .targetFolders(listKind)
      .then((rows) => {
        if (alive) setFolders(rows);
      })
      .catch(() => {
        if (alive) setFolders([]);
      });
    return () => {
      alive = false;
    };
  }, [listKind]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const orderedItems = useMemo(() => {
    if (!listKind) return [...items];
    const finderMapped = items.map((it, idx) => ({
      ...it,
      folderId: it.folderId ?? null,
      sortOrder: it.sortOrder ?? idx,
      avatarUrl: it.avatarUrl ?? null,
      count: 0,
    }));
    return orderedFinderItems(finderMapped, folders);
  }, [items, listKind, folders]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orderedItems;
    return orderedItems.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.id.toLowerCase().includes(q) ||
        (it.sub ?? '').toLowerCase().includes(q),
    );
  }, [orderedItems, query]);

  const sections = useMemo(() => {
    if (!listKind || folders.length === 0) {
      return [{ id: '__all__', name: '', rows: filtered }];
    }
    const base = [
      ...folders.map((f) => ({
        id: f.id,
        name: f.name,
        rows: filtered.filter((it) => (it.folderId ?? '') === f.id),
      })),
      {
        id: '',
        name: '未分组',
        rows: filtered.filter((it) => (it.folderId ?? '') === ''),
      },
    ];
    return query.trim() ? base.filter((sec) => sec.rows.length > 0) : base;
  }, [listKind, folders, filtered, query]);

  const visibleIds = useMemo(
    () => sections.flatMap((sec) => (closed.has(sec.id) ? [] : sec.rows.map((row) => row.id))),
    [sections, closed],
  );

  const applySelectionSet = (next: Set<string>) => {
    const orderedIds = orderedItems.filter((it) => next.has(it.id)).map((it) => it.id);
    // Preserve any pre-existing selected IDs not in current list (defensive)
    for (const id of next) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    onChange(orderedIds);
  };

  const toggleMany = (ids: readonly string[], checked: boolean) => {
    const next = new Set(selectedIds);
    for (const id of ids) {
      if (checked) next.add(id);
      else next.delete(id);
    }
    applySelectionSet(next);
  };

  const toggleOne = (id: string, shiftKey: boolean) => {
    const next = rangeFinderSelection(
      selectedSet,
      visibleIds,
      anchorRef.current,
      id,
      !selectedSet.has(id),
      shiftKey,
    );
    anchorRef.current = id;
    applySelectionSet(next);
  };

  const selectedInPool = useMemo(
    () => items.filter((it) => selectedSet.has(it.id)).length,
    [items, selectedSet],
  );

  const selectByIdsCandidates = useMemo(() => {
    if (!listKind) return [];
    return buildTargetCandidates(
      orderedItems.map((it, idx) => ({
        id: it.id,
        name: it.name,
        avatarUrl: it.avatarUrl ?? null,
        folderId: it.folderId ?? null,
        sortOrder: it.sortOrder ?? idx,
        count: 0,
      })),
    );
  }, [listKind, orderedItems]);

  return (
    <div className="sched-drawer unified-picker">
      <div className="sched-drawer-bar">
        <span className="sched-drawer-title">
          {title}（已选 <strong>{selectedInPool}</strong> / {items.length}）
        </span>
        <input
          type="search"
          className="sched-drawer-search"
          placeholder="搜索名称或 ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="sched-drawer-actions">
          {listKind && items.length > 0 && (
            <button
              type="button"
              className="sched-link-btn"
              onClick={() => setSelectByIdsOpen(true)}
            >
              按 ID 选中
            </button>
          )}
          <button
            type="button"
            className="sched-link-btn"
            onClick={() =>
              toggleMany(
                filtered.map((it) => it.id),
                true,
              )
            }
          >
            全选
          </button>
          <button type="button" className="sched-link-btn" onClick={() => onChange([])}>
            清空
          </button>
          {onDone && (
            <button type="button" className="sched-drawer-done" onClick={onDone}>
              收起
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="sched-drawer-empty">{items.length === 0 ? emptyHint : '无匹配结果'}</div>
      ) : (
        <div className="unified-picker-scroll">
          {sections.map((sec) => {
            const secIds = sec.rows.map((r) => r.id);
            const isClosed = closed.has(sec.id);
            const showFolderHeader = Boolean(
              listKind && folders.length > 0 && sec.id !== '__all__',
            );
            return (
              <div key={sec.id || 'unfiled'} className="unified-picker-section">
                {showFolderHeader && (
                  <div className="unified-picker-folder">
                    <FinderCheck
                      ids={secIds}
                      selected={selectedSet}
                      label={'选择整组 ' + sec.name}
                      disabled={secIds.length === 0}
                      onChange={(checked) => toggleMany(secIds, checked)}
                    />
                    <button
                      type="button"
                      className="unified-picker-folder-btn"
                      onClick={() =>
                        setClosed((prev) => {
                          const next = new Set(prev);
                          if (next.has(sec.id)) next.delete(sec.id);
                          else next.add(sec.id);
                          return next;
                        })
                      }
                    >
                      <span>{isClosed ? '▸' : '▾'}</span>
                      <strong>{sec.name}</strong>
                      <small>
                        ({secIds.filter((id) => selectedSet.has(id)).length}/{secIds.length})
                      </small>
                    </button>
                  </div>
                )}
                {!isClosed && (
                  <div className="unified-picker-list">
                    {sec.rows.map((it) => {
                      const checked = selectedSet.has(it.id);
                      return (
                        <div
                          key={it.id}
                          role="option"
                          aria-selected={checked}
                          className={'unified-picker-row' + (checked ? ' is-checked' : '')}
                          onClick={(e) => toggleOne(it.id, e.shiftKey)}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            aria-label={'选择 ' + it.name}
                            readOnly
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleOne(it.id, e.shiftKey);
                            }}
                          />
                          <span className="unified-picker-avatar">
                            <FinderAvatar
                              item={{ name: it.name, avatarUrl: it.avatarUrl ?? null }}
                            />
                          </span>
                          <span className="unified-picker-main">
                            <span
                              className="unified-picker-name"
                              title={it.sub ? `${it.name} (${it.sub})` : it.name}
                            >
                              {it.name}
                            </span>
                            {!showCodeSub && it.sub && (
                              <span className="unified-picker-sub">{it.sub}</span>
                            )}
                          </span>
                          {it.badge && <span className="unified-picker-badge">{it.badge}</span>}
                          {showCodeSub && it.sub && (
                            <code className="unified-picker-id">{it.sub}</code>
                          )}
                        </div>
                      );
                    })}
                    {sec.rows.length === 0 && <div className="sched-drawer-empty">暂无条目</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {selectByIdsOpen && listKind && (
        <SelectByIdsDialog
          title={'按 ID 批量选中 · ' + title}
          kind={listKind}
          candidates={selectByIdsCandidates}
          onClose={() => setSelectByIdsOpen(false)}
          onApply={(matchedIds, applyMode) => {
            const next =
              applyMode === 'replace'
                ? new Set(matchedIds)
                : new Set([...selectedIds, ...matchedIds]);
            applySelectionSet(next);
            const matchedSet = new Set(matchedIds);
            const foldersToOpen = new Set(
              items.filter((i) => matchedSet.has(i.id)).map((i) => i.folderId ?? ''),
            );
            if (foldersToOpen.size > 0) {
              setClosed((prev) => {
                const nextClosed = new Set(prev);
                for (const fid of foldersToOpen) nextClosed.delete(fid);
                return nextClosed;
              });
            }
          }}
        />
      )}
    </div>
  );
}
