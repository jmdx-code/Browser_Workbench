import { useMemo, useState } from 'react';
import type { z } from 'zod';
import { profileDisplayName, type Profile, type Workspace } from '../shared/contracts.js';
import type { BumperProfileStat } from '../shared/group-bumper.js';
import type { GroupInviterProfileStat } from '../shared/group-inviter.js';
import type { Inspection } from '../shared/profile-inspection.js';
import type { TaskCommand, TaskRuntimeOverview } from '../shared/task-contracts.js';
import { marketplaceBridgeSupported } from '../shared/task-policies.js';
import { windowLayoutMessage } from '../shared/window-layout.js';
import {
  AccountsSidebarShell,
  buildMoveMenuItems,
  buildSidebarViewModel,
  mi,
  sa,
  SidebarRowShell,
  useSidebarListState,
} from './accounts-sidebar-shell.js';
import { api } from './api.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { insertFinderIds, nudgeFinderIds } from './finder-list-model.js';
import { IconClose, IconEdit, IconPlay, IconRefresh, IconStop, IconWindow } from './icons.js';
import {
  inspectionAvatarURL,
  inspectionDisplayName,
  inspectionPresentation,
} from './inspection-presentation.js';
import { DailyRiskLimitModal } from './modules/daily-risk-limit-modal.js';
import type {
  ProfileActivityDescriptor,
  SelectionControlSummary,
} from './modules/module-contracts.js';
import {
  projectProfileActivitiesMap,
  projectSelectionControls,
} from './modules/profile-activity-projector.js';
import { Btn } from './modules/shared/module-ui.js';
import { NameDialog } from './name-dialog.js';
import type { MenuItem } from './popover-menu.js';
import type { StatusTone } from './profile-avatar.js';
import { SelectByIdsDialog, buildProfileCandidates } from './select-by-ids-dialog.js';
import type { PointerDragRowProps } from './use-pointer-drag-reorder.js';
declare const __BRIDGE_EXTENSION_VERSION__: string;
const EXPECTED_BRIDGE_VERSION =
  typeof __BRIDGE_EXTENSION_VERSION__ !== 'undefined' ? __BRIDGE_EXTENSION_VERSION__ : '0.3.88';
const ENDED_STATES = ['STOPPED', 'COMPLETED', 'FAILED'];
const phaseNames: Record<string, string> = {
  OFFLINE: '离线',
  SYNCING: '对账中',
  PAUSED: '已连接 · 就绪',
  RUNNING: '通道就绪',
  STOPPING: '停止中',
};
const ID_BTN = 'h-[26px] w-auto text-[11px] whitespace-nowrap shrink-0 px-1.5';
const ID_ATTN =
  ' font-semibold bg-[var(--brand-soft)] border-[var(--brand)] text-[var(--brand)] hover:bg-[#dce9ff]';
const toneNames: Record<StatusTone, string> = {
  idle: '离线',
  ok: '已连接',
  run: '运行中',
  warn: '需要留意',
  err: '账号状态异常',
};
type SidebarModal =
  | { kind: 'ids' }
  | { kind: 'risk' }
  | { kind: 'createMove'; ids: string[] }
  | { kind: 'delete'; ids: string[]; label: string }
  | null;
export function Sidebar(p: {
  workspace: Workspace;
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  onInspect: (id: string) => void;
  nameAction?: 'select' | 'filter';
  filteredId?: string | null;
  mutate: (work: () => Promise<unknown>) => Promise<void>;
  inspections: Inspection[];
  inspectionAvailable: boolean;
  inspectionError: string;
  busy: boolean;
  onCheck: (ids: string[]) => void;
  onRename?: (profile: Profile) => void;
  onShow?: (id: string) => void;
  tasks?: z.infer<typeof TaskRuntimeOverview> | null;
  onTaskCommand?: (command: TaskCommand['command'], plans: TaskCommand['plans']) => void;
  activities?: ReadonlyMap<string, ProfileActivityDescriptor>;
  selectionControls?: SelectionControlSummary;
  onStopModules?: (profileIds: string[]) => void;
  onStopProfiles?: (plans: TaskCommand['plans'], moduleProfileIds: string[]) => void;
  onRefreshWorkspace?: () => Promise<void>;
  onNotify?: (msg: string) => void;
  bumperCounts?: Record<string, BumperProfileStat>;
  bumperRunningIds?: string[];
  groupInviterCounts?: Record<string, GroupInviterProfileStat> | null;
  groupInviterRunningIds?: string[];
  onHideSidebar?: (() => void) | undefined;
}) {
  const {
    workspace: ws,
    selected,
    onSelect,
    onInspect,
    nameAction = 'select',
    filteredId = null,
    mutate,
    inspections,
    inspectionAvailable,
    inspectionError,
    busy,
    onCheck,
    onRename,
    onShow,
    tasks,
    onTaskCommand,
    onStopModules,
    onStopProfiles,
    onRefreshWorkspace,
    onNotify,
  } = p;
  const list = useSidebarListState(selected, onSelect);
  const [modal, setModal] = useState<SidebarModal>(null);
  const [arrangingWindows, setArrangingWindows] = useState(false);
  const inspectionByProfile = useMemo(
    () => new Map(inspections.map((i) => [i.profileId, i])),
    [inspections],
  );
  const activePlanByProfile = useMemo(() => {
    const map = new Map<string, NonNullable<typeof tasks>['plans'][number]>();
    for (const v of tasks?.plans ?? [])
      if (!ENDED_STATES.includes(v.state) && !map.has(v.profileId)) map.set(v.profileId, v);
    return map;
  }, [tasks?.plans]);
  const sortedProfiles = useMemo(
    () =>
      [...ws.profiles].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)),
    [ws.profiles],
  );
  const sortedGroups = useMemo(
    () => [...ws.groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    [ws.groups],
  );
  const isAttentionProfile = (r: Profile) => {
    const inspection = inspectionByProfile.get(r.id);
    const account = inspection?.state === 'OBSERVED' ? inspection.account : r.account;
    const extensionOutdated =
      r.online && !marketplaceBridgeSupported(r.extensionVersion, EXPECTED_BRIDGE_VERSION);
    return (
      ['logged-out', 'restricted', 'verification'].includes(account.state) ||
      account.state === 'unknown' ||
      !account.id ||
      !account.avatar ||
      Boolean(r.bindingConflict) ||
      extensionOutdated ||
      r.unresolved > 0
    );
  };
  const attentionCount = sortedProfiles.filter(isAttentionProfile).length;
  const qLower = list.query.toLowerCase();
  const matched = sortedProfiles.filter((r) => {
    const nameHit =
      `${r.alias} ${r.browserName ?? ''} ${r.account.name ?? ''} ${r.account.id ?? ''} ${inspectionDisplayName(r, inspectionByProfile.get(r.id), inspectionAvailable) ?? ''}`
        .toLowerCase()
        .includes(qLower);
    if (!nameHit) return false;
    if (list.filter === 'online') return r.online;
    if (list.filter === 'selected') return selected.has(r.id);
    if (list.filter === 'attention') return isAttentionProfile(r);
    return true;
  });
  const projIn = {
    tasks,
    bumperCounts: p.bumperCounts,
    bumperRunningIds: p.bumperRunningIds,
    groupInviterCounts: p.groupInviterCounts,
    groupInviterRunningIds: p.groupInviterRunningIds,
  };
  const resolvedActivities = p.activities ?? projectProfileActivitiesMap(ws.profiles, projIn);
  const resolvedControls = p.selectionControls ?? projectSelectionControls(selected, projIn);
  const visibleGroups = [
    ...sortedGroups,
    { id: 'ungrouped', name: '未分组', color: 'gray', order: -1 },
  ];
  const { folderGroups, visibleIds } = buildSidebarViewModel({
    groups: visibleGroups,
    allItems: ws.profiles,
    matchedItems: matched,
    getGroupId: (r) => r.groupId ?? 'ungrouped',
    isRunning: (r) => resolvedActivities.get(r.id)?.running === true,
    closed: list.closed,
  });
  const visualIdx = new Map(
    visibleGroups
      .flatMap((g) =>
        sortedProfiles.filter((r) => (r.groupId ?? 'ungrouped') === g.id).map((r) => r.id),
      )
      .map((id, idx) => [id, idx]),
  );
  const sortVisual = (ids: string[]) =>
    ids.sort((a, b) => (visualIdx.get(a) ?? 9999) - (visualIdx.get(b) ?? 9999));
  const onlineProfiles = ws.profiles.filter((r) => r.online);
  const orderedOnlineIds = sortVisual(onlineProfiles.map((r) => r.id));
  const orderedSelectedIds = sortVisual([...selected]);
  const unidentifiedOnlineIds = onlineProfiles
    .filter((r) => !r.account.id || !r.account.avatar)
    .map((r) => r.id);
  const selectedOnlineIds = onlineProfiles.filter((r) => selected.has(r.id)).map((r) => r.id);
  const orderedSelectedOnlineIds = sortVisual([...selectedOnlineIds]);
  const inspectingAny = inspections.some((i) => i.state === 'QUEUED' || i.state === 'READING');
  const quickIdentifyTargetIds = selectedOnlineIds.length
    ? selectedOnlineIds
    : unidentifiedOnlineIds.length
      ? unidentifiedOnlineIds
      : onlineProfiles.map((r) => r.id);
  const quickIdentifyTitle = selectedOnlineIds.length
    ? `一键识别已选的 ${selectedOnlineIds.length} 个在线浏览器账号与头像（自动读取已打开的 Facebook 页面）`
    : unidentifiedOnlineIds.length
      ? `一键识别 ${unidentifiedOnlineIds.length} 个未显示头像的在线浏览器（请确保浏览器已打开 Facebook 页面）`
      : onlineProfiles.length
        ? `刷新全部 ${onlineProfiles.length} 个在线浏览器的 FB 账号与头像`
        : '暂无已连接的在线浏览器';
  const moveProfilesTo = (
    groupId: string | null,
    ids = [...selected],
    target?: string,
    after = false,
  ) => {
    const normalizedGid = groupId ?? null;
    return mutate(() =>
      api.reorderProfiles(
        normalizedGid,
        insertFinderIds(
          sortedProfiles.filter((r) => (r.groupId ?? null) === normalizedGid).map((r) => r.id),
          ids,
          target,
          after,
        ),
      ),
    );
  };
  async function nudgeProfiles(direction: -1 | 1, targetIds: ReadonlySet<string> = selected) {
    for (const g of visibleGroups) {
      const id = g.id === 'ungrouped' ? null : g.id;
      const ids = sortedProfiles.filter((r) => (r.groupId ?? null) === id).map((r) => r.id);
      if (ids.some((k) => targetIds.has(k)))
        await mutate(() => api.reorderProfiles(id, nudgeFinderIds(ids, targetIds, direction)));
    }
  }
  function nudgeGroup(id: string, direction: -1 | 1) {
    const ids = sortedGroups.map((g) => g.id);
    const at = ids.indexOf(id);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to] ?? '', ids[at] ?? ''];
    void mutate(() => api.reorderGroups(ids));
  }
  async function arrangeWindowBatch(ids: string[], emptyMsg: string, successLabel: string) {
    if (arrangingWindows || !ids.length) return;
    setArrangingWindows(true);
    try {
      const res = await api.windowLayout({ action: 'apply', profileIds: ids });
      if (res.error) throw Error(windowLayoutMessage(res.error));
      const moved = res.movedCount ?? res.managed.length;
      const failedCount = res.failedProfiles?.length ?? 0;
      return moved
        ? `已${successLabel} ${moved} 个${successLabel === '整理' ? '在线' : ''}浏览器窗口${failedCount ? `（${failedCount} 个失败）` : ''}`
        : emptyMsg;
    } finally {
      setArrangingWindows(false);
    }
  }
  const runPower = (ids: string[], mode: 'launch' | 'close', singleName?: string, emptyMsg = '') =>
    void mutate(async () => {
      const res = mode === 'launch' ? await api.launchProfiles(ids) : await api.closeProfiles(ids);
      await onRefreshWorkspace?.();
      const verb = mode === 'launch' ? '启动' : '关闭';
      const count = 'launchedIds' in res ? res.launchedIds.length : res.closedIds.length;
      if (singleName !== undefined) {
        if (res.failed.length) throw Error(res.failed[0]?.reason || `${verb}「${singleName}」失败`);
        return mode === 'launch' && !count
          ? `浏览器「${singleName}」已在线`
          : `已${verb}浏览器「${singleName}」`;
      }
      const parts = [
        count ? `已${verb} ${count} 个` : '',
        res.failed.length ? `${res.failed.length} 个失败（${res.failed[0]?.reason ?? ''}）` : '',
      ].filter(Boolean);
      return parts.length ? `批量${verb}完成：${parts.join('，')}` : emptyMsg;
    });
  const dispatchStop = (plans: TaskCommand['plans'], moduleIds: string[]) => {
    if (onStopProfiles) return onStopProfiles(plans, moduleIds);
    if (plans.length) onTaskCommand?.('stop', plans);
    if (moduleIds.length) onStopModules?.(moduleIds);
  };
  const selectedList = ws.profiles.filter((r) => selected.has(r.id));
  const selectedOfflineIds = selectedList.filter((r) => !r.online).map((r) => r.id);
  const selectedOnlineOnlyIds = selectedList.filter((r) => r.online).map((r) => r.id);
  const selectionActions = [
    sa(
      '启动',
      busy || !selectedOfflineIds.length,
      () => runPower(selectedOfflineIds, 'launch', undefined, '所选浏览器已在线'),
      {
        className: 'btn-launch',
        title: selectedOfflineIds.length
          ? `启动所选的 ${selectedOfflineIds.length} 个离线浏览器`
          : '所选浏览器均已在线',
      },
    ),
    sa(
      '停止',
      busy || resolvedControls.totalStoppableCount === 0,
      () =>
        dispatchStop(resolvedControls.stoppableTargets, resolvedControls.stoppableModuleProfileIds),
      { className: 'btn-danger' },
    ),
    sa(
      '关闭',
      busy || !selectedOnlineOnlyIds.length,
      () => runPower(selectedOnlineOnlyIds, 'close', undefined, '未关闭任何浏览器'),
      {
        title: selectedOnlineOnlyIds.length
          ? `安全关闭所选的 ${selectedOnlineOnlyIds.length} 个在线浏览器`
          : '所选浏览器均未启动',
      },
    ),
    sa(
      '清理标签',
      busy,
      () =>
        void mutate(async () => {
          const r = await api.cleanupProfileTabs([...selected]);
          return `已清理 ${r.cleanedProfiles} 个浏览器，共关闭 ${r.closedTabs} 个多余标签页${r.skippedOffline > 0 ? `（${r.skippedOffline} 个离线未连接）` : ''}`;
        }),
    ),
    sa(
      arrangingWindows ? '整理中...' : '整理窗口',
      busy || arrangingWindows || !selected.size || selected.size > 100,
      () =>
        void mutate(() =>
          arrangeWindowBatch(orderedSelectedIds, '所选浏览器暂无已连接的窗口可排列', '整齐排列'),
        ),
      { title: '按当前排版模式整齐排列所选窗口' },
    ),
  ];
  function renderProfileRow(
    profile: Profile,
    drag?: { rowProps: PointerDragRowProps; dropClass: string } | undefined,
  ) {
    const displayName = profileDisplayName(profile);
    const inspection = inspectionByProfile.get(profile.id);
    const activity = resolvedActivities.get(profile.id) ?? null;
    const plan = activePlanByProfile.get(profile.id);
    const account = inspection?.state === 'OBSERVED' ? inspection.account : profile.account;
    const extensionOutdated =
      profile.online &&
      !marketplaceBridgeSupported(profile.extensionVersion, EXPECTED_BRIDGE_VERSION);
    const hasBindingConflict = Boolean(profile.bindingConflict);
    const tone: StatusTone = !profile.online
      ? hasBindingConflict
        ? 'warn'
        : 'idle'
      : ['logged-out', 'restricted', 'verification'].includes(account.state)
        ? 'err'
        : extensionOutdated || hasBindingConflict
          ? 'warn'
          : activity?.running
            ? 'run'
            : 'ok';
    const fbName = inspectionDisplayName(profile, inspection, inspectionAvailable);
    const tooltip = [
      displayName + (fbName ? ' · ' + fbName : ''),
      '连接：' + (phaseNames[profile.phase] ?? profile.phase),
      'FB 状态：' + inspectionPresentation(profile, inspection, inspectionAvailable).title,
      ...(profile.bindingConflict ? [`⚠️ ${profile.bindingConflict}，易触发启动冲突`] : []),
      ...(profile.unresolved ? [profile.unresolved + ' 项待核对'] : []),
      ...(extensionOutdated
        ? [`插件 ${profile.extensionVersion ?? '未知'}，建议刷新至 ${EXPECTED_BRIDGE_VERSION}`]
        : []),
      ...(activity?.tooltipLines ?? []),
    ].join('\n');
    const singleTarget = plan
      ? [
          {
            profileId: plan.profileId,
            planId: plan.id,
            expectedState: plan.state,
            expectedUpdatedAt: plan.updatedAt,
          },
        ]
      : [];
    const hasStoppableModule =
      activity?.running === true && activity.moduleId !== 'active-accounts';
    const moveTargets =
      selected.has(profile.id) && selected.size > 1 ? [...selected] : [profile.id];
    const isBusyAny = resolvedControls.isProfileBusy(profile.id);
    const rowItems: MenuItem[] = [
      ...(!profile.online
        ? [
            mi('启动浏览器', () => runPower([profile.id], 'launch', displayName), {
              icon: <IconPlay />,
              disabled: busy,
              title: '自动启动该浏览器资料并等待桥接上线',
            }),
          ]
        : [
            mi('显示浏览器窗口', () => onShow?.(profile.id), {
              icon: <IconWindow />,
              disabled: !onShow,
              title: '显示这份浏览器的工作页面',
            }),
            mi('关闭浏览器', () => runPower([profile.id], 'close', displayName), {
              icon: <IconClose />,
              disabled: busy,
              title: '如有运行中任务将先安全停止，随后关闭该浏览器窗口',
            }),
          ]),
      ...(onRename
        ? [mi('修改别名', () => onRename(profile), { icon: <IconEdit />, disabled: busy })]
        : []),
      mi('检查 FB 状态', () => onCheck([profile.id]), {
        icon: <IconRefresh />,
        disabled: busy || !inspectionAvailable,
      }),
      mi(
        '清理其他标签页',
        () =>
          void mutate(async () => {
            const res = await api.cleanupProfileTabs([profile.id]);
            return res.cleanedProfiles
              ? `已为「${displayName}」清理 ${res.closedTabs} 个多余标签页，仅保留主页面`
              : `未清理：${res.skippedBusy} 个忙碌，${res.skippedOffline} 个离线`;
          }),
        { icon: <IconClose />, disabled: !profile.online || busy },
      ),
      { separator: true },
      ...buildMoveMenuItems(
        profile.groupId ?? null,
        sortedGroups,
        busy,
        (dir) => void nudgeProfiles(dir, new Set([profile.id])),
        (gid) => void moveProfilesTo(gid, moveTargets),
      ),
      mi('+ 新建分组并移入', () => setModal({ kind: 'createMove', ids: moveTargets }), {
        disabled: busy,
      }),
      ...((plan && !ENDED_STATES.includes(plan.state) && onTaskCommand) ||
      (hasStoppableModule && onStopModules)
        ? [
            { separator: true } as MenuItem,
            mi(
              '停止当前任务',
              () => {
                if (activity?.moduleId === 'auto-scheduler' && onStopModules)
                  return onStopModules([profile.id]);
                const hasActivePlan = Boolean(plan && !ENDED_STATES.includes(plan.state));
                dispatchStop(
                  hasActivePlan ? singleTarget : [],
                  hasStoppableModule ? [profile.id] : [],
                );
              },
              { icon: <IconStop />, danger: true, disabled: busy },
            ),
          ]
        : []),
      { separator: true },
      mi(
        '删除浏览器',
        () => setModal({ kind: 'delete', ids: [profile.id], label: `「${displayName}」` }),
        {
          icon: <IconClose />,
          danger: true,
          disabled: busy || isBusyAny,
          title: isBusyAny ? '请先停止该浏览器的运行任务后再删除' : '从列表中移除该浏览器资料',
        },
      ),
    ];
    return (
      <SidebarRowShell
        key={profile.id}
        id={profile.id}
        displayName={displayName}
        codeText={account.id ?? profile.account.id ?? '—'}
        selected={selected.has(profile.id)}
        isFiltered={filteredId === profile.id}
        dropClass={drag?.dropClass ?? ''}
        dragProps={drag?.rowProps}
        avatarUrl={inspectionAvatarURL(profile, inspection, inspectionAvailable)}
        online={profile.online}
        refreshKey={inspection?.checkedAt ?? 0}
        tone={tone}
        toneLabel={toneNames[tone]}
        tooltip={tooltip}
        ariaPressed={nameAction === 'filter' ? filteredId === profile.id : undefined}
        taskText={
          profile.bindingConflict && !activity?.running ? profile.bindingConflict : activity?.text
        }
        taskTone={profile.bindingConflict && !activity?.running ? 'warn' : activity?.tone}
        taskClassName={
          profile.bindingConflict && !activity?.running ? undefined : activity?.className
        }
        progressView={
          profile.bindingConflict && !activity?.running ? undefined : activity?.progressView
        }
        menuItems={rowItems}
        onSelect={(checked, shift) => list.selectRow(visibleIds, profile.id, checked, shift)}
        onMainClick={(shift, ctrl) =>
          nameAction === 'filter' && !shift && !ctrl
            ? onInspect(profile.id)
            : list.selectRow(visibleIds, profile.id, !selected.has(profile.id), shift)
        }
      />
    );
  }
  const headerArrangeIds = selected.size > 0 ? orderedSelectedOnlineIds : orderedOnlineIds;
  const headerArrangeLabel =
    selected.size > 0 ? `整理已选 (${orderedSelectedOnlineIds.length})` : '整理全部在线浏览器窗口';
  return (
    <AccountsSidebarShell
      title="浏览器"
      countTitle="已连接 / 全部"
      onlineCount={onlineProfiles.length}
      totalCount={ws.profiles.length}
      onHideSidebar={p.onHideSidebar}
      headingActions={
        <Btn
          v="icon"
          className="h-[26px] w-[26px]"
          title={
            selected.size > 0
              ? orderedSelectedOnlineIds.length
                ? `按当前排版模式整理已选的 ${orderedSelectedOnlineIds.length} 个在线浏览器窗口`
                : '所选浏览器当前均未在线'
              : '按当前排版模式整理全部在线浏览器窗口'
          }
          aria-label={headerArrangeLabel}
          disabled={busy || arrangingWindows || !headerArrangeIds.length}
          onClick={() =>
            void mutate(() =>
              arrangeWindowBatch(
                headerArrangeIds,
                selected.size > 0 ? '所选浏览器当前均未在线' : '暂无在线浏览器窗口可整理',
                '整理',
              ),
            )
          }
        >
          <IconWindow size={15} />
        </Btn>
      }
      searchPlaceholder="搜索名称、别名或 FB ID"
      list={list}
      selectAllLabel="全选当前显示的浏览器"
      matchedIds={matched.map((r) => r.id)}
      filterLabels={['全部', '已连接', '已选']}
      attentionChip={{
        label: '异常 / 需验证 / 未识别',
        count: attentionCount,
        title: '一键筛选登出、受限、需验证、冲突、过期扩展或未识别账号',
      }}
      extraTools={
        <div className="mt-2 grid grid-cols-3 gap-1.5 [&_.btn]:h-[27px] [&_.btn]:justify-center [&_.btn]:px-1.5 [&_.btn]:text-[11.5px]">
          <Btn
            className={`${ID_BTN}${unidentifiedOnlineIds.length > 0 ? ID_ATTN : ''}`}
            title={quickIdentifyTitle}
            aria-label="一键识别在线浏览器账号与头像"
            disabled={busy || !inspectionAvailable || !quickIdentifyTargetIds.length}
            onClick={() => onCheck(quickIdentifyTargetIds)}
          >
            {inspectingAny
              ? '识别中…'
              : unidentifiedOnlineIds.length > 0 && !selectedOnlineIds.length
                ? `识别(${unidentifiedOnlineIds.length})`
                : '识别'}
          </Btn>
          <Btn
            className={ID_BTN}
            title="按 ID 批量选中浏览器"
            aria-label="按 ID 选中浏览器"
            disabled={!ws.profiles.length}
            onClick={() => setModal({ kind: 'ids' })}
          >
            按 ID
          </Btn>
          <Btn
            className={ID_BTN}
            title="设置浏览器每日安全限额（全局与单号覆盖）"
            aria-label="浏览器日限额设置"
            onClick={() => setModal({ kind: 'risk' })}
          >
            日限额
          </Btn>
        </div>
      }
      onCreateGroup={(name) => mutate(() => api.createGroup(name, 'blue'))}
      groups={folderGroups}
      selected={selected}
      onSelect={onSelect}
      busy={busy}
      onNudgeGroup={nudgeGroup}
      onRenameGroupSubmit={async (id, name) => {
        await api.renameGroup(id, name);
        await mutate(async () => undefined);
      }}
      onDeleteGroupConfirm={async (id) => {
        await api.deleteGroup(id);
        await mutate(async () => '分组已删除，浏览器已移到未分组');
      }}
      deleteGroupDescription="组内浏览器会移到未分组，保留当前选择、别名和任务记录。"
      dragReorder={{
        disabled: busy,
        unitLabel: '浏览器',
        getDragIds: (id) =>
          selected.has(id)
            ? sortedProfiles.filter((x) => selected.has(x.id)).map((x) => x.id)
            : [id],
        onDropOnRow: (gid, ids, targetId, after) =>
          void moveProfilesTo(gid === 'ungrouped' ? null : gid, ids, targetId, after),
        onDropOnFolder: (gid, ids) => void moveProfilesTo(gid === 'ungrouped' ? null : gid, ids),
      }}
      renderRow={renderProfileRow}
      emptyGroupText={(n) => (n ? '没有匹配的浏览器' : '暂无浏览器')}
      emptyListNode={
        <div className="mx-1.5 my-4 rounded-[var(--r-md)] border border-dashed border-[var(--line-strong)] bg-[var(--surface)] p-[13px] text-xs text-[var(--text-2)]">
          <strong className="text-[#526171]">等待浏览器连接</strong>
          <p className="mt-2 leading-[1.6]">
            打开已有的 Chrome 或 Brave，安装桥接扩展后会自动出现在这里，无需配对码。
          </p>
        </div>
      }
      footerNotice={
        inspectionError ? (
          <p
            className="m-0 border-t border-[var(--line)] px-3 py-1.5 text-[11px] leading-relaxed text-[#9c6257]"
            role="status"
          >
            {inspectionError}
          </p>
        ) : null
      }
      selectionBarAriaLabel="已选浏览器操作"
      selectionActions={selectionActions}
      dialogs={
        <>
          {modal?.kind === 'risk' && (
            <DailyRiskLimitModal
              carrier="browser"
              targets={sortedProfiles.map((prof) => ({
                id: prof.id,
                title: profileDisplayName(prof),
                subtitle: prof.account.name || prof.account.id || undefined,
              }))}
              onNotify={onNotify}
              onClose={() => setModal(null)}
            />
          )}
          {modal?.kind === 'ids' && (
            <SelectByIdsDialog
              title="按 ID 批量选中浏览器"
              kind="profiles"
              candidates={buildProfileCandidates(sortedProfiles, inspections)}
              onClose={() => setModal(null)}
              onApply={(ids, mode) => {
                onSelect(mode === 'replace' ? new Set(ids) : new Set([...selected, ...ids]));
                const s = new Set(ids);
                list.openFolders(
                  ws.profiles.filter((r) => s.has(r.id)).map((r) => r.groupId ?? 'ungrouped'),
                );
              }}
            />
          )}
          {modal?.kind === 'createMove' && (
            <NameDialog
              title="新建分组并移入"
              initial=""
              onClose={() => setModal(null)}
              onSubmit={async (name) => {
                const group = (await api.createGroup(name, 'blue')) as { id: string };
                await api.reorderProfiles(group.id, modal.ids);
                await onRefreshWorkspace?.();
                onNotify?.(`已创建分组「${name}」并移入 ${modal.ids.length} 个浏览器`);
              }}
            />
          )}
          {modal?.kind === 'delete' && (
            <ConfirmDialog
              title={'删除浏览器 ' + modal.label}
              description="删除后将从左侧列表中移除该浏览器资料及配对信息（若该浏览器重新打开窗口，可重新自动连接）。"
              label="删除浏览器"
              onClose={() => setModal(null)}
              onConfirm={async () => {
                await api.deleteProfiles(modal.ids);
                const next = new Set(selected);
                for (const id of modal.ids) next.delete(id);
                onSelect(next);
                await mutate(async () => `已删除 ${modal.ids.length} 个浏览器`);
              }}
            />
          )}
        </>
      }
    />
  );
}
