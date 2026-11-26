import { useEffect, useMemo, useRef, useState } from 'react';
import type { TargetFolder, TargetListKind } from '../../../shared/target-list.js';
import { api } from '../../api.js';
import { orderedFinderItems, rangeFinderSelection } from '../../finder-list-model.js';
import { FinderAvatar, FinderCheck } from '../../finder-target-list.js';
import { buildTargetCandidates, SelectByIdsDialog } from '../../select-by-ids-dialog.js';
import { toggleSet } from '../../selection.js';
import { UI_INPUT_SM } from '../../ui/primitives.js';
import { Btn } from './module-ui.js';

export interface UnifiedPickerItem {
  id: string;
  name: string;
  sub?: string | undefined;
  avatarUrl?: string | null | undefined;
  badge?: string | undefined;
  folderId?: string | null | undefined;
  sortOrder?: number | undefined;
}

const LINK_BTN =
  'h-auto border-0 bg-transparent p-0 text-xs font-medium text-[var(--primary)] cursor-pointer hover:underline';

export function UnifiedTargetPicker(p: {
  title: string;
  listKind?: TargetListKind | undefined;
  items: readonly UnifiedPickerItem[];
  selectedIds: readonly string[];
  onChange: (nextIds: string[]) => void;
  onDone?: (() => void) | undefined;
  emptyHint?: string | undefined;
  showCodeSub?: boolean | undefined;
}) {
  const {
    title,
    listKind,
    items,
    selectedIds,
    onChange,
    onDone,
    emptyHint = '当前列表为空，请先在对应功能模块添加目标',
    showCodeSub = false,
  } = p;
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const anchorRef = useRef<string | null>(null);

  useEffect(() => {
    if (!listKind) return setFolders([]);
    let alive = true;
    void api.targetFolders(listKind).then(
      (rows) => alive && setFolders(rows),
      () => alive && setFolders([]),
    );
    return () => {
      alive = false;
    };
  }, [listKind]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const orderedItems = useMemo(
    () =>
      !listKind
        ? [...items]
        : orderedFinderItems(
            items.map((it, idx) => ({
              ...it,
              folderId: it.folderId ?? null,
              sortOrder: it.sortOrder ?? idx,
              avatarUrl: it.avatarUrl ?? null,
              count: 0,
            })),
            folders,
          ),
    [items, listKind, folders],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return !q
      ? orderedItems
      : orderedItems.filter((it) =>
          `${it.name} ${it.id} ${it.sub ?? ''}`.toLowerCase().includes(q),
        );
  }, [orderedItems, query]);
  const sections = useMemo(() => {
    if (!listKind || folders.length === 0) return [{ id: '__all__', name: '', rows: filtered }];
    const base = [
      ...folders.map((f) => ({
        id: f.id,
        name: f.name,
        rows: filtered.filter((it) => (it.folderId ?? '') === f.id),
      })),
      { id: '', name: '未分组', rows: filtered.filter((it) => (it.folderId ?? '') === '') },
    ];
    return query.trim() ? base.filter((sec) => sec.rows.length > 0) : base;
  }, [listKind, folders, filtered, query]);
  const visibleIds = useMemo(
    () => sections.flatMap((sec) => (closed.has(sec.id) ? [] : sec.rows.map((r) => r.id))),
    [sections, closed],
  );

  const applySelectionSet = (next: Set<string>) => {
    const orderedIds = orderedItems.filter((it) => next.has(it.id)).map((it) => it.id);
    for (const id of next) if (!orderedIds.includes(id)) orderedIds.push(id);
    onChange(orderedIds);
  };
  const toggleMany = (ids: readonly string[], checked: boolean) => {
    const next = new Set(selectedIds);
    for (const id of ids) checked ? next.add(id) : next.delete(id);
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
  const openMatchedFolders = (matchedIds: readonly string[]) => {
    const matchedSet = new Set(matchedIds),
      toOpen = items.filter((i) => matchedSet.has(i.id)).map((i) => i.folderId ?? '');
    if (toOpen.length)
      setClosed((prev) => {
        const n = new Set(prev);
        toOpen.forEach((fid) => n.delete(fid));
        return n;
      });
  };

  const selectedInPool = useMemo(
    () => items.filter((it) => selectedSet.has(it.id)).length,
    [items, selectedSet],
  );
  const candidates = useMemo(
    () =>
      !listKind
        ? []
        : buildTargetCandidates(
            orderedItems.map((it, idx) => ({
              id: it.id,
              name: it.name,
              avatarUrl: it.avatarUrl ?? null,
              folderId: it.folderId ?? null,
              sortOrder: it.sortOrder ?? idx,
              count: 0,
            })),
          ),
    [listKind, orderedItems],
  );

  return (
    <div className="mt-2 flex flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] bg-slate-50 px-2.5 py-2 text-xs">
        <span className="font-medium text-slate-800">
          {title}（已选 <strong>{selectedInPool}</strong> / {items.length}）
        </span>
        <input
          type="search"
          className={UI_INPUT_SM + ' min-w-[140px] flex-1'}
          placeholder="搜索名称或 ID…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="flex items-center gap-2">
          {listKind && items.length > 0 && (
            <button type="button" className={LINK_BTN} onClick={() => setSelectByIdsOpen(true)}>
              按 ID 选中
            </button>
          )}
          <button
            type="button"
            className={LINK_BTN}
            onClick={() =>
              toggleMany(
                filtered.map((it) => it.id),
                true,
              )
            }
          >
            全选
          </button>
          <button type="button" className={LINK_BTN} onClick={() => onChange([])}>
            清空
          </button>
          {onDone && (
            <Btn v="primary" onClick={onDone}>
              收起
            </Btn>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-4 text-center text-xs text-[var(--muted)]">
          {items.length === 0 ? emptyHint : '无匹配结果'}
        </div>
      ) : (
        <div className="max-h-64 overflow-y-auto p-1.5">
          {sections.map((sec) => {
            const secIds = sec.rows.map((r) => r.id),
              isClosed = closed.has(sec.id);
            const showHeader = Boolean(listKind && folders.length > 0 && sec.id !== '__all__');
            return (
              <div key={sec.id || 'unfiled'} className="mb-1 last:mb-0">
                {showHeader && (
                  <div className="flex items-center gap-1.5 rounded-md bg-slate-50 px-2 py-1 text-xs">
                    <FinderCheck
                      ids={secIds}
                      selected={selectedSet}
                      label={'选择整组 ' + sec.name}
                      disabled={secIds.length === 0}
                      onChange={(c) => toggleMany(secIds, c)}
                    />
                    <button
                      type="button"
                      className="flex flex-1 items-center gap-1.5 border-0 bg-transparent p-0 text-left text-xs text-slate-800"
                      onClick={() => setClosed((prev) => toggleSet(prev, sec.id))}
                    >
                      <span>{isClosed ? '▸' : '▾'}</span>
                      <strong>{sec.name}</strong>
                      <small className="text-[var(--muted)]">
                        ({secIds.filter((id) => selectedSet.has(id)).length}/{secIds.length})
                      </small>
                    </button>
                  </div>
                )}
                {!isClosed && (
                  <div className="flex flex-col gap-0.5 py-0.5">
                    {sec.rows.map((it) => {
                      const checked = selectedSet.has(it.id);
                      return (
                        <div
                          key={it.id}
                          role="option"
                          aria-selected={checked}
                          className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs ${checked ? 'bg-slate-100 font-medium text-slate-900' : 'hover:bg-slate-50'}`}
                          onClick={(e) => toggleOne(it.id, e.shiftKey)}
                        >
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 shrink-0"
                            checked={checked}
                            aria-label={'选择 ' + it.name}
                            readOnly
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleOne(it.id, e.shiftKey);
                            }}
                          />
                          <span className="unified-picker-avatar inline-flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md bg-slate-100">
                            <FinderAvatar
                              item={{ name: it.name, avatarUrl: it.avatarUrl ?? null }}
                            />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span
                              className="truncate"
                              title={it.sub ? `${it.name} (${it.sub})` : it.name}
                            >
                              {it.name}
                            </span>
                            {!showCodeSub && it.sub && (
                              <span className="truncate text-[11px] text-[var(--muted)]">
                                {it.sub}
                              </span>
                            )}
                          </span>
                          {it.badge && (
                            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                              {it.badge}
                            </span>
                          )}
                          {showCodeSub && it.sub && (
                            <code className="shrink-0 font-mono text-[11px] text-[var(--muted)]">
                              {it.sub}
                            </code>
                          )}
                        </div>
                      );
                    })}
                    {sec.rows.length === 0 && (
                      <div className="p-2 text-center text-xs text-[var(--muted)]">暂无条目</div>
                    )}
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
          candidates={candidates}
          onClose={() => setSelectByIdsOpen(false)}
          onApply={(matchedIds, applyMode) => {
            applySelectionSet(
              applyMode === 'replace'
                ? new Set(matchedIds)
                : new Set([...selectedIds, ...matchedIds]),
            );
            openMatchedFolders(matchedIds);
          }}
        />
      )}
    </div>
  );
}
