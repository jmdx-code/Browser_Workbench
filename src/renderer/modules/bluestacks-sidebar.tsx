import { useRef, useState } from 'react';
import {
  bluestacksDisplayTitle,
  type BluestacksInstance,
  type BluestacksState,
} from '../../shared/bluestacks.js';
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
import { BluestacksBatchLoginModal } from './bluestacks-batch-login-modal.js';
import { BluestacksSidebarDialogs } from './bluestacks-config-dialog.js';
import { BluestacksHealthCheckModal } from './bluestacks-health-check-modal.js';
import { BluestacksRiskDashboardModal } from './bluestacks-risk-dashboard-modal.js';
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
  mode?:
    | 'bluestacks-active'
    | 'bluestacks-group-poster'
    | 'bluestacks-group-bumper'
    | 'bluestacks-page-bumper'
    | 'bluestacks-group-inviter';
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
  const [loginInst, setLoginInst] = useState<BluestacksInstance | null>(null);
  const [switchIdentityInst, setSwitchIdentityInst] = useState<BluestacksInstance | null>(null);
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const [batchLoginOpen, setBatchLoginOpen] = useState(false);
  const [healthCheckOpen, setHealthCheckOpen] = useState(false);
  const [riskDashboardOpen, setRiskDashboardOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rangeAnchor = useRef<string | null>(null);

  const instances = state?.instances ?? [];
  const folders = state?.folders ?? [];
  const onlineCount = instances.filter((i) => i.online).length;
  const launchingSet = new Set(state?.launchingIds ?? []);
  const closingSet = new Set(state?.closingIds ?? []);
  const inspectingSet = new Set(state?.inspectingIds ?? []);
  const installingSet = new Set(state?.installingIds ?? []);
  const loggingInSet = new Set(state?.loggingInIds ?? []);
  const switchingSet = new Set(state?.switchingIds ?? []);

  const busyRef = useRef(false);
  async function exec(action: string, payload: unknown = {}): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      onChange(await api.bluestacksAction(action, payload));
      return true;
    } catch (err) {
      onError(err instanceof Error ? err.message : '操作未成功');
      return false;
    } finally {
      busyRef.current = false;
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
    closed.has(g.id)
      ? []
      : matched.filter((i) => (i.folderId ?? 'ungrouped') === g.id).map((i) => i.id),
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
    const activeStat = state?.activeProfileCounts?.[id];
    const posterStat = state?.posterProfileCounts?.[id];
    const inviterStat = state?.inviterProfileCounts?.[id];
    const groupStat = state?.profileCounts[id];
    const pageStat = state?.pageBumperProfileCounts?.[id];
    if (activeStat?.running) return activeStat;
    if (posterStat?.running) return posterStat;
    if (inviterStat?.running) return inviterStat;
    if (pageStat?.running) return pageStat;
    if (groupStat?.running) return groupStat;
    if (mode === 'bluestacks-active') return activeStat ?? groupStat;
    if (mode === 'bluestacks-group-poster') return posterStat ?? groupStat;
    if (mode === 'bluestacks-group-inviter') return inviterStat ?? groupStat;
    if (mode === 'bluestacks-page-bumper') return pageStat ?? groupStat;
    return groupStat ?? pageStat;
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
        <div className="sidebar-heading-actions">
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
            title="蓝蝶路径与 APK 设置"
            aria-label="蓝蝶路径与 APK 设置"
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 6 }}>
          <div style={{ display: 'flex', gap: 5 }}>
            <button
              type="button"
              className="btn btn-sm sidebar-select-ids-btn"
              style={{ flex: 1, padding: '0 6px', fontSize: 12 }}
              disabled={instances.length === 0}
              onClick={() => setSelectByIdsOpen(true)}
            >
              按 ID 选中
            </button>
            <button
              type="button"
              className="btn btn-sm"
              style={{
                flex: 1,
                padding: '0 6px',
                fontSize: 12,
                ...((state?.dailyUsage?.reachedLimitInstances ?? 0) > 0
                  ? { color: '#b45309', borderColor: 'rgba(245,158,11,0.5)' }
                  : {}),
              }}
              disabled={instances.length === 0}
              title="查看今日蓝蝶各模块动作统计并配置单号每日风控安全限额"
              onClick={() => setRiskDashboardOpen(true)}
            >
              {(state?.dailyUsage?.reachedLimitInstances ?? 0) > 0
                ? `风控·休眠${state?.dailyUsage?.reachedLimitInstances}`
                : (state?.dailyUsage?.totalActions ?? 0) > 0
                  ? `风控(${state?.dailyUsage?.totalActions})`
                  : '风控看板'}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              style={{ padding: '0 8px', fontSize: 12 }}
              disabled={busy || onlineCount === 0}
              title="自动整齐平铺当前在线的蓝蝶模拟器窗口"
              onClick={() => void exec('instances/arrange', {})}
            >
              平铺
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            <button
              type="button"
              className={state?.batchLogin?.running ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ padding: '0 6px', fontSize: 12 }}
              disabled={instances.length === 0}
              title="粘贴账号清单批量自动登录 FB Lite（支持 2FA、自动开机与自动装包）"
              onClick={() => setBatchLoginOpen(true)}
            >
              {state?.batchLogin?.running
                ? `登录 ${state.batchLogin.completed}/${state.batchLogin.total}`
                : '批量登录'}
            </button>
            <button
              type="button"
              className={state?.healthCheck?.running ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
              style={{ padding: '0 6px', fontSize: 12 }}
              disabled={instances.length === 0}
              title="并发巡检蓝蝶窗口健康状态（未登录 / Checkpoint / 封禁 / 缺 App / 横屏，并支持缺包自装）"
              onClick={() => setHealthCheckOpen(true)}
            >
              {state?.healthCheck?.running
                ? `体检 ${state.healthCheck.completed}/${state.healthCheck.total}`
                : '批量体检'}
            </button>
          </div>
        </div>
      </div>

      {creating && (
        <form
          className="inline-create"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || !folderName.trim()) return;
            void exec('folders/create', { name: folderName.trim() }).then((ok) => {
              if (ok) {
                setFolderName('');
                setCreating(false);
              }
            });
          }}
        >
          <input
            required
            autoFocus
            disabled={busy}
            maxLength={80}
            placeholder="分组名称"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
          />
          <button className="btn btn-primary" type="submit" disabled={busy}>
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
        {instances.length === 0 ? (
          <div className="sidebar-empty-guide">
            <strong>未检测到蓝蝶多开实例</strong>
            <p className="hint">
              请确认已安装 BlueStacks 5，或点击下方按钮手动配置安装目录与{' '}
              <code>bluestacks.conf</code> 路径。
            </p>
            <div className="sidebar-empty-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setConfigOpen(true)}
              >
                配置蓝蝶路径
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => void exec('refresh')}
              >
                重新扫描
              </button>
            </div>
          </div>
        ) : (
          visibleGroups.map((group) => {
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
                      dailyStat={state?.dailyUsage?.perInstance[inst.id]}
                      selected={selected.has(inst.id)}
                      busy={busy}
                      isLaunching={launchingSet.has(inst.id)}
                      isClosing={closingSet.has(inst.id)}
                      isInspecting={inspectingSet.has(inst.id)}
                      isInstalling={installingSet.has(inst.id)}
                      isLoggingIn={loggingInSet.has(inst.id)}
                      isSwitching={switchingSet.has(inst.id)}
                      onSelectRow={selectRow}
                      onExec={(action, payload) => void exec(action, payload)}
                      onRename={() =>
                        setRenamingInst({ id: inst.id, alias: inst.alias ?? inst.displayName })
                      }
                      onDelete={() =>
                        setDeletingInsts({ ids: [inst.id], label: bluestacksDisplayTitle(inst) })
                      }
                      onLogin={() => setLoginInst(inst)}
                      onSwitchIdentity={() => setSwitchIdentityInst(inst)}
                    />
                  ))}
                {!isClosed && visibleInGroup.length === 0 && (
                  <p className="group-empty">暂无匹配的蓝蝶窗口</p>
                )}
              </section>
            );
          })
        )}
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
            disabled={busy || anySelectedRunning}
            title="自动进入菜单识别所选模拟器的 FB Lite 账号名与头像（未启动窗口会自动拉起）"
            onClick={() => void exec('instances/inspect', { instanceIds: selectedIds })}
          >
            识别账号
          </button>
          {anySelectedRunning && (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => void exec('stop-all', { profileIds: selectedIds })}
            >
              停止
            </button>
          )}
          <PopoverMenu
            label="更多操作"
            align="end"
            trigger={<IconMore size={15} />}
            items={[
              {
                label: '平铺所选窗口',
                disabled: busy || !anySelectedOnline,
                onSelect: () => void exec('instances/arrange', { instanceIds: selectedIds }),
              },
              {
                label: '批量安装 FB Lite APK',
                disabled: busy || anySelectedRunning,
                onSelect: () => void exec('instances/install-apk', { instanceIds: selectedIds }),
              },
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

      {batchLoginOpen && state && (
        <BluestacksBatchLoginModal
          state={state}
          selected={selected}
          onSelect={onSelect}
          onChange={onChange}
          onClose={() => setBatchLoginOpen(false)}
        />
      )}

      {healthCheckOpen && state && (
        <BluestacksHealthCheckModal
          state={state}
          selected={selected}
          onSelect={onSelect}
          onChange={onChange}
          onOpenBatchLogin={(ids) => {
            onSelect(new Set(ids));
            setHealthCheckOpen(false);
            setBatchLoginOpen(true);
          }}
          onClose={() => setHealthCheckOpen(false)}
        />
      )}

      {riskDashboardOpen && state && (
        <BluestacksRiskDashboardModal
          state={state}
          onChange={onChange}
          onClose={() => setRiskDashboardOpen(false)}
        />
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
        loginInst={loginInst}
        onCloseLoginInst={() => setLoginInst(null)}
        switchIdentityInst={switchIdentityInst}
        onCloseSwitchIdentityInst={() => setSwitchIdentityInst(null)}
      />
    </aside>
  );
}
