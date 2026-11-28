import { useRef, useState } from 'react';
import {
  bluestacksDisplayTitle,
  isBluestacksPortraitResolution,
  type BluestacksInstance,
  type BluestacksState,
} from '../../shared/bluestacks.js';
import {
  AccountsSidebarShell,
  buildMoveMenuItems,
  buildSidebarViewModel,
  mi,
  sa,
  SidebarRowShell,
  useSidebarListState,
} from '../accounts-sidebar-shell.js';
import { api } from '../api.js';
import { nudgeFinderIds } from '../finder-list-model.js';
import {
  IconClose,
  IconEdit,
  IconPlay,
  IconRefresh,
  IconSettings,
  IconStop,
  IconWindow,
} from '../icons.js';
import type { MenuItem } from '../popover-menu.js';
import type { StatusTone } from '../profile-avatar.js';
import { BluestacksBatchLoginModal } from './bluestacks-batch-login-modal.js';
import { BluestacksSidebarDialogs, type BluestacksRowDialog } from './bluestacks-config-dialog.js';
import { BluestacksHealthCheckModal } from './bluestacks-health-check-modal.js';
import { DailyRiskLimitModal } from './daily-risk-limit-modal.js';
import { Btn, errMsg, FilterChip } from './shared/module-ui.js';
import { UI_MUTED } from '../ui/primitives.js';
type BluestacksModal =
  BluestacksRowDialog | { kind: 'batchLogin' } | { kind: 'healthCheck' } | { kind: 'risk' };
type BsStatusFilter = 'all' | 'logged-in' | 'online' | 'missing-app' | 'unknown';
const ISSUE_STATES = new Set(['missing-app', 'logged-out', 'restricted', 'verification']);
function instanceTone(inst: BluestacksInstance, isRunning: boolean, isBusy: boolean): StatusTone {
  if (isRunning || isBusy) return 'run';
  if (!inst.online) return 'idle';
  if (
    !isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight) ||
    ISSUE_STATES.has(inst.accountState)
  )
    return 'err';
  return inst.accountState === 'logged-in' ? 'ok' : 'warn';
}
export function BluestacksSidebar(p: {
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
  onHideSidebar?: (() => void) | undefined;
}) {
  const { state, onChange, selected, onSelect, onError, mode = 'bluestacks-group-bumper' } = p;
  const list = useSidebarListState(selected, onSelect);
  const [statusFilter, setStatusFilter] = useState<BsStatusFilter>('all');
  const [modal, setModal] = useState<BluestacksModal>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const instances = state?.instances ?? [];
  const folders = state?.folders ?? [];
  const onlineCount = instances.filter((i) => i.online).length;
  const sets = {
    launch: new Set(state?.launchingIds ?? []),
    close: new Set(state?.closingIds ?? []),
    inspect: new Set(state?.inspectingIds ?? []),
    install: new Set(state?.installingIds ?? []),
    login: new Set(state?.loggingInIds ?? []),
    sw: new Set(state?.switchingIds ?? []),
  };
  const matchesStatusFilter = (inst: BluestacksInstance, f: BsStatusFilter) =>
    f === 'logged-in'
      ? inst.accountState === 'logged-in'
      : f === 'online'
        ? inst.online || sets.launch.has(inst.id)
        : f === 'missing-app'
          ? inst.accountState === 'missing-app' || inst.fbLiteInstalled === false
          : f === 'unknown'
            ? inst.accountState === 'unknown'
            : true;
  const statusChips: ReadonlyArray<readonly [BsStatusFilter, string, number]> = (
    [
      ['all', '全部'],
      ['logged-in', '已登录'],
      ['online', '在线'],
      ['missing-app', '缺APK'],
      ['unknown', '未检测'],
    ] as const
  ).map(([k, l]) => [
    k,
    l,
    k === 'all' ? instances.length : instances.filter((i) => matchesStatusFilter(i, k)).length,
  ]);
  async function exec(action: string, payload: unknown = {}): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    try {
      onChange(await api.bluestacksAction(action, payload));
      return true;
    } catch (err) {
      onError(errMsg(err, '操作未成功'));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const q = list.query.trim().toLowerCase();
  const matched = instances.filter(
    (inst) =>
      (!q ||
        `${inst.displayName} ${inst.alias ?? ''} ${inst.instanceKey} ${inst.accountName} ${inst.adbPort} ${inst.fbLiteVersion ?? ''}`
          .toLowerCase()
          .includes(q)) &&
      matchesStatusFilter(inst, statusFilter) &&
      (list.filter === 'online'
        ? inst.online || sets.launch.has(inst.id)
        : list.filter === 'selected'
          ? selected.has(inst.id)
          : true),
  );
  const groups = [
    ...folders.map((f) => ({ id: f.id, name: f.name })),
    { id: 'ungrouped', name: '未分组' },
  ];
  const visibleGroups = groups.filter(
    (g) => g.id !== 'ungrouped' || instances.some((i) => !i.folderId) || !folders.length,
  );
  function getEffectiveStat(id: string) {
    const map = {
      'bluestacks-active': state?.activeProfileCounts?.[id],
      'bluestacks-group-poster': state?.posterProfileCounts?.[id],
      'bluestacks-group-inviter': state?.inviterProfileCounts?.[id],
      'bluestacks-page-bumper': state?.pageBumperProfileCounts?.[id],
      'bluestacks-group-bumper': state?.profileCounts[id],
    };
    return (
      Object.values(map).find((s) => s?.running) ??
      map[mode] ??
      map['bluestacks-group-bumper'] ??
      map['bluestacks-page-bumper']
    );
  }
  const { folderGroups, visibleIds } = buildSidebarViewModel({
    groups: visibleGroups,
    allItems: instances,
    matchedItems: matched,
    getGroupId: (i) => i.folderId ?? 'ungrouped',
    isRunning: (i) => Boolean(getEffectiveStat(i.id)?.running),
    closed: list.closed,
  });
  async function moveInstancesTo(folderId: string | null, ids = [...selected]) {
    const inTarget = instances
      .filter((i) => i.folderId === folderId && !ids.includes(i.id))
      .map((i) => i.id);
    await exec('instances/reorder', { folderId, ids: [...ids, ...inTarget] });
  }
  async function nudgeInstance(id: string, direction: -1 | 1) {
    const idSet = new Set([id]);
    for (const g of groups) {
      const folderId = g.id === 'ungrouped' ? null : g.id;
      const ordered = instances.filter((i) => i.folderId === folderId).map((i) => i.id);
      const next = nudgeFinderIds(ordered, idSet, direction);
      if (next.some((item, idx) => item !== ordered[idx]))
        await exec('instances/reorder', { folderId, ids: next });
    }
  }
  const selectedIds = [...selected];
  const anySelectedRunning = selectedIds.some((id) => Boolean(getEffectiveStat(id)?.running));
  const anySelectedOnline = selectedIds.some((id) => instances.find((x) => x.id === id)?.online);
  const selectionActions = [
    sa('启动', busy, () => void exec('instances/launch', { instanceIds: selectedIds }), {
      className: 'btn-launch',
      title: '启动所选蓝蝶多开窗口',
    }),
    sa(
      '停止',
      busy || !anySelectedRunning,
      () => void exec('stop-all', { profileIds: selectedIds }),
      { className: 'btn-danger', title: '停止所选蓝蝶窗口正在执行的任务' },
    ),
    sa(
      '关闭',
      busy || !anySelectedOnline || anySelectedRunning,
      () => void exec('instances/close', { instanceIds: selectedIds }),
      { title: '关闭所选蓝蝶窗口' },
    ),
    sa(
      '识别',
      busy || anySelectedRunning,
      () => void exec('instances/inspect', { instanceIds: selectedIds }),
      { title: '自动进入菜单识别所选模拟器的 FB Lite 账号名与头像（未启动窗口会自动拉起）' },
    ),
    sa(
      '整理窗口',
      busy || !anySelectedOnline,
      () => void exec('instances/arrange', { instanceIds: selectedIds }),
      { title: '自动整齐平铺所选的蓝蝶模拟器窗口' },
    ),
  ];
  function renderInstanceRow(inst: BluestacksInstance) {
    const stat = getEffectiveStat(inst.id);
    const dailyStat = state?.dailyUsage?.perInstance[inst.id];
    const isRunning = Boolean(stat?.running);
    const isLaunching = sets.launch.has(inst.id);
    const isClosing = sets.close.has(inst.id);
    const isActionBusy =
      isLaunching ||
      sets.inspect.has(inst.id) ||
      sets.install.has(inst.id) ||
      sets.login.has(inst.id) ||
      sets.sw.has(inst.id);
    const tone = instanceTone(inst, isRunning, isActionBusy);
    const rowTitle = bluestacksDisplayTitle(inst);
    const portrait = isBluestacksPortraitResolution(inst.fbWidth, inst.fbHeight);
    const roleTag =
      inst.accountState === 'logged-in'
        ? inst.identityType === 'page'
          ? '专页'
          : inst.identityType === 'personal'
            ? '个人'
            : ''
        : '';
    const fbVerBadge = inst.fbLiteVersion
      ? `FB v${inst.fbLiteVersion}`
      : inst.fbLiteInstalled === false
        ? '缺APK'
        : '';
    const baseSubCode = inst.accountName
      ? roleTag
        ? `[${roleTag}] ${inst.accountName}`
        : inst.accountName
      : portrait
        ? `:${inst.adbPort}`
        : `横屏 :${inst.adbPort}`;
    const subCode = fbVerBadge ? `${baseSubCode} · ${fbVerBadge}` : baseSubCode;
    const isRiskSleeping = Boolean(dailyStat?.limitReached && !isRunning && !isActionBusy);
    const stateSummary = !portrait
      ? `横屏 ${inst.fbWidth}×${inst.fbHeight}`
      : inst.accountState === 'missing-app' || inst.fbLiteInstalled === false
        ? '缺 FB Lite APK'
        : ((
            {
              verification: '需安全验证',
              restricted: '账号受限',
              'logged-out': '未登录',
              unknown: inst.online ? '在线未检测' : '未启动 · 未检测',
            } as Record<string, string>
          )[inst.accountState] ?? (inst.online ? '在线就绪' : '未启动 · 已登录'));
    const lastErrNote = inst.lastStatus?.trim() || '';
    const idleSummary =
      lastErrNote && !lastErrNote.includes(stateSummary)
        ? inst.accountState === 'logged-in' && portrait && inst.fbLiteInstalled !== false
          ? lastErrNote
          : `${stateSummary} · ${lastErrNote}`
        : stateSummary;
    const lineText =
      (
        [
          [sets.install.has(inst.id), '正在安装 FB Lite…'],
          [sets.login.has(inst.id), '正在自动登录…'],
          [sets.sw.has(inst.id), '正在切换身份…'],
          [isLaunching, '正在启动窗口…'],
          [isClosing, '正在关闭窗口…'],
          [sets.inspect.has(inst.id), '正在识别账号…'],
          [
            isRiskSleeping,
            `风控休眠 · 今日 ${dailyStat?.totalActionsToday ?? 0}/${dailyStat?.effectiveLimits.dailyMaxTotalActions || '∞'}`,
          ],
        ] as const
      ).find(([c]) => c)?.[1] ??
      stat?.status ??
      idleSummary;
    const hasIssue =
      !portrait || inst.fbLiteInstalled === false || ISSUE_STATES.has(inst.accountState);
    const rowTaskTone =
      isRunning || isActionBusy
        ? 'run'
        : isRiskSleeping
          ? 'warn'
          : hasIssue
            ? inst.accountState === 'logged-out'
              ? 'warn'
              : 'err'
            : tone;
    const moveTargets = selected.has(inst.id) && selected.size > 1 ? selectedIds : [inst.id];
    const menuItems: MenuItem[] = [
      ...(inst.online
        ? [
            mi('显示蓝蝶窗口', () => void exec('instances/show', { instanceId: inst.id }), {
              disabled: busy || isClosing,
            }),
            mi('关闭蓝蝶窗口', () => void exec('instances/close', { instanceIds: [inst.id] }), {
              icon: <IconStop />,
              disabled: busy || isRunning || isClosing,
            }),
          ]
        : [
            mi('启动蓝蝶窗口', () => void exec('instances/launch', { instanceIds: [inst.id] }), {
              icon: <IconPlay />,
              disabled: busy || isLaunching,
            }),
          ]),
      mi('识别账号与身份', () => void exec('instances/inspect', { instanceIds: [inst.id] }), {
        disabled: busy || isRunning || isActionBusy,
      }),
      mi('切换个人 / 专页身份', () => setModal({ kind: 'switch', instance: inst }), {
        disabled: busy || isRunning || isActionBusy || inst.accountState !== 'logged-in',
      }),
      mi('自动登录 FB Lite (支持 2FA)', () => setModal({ kind: 'login', instance: inst }), {
        disabled: busy || isRunning || isActionBusy,
      }),
      mi(
        inst.fbLiteInstalled ? '升级 / 重装 FB Lite APK' : '安装 FB Lite APK',
        () => void exec('instances/install-apk', { instanceIds: [inst.id] }),
        { disabled: busy || isRunning || isActionBusy },
      ),
      ...(isRunning
        ? [
            mi('停止当前任务', () => void exec('stop-all', { profileIds: [inst.id] }), {
              danger: true,
            }),
          ]
        : []),
      mi(
        '修改备注别名',
        () => setModal({ kind: 'rename', id: inst.id, alias: inst.alias ?? inst.displayName }),
        { icon: <IconEdit /> },
      ),
      ...buildMoveMenuItems(
        inst.folderId ?? null,
        folders,
        busy,
        (dir) => void nudgeInstance(inst.id, dir),
        (fid) => void moveInstancesTo(fid, moveTargets),
      ),
      mi('移除列表记录', () => setModal({ kind: 'delete', ids: [inst.id], label: rowTitle }), {
        icon: <IconClose />,
        danger: true,
        disabled: busy || isRunning,
      }),
    ];
    const tooltipLines = [
      `${rowTitle} (${inst.instanceKey}) · 127.0.0.1:${inst.adbPort} · ${inst.fbWidth}×${inst.fbHeight}`,
      `FB Lite：${inst.fbLiteInstalled === false ? '未安装 APK' : inst.fbLiteVersion ? `v${inst.fbLiteVersion}` : '版本未知'}${inst.androidSdk ? ` · Android SDK ${inst.androidSdk}` : ''}`,
      ...(inst.numericAccountId ? [`FB 数字 ID：${inst.numericAccountId}`] : []),
      ...(inst.managedIdentities?.length
        ? [`名下身份：${inst.managedIdentities.map((m) => m.name).join(' / ')}`]
        : []),
      ...(dailyStat
        ? [
            `今日动作：总 ${dailyStat.totalActionsToday}/${dailyStat.effectiveLimits.dailyMaxTotalActions || '不限'}（顶贴 ${dailyStat.groupBumpsToday + dailyStat.pageBumpsToday} / 发帖 ${dailyStat.postsToday} / 邀人 ${dailyStat.invitesToday} / 活跃赞 ${dailyStat.activeLikesToday}）`,
          ]
        : []),
      ...(dailyStat?.limitReason ? [`风控状态：${dailyStat.limitReason}`] : []),
      `状态摘要：${lineText}`,
      ...(lastErrNote && !String(lineText).includes(lastErrNote)
        ? [`最近记录：${lastErrNote}`]
        : []),
    ];
    return (
      <SidebarRowShell
        key={inst.id}
        id={inst.id}
        displayName={rowTitle}
        codeText={subCode}
        selected={selected.has(inst.id)}
        avatarUrl={inst.avatarUrl}
        online={inst.online}
        refreshKey={inst.updatedAt}
        tone={tone}
        toneLabel={tone === 'err' ? '异常' : inst.online ? '在线' : '未启动'}
        tooltip={tooltipLines.join('\n')}
        taskText={String(lineText)}
        taskTone={rowTaskTone}
        menuItems={menuItems}
        onSelect={(checked, shift) => list.selectRow(visibleIds, inst.id, checked, shift)}
        onMainClick={(shift) => list.selectRow(visibleIds, inst.id, !selected.has(inst.id), shift)}
      />
    );
  }
  const reached = state?.dailyUsage?.reachedLimitInstances ?? 0;
  const toolBtns: ReadonlyArray<
    [
      'ids' | 'risk' | 'batchLogin' | 'healthCheck',
      string,
      string?,
      string?,
      ('primary' | 'default')?,
    ]
  > = [
    ['ids', '按 ID 选中'],
    [
      'risk',
      reached > 0 ? `日限额·休眠${reached}` : '日限额',
      '配置蓝蝶全局及单号每日安全动作限额（查看今日动作请前往数据与记录）',
      reached > 0 ? 'border-[#e85d5d] bg-[#fff5f5] font-semibold text-[#c53030]' : undefined,
    ],
    [
      'batchLogin',
      state?.batchLogin?.running
        ? `登录 ${state.batchLogin.completed}/${state.batchLogin.total}`
        : '批量登录',
      '粘贴账号清单批量自动登录 FB Lite（支持 2FA、自动开机与自动装包）',
      undefined,
      state?.batchLogin?.running ? 'primary' : 'default',
    ],
    [
      'healthCheck',
      state?.healthCheck?.running
        ? `体检 ${state.healthCheck.completed}/${state.healthCheck.total}`
        : '批量体检',
      '并发巡检蓝蝶窗口健康状态（未登录 / Checkpoint / 封禁 / 缺 App / 横屏，并支持缺包自装）',
      undefined,
      state?.healthCheck?.running ? 'primary' : 'default',
    ],
  ];
  const runningBanners = (
    [
      ['batchLogin', state?.batchLogin, '批量登录', 'batch-login/stop'],
      ['healthCheck', state?.healthCheck, '批量体检', 'health-check/stop'],
    ] as const
  )
    .filter(([, job]) => job?.running)
    .map(([kind, job, label, stop]) => ({
      kind,
      label: `${label} ${job?.completed ?? 0}/${job?.total ?? 0}`,
      title: job?.statusText ?? '',
      stop,
    }));
  const rowDialog =
    modal && modal.kind !== 'batchLogin' && modal.kind !== 'healthCheck' && modal.kind !== 'risk'
      ? modal
      : null;
  const headIcons = [
    ['刷新蓝蝶多开列表', busy, () => void exec('refresh'), <IconRefresh key="r" />],
    [
      '蓝蝶路径与 APK 设置',
      false,
      () => setModal({ kind: 'config' }),
      <IconSettings key="s" size={15} />,
    ],
    [
      '平铺在线蓝蝶窗口',
      busy || onlineCount === 0,
      () => void exec('instances/arrange', {}),
      <IconWindow key="w" size={14} />,
      '自动整齐平铺当前在线的蓝蝶模拟器窗口',
    ],
  ] as const;
  return (
    <AccountsSidebarShell
      title="蓝蝶窗口"
      countTitle="在线窗口 / 全部实例"
      onlineCount={onlineCount}
      totalCount={instances.length}
      onHideSidebar={p.onHideSidebar}
      headingActions={headIcons.map(([aria, dis, onClick, icon, title]) => (
        <Btn
          key={aria}
          v="icon"
          className="h-[26px] w-[26px]"
          title={title ?? aria}
          aria-label={aria}
          disabled={dis}
          onClick={onClick}
        >
          {icon}
        </Btn>
      ))}
      searchPlaceholder="搜索窗口名、备注、账号名或端口"
      list={list}
      selectAllLabel="全选当前显示的蓝蝶窗口"
      matchedIds={visibleIds}
      filterLabels={['全部', '在线', '已选']}
      extraTools={
        <>
          <div role="group" aria-label="蓝蝶状态筛选" className="mt-1.5 flex flex-wrap gap-1 pl-2">
            {statusChips.map(([key, label, count]) => (
              <FilterChip
                key={key}
                label={label}
                count={count}
                active={statusFilter === key}
                className="h-[22px]"
                onClick={() => {
                  setStatusFilter(key);
                  if (list.filter !== 'all') list.setFilter('all');
                }}
              />
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5 [&_.btn]:h-[27px] [&_.btn]:justify-center [&_.btn]:px-2 [&_.btn]:text-[11.5px]">
            {toolBtns.map(([key, label, title, className, v]) => (
              <Btn
                key={key}
                v={v ?? 'default'}
                className={className}
                disabled={!instances.length}
                title={title}
                onClick={() => setModal({ kind: key })}
              >
                {label}
              </Btn>
            ))}
          </div>
          {runningBanners.length > 0 && (
            <div className="mt-1.5 flex flex-col gap-1">
              {runningBanners.map((b) => (
                <div
                  key={b.kind}
                  className="flex items-center justify-between gap-1.5 rounded-md border border-blue-200 bg-blue-50/80 px-2 py-1 text-[11px] text-blue-900"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    onClick={() => setModal({ kind: b.kind })}
                    title={b.title}
                  >
                    {b.label}
                  </button>
                  <Btn
                    v="danger"
                    className="h-5 px-1.5 text-[10.5px]"
                    disabled={busy}
                    onClick={() => void exec(b.stop, {})}
                  >
                    中止执行
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </>
      }
      creatingBusy={busy}
      onCreateGroup={(name) =>
        busy || !name.trim() ? undefined : exec('folders/create', { name: name.trim() })
      }
      groups={folderGroups}
      selected={selected}
      onSelect={onSelect}
      busy={busy}
      onNudgeGroup={(gid, dir) =>
        void exec('folders/reorder', {
          ids: nudgeFinderIds(
            folders.map((f) => f.id),
            new Set([gid]),
            dir,
          ),
        })
      }
      onRenameGroupSubmit={async (id, name) => void (await exec('folders/rename', { id, name }))}
      onDeleteGroupConfirm={async (id) => void (await exec('folders/delete', { id }))}
      deleteGroupDescription="删除分组不会删除蓝蝶模拟器实例，组内实例将移入「未分组」。"
      renderRow={renderInstanceRow}
      emptyGroupText={() => '暂无匹配的蓝蝶窗口'}
      emptyListNode={
        <div className="mx-2.5 my-3.5 flex flex-col gap-2 rounded-xl border border-dashed border-[var(--line-strong)] bg-white px-3.5 py-4 [&_p]:m-0 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-[var(--text-2)] [&_strong]:text-[13px] [&_strong]:text-[var(--text)]">
          <strong>未检测到蓝蝶多开实例</strong>
          <p className={UI_MUTED}>
            请确认已安装 BlueStacks 5，或点击下方按钮手动配置安装目录与 <code>bluestacks.conf</code>{' '}
            路径。
          </p>
          <div className="mt-1 flex gap-2">
            <Btn v="primary" onClick={() => setModal({ kind: 'config' })}>
              配置蓝蝶路径
            </Btn>
            <Btn disabled={busy} onClick={() => void exec('refresh')}>
              重新扫描
            </Btn>
          </div>
        </div>
      }
      selectionBarAriaLabel="已选蓝蝶窗口操作"
      selectionActions={selectionActions}
      dialogs={
        <>
          {modal?.kind === 'batchLogin' && state && (
            <BluestacksBatchLoginModal
              state={state}
              selected={selected}
              onSelect={onSelect}
              onChange={onChange}
              onClose={() => setModal(null)}
            />
          )}
          {modal?.kind === 'healthCheck' && state && (
            <BluestacksHealthCheckModal
              state={state}
              selected={selected}
              onSelect={onSelect}
              onChange={onChange}
              onOpenBatchLogin={(ids) => {
                onSelect(new Set(ids));
                setModal({ kind: 'batchLogin' });
              }}
              onClose={() => setModal(null)}
            />
          )}
          {modal?.kind === 'risk' && state && (
            <DailyRiskLimitModal
              carrier="bluestacks"
              targets={instances.map((inst) => ({
                id: inst.id,
                title: bluestacksDisplayTitle(inst),
                subtitle: inst.accountName || inst.instanceKey || undefined,
              }))}
              bluestacksState={state}
              onBluestacksChange={onChange}
              onClose={() => setModal(null)}
            />
          )}
          <BluestacksSidebarDialogs
            state={state}
            onChange={onChange}
            selected={selected}
            onSelect={onSelect}
            dialog={rowDialog}
            onClose={() => setModal(null)}
          />
        </>
      }
    />
  );
}
