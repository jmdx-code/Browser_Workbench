import { useRef, useState } from 'react';
import { bluestacksDisplayTitle, type BluestacksState } from '../../shared/bluestacks.js';
import { api } from '../api.js';
import { nudgeFinderIds } from '../finder-list-model.js';
import {
  IconChevronDown,
  IconClose,
  IconEdit,
  IconMore,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSettings,
} from '../icons.js';
import { PopoverMenu } from '../popover-menu.js';
import { selectionState, toggleSet } from '../selection.js';
import { BluestacksSidebarDialogs } from './bluestacks-config-dialog.js';
import { BluestacksGroupCheck, BluestacksInstanceRow } from './bluestacks-sidebar-row.js';

export function BluestacksSidebar({
  state,
  onChange,
  selected,
  onSelect,
  onError,
  mode = 'bluestacks-group-bumper',
}: {
  state: BluestacksState | null;
  onChange: (next: BluestacksState) => void;
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  onError: (msg: string) => void;
  mode?: 'bluestacks-group-bumper' | 'bluestacks-page-bumper';
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'selected'>('all');
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [renamingFolder, setRenamingFolder] = useState<{ id: string; name: string } | null>(null);
  const [deletingFolder, setDeletingFolder] = useState<{ id: string; name: string } | null>(null);
  const [renamingInst, setRenamingInst] = useState<{ id: string; alias: string } | null>(null);
  const [deletingInsts, setDeletingInsts] = useState<{ ids: string[]; label: string } | null>(null);
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rangeAnchor = useRef<string | null>(null);

  const instances = state?.instances ?? [];
  const folders = state?.folders ?? [];
  const onlineCount = instances.filter((i) => i.online).length;
  const launchingSet = new Set(state?.launchingIds ?? []);
  const closingSet = new Set(state?.closingIds ?? []);
  const inspectingSet = new Set(state?.inspectingIds ?? []);

  async function exec(action: string, payload: unknown = {}) {
    setBusy(true);
    try {
      onChange(await api.bluestacksAction(action, payload));
    } catch (err) {
      onError(err instanceof Error ? err.message : '操作未成功');
    } finally {
      setBusy(false);
    }
  }

  const matched = instances.filter((inst) => {
    const q = query.trim().toLowerCase();
    const hay =
      `${inst.displayName} ${inst.alias ?? ''} ${inst.instanceKey} ${inst.accountName} ${inst.adbPort}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (filter === 'online') return inst.online || launchingSet.has(inst.id);
    if (filter === 'selected') return selected.has(inst.id);
    return true;
  });

  const groups = [
    ...folders.map((f) => ({ id: f.id, name: f.name })),
    { id: 'ungrouped', name: '未分组' },
  ];
  const visibleGroups = groups.filter(
    (g) => g.id !== 'ungrouped' || instances.some((i) => !i.folderId) || folders.length === 0,
  );
  const visibleIds = visibleGroups.flatMap((g) =>
    matched.filter((i) => (i.folderId ?? 'ungrouped') === g.id).map((i) => i.id),
  );
  const matchedState = selectionState(selected, visibleIds);

  function selectRow(id: string, checked: boolean, shiftKey = false) {
    const anchor = rangeAnchor.current;
    if (shiftKey && anchor && anchor !== id) {
      const a = visibleIds.indexOf(anchor);
      const b = visibleIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        onSelect(
          toggleSet(selected, visibleIds.slice(Math.min(a, b), Math.max(a, b) + 1), checked),
        );
        return;
      }
    }
    rangeAnchor.current = id;
    onSelect(toggleSet(selected, [id], checked));
  }

  async function moveInstancesTo(folderId: string | null, ids = [...selected]) {
    const inTarget = instances
      .filter((i) => i.folderId === folderId && !ids.includes(i.id))
      .map((i) => i.id);
    await exec('instances/reorder', { folderId, ids: [...ids, ...inTarget] });
  }

  async function nudgeSelected(direction: -1 | 1) {
    for (const g of groups) {
      const folderId = g.id === 'ungrouped' ? null : g.id;
      const ordered = instances.filter((i) => i.folderId === folderId).map((i) => i.id);
      const next = nudgeFinderIds(ordered, selected, direction);
      if (next.some((id, idx) => id !== ordered[idx])) {
        await exec('instances/reorder', { folderId, ids: next });
      }
    }
  }

  function getEffectiveStat(id: string) {
    const groupStat = state?.profileCounts[id];
    const pageStat = state?.pageBumperProfileCounts?.[id];
    if (pageStat?.running) return pageStat;
    if (groupStat?.running) return groupStat;
    return mode === 'bluestacks-page-bumper' ? (pageStat ?? groupStat) : (groupStat ?? pageStat);
  }

  const selectedIds = [...selected];
  const anySelectedRunning = selectedIds.some((id) => Boolean(getEffectiveStat(id)?.running));
  const anySelectedOnline = selectedIds.some((id) => instances.find((x) => x.id === id)?.online);

  return (
    <aside className="sidebar">
      <div className="sidebar-heading">
        <strong>蓝蝶窗口</strong>
        <span className="count-chip" title="在线窗口 / 全部实例">
          {onlineCount}/{instances.length}
        </span>
        <button
          type="button"
          className="btn btn-sm sidebar-select-ids-btn"
          disabled={instances.length === 0}
          onClick={() => setSelectByIdsOpen(true)}
        >
          按 ID 选中
        </button>
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          title="刷新蓝蝶多开列表"
          aria-label="刷新蓝蝶多开列表"
          disabled={busy}
          onClick={() => void exec('refresh')}
        >
          <IconRefresh />
        </button>
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          title="蓝蝶路径设置"
          aria-label="蓝蝶路径设置"
          onClick={() => setConfigOpen(true)}
        >
          <IconSettings size={15} />
        </button>
        <button
          type="button"
          className="btn btn-icon btn-ghost"
          title="新建分组"
          aria-label="新建分组"
          onClick={() => setCreating(!creating)}
        >
          <IconPlus />
        </button>
      </div>

      <div className="search-area">
        <label className="search-field">
          <IconSearch />
          <input
            placeholder="搜索窗口名、备注、账号名或端口"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <div className="filter-row">
          <BluestacksGroupCheck
            {...matchedState}
            label="全选当前显示的蓝蝶窗口"
            onChange={(checked) => onSelect(toggleSet(selected, visibleIds, checked))}
          />
          <div className="segmented">
            {(
              [
                ['all', '全部'],
                ['online', '在线'],
                ['selected', '已选'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={filter === val ? 'active' : ''}
                onClick={() => setFilter(val)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {creating && (
        <form
          className="inline-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (!folderName.trim()) return;
            void exec('folders/create', { name: folderName.trim() }).then(() => {
              setFolderName('');
              setCreating(false);
            });
          }}
        >
          <input
            required
            autoFocus
            maxLength={80}
            placeholder="分组名称"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            创建
          </button>
          <button
            className="btn btn-icon btn-ghost"
            type="button"
            aria-label="取消"
            onClick={() => setCreating(false)}
          >
            <IconClose />
          </button>
        </form>
      )}

      <div className="profile-list">
        {visibleGroups.map((group) => {
          const allInGroup = instances.filter((i) => (i.folderId ?? 'ungrouped') === group.id);
          const visibleInGroup = matched.filter((i) => (i.folderId ?? 'ungrouped') === group.id);
          const groupVisIds = visibleInGroup.map((i) => i.id);
          const gState = selectionState(selected, groupVisIds);
          const isClosed = closed.has(group.id);
          const runningCount = allInGroup.filter((i) => getEffectiveStat(i.id)?.running).length;

          return (
            <section className="group color-blue" key={group.id}>
              <div className="group-head">
                <BluestacksGroupCheck
                  {...gState}
                  label={'选择整组 ' + group.name}
                  onChange={(checked) => onSelect(toggleSet(selected, groupVisIds, checked))}
                />
                <button
                  type="button"
                  className={'group-title' + (isClosed ? ' is-closed' : '')}
                  aria-expanded={!isClosed}
                  onClick={() => setClosed(toggleSet(closed, [group.id], !isClosed))}
                >
                  <IconChevronDown size={14} />
                  <span>{group.name}</span>
                </button>
                {runningCount > 0 && (
                  <span className="group-running">
                    <IconPlay size={10} /> {runningCount}
                  </span>
                )}
                <span className="group-count">
                  {allInGroup.filter((i) => selected.has(i.id)).length}/{allInGroup.length}
                </span>
                {group.id !== 'ungrouped' && (
                  <PopoverMenu
                    className="group-menu"
                    label={'分组操作 · ' + group.name}
                    trigger={<IconMore size={15} />}
                    items={[
                      {
                        label: '↑ 上移分组',
                        onSelect: () => {
                          const next = nudgeFinderIds(
                            folders.map((f) => f.id),
                            new Set([group.id]),
                            -1,
                          );
                          void exec('folders/reorder', { ids: next });
                        },
                      },
                      {
                        label: '↓ 下移分组',
                        onSelect: () => {
                          const next = nudgeFinderIds(
                            folders.map((f) => f.id),
                            new Set([group.id]),
                            1,
                          );
                          void exec('folders/reorder', { ids: next });
                        },
                      },
                      {
                        label: '重命名分组',
                        icon: <IconEdit />,
                        onSelect: () => setRenamingFolder({ id: group.id, name: group.name }),
                      },
                      {
                        label: '删除分组',
                        icon: <IconClose />,
                        danger: true,
                        onSelect: () => setDeletingFolder({ id: group.id, name: group.name }),
                      },
                    ]}
                  />
                )}
              </div>
              {!isClosed &&
                visibleInGroup.map((inst) => (
                  <BluestacksInstanceRow
                    key={inst.id}
                    inst={inst}
                    stat={getEffectiveStat(inst.id)}
                    selected={selected.has(inst.id)}
                    busy={busy}
                    isLaunching={launchingSet.has(inst.id)}
                    isClosing={closingSet.has(inst.id)}
                    isInspecting={inspectingSet.has(inst.id)}
                    onSelectRow={selectRow}
                    onExec={(action, payload) => void exec(action, payload)}
                    onRename={() =>
                      setRenamingInst({ id: inst.id, alias: inst.alias ?? inst.displayName })
                    }
                    onDelete={() =>
                      setDeletingInsts({ ids: [inst.id], label: bluestacksDisplayTitle(inst) })
                    }
                  />
                ))}
              {!isClosed && visibleInGroup.length === 0 && (
                <p className="group-empty">暂无匹配的蓝蝶窗口</p>
              )}
            </section>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className="selection-bar compact-selection" aria-label="已选蓝蝶窗口操作">
          <span className="compact-selection-count">
            <strong>{selected.size}</strong>
            <button
              type="button"
              className="compact-clear-btn"
              aria-label="清空选择"
              title="清空选择"
              onClick={() => onSelect(new Set())}
            >
              ×
            </button>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            title="启动所选蓝蝶多开窗口"
            onClick={() => void exec('instances/launch', { instanceIds: selectedIds })}
          >
            启动窗口
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !anySelectedOnline || anySelectedRunning}
            title="关闭所选蓝蝶窗口"
            onClick={() => void exec('instances/close', { instanceIds: selectedIds })}
          >
            关闭窗口
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !anySelectedOnline}
            title="自动进入菜单识别所选在线模拟器的 FB Lite 账号名与头像"
            onClick={() => void exec('instances/inspect', { instanceIds: selectedIds })}
          >
            识别账号
          </button>
          {anySelectedRunning && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => void exec('bumper/stop', { profileIds: selectedIds })}
            >
              停止
            </button>
          )}
          <PopoverMenu
            label="更多操作"
            align="end"
            trigger={<IconMore size={15} />}
            items={[
              { label: '移至：未分组', onSelect: () => void moveInstancesTo(null) },
              ...folders.map((f) => ({
                label: '移至：' + f.name,
                onSelect: () => void moveInstancesTo(f.id),
              })),
              { label: '↑ 上移所选窗口', onSelect: () => void nudgeSelected(-1) },
              { label: '↓ 下移所选窗口', onSelect: () => void nudgeSelected(1) },
            ]}
          />
        </div>
      )}

      <BluestacksSidebarDialogs
        state={state}
        onChange={onChange}
        selected={selected}
        onSelect={onSelect}
        selectByIdsOpen={selectByIdsOpen}
        onCloseSelectByIds={() => setSelectByIdsOpen(false)}
        configOpen={configOpen}
        onCloseConfig={() => setConfigOpen(false)}
        renamingFolder={renamingFolder}
        onCloseRenamingFolder={() => setRenamingFolder(null)}
        renamingInst={renamingInst}
        onCloseRenamingInst={() => setRenamingInst(null)}
        deletingFolder={deletingFolder}
        onCloseDeletingFolder={() => setDeletingFolder(null)}
        deletingInsts={deletingInsts}
        onCloseDeletingInsts={() => setDeletingInsts(null)}
      />
    </aside>
  );
}
