import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import type { TargetFolder, TargetListCommand, TargetListKind } from '../shared/target-list.js';
import { api } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';
import {
  insertFinderIds,
  orderedFinderItems,
  rangeFinderSelection,
  type FinderItem,
} from './finder-list-model.js';
import { IconMore, IconSearch } from './icons.js';
import { Btn } from './modules/shared/module-ui.js';
import { NameDialog } from './name-dialog.js';
import { PopoverMenu, type MenuItem } from './popover-menu.js';
import { buildTargetCandidates, SelectByIdsDialog } from './select-by-ids-dialog.js';
import { toggleSet } from './selection.js';
import { UI_CHECKBOX, UI_INPUT_SM } from './ui/primitives.js';

export { orderedFinderItems } from './finder-list-model.js';

const FINDER_GRID =
  'grid grid-cols-[28px_minmax(140px,1fr)_144px_96px_28px] items-center gap-2 max-[860px]:grid-cols-[28px_minmax(120px,1fr)_116px_80px_24px]';
const PILL_CLS: Record<'ok' | 'run' | 'warn' | 'idle', string> = {
  ok: 'pill pill-ok inline-flex items-center rounded-full bg-[var(--ok-soft)] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-[var(--ok)]',
  run: 'pill pill-run inline-flex items-center rounded-full bg-[var(--run-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--run)]',
  warn: 'pill pill-warn inline-flex items-center rounded-full bg-[var(--warn-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--warn)]',
  idle: 'pill pill-idle inline-flex items-center rounded-full bg-[var(--idle-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-2)]',
};

export function FinderAvatar({ item }: { item: Pick<FinderItem, 'name' | 'avatarUrl'> }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [item.avatarUrl]);
  return item.avatarUrl && !broken ? (
    <img
      src={item.avatarUrl}
      alt=""
      className="h-6 w-6 shrink-0 rounded-md border border-[var(--line)] bg-slate-100 object-cover"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  ) : (
    <span className="finder-avatar-placeholder inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--line)] bg-slate-100 text-[11px] font-semibold text-[var(--text-2)]">
      {Array.from(item.name)[0] ?? '?'}
    </span>
  );
}

export interface FinderDisabledItemInfo {
  badge: string;
  tone?: 'muted' | 'run' | 'warn' | undefined;
  title?: string | undefined;
}

export function FinderCheck(p: {
  ids: string[];
  selected: ReadonlySet<string>;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const count = p.ids.filter((id) => p.selected.has(id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < p.ids.length;
  }, [count, p.ids.length]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={UI_CHECKBOX}
      aria-label={p.label}
      checked={p.ids.length > 0 && count === p.ids.length}
      disabled={p.disabled}
      onChange={(e) => p.onChange(e.target.checked)}
    />
  );
}

interface RowCtx {
  listKind: TargetListKind;
  unavailable: boolean;
  selected: ReadonlySet<string>;
  drop: string;
  ordered: FinderItem[];
  drag: RefObject<string[]>;
  paint: RefObject<boolean | null>;
  textSelectRef: RefObject<boolean>;
  pointerHandledRef: RefObject<string | null>;
  selectionRef: RefObject<ReadonlySet<string>>;
  anchor: RefObject<string | null>;
  setDrop: (v: string) => void;
  choose: (id: string, shift: boolean) => void;
  select: (ids: string[], checked: boolean) => void;
  move: (
    folderId: string | null,
    moved?: string[],
    target?: string,
    after?: boolean,
  ) => Promise<unknown>;
  disableDrag: (e: MouseEvent<HTMLElement>) => void;
  onDel: (item: FinderItem) => void;
}

const isAfter = (e: MouseEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY >= r.top + r.height / 2;
};

function FinderTargetRow({
  item,
  dis,
  ctx,
}: {
  item: FinderItem;
  dis: FinderDisabledItemInfo | undefined;
  ctx: RowCtx;
}) {
  const off = ctx.unavailable || Boolean(dis);
  const selectedRow = !dis && ctx.selected.has(item.id);
  const rowCls =
    `finder-row ${FINDER_GRID} border-b border-slate-100 px-3 py-1.5 text-xs transition-colors ` +
    (selectedRow
      ? 'is-selected bg-[var(--brand-soft)]/70 hover:bg-[var(--brand-soft)]'
      : dis
        ? 'is-disabled-target bg-slate-50/60 opacity-65'
        : 'hover:bg-slate-50/90') +
    (ctx.drop === 'b:' + item.id
      ? ' drop-before shadow-[inset_0_2px_0_#2f6fed]'
      : ctx.drop === 'a:' + item.id
        ? ' drop-after shadow-[inset_0_-2px_0_#2f6fed]'
        : '');
  const pillCls = dis
    ? PILL_CLS[dis.tone === 'run' ? 'run' : dis.tone === 'warn' ? 'warn' : 'idle']
    : PILL_CLS.ok;
  return (
    <div
      data-finder-id={item.id}
      draggable={!off}
      title={dis?.title}
      className={rowCls}
      onClick={(e) => {
        if (!window.getSelection()?.toString().trim() && !off) ctx.choose(item.id, e.shiftKey);
      }}
      onDragStart={(e) => {
        if (
          ctx.paint.current !== null ||
          ctx.textSelectRef.current ||
          window.getSelection()?.toString().trim()
        )
          return e.preventDefault();
        ctx.drag.current = ctx.selected.has(item.id)
          ? ctx.ordered.filter((i) => ctx.selected.has(i.id)).map((i) => i.id)
          : [item.id];
        e.dataTransfer.setData(
          'text/plain',
          JSON.stringify({ listKind: ctx.listKind, ids: ctx.drag.current }),
        );
        e.dataTransfer.effectAllowed = 'move';
        const ghost = Object.assign(document.createElement('div'), {
          className:
            'finder-drag-ghost fixed -top-[9999px] left-0 rounded-lg border border-[var(--brand)] bg-[var(--graphite)] px-2.5 py-1 text-xs font-medium text-white shadow-md',
          textContent: `移动 ${ctx.drag.current.length} 个条目`,
        });
        document.body.append(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => ghost.remove(), 0);
      }}
      onDragEnd={() => {
        ctx.drag.current = [];
        ctx.setDrop('');
      }}
      onDragOver={(e) => {
        if (!ctx.unavailable && ctx.drag.current.length) {
          e.preventDefault();
          ctx.setDrop((isAfter(e) ? 'a:' : 'b:') + item.id);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ctx.setDrop('');
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (ctx.unavailable || ctx.drag.current.includes(item.id)) return;
        void ctx.move(item.folderId, ctx.drag.current, item.id, isAfter(e)).catch(() => {});
        ctx.drag.current = [];
        ctx.setDrop('');
      }}
    >
      <span
        className="finder-check-cell flex h-full cursor-pointer items-center justify-center"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          if (off || e.button !== 0) return;
          e.stopPropagation();
          ctx.pointerHandledRef.current = item.id;
          const next = !ctx.selectionRef.current.has(item.id);
          ctx.paint.current = next;
          if (e.shiftKey) ctx.choose(item.id, true);
          else {
            ctx.anchor.current = item.id;
            ctx.select([item.id], next);
          }
        }}
        onPointerEnter={() => {
          if (ctx.paint.current !== null && !off) ctx.select([item.id], ctx.paint.current);
        }}
      >
        <input
          type="checkbox"
          className={UI_CHECKBOX}
          checked={!dis && ctx.selected.has(item.id)}
          disabled={off}
          aria-label={'选择 ' + item.name}
          readOnly
          onClick={(e) => {
            e.stopPropagation();
            if (ctx.pointerHandledRef.current === item.id) {
              ctx.pointerHandledRef.current = null;
              return;
            }
            if (!off) ctx.choose(item.id, e.shiftKey);
          }}
        />
      </span>
      <span className="finder-name flex min-w-0 items-center gap-2">
        <FinderAvatar item={item} />
        <strong
          className="finder-row-name min-w-0 truncate font-medium text-[var(--text)] select-text"
          onMouseDown={ctx.disableDrag}
        >
          {item.name}
        </strong>
      </span>
      <code
        className="truncate font-mono text-[11px] text-[var(--text-3)] select-text"
        title={item.id}
        onMouseDown={ctx.disableDrag}
      >
        {item.id}
      </code>
      <span className="finder-count-cell flex items-center justify-start">
        <span className={pillCls} title={dis?.title}>
          {dis ? dis.badge : item.count}
        </span>
      </span>
      <button
        type="button"
        className="inline-flex h-6 w-6 items-center justify-center rounded border-0 bg-transparent p-0 text-sm leading-none text-[var(--text-3)] transition-colors hover:not-disabled:bg-rose-50 hover:not-disabled:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={ctx.unavailable}
        aria-label={'删除 ' + item.name}
        onClick={(e) => {
          e.stopPropagation();
          ctx.onDel(item);
        }}
      >
        ×
      </button>
    </div>
  );
}

type FinderModal =
  | { kind: 'ids' }
  | { kind: 'name'; id?: string; name: string }
  | { kind: 'delete'; target: 'items'; ids: string[]; label: string }
  | { kind: 'delete'; target: 'folder'; id: string; name: string }
  | null;

export function FinderTargetList(p: {
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
  disabledItems?: ReadonlyMap<string, FinderDisabledItemInfo> | undefined;
  tools?: ReactNode;
  moreItems?: MenuItem[];
}) {
  const {
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
    disabledItems,
    tools,
    moreItems,
  } = p;
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<FinderModal>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [drop, setDrop] = useState('');
  const anchor = useRef<string | null>(null);
  const drag = useRef<string[]>([]);
  const paint = useRef<boolean | null>(null);
  const textSelectRef = useRef(false);
  const pointerHandledRef = useRef<string | null>(null);
  const selectionRef = useRef(selected);
  selectionRef.current = selected;
  const unavailable = disabled || working;

  const disableDrag = (e: MouseEvent<HTMLElement>) => {
    textSelectRef.current = true;
    e.stopPropagation();
    const row = e.currentTarget.closest<HTMLElement>('.finder-row');
    if (!row?.draggable) return;
    row.draggable = false;
    const restore = () => {
      row.draggable = !unavailable;
      window.removeEventListener('mouseup', restore, true);
      window.removeEventListener('dragend', restore, true);
    };
    window.addEventListener('mouseup', restore, true);
    window.addEventListener('dragend', restore, true);
  };
  const loadFolders = async () => {
    const next = await api.targetFolders(listKind);
    setFolders(next);
    onFolders?.(next);
  };
  useEffect(() => {
    let alive = true;
    void api.targetFolders(listKind).then(
      (next) => alive && (setFolders(next), onFolders?.(next)),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [listKind]);
  useEffect(() => {
    if (selected.size === 0) return;
    const valid = new Set(items.filter((i) => !disabledItems?.has(i.id)).map((i) => i.id));
    if ([...selected].some((id) => !valid.has(id))) {
      const pruned = new Set([...selected].filter((id) => valid.has(id)));
      selectionRef.current = pruned;
      onSelect(pruned);
    }
  }, [items, selected, onSelect, disabledItems]);
  useEffect(() => {
    const stop = () => {
      paint.current = null;
      textSelectRef.current = false;
      setTimeout(() => {
        pointerHandledRef.current = null;
      }, 0);
    };
    for (const ev of ['pointerup', 'mouseup', 'blur'] as const) window.addEventListener(ev, stop);
    return () => {
      for (const ev of ['pointerup', 'mouseup', 'blur'] as const)
        window.removeEventListener(ev, stop);
    };
  }, []);

  const q = query.trim().toLowerCase();
  const matchedFids = new Set(
    q ? folders.filter((f) => f.name.toLowerCase().includes(q)).map((f) => f.id) : [],
  );
  const ordered = orderedFinderItems(items, folders);
  const filtered = q
    ? ordered.filter(
        (i) =>
          (i.name + ' ' + i.id).toLowerCase().includes(q) ||
          (i.folderId ? matchedFids.has(i.folderId) : false),
      )
    : ordered;
  const sections = [
    ...folders.map((f) => ({ id: f.id, name: f.name })),
    { id: '', name: folders.length ? '未分组' : '' },
  ];
  const visible = sections.flatMap((f) =>
    !q && closed.has(f.id)
      ? []
      : filtered
          .filter((i) => (i.folderId ?? '') === f.id && !disabledItems?.has(i.id))
          .map((i) => i.id),
  );

  const select = (ids: string[], checked: boolean) => {
    const next = new Set(selectionRef.current);
    ids.forEach((id) => (checked ? !disabledItems?.has(id) && next.add(id) : next.delete(id)));
    selectionRef.current = next;
    onSelect(next);
  };
  const choose = (id: string, shift: boolean) => {
    if (disabledItems?.has(id)) return;
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
  };
  const command = async (c: TargetListCommand) => {
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
  };
  const move = (
    folderId: string | null,
    moved = ordered.filter((i) => selected.has(i.id)).map((i) => i.id),
    target?: string,
    after = false,
  ) => {
    const ids = items
      .filter((i) => (i.folderId ?? null) === (folderId ?? null))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((i) => i.id);
    return command({
      action: 'reorder-items',
      listKind,
      folderId,
      orderedItemIds: insertFinderIds(ids, moved, target, after),
    });
  };
  const reorderFolder = (id: string, dir: -1 | 1) => {
    const ids = folders.map((f) => f.id);
    const at = ids.indexOf(id);
    const to = at + dir;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to] ?? '', ids[at] ?? ''];
    void command({ action: 'reorder-folders', listKind, orderedFolderIds: ids }).catch(() => {});
  };
  const remove = async (ids: string[]) => {
    setWorking(true);
    setError('');
    try {
      await onDelete(ids);
      const next = new Set([...selectionRef.current].filter((id) => !ids.includes(id)));
      selectionRef.current = next;
      onSelect(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const rowCtx: RowCtx = {
    listKind,
    unavailable,
    selected,
    drop,
    ordered,
    drag,
    paint,
    textSelectRef,
    pointerHandledRef,
    selectionRef,
    anchor,
    setDrop,
    choose,
    select,
    move,
    disableDrag,
    onDel: (t) =>
      setModal({ kind: 'delete', target: 'items', ids: [t.id], label: `「${t.name}」` }),
  };
  const selectedCount = items.filter((i) => selected.has(i.id)).length;
  const menuItems: MenuItem[] = [
    ...(moreItems ?? []),
    {
      label: '＋ 新建分组…',
      disabled: unavailable,
      onSelect: () => setModal({ kind: 'name', name: '' }),
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

  const dropCls = ' is-drop ring-2 ring-inset ring-blue-500 bg-blue-50/60';
  return (
    <section
      className="finder-target-list flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--line)] bg-white shadow-xs"
      aria-label={title}
    >
      <div className="finder-toolbar flex flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--surface-2)] px-3 py-2">
        <FinderCheck
          ids={visible}
          selected={selected}
          label={'全选' + title}
          disabled={unavailable || visible.length === 0}
          onChange={(c) => select(visible, c)}
        />
        <strong className="text-[13px] font-semibold text-[var(--text)]">{title}</strong>
        <small className="mr-auto text-xs tabular-nums text-[var(--text-3)]">
          已选 {selectedCount}/{items.length}
        </small>
        <div className="flex min-w-0 max-w-full flex-[0_1_auto] flex-wrap items-center justify-start gap-1.5">
          {selectedCount > 0 && (
            <Btn
              v="danger"
              disabled={unavailable}
              onClick={() => {
                const live = items.filter((i) => selected.has(i.id)).map((i) => i.id);
                setModal({
                  kind: 'delete',
                  target: 'items',
                  ids: live,
                  label: `所选的 ${live.length} 个条目`,
                });
              }}
            >
              删除 ({selectedCount})
            </Btn>
          )}
          {searchOpen || query.length > 0 ? (
            <div className="finder-search-box relative inline-flex items-center">
              <input
                autoFocus={searchOpen}
                className={`${UI_INPUT_SM} w-[148px] pr-6`}
                aria-label={'搜索' + title}
                placeholder="搜索名称或 ID"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onBlur={() => !query.trim() && setSearchOpen(false)}
              />
              <button
                type="button"
                className="absolute right-1 inline-flex h-5 w-5 items-center justify-center rounded border-0 bg-transparent p-0 text-sm leading-none text-[var(--text-3)] hover:bg-slate-200/70 hover:text-[var(--text)]"
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
            <Btn
              v="icon"
              aria-label={'展开搜索' + title}
              title={'搜索' + title}
              onClick={() => setSearchOpen(true)}
            >
              <IconSearch size={14} />
            </Btn>
          )}
          {tools}
          <Btn
            disabled={unavailable || items.length === 0}
            onClick={() => setModal({ kind: 'ids' })}
          >
            按 ID 选中
          </Btn>
          <PopoverMenu
            disabled={unavailable}
            label={'更多' + title + '操作'}
            trigger={<IconMore size={14} />}
            items={menuItems}
          />
        </div>
      </div>
      {error && (
        <p
          className="m-0 border-b border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700"
          role="alert"
        >
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-b-xl">
        <div
          className={`finder-columns ${FINDER_GRID} sticky top-0 z-10 border-b border-[var(--line)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] font-semibold text-[var(--text-3)]`}
        >
          <span />
          <span>名称</span>
          <span>ID</span>
          <span>{countLabel}</span>
          <span />
        </div>
        {q && filtered.length === 0 && (
          <p className="finder-empty m-0 px-3 py-5 text-center text-xs text-[var(--text-3)]">
            无匹配条目
          </p>
        )}
        {sections.map((f, sectionIndex) => {
          const rows = filtered.filter((i) => (i.folderId ?? '') === f.id);
          const selIds = rows.map((i) => i.id).filter((id) => !disabledItems?.has(id));
          if (q && rows.length === 0) return null;
          const isClosed = !q && closed.has(f.id);
          const dropHandlers = (reqNonEmpty: boolean) => ({
            onDragOver: (e: React.DragEvent<HTMLElement>) => {
              if (!unavailable && drag.current.length) {
                e.preventDefault();
                setDrop('f:' + f.id);
              }
            },
            onDragLeave: (e: React.DragEvent<HTMLElement>) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop('');
            },
            onDrop: (e: React.DragEvent<HTMLElement>) => {
              e.preventDefault();
              if (!unavailable && (!reqNonEmpty || drag.current.length)) {
                void move(f.id || null, drag.current).catch(() => {});
                drag.current = [];
                setDrop('');
              }
            },
          });
          return (
            <section key={f.id || 'unfiled'}>
              {(f.id || folders.length > 0) && (
                <div
                  className={
                    'finder-folder group/fld flex items-center gap-2 border-b border-[var(--line)] bg-slate-50/90 px-3 py-1.5 text-xs transition-colors' +
                    (drop === 'f:' + f.id ? dropCls : '')
                  }
                  {...dropHandlers(false)}
                >
                  <FinderCheck
                    ids={selIds}
                    selected={selected}
                    label={'选择整组 ' + f.name}
                    disabled={unavailable || selIds.length === 0}
                    onChange={(v) => select(selIds, v)}
                  />
                  <button
                    type="button"
                    className="finder-folder-title flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent p-0 text-left text-xs font-semibold text-[var(--text)] [&_small]:font-normal [&_small]:tabular-nums [&_small]:text-[var(--text-3)]"
                    onClick={() => setClosed((prev) => toggleSet(prev, f.id))}
                  >
                    {isClosed ? '▸' : '▾'} {f.name}{' '}
                    <small>
                      ({selIds.filter((id) => selected.has(id)).length}/{selIds.length})
                    </small>
                  </button>
                  {f.id && (
                    <div className="flex gap-1 opacity-0 transition-opacity group-focus-within/fld:opacity-100 group-hover/fld:opacity-100 [&_button]:h-[22px] [&_button]:min-h-[22px] [&_button]:cursor-pointer [&_button]:rounded [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-1.5 [&_button]:text-xs [&_button]:text-[var(--text-2)] [&_button:hover:not(:disabled)]:bg-slate-200/70 [&_button:hover:not(:disabled)]:text-[var(--text)]">
                      <button
                        type="button"
                        disabled={unavailable || sectionIndex === 0}
                        aria-label={`${f.name}分组上移`}
                        onClick={() => reorderFolder(f.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        disabled={unavailable || sectionIndex >= folders.length - 1}
                        aria-label={`${f.name}分组下移`}
                        onClick={() => reorderFolder(f.id, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        disabled={unavailable}
                        onClick={() => setModal({ kind: 'name', id: f.id, name: f.name })}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        disabled={unavailable}
                        title="删除分组，条目移到未分组"
                        onClick={() =>
                          setModal({ kind: 'delete', target: 'folder', id: f.id, name: f.name })
                        }
                      >
                        ×
                      </button>
                    </div>
                  )}
                </div>
              )}
              {!isClosed &&
                rows.map((item) => (
                  <FinderTargetRow
                    key={item.id}
                    item={item}
                    dis={disabledItems?.get(item.id)}
                    ctx={rowCtx}
                  />
                ))}
              {!isClosed && !rows.length && (
                <p
                  className={
                    'finder-empty m-0 px-3 py-5 text-center text-xs text-[var(--text-3)] transition-colors' +
                    (drop === 'f:' + f.id ? dropCls : '')
                  }
                  {...dropHandlers(true)}
                >
                  {query ? '无匹配条目' : '暂无条目'}
                </p>
              )}
            </section>
          );
        })}
      </div>
      {modal?.kind === 'ids' && (
        <SelectByIdsDialog
          title={'按 ID 批量选中 · ' + title}
          kind={listKind}
          candidates={buildTargetCandidates(ordered.filter((i) => !disabledItems?.has(i.id)))}
          onClose={() => setModal(null)}
          onApply={(matchedIds, applyMode) => {
            const next =
              applyMode === 'replace'
                ? new Set(matchedIds)
                : new Set([...selectionRef.current, ...matchedIds]);
            selectionRef.current = next;
            onSelect(next);
            const matchedSet = new Set(matchedIds);
            const toOpen = items.filter((i) => matchedSet.has(i.id)).map((i) => i.folderId ?? '');
            if (toOpen.length)
              setClosed((prev) => new Set([...prev].filter((fid) => !toOpen.includes(fid))));
          }}
        />
      )}
      {modal?.kind === 'name' && (
        <NameDialog
          title={modal.id ? '重命名分组' : '新建分组'}
          initial={modal.name}
          onClose={() => setModal(null)}
          onSubmit={async (v) =>
            command(
              modal.id
                ? { action: 'rename', id: modal.id, name: v }
                : { action: 'create', listKind, name: v },
            )
          }
        />
      )}
      {modal?.kind === 'delete' && (
        <ConfirmDialog
          title={modal.target === 'folder' ? '删除分组' : `删除${title}条目`}
          description={
            modal.target === 'folder'
              ? `确定要删除分组「${modal.name}」吗？组内条目将保留并自动移至「未分组」。`
              : `确定要从${title}中删除${modal.label}吗？`
          }
          confirmText="确认删除"
          danger
          busy={working}
          onCancel={() => setModal(null)}
          onConfirm={() => {
            const t = modal;
            setModal(null);
            if (t.target === 'folder') void command({ action: 'delete', id: t.id }).catch(() => {});
            else void remove(t.ids);
          }}
        />
      )}
    </section>
  );
}
