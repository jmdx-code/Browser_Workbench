import { useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './confirm-dialog.js';
import {
  IconChevronDown,
  IconClose,
  IconEdit,
  IconMore,
  IconPanelClose,
  IconPlay,
  IconPlus,
  IconSearch,
} from './icons.js';
import type { ProfileActivityDescriptor } from './modules/module-contracts.js';
import { Btn, TriCheck } from './modules/shared/module-ui.js';
import { NameDialog } from './name-dialog.js';
import { PopoverMenu, type MenuItem } from './popover-menu.js';
import { ProfileAvatar, type StatusTone } from './profile-avatar.js';
import { selectionState, toggleSet } from './selection.js';
import { TaskProgressView } from './task-progress.js';
import { UI_CHECKBOX, UI_COUNT_CHIP, UI_INPUT_SM } from './ui/primitives.js';
import {
  computeDragAutoScrollDelta,
  usePointerDragReorder,
  type PointerDragRowProps,
} from './use-pointer-drag-reorder.js';
export { computeDragAutoScrollDelta };
interface SidebarSelectionAction {
  label: string;
  title?: string;
  className?: string;
  disabled: boolean;
  onClick: () => void;
}
export interface SidebarDragReorderConfig {
  disabled: boolean;
  unitLabel: string;
  getDragIds: (rowId: string) => string[];
  onDropOnRow: (folderId: string, movedIds: string[], targetRowId: string, after: boolean) => void;
  onDropOnFolder: (folderId: string, movedIds: string[]) => void;
}
export type SidebarAttentionChipConfig = { label: string; count: number; title?: string };
export const mi = (
  label: string,
  onSelect: () => void,
  opts?: Partial<Omit<MenuItem, 'label' | 'onSelect'>>,
): MenuItem => ({ label, onSelect, ...opts });
export const sa = (
  label: string,
  disabled: boolean,
  onClick: () => void,
  opts?: { className?: string; title?: string },
): SidebarSelectionAction => ({ label, disabled, onClick, ...opts });
export function buildMoveMenuItems(
  currentFolderId: string | null,
  folders: ReadonlyArray<{ id: string; name: string }>,
  busy: boolean,
  onNudge: (dir: -1 | 1) => void,
  onMove: (folderId: string | null) => void,
): MenuItem[] {
  return [
    mi('↑ 上移', () => onNudge(-1), { disabled: busy }),
    mi('↓ 下移', () => onNudge(1), { disabled: busy }),
    mi('移至：未分组', () => onMove(null), { disabled: busy || currentFolderId === null }),
    ...folders.map((f) =>
      mi('移至：' + f.name, () => onMove(f.id), { disabled: busy || currentFolderId === f.id }),
    ),
  ];
}
export function useSidebarListState(
  selected: ReadonlySet<string>,
  onSelect: (ids: Set<string>) => void,
) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'selected' | 'attention'>('all');
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const anchorRef = useRef<string | null>(null);
  const toggleClosed = (gid: string, nextClosed: boolean) =>
    setClosed((prev) => toggleSet(prev, [gid], nextClosed));
  const openFolders = (gids: Iterable<string>) =>
    setClosed((prev) => {
      const n = new Set(prev);
      let ch = false;
      for (const g of gids) if (n.delete(g)) ch = true;
      return ch ? n : prev;
    });
  const selectRow = (
    visibleIds: readonly string[],
    id: string,
    checked: boolean,
    shift: boolean,
  ) => {
    const start = anchorRef.current ? visibleIds.indexOf(anchorRef.current) : -1;
    const end = visibleIds.indexOf(id);
    const range =
      shift && start >= 0 && end >= 0
        ? visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)
        : [id];
    onSelect(toggleSet(selected, range, checked));
    anchorRef.current = id;
  };
  return { query, setQuery, filter, setFilter, closed, toggleClosed, openFolders, selectRow };
}
interface SidebarRowShellProps {
  id: string;
  displayName: string;
  codeText: string;
  selected: boolean;
  isFiltered?: boolean;
  dropClass?: string;
  dragProps?: PointerDragRowProps | undefined;
  avatarUrl: string | null;
  online: boolean;
  refreshKey: number;
  tone: StatusTone;
  toneLabel: string;
  tooltip: string;
  ariaPressed?: boolean | undefined;
  taskText?: string | undefined;
  taskTone?: string | undefined;
  taskClassName?: string | undefined;
  progressView?: ProfileActivityDescriptor['progressView'];
  menuItems: MenuItem[];
  onSelect: (checked: boolean, shiftKey: boolean) => void;
  onMainClick: (shiftKey: boolean, ctrlOrMeta: boolean) => void;
}
const TASK_TONE_CLS: Record<string, string> = {
  run: 'bg-[var(--run-soft)] text-[var(--run)]',
  queue: 'bg-[#eef1f6] text-[#5c6b82]',
  ok: 'bg-[#eaf5ef] text-[#26724e]',
  err: 'bg-[#faeceb] text-[#b1453f]',
  pause: 'bg-[var(--warn-soft)] text-[var(--warn)]',
  warn: 'bg-[var(--warn-soft)] text-[var(--warn)]',
};
const COMPACT_BASE_CLS =
  'btn inline-flex h-7 flex-1 min-w-[64px] items-center justify-center rounded-md border px-2 text-[11.5px] font-medium leading-none whitespace-nowrap transition-colors active:not-disabled:translate-y-[0.5px] disabled:cursor-not-allowed';
const COMPACT_ACTION_CLS = `${COMPACT_BASE_CLS} border-white/15 bg-white/10 text-slate-100 hover:not-disabled:border-white/25 hover:not-disabled:bg-white/18 hover:not-disabled:text-white disabled:border-white/10 disabled:bg-white/[0.05] disabled:text-slate-400`;
const COMPACT_LAUNCH_CLS = `${COMPACT_BASE_CLS} btn-launch border-blue-400/50 bg-blue-600 text-white shadow-2xs hover:not-disabled:bg-blue-500 disabled:border-white/10 disabled:bg-white/[0.06] disabled:text-slate-400`;
const COMPACT_DANGER_CLS = `${COMPACT_BASE_CLS} btn-danger border-rose-400/50 bg-rose-600/90 text-white shadow-2xs hover:not-disabled:bg-rose-500 disabled:border-white/10 disabled:bg-white/[0.06] disabled:text-slate-400`;
export function SidebarRowShell(p: SidebarRowShellProps) {
  const dropRing = p.dropClass?.includes('drop-before')
    ? ' shadow-[inset_0_2px_0_#2f6fed]'
    : p.dropClass?.includes('drop-after')
      ? ' shadow-[inset_0_-2px_0_#2f6fed]'
      : '';
  return (
    <div
      className={`profile-row group relative my-px flex min-h-[46px] items-center gap-2.5 rounded-md py-1.5 pr-1 pl-2 transition-colors ${p.dragProps ? 'cursor-grab active:cursor-grabbing ' : ''}${p.selected ? 'selected bg-[var(--brand-soft)]' : 'bg-transparent hover:bg-[var(--surface-3)]'}${p.isFiltered ? ' bg-white shadow-[inset_3px_0_0_var(--brand),var(--shadow-1)]' : ''}${p.dropClass ?? ''}${dropRing}`}
      onClick={(e) => {
        if (
          !(e.target instanceof Element && e.target.closest('button,input')) &&
          (e.shiftKey || e.ctrlKey || e.metaKey)
        )
          p.onSelect(!p.selected, e.shiftKey);
      }}
      {...p.dragProps}
    >
      <input
        type="checkbox"
        className={UI_CHECKBOX}
        aria-label={'选择 ' + p.displayName}
        checked={p.selected}
        onChange={(e) =>
          p.onSelect(
            e.target.checked,
            e.nativeEvent instanceof MouseEvent && e.nativeEvent.shiftKey,
          )
        }
      />
      <ProfileAvatar
        url={p.avatarUrl}
        online={p.online}
        refreshKey={p.refreshKey}
        tone={p.tone}
        toneLabel={p.toneLabel}
      />
      <button
        type="button"
        data-drag-allow="true"
        className="flex h-auto min-w-0 flex-1 flex-col gap-[3px] border-0 bg-transparent p-0 text-left hover:bg-transparent"
        title={p.tooltip}
        aria-pressed={p.ariaPressed}
        onClick={(e) => p.onMainClick(e.shiftKey, e.ctrlKey || e.metaKey)}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <strong className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--text)]">
            {p.displayName}
          </strong>
          <code className="max-w-[58%] shrink-0 truncate font-mono text-[11px] tabular-nums text-[var(--text-3)]">
            {p.codeText}
          </code>
        </span>
        {p.taskText !== undefined && (
          <span
            className={`flex h-5 min-w-0 items-center gap-1.5 rounded-[5px] px-[7px] text-xs font-semibold ${p.taskClassName ?? ''} ${TASK_TONE_CLS[p.taskTone ?? p.tone] ?? ''}`}
          >
            <span className="min-w-0 flex-1 truncate">{p.taskText}</span>
            {p.progressView && <TaskProgressView {...p.progressView} compact />}
          </span>
        )}
      </button>
      <PopoverMenu
        className="row-menu shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded='true']]:opacity-100"
        label={'更多 · ' + p.displayName}
        trigger={<IconMore size={15} />}
        items={p.menuItems}
      />
    </div>
  );
}
interface SidebarFolderGroup<T extends { id: string }> {
  id: string;
  name: string;
  color: string;
  allItems: T[];
  matchedItems: T[];
  runningCount: number;
}
export function buildSidebarViewModel<T extends { id: string }>(opts: {
  groups: ReadonlyArray<{ id: string; name: string; color?: string }>;
  allItems: readonly T[];
  matchedItems: readonly T[];
  getGroupId: (item: T) => string;
  isRunning: (item: T) => boolean;
  closed: ReadonlySet<string>;
}) {
  const folderGroups: SidebarFolderGroup<T>[] = opts.groups.map((g) => {
    const allItems = opts.allItems.filter((item) => opts.getGroupId(item) === g.id);
    return {
      id: g.id,
      name: g.name,
      color: g.color ?? 'blue',
      allItems,
      matchedItems: opts.matchedItems.filter((item) => opts.getGroupId(item) === g.id),
      runningCount: allItems.filter(opts.isRunning).length,
    };
  });
  const visibleIds = folderGroups.flatMap((g) =>
    opts.closed.has(g.id) ? [] : g.matchedItems.map((i) => i.id),
  );
  return { folderGroups, visibleIds };
}
export function AccountsSidebarShell<T extends { id: string }>(p: {
  title: string;
  countTitle: string;
  onlineCount: number;
  totalCount: number;
  headingActions: ReactNode;
  onHideSidebar?: (() => void) | undefined;
  searchPlaceholder: string;
  list: ReturnType<typeof useSidebarListState>;
  selectAllLabel: string;
  matchedIds: string[];
  filterLabels: readonly [string, string, string];
  attentionChip?: SidebarAttentionChipConfig | undefined;
  extraTools?: ReactNode;
  creatingBusy?: boolean;
  onCreateGroup: (name: string) => Promise<boolean | void> | void;
  groups: readonly SidebarFolderGroup<T>[];
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  busy: boolean;
  onNudgeGroup: (id: string, dir: -1 | 1) => void;
  onRenameGroupSubmit: (id: string, name: string) => Promise<void>;
  onDeleteGroupConfirm: (id: string) => Promise<void>;
  deleteGroupDescription: string;
  dragReorder?: SidebarDragReorderConfig | undefined;
  renderRow: (
    item: T,
    drag?: { rowProps: PointerDragRowProps; dropClass: string } | undefined,
  ) => ReactNode;
  emptyGroupText: (allCount: number) => string;
  emptyListNode?: ReactNode;
  footerNotice?: ReactNode;
  selectionBarAriaLabel: string;
  selectionActions: readonly SidebarSelectionAction[];
  dialogs: ReactNode;
}) {
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [groupModal, setGroupModal] = useState<{
    kind: 'rename' | 'delete';
    id: string;
    name: string;
  } | null>(null);
  const { list } = p;
  const matchedState = selectionState(p.selected, p.matchedIds);
  const filterTabs: readonly ['all' | 'online' | 'selected', string][] = [
    ['all', p.filterLabels[0]],
    ['online', p.filterLabels[1]],
    ['selected', p.filterLabels[2]],
  ];
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const drag = usePointerDragReorder({
    disabled: p.busy || !p.dragReorder || p.dragReorder.disabled,
    scrollContainerRef,
    unitLabel: p.dragReorder?.unitLabel ?? '项',
    getDragIds: p.dragReorder?.getDragIds ?? ((id) => [id]),
    isFolderCollapsed: (gid) => list.closed.has(gid),
    onAutoExpandFolder: (gid) => list.openFolders([gid]),
    onDropOnRow: (gid, ids, targetId, after) =>
      p.dragReorder?.onDropOnRow(gid, ids, targetId, after),
    onDropOnFolder: (gid, ids) => p.dragReorder?.onDropOnFolder(gid, ids),
  });
  const dropRingCls = ' is-drop rounded-md ring-2 ring-inset ring-[var(--brand)] bg-blue-50/60';
  return (
    <aside className="sidebar flex min-h-0 w-[var(--sidebar-width,290px)] shrink-0 flex-col border-r border-[var(--line)] bg-[var(--sidebar-bg)] max-[860px]:w-[min(var(--sidebar-width,248px),30vw)] max-[860px]:min-w-[216px]">
      <div className="flex h-12 shrink-0 items-center justify-between gap-1 overflow-hidden px-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <strong className="truncate text-[13.5px] font-semibold whitespace-nowrap text-slate-900">
            {p.title}
          </strong>
          <span className={UI_COUNT_CHIP + ' max-[960px]:hidden'} title={p.countTitle}>
            {p.onlineCount}/{p.totalCount}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {p.headingActions}
          <Btn
            v="icon"
            className="h-[26px] w-[26px]"
            title="新建分组"
            aria-label="新建分组"
            onClick={() => setCreating((v) => !v)}
          >
            <IconPlus />
          </Btn>
          {p.onHideSidebar && (
            <Btn
              v="icon"
              className="h-[26px] w-[26px]"
              title="收起左侧设备栏（可随时在左侧边缘重新展开）"
              aria-label="收起设备栏"
              onClick={p.onHideSidebar}
            >
              <IconPanelClose size={15} />
            </Btn>
          )}
        </div>
      </div>
      <div className="px-2.5 pb-2.5">
        <label className="relative flex min-w-0 items-center">
          <IconSearch className="pointer-events-none absolute left-2.5 text-[var(--text-3)]" />
          <input
            className={UI_INPUT_SM + ' h-8 w-full pl-8 text-xs'}
            placeholder={p.searchPlaceholder}
            value={list.query}
            onChange={(e) => list.setQuery(e.target.value)}
          />
        </label>
        <div className="mt-2 flex items-center gap-2 pl-2">
          <TriCheck
            {...matchedState}
            label={p.selectAllLabel}
            title={p.selectAllLabel}
            onChange={(c) => p.onSelect(toggleSet(p.selected, p.matchedIds, c))}
          />
          <div className="flex flex-1 rounded-md border border-[var(--line)] bg-[var(--surface-3)] p-0.5">
            {filterTabs.map(([v, label]) => (
              <button
                key={v}
                type="button"
                className={`h-[26px] flex-1 rounded-[5px] border-0 text-xs font-semibold transition-colors ${list.filter === v ? 'bg-white text-[var(--text)] shadow-2xs' : 'bg-transparent text-[var(--text-2)] hover:text-[var(--text)]'}`}
                onClick={() => list.setFilter(v)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {p.attentionChip && (
          <div className="mt-1.5 flex items-center pl-2">
            <button
              type="button"
              aria-pressed={list.filter === 'attention'}
              title={p.attentionChip.title}
              className={`inline-flex h-6 w-full items-center justify-between rounded-md border px-2 text-[11px] font-semibold transition-colors ${
                list.filter === 'attention'
                  ? 'border-rose-300 bg-rose-50 text-rose-700 shadow-2xs'
                  : p.attentionChip.count > 0
                    ? 'border-amber-200 bg-amber-50/70 text-amber-800 hover:bg-amber-100/70'
                    : 'border-[var(--line)] bg-white text-[var(--text-3)] hover:text-[var(--text)]'
              }`}
              onClick={() => list.setFilter(list.filter === 'attention' ? 'all' : 'attention')}
            >
              <span>{p.attentionChip.label}</span>
              <span className="rounded-full bg-black/5 px-1.5 py-px tabular-nums">
                {p.attentionChip.count}
              </span>
            </button>
          </div>
        )}
        {p.extraTools}
      </div>
      {creating && (
        <form
          className="flex gap-1.5 px-2.5 pb-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void Promise.resolve(p.onCreateGroup(createName)).then((ok) => {
              if (ok !== false) {
                setCreateName('');
                setCreating(false);
              }
            });
          }}
        >
          <input
            required
            autoFocus
            className={UI_INPUT_SM + ' flex-1'}
            disabled={p.creatingBusy}
            maxLength={80}
            placeholder="分组名称"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && !p.creatingBusy) setCreating(false);
            }}
          />
          <Btn v="primary" type="submit" disabled={p.creatingBusy}>
            创建
          </Btn>
          <Btn
            v="icon"
            aria-label="取消"
            disabled={p.creatingBusy}
            onClick={() => setCreating(false)}
          >
            <IconClose />
          </Btn>
        </form>
      )}
      <div
        ref={scrollContainerRef}
        className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--line)] px-2 pt-1 pb-3"
        onClickCapture={drag.onContainerClickCapture}
      >
        {p.totalCount === 0 && p.emptyListNode
          ? p.emptyListNode
          : p.groups.map((group) => {
              const visibleGroupIds = group.matchedItems.map((i) => i.id);
              const gState = selectionState(p.selected, visibleGroupIds);
              const isClosed = list.closed.has(group.id);
              const isDrop = drag.dropKey === 'f:' + group.id;
              return (
                <section className="mt-2 first:mt-1" key={group.id}>
                  <div
                    data-drag-drop-folder-id={p.dragReorder ? group.id : undefined}
                    className={`group-head group flex min-h-8 items-center gap-1.5 rounded-md pr-1 pl-2 transition-colors hover:bg-[var(--surface-3)]${isDrop ? ' is-drop ring-2 ring-inset ring-[var(--brand)] bg-blue-50/60' : ''}`}
                  >
                    <TriCheck
                      {...gState}
                      label={'选择整组 ' + group.name}
                      title={'选择整组 ' + group.name}
                      onChange={(c) => p.onSelect(toggleSet(p.selected, visibleGroupIds, c))}
                    />
                    <button
                      type="button"
                      className={`flex h-7 min-w-0 flex-1 items-center gap-1 border-0 bg-transparent px-0.5 text-left text-xs font-bold tracking-wide text-[var(--text-2)] hover:text-[var(--text)]${isClosed ? ' is-closed' : ''}`}
                      aria-expanded={!isClosed}
                      onClick={() => list.toggleClosed(group.id, !isClosed)}
                    >
                      <IconChevronDown
                        size={14}
                        className={`shrink-0 text-[var(--text-3)] transition-transform ${isClosed ? '-rotate-90' : ''}`}
                      />
                      <span className="truncate">{group.name}</span>
                    </button>
                    {group.runningCount > 0 && (
                      <span
                        className="inline-flex h-[18px] items-center gap-[3px] rounded-full bg-[var(--run-soft)] px-1.5 text-[11px] font-bold whitespace-nowrap text-[var(--run)]"
                        title="正在执行任务的浏览器数量"
                      >
                        <IconPlay size={10} /> {group.runningCount}
                      </span>
                    )}
                    <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-3)]">
                      {group.allItems.filter((i) => p.selected.has(i.id)).length}/
                      {group.allItems.length}
                    </span>
                    {group.id !== 'ungrouped' && (
                      <PopoverMenu
                        className="group-menu shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded='true']]:opacity-100"
                        label={'分组操作 · ' + group.name}
                        trigger={<IconMore size={15} />}
                        items={[
                          mi('↑ 上移分组', () => p.onNudgeGroup(group.id, -1), {
                            disabled: p.busy,
                          }),
                          mi('↓ 下移分组', () => p.onNudgeGroup(group.id, 1), { disabled: p.busy }),
                          mi(
                            '重命名分组',
                            () => setGroupModal({ kind: 'rename', id: group.id, name: group.name }),
                            { icon: <IconEdit /> },
                          ),
                          mi(
                            '删除分组',
                            () => setGroupModal({ kind: 'delete', id: group.id, name: group.name }),
                            { icon: <IconClose />, danger: true, disabled: p.busy },
                          ),
                        ]}
                      />
                    )}
                  </div>
                  {!isClosed &&
                    group.matchedItems.map((item) => {
                      const rowDrag = p.dragReorder
                        ? {
                            rowProps: drag.getRowProps(item.id, group.id),
                            dropClass:
                              drag.dropKey === 'b:' + item.id
                                ? ' drop-before'
                                : drag.dropKey === 'a:' + item.id
                                  ? ' drop-after'
                                  : '',
                          }
                        : undefined;
                      return p.renderRow(item, rowDrag);
                    })}
                  {!isClosed && group.matchedItems.length === 0 && (
                    <p
                      data-drag-drop-folder-id={p.dragReorder ? group.id : undefined}
                      className={`group-empty py-1.5 pr-3 pb-2 pl-10 text-xs text-[var(--text-3)]${isDrop ? dropRingCls : ''}`}
                    >
                      {p.emptyGroupText(group.allItems.length)}
                    </p>
                  )}
                </section>
              );
            })}
      </div>
      {p.footerNotice}
      {p.selected.size > 0 && (
        <div
          className="selection-bar compact-selection mx-2 mt-1 mb-2 flex shrink-0 flex-col gap-1.5 rounded-xl border border-slate-700/80 bg-[#1e242d] p-2 text-slate-100 shadow-lg"
          aria-label={p.selectionBarAriaLabel}
        >
          <div className="flex items-center justify-between gap-2 px-0.5">
            <span className="whitespace-nowrap text-[11px] font-medium text-slate-300">
              已选{' '}
              <strong className="font-semibold tabular-nums text-white">{p.selected.size}</strong>{' '}
              项
            </span>
            <button
              type="button"
              className="inline-flex h-5 shrink-0 items-center gap-0.5 whitespace-nowrap rounded px-1.5 text-[11px] font-medium text-slate-300 transition-colors hover:bg-white/12 hover:text-white"
              aria-label="清空选择"
              title="清空选择"
              onClick={() => p.onSelect(new Set())}
            >
              × 清空
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {p.selectionActions.map((a) => {
              const cls = a.className?.includes('btn-danger')
                ? COMPACT_DANGER_CLS
                : a.className?.includes('btn-launch')
                  ? COMPACT_LAUNCH_CLS
                  : COMPACT_ACTION_CLS;
              return (
                <button
                  key={a.label}
                  type="button"
                  className={cls}
                  disabled={a.disabled}
                  title={a.title}
                  onClick={a.onClick}
                >
                  {a.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {groupModal?.kind === 'rename' && (
        <NameDialog
          title="分组名称"
          initial={groupModal.name}
          onClose={() => setGroupModal(null)}
          onSubmit={(name) => p.onRenameGroupSubmit(groupModal.id, name)}
        />
      )}
      {groupModal?.kind === 'delete' && (
        <ConfirmDialog
          title={'删除分组「' + groupModal.name + '」'}
          description={p.deleteGroupDescription}
          label="删除分组"
          onClose={() => setGroupModal(null)}
          onConfirm={() => p.onDeleteGroupConfirm(groupModal.id)}
        />
      )}
      {p.dialogs}
      {drag.ghost}
    </aside>
  );
}
