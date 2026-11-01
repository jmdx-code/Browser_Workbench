import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.js';
import { NameDialog } from './name-dialog.js';
import { PopoverMenu, type MenuItem } from './popover-menu.js';
import { SelectByIdsDialog, buildTargetCandidates } from './select-by-ids-dialog.js';
import {
  orderedFinderItems,
  insertFinderIds,
  rangeFinderSelection,
  type FinderItem,
} from './finder-list-model.js';
import type { TargetListKind, TargetFolder, TargetListCommand } from '../shared/target-list.js';
export { orderedFinderItems } from './finder-list-model.js';
export function FinderCheck({
  ids,
  selected,
  onChange,
  label,
  disabled = false,
}: {
  ids: string[];
  selected: ReadonlySet<string>;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const count = ids.filter((id) => selected.has(id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < ids.length;
  }, [count, ids.length]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={ids.length > 0 && count === ids.length}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
function FinderAvatar({ item }: { item: FinderItem }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [item.avatarUrl]);
  return item.avatarUrl && !broken ? (
    <img src={item.avatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  ) : (
    <span className="finder-avatar-placeholder">{Array.from(item.name)[0] ?? '?'}</span>
  );
}
export function FinderTargetList({
  listKind,
  items,
  selected,
  onSelect,
  onDelete,
  onChanged,
  onFolders,
  title,
  countLabel,
  disabled = false,
  tools,
  moreItems,
}: {
  listKind: TargetListKind;
  items: FinderItem[];
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  onDelete: (ids: string[]) => Promise<unknown>;
  onChanged: () => Promise<unknown>;
  onFolders?: (folders: TargetFolder[]) => void;
  title: string;
  countLabel: string;
  disabled?: boolean;
  tools?: ReactNode;
  moreItems?: MenuItem[];
}) {
  const [folders, setFolders] = useState<TargetFolder[]>([]),
    [query, setQuery] = useState(''),
    [searchOpen, setSearchOpen] = useState(false),
    [closed, setClosed] = useState<Set<string>>(new Set()),
    [name, setName] = useState<{ id?: string; name: string } | null>(null),
    [selectByIdsOpen, setSelectByIdsOpen] = useState(false),
    [error, setError] = useState(''),
    [working, setWorking] = useState(false),
    [drop, setDrop] = useState('');
  const anchor = useRef<string | null>(null),
    drag = useRef<string[]>([]),
    paint = useRef<boolean | null>(null),
    pointerHandledRef = useRef<string | null>(null),
    selectionRef = useRef(selected);
  selectionRef.current = selected;
  const unavailable = disabled || working;
  async function loadFolders() {
    const next = await api.targetFolders(listKind);
    setFolders(next);
    onFolders?.(next);
  }
  useEffect(() => {
    void loadFolders().catch((e) => setError(String(e)));
  }, [listKind]);
  useEffect(() => {
    const stop = () => {
      paint.current = null;
      setTimeout(() => {
        pointerHandledRef.current = null;
      }, 0);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('blur', stop);
    };
  }, []);
  const ordered = orderedFinderItems(items, folders),
    filtered = ordered.filter((i) =>
      (i.name + ' ' + i.id).toLowerCase().includes(query.trim().toLowerCase()),
    );
  const sections = [
    ...folders.map((f) => ({ id: f.id, name: f.name })),
    { id: '', name: folders.length ? '未分组' : '' },
  ];
  const visible = sections.flatMap((f) =>
    closed.has(f.id) ? [] : filtered.filter((i) => (i.folderId ?? '') === f.id).map((i) => i.id),
  );
  function select(ids: string[], checked: boolean) {
    const next = new Set(selectionRef.current);
    ids.forEach((id) => (checked ? next.add(id) : next.delete(id)));
    selectionRef.current = next;
    onSelect(next);
  }
  function choose(id: string, shift: boolean) {
    const next = rangeFinderSelection(
      selectionRef.current,
      visible,
      anchor.current,
      id,
      !selectionRef.current.has(id),
      shift,
    );
    anchor.current = id;
    selectionRef.current = next;
    onSelect(next);
  }
  async function command(c: TargetListCommand) {
    setWorking(true);
    setError('');
    try {
      await api.targetListCommand(c);
      await loadFolders();
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      throw e;
    } finally {
      setWorking(false);
    }
  }
  function saveOrder(folderId: string | null, ids: string[]) {
    return command({ action: 'reorder-items', listKind, folderId, orderedItemIds: ids });
  }
  function move(
    folderId: string | null,
    moved = ordered.filter((i) => selected.has(i.id)).map((i) => i.id),
    target?: string,
    after = false,
  ) {
    const ids = items
      .filter((i) => i.folderId === folderId)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((i) => i.id);
    return saveOrder(folderId, insertFinderIds(ids, moved, target, after));
  }
  function reorderFolder(id: string, direction: -1 | 1) {
    const ids = folders.map((f) => f.id),
      at = ids.indexOf(id),
      to = at + direction;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to] ?? '', ids[at] ?? ''];
    void command({ action: 'reorder-folders', listKind, orderedFolderIds: ids }).catch(() => {});
  }
  async function remove(ids: string[]) {
    setWorking(true);
    try {
      await onDelete(ids);
      onSelect(new Set([...selected].filter((id) => !ids.includes(id))));
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  }
  const selectedCount = items.filter((i) => selected.has(i.id)).length;
  const menuItems: MenuItem[] = [
    ...(moreItems ?? []),
    {
      label: '按 ID 选中…',
      disabled: unavailable || items.length === 0,
      onSelect: () => setSelectByIdsOpen(true),
    },
    {
      label: '＋ 新建分组…',
      disabled: unavailable,
      onSelect: () => setName({ name: '' }),
    },
    ...(selected.size > 0
      ? [
          { separator: true as const, label: '移动已选到分组' },
          {
            label: '移到：未分组',
            disabled: unavailable,
            onSelect: () => void move(null).catch(() => {}),
          },
          ...folders.map((f) => ({
            label: '移到：' + f.name,
            disabled: unavailable,
            onSelect: () => void move(f.id).catch(() => {}),
          })),
        ]
      : []),
  ];
  return (
    <section className="finder-target-list" aria-label={title}>
      <div className="finder-toolbar">
        <FinderCheck
          ids={filtered.map((i) => i.id)}
          selected={selected}
          label={'全选' + title}
          disabled={unavailable}
          onChange={(checked) =>
            select(
              filtered.map((i) => i.id),
              checked,
            )
          }
        />
        <strong>{title}</strong>
        <small>
          已选 {selectedCount}/{items.length}
        </small>
        <div className="finder-toolbar-right">
          {selected.size > 0 && (
            <button
              className="btn btn-sm btn-danger"
              disabled={unavailable}
              onClick={() => void remove([...selected])}
            >
              删除 ({selected.size})
            </button>
          )}
          {searchOpen || query.length > 0 ? (
            <div className="finder-search-box">
              <input
                autoFocus={searchOpen}
                className="finder-search"
                aria-label={'搜索' + title}
                placeholder="搜索名称或 ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => {
                  if (!query.trim()) setSearchOpen(false);
                }}
              />
              <button
                type="button"
                className="finder-search-clear"
                aria-label={'关闭搜索' + title}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQuery('');
                  setSearchOpen(false);
                }}
              >
                ×
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-sm btn-icon finder-search-toggle"
              aria-label={'展开搜索' + title}
              title={'搜索' + title}
              onClick={() => setSearchOpen(true)}
            >
              🔍
            </button>
          )}
          {tools}
          <PopoverMenu
            disabled={unavailable}
            label={'更多' + title + '操作'}
            trigger={<>⋯</>}
            items={menuItems}
          />
        </div>
      </div>
      {error && (
        <p className="text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="finder-scroll">
        <div className="finder-columns">
          <span />
          <span>名称</span>
          <span>ID</span>
          <span>{countLabel}</span>
          <span />
        </div>
        {sections.map((f) => {
          const rows = filtered.filter((i) => (i.folderId ?? '') === f.id),
            ids = rows.map((i) => i.id);
          return (
            <section key={f.id || 'unfiled'}>
              {(f.id || folders.length > 0) && (
                <div
                  className={'finder-folder' + (drop === 'f:' + f.id ? ' is-drop' : '')}
                  onDragOver={(e) => {
                    if (!unavailable && drag.current.length) {
                      e.preventDefault();
                      setDrop('f:' + f.id);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop('');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (unavailable) return;
                    void move(f.id || null, drag.current).catch(() => {});
                    drag.current = [];
                    setDrop('');
                  }}
                >
                  <FinderCheck
                    ids={ids}
                    selected={selected}
                    label={'选择整组 ' + f.name}
                    disabled={unavailable}
                    onChange={(v) => select(ids, v)}
                  />
                  <button
                    className="finder-folder-title"
                    onClick={() =>
                      setClosed((prev) => {
                        const next = new Set(prev);
                        next.has(f.id) ? next.delete(f.id) : next.add(f.id);
                        return next;
                      })
                    }
                  >
                    {closed.has(f.id) ? '▸' : '▾'} {f.name}{' '}
                    <small>
                      ({ids.filter((id) => selected.has(id)).length}/{ids.length})
                    </small>
                  </button>
                  {f.id && (
                    <div className="finder-folder-actions">
                      <button
                        disabled={unavailable}
                        aria-label={f.name + '分组上移'}
                        onClick={() => reorderFolder(f.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        disabled={unavailable}
                        aria-label={f.name + '分组下移'}
                        onClick={() => reorderFolder(f.id, 1)}
                      >
                        ↓
                      </button>
                      <button
                        disabled={unavailable}
                        onClick={() => setName({ id: f.id, name: f.name })}
                      >
                        重命名
                      </button>
                      <button
                        disabled={unavailable}
                        title="删除分组，条目移到未分组"
                        onClick={() => void command({ action: 'delete', id: f.id }).catch(() => {})}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              )}
              {!closed.has(f.id) &&
                rows.map((item) => (
                  <div
                    key={item.id}
                    data-finder-id={item.id}
                    draggable={!unavailable}
                    className={
                      'finder-row' +
                      (selected.has(item.id) ? ' is-selected' : '') +
                      (drop === 'b:' + item.id
                        ? ' drop-before'
                        : drop === 'a:' + item.id
                          ? ' drop-after'
                          : '')
                    }
                    onClick={(e) => {
                      if (!unavailable) choose(item.id, e.shiftKey);
                    }}
                    onDragStart={(e) => {
                      if (paint.current !== null) {
                        e.preventDefault();
                        return;
                      }
                      drag.current = selected.has(item.id)
                        ? ordered.filter((i) => selected.has(i.id)).map((i) => i.id)
                        : [item.id];
                      e.dataTransfer.setData(
                        'text/plain',
                        JSON.stringify({ listKind, ids: drag.current }),
                      );
                      e.dataTransfer.effectAllowed = 'move';
                      const ghost = document.createElement('div');
                      ghost.className = 'finder-drag-ghost';
                      ghost.textContent = '移动 ' + drag.current.length + ' 个条目';
                      document.body.append(ghost);
                      e.dataTransfer.setDragImage(ghost, 0, 0);
                      setTimeout(() => ghost.remove(), 0);
                    }}
                    onDragEnd={() => {
                      drag.current = [];
                      setDrop('');
                    }}
                    onDragOver={(e) => {
                      if (!unavailable && drag.current.length) {
                        e.preventDefault();
                        setDrop(
                          (e.clientY <
                          e.currentTarget.getBoundingClientRect().top +
                            e.currentTarget.offsetHeight / 2
                            ? 'b:'
                            : 'a:') + item.id,
                        );
                      }
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop('');
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (unavailable || drag.current.includes(item.id)) return;
                      void move(
                        item.folderId,
                        drag.current,
                        item.id,
                        e.clientY >=
                          e.currentTarget.getBoundingClientRect().top +
                            e.currentTarget.getBoundingClientRect().height / 2,
                      ).catch(() => {});
                      drag.current = [];
                      setDrop('');
                    }}
                  >
                    <span
                      className="finder-check-cell"
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => {
                        if (unavailable || e.button !== 0) return;
                        e.stopPropagation();
                        pointerHandledRef.current = item.id;
                        const nextChecked = !selectionRef.current.has(item.id);
                        paint.current = nextChecked;
                        if (e.shiftKey) choose(item.id, true);
                        else {
                          anchor.current = item.id;
                          select([item.id], nextChecked);
                        }
                      }}
                      onPointerEnter={() => {
                        if (paint.current !== null && !unavailable)
                          select([item.id], paint.current);
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        disabled={unavailable}
                        aria-label={'选择 ' + item.name}
                        readOnly
                        onClick={(e) => {
                          e.stopPropagation();
                          if (pointerHandledRef.current === item.id) {
                            pointerHandledRef.current = null;
                            return;
                          }
                          if (!unavailable) choose(item.id, e.shiftKey);
                        }}
                      />
                    </span>
                    <span className="finder-name">
                      <FinderAvatar item={item} />
                      <strong>{item.name}</strong>
                    </span>
                    <code>{item.id}</code>
                    <span className="pill pill-ok">{item.count}</span>
                    <button
                      className="finder-delete"
                      disabled={unavailable}
                      aria-label={'删除 ' + item.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        void remove([item.id]);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              {!closed.has(f.id) && !rows.length && (
                <p
                  className={'finder-empty' + (drop === 'f:' + f.id ? ' is-drop' : '')}
                  onDragOver={(e) => {
                    if (!unavailable && drag.current.length) {
                      e.preventDefault();
                      setDrop('f:' + f.id);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop('');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (unavailable || !drag.current.length) return;
                    void move(f.id || null, drag.current).catch(() => {});
                    drag.current = [];
                    setDrop('');
                  }}
                >
                  {query ? '无匹配条目' : '暂无条目'}
                </p>
              )}
            </section>
          );
        })}
      </div>
      {selectByIdsOpen && (
        <SelectByIdsDialog
          title={'按 ID 批量选中 · ' + title}
          kind={listKind}
          candidates={buildTargetCandidates(ordered)}
          onClose={() => setSelectByIdsOpen(false)}
          onApply={(matchedIds, applyMode) => {
            const next =
              applyMode === 'replace'
                ? new Set(matchedIds)
                : new Set([...selectionRef.current, ...matchedIds]);
            selectionRef.current = next;
            onSelect(next);
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
      {name && (
        <NameDialog
          title={name.id ? '重命名分组' : '新建分组'}
          initial={name.name}
          onClose={() => setName(null)}
          onSubmit={async (value) => {
            await command(
              name.id
                ? { action: 'rename', id: name.id, name: value }
                : { action: 'create', listKind, name: value },
            );
          }}
        />
      )}
    </section>
  );
}
