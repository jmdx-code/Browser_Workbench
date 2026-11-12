import { insertFinderIds, nudgeFinderIds } from './finder-list-model.js';
import type { BumperProfileStat } from '../shared/group-bumper.js';
import { useEffect, useRef, useState } from 'react';
import type { Profile, Workspace } from '../shared/contracts.js';
import { selectionState, toggleSet } from './selection.js';
import { api } from './api.js';
import { NameDialog } from './name-dialog.js';
import { ConfirmDialog } from './confirm-dialog.js';
import { SelectByIdsDialog, buildProfileCandidates } from './select-by-ids-dialog.js';
import type { Inspection } from '../shared/profile-inspection.js';
import {
  inspectionPresentation,
  inspectionAvatarURL,
  inspectionDisplayName,
} from './inspection-presentation.js';
import { ProfileAvatar, type StatusTone } from './profile-avatar.js';
import { marketplaceBridgeSupported } from '../shared/task-features.js';
import type { z } from 'zod';
import type { TaskRuntimeOverview, TaskCommand } from '../shared/task-contracts.js';
import type { GroupInviterProfileStat } from '../shared/group-inviter.js';
import { TaskProgressView } from './task-progress.js';
import { PopoverMenu, type MenuItem } from './popover-menu.js';
import type {
  ProfileActivityDescriptor,
  SelectionControlSummary,
} from './modules/module-contracts.js';
import {
  projectProfileActivitiesMap,
  projectSelectionControls,
} from './modules/profile-activity-projector.js';
import {
  IconChevronDown,
  IconClose,
  IconEdit,
  IconMore,
  IconPause,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconStop,
  IconWindow,
} from './icons.js';
function GroupCheck({
  checked,
  mixed,
  onChange,
  label,
}: {
  checked: boolean;
  mixed: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={input}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      aria-label={label}
      title={label}
    />
  );
}
const phaseNames: Record<string, string> = {
  OFFLINE: '离线',
  SYNCING: '对账中',
  PAUSED: '已连接 · 就绪',
  RUNNING: '通道就绪',
  STOPPING: '停止中',
  STARTING: '恢复中',
  RECOVERING: '需要核对',
};
const toneNames: Record<StatusTone, string> = {
  idle: '离线',
  ok: '已连接',
  run: '运行中',
  warn: '需要留意',
  err: '账号状态异常',
};
export function Sidebar({
  workspace,
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
  onShow,
  tasks,
  onTaskCommand,
  activities,
  selectionControls,
  onStopModules,
  groupInviterCounts,
  bumperCounts,
  bumperRunningIds,
  groupInviterRunningIds,
  onStopGroupInviterProfiles,
}: {
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
  onShow?: (id: string) => void;
  tasks?: z.infer<typeof TaskRuntimeOverview> | null;
  onTaskCommand?: (command: TaskCommand['command'], plans: TaskCommand['plans']) => void;
  activities?: ReadonlyMap<string, ProfileActivityDescriptor>;
  selectionControls?: SelectionControlSummary;
  onStopModules?: (profileIds: string[]) => void;
  bumperCounts?: Record<string, BumperProfileStat>;
  bumperRunningIds?: string[];
  groupInviterCounts?: Record<string, GroupInviterProfileStat> | null;
  groupInviterRunningIds?: string[];
  onStopGroupInviterProfiles?: (profileIds: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [deletingProfiles, setDeletingProfiles] = useState<{
    ids: string[];
    label: string;
  } | null>(null);
  const rangeAnchor = useRef<string | null>(null);
  const draggingProfiles = useRef<string[]>([]);
  const [dropProfile, setDropProfile] = useState('');
  const [createAndMove, setCreateAndMove] = useState(false);
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const [arrangingWindows, setArrangingWindows] = useState(false);
  const sortedProfiles = [...workspace.profiles].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
  );
  const matched = sortedProfiles.filter(
    (profile) =>
      (
        profile.alias +
        ' ' +
        (profile.browserName ?? '') +
        ' ' +
        (profile.account.name ?? '') +
        ' ' +
        (profile.account.id ?? '') +
        ' ' +
        (inspectionDisplayName(
          profile,
          inspections.find((item) => item.profileId === profile.id),
          inspectionAvailable,
        ) ?? '')
      )
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'all' || (filter === 'online' ? profile.online : selected.has(profile.id))),
  );
  const matchedIds = matched.map((profile) => profile.id);
  const matchedState = selectionState(selected, matchedIds);
  const projectionInput = {
    tasks,
    bumperCounts,
    bumperRunningIds,
    groupInviterCounts,
    groupInviterRunningIds,
  };
  const resolvedActivities =
    activities ?? projectProfileActivitiesMap(workspace.profiles, projectionInput);
  const resolvedControls = selectionControls ?? projectSelectionControls(selected, projectionInput);
  const stopModulesHandler = onStopModules ?? onStopGroupInviterProfiles;
  const visibleGroups = [
    ...[...workspace.groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    { id: 'ungrouped', name: '未分组', color: 'gray', order: -1 },
  ];
  const visibleIds = visibleGroups.flatMap((group) =>
    closed.has(group.id)
      ? []
      : matched
          .filter((profile) => (profile.groupId ?? 'ungrouped') === group.id)
          .map((profile) => profile.id),
  );
  const onlineCount = workspace.profiles.filter((profile) => profile.online).length;
  function selectProfile(id: string, checked: boolean, shift: boolean) {
    const start = rangeAnchor.current ? visibleIds.indexOf(rangeAnchor.current) : -1;
    const end = visibleIds.indexOf(id);
    const ids =
      shift && start >= 0 && end >= 0
        ? visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)
        : [id];
    onSelect(toggleSet(selected, ids, checked));
    rangeAnchor.current = id;
  }
  function moveProfilesTo(
    groupId: string | null,
    ids = [...selected],
    target?: string,
    after = false,
  ) {
    const old = sortedProfiles.filter((p) => p.groupId === groupId).map((p) => p.id);
    return mutate(() => api.reorderProfiles(groupId, insertFinderIds(old, ids, target, after)));
  }
  async function nudgeProfiles(direction: -1 | 1) {
    for (const group of visibleGroups) {
      const id = group.id === 'ungrouped' ? null : group.id;
      const ids = sortedProfiles.filter((p) => p.groupId === id).map((p) => p.id);
      if (ids.some((key) => selected.has(key)))
        await mutate(() => api.reorderProfiles(id, nudgeFinderIds(ids, selected, direction)));
    }
  }
  function nudgeGroup(id: string, direction: -1 | 1) {
    const ids = workspace.groups.map((g) => g.id),
      at = ids.indexOf(id),
      to = at + direction;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to] ?? '', ids[at] ?? ''];
    void mutate(() => api.reorderGroups(ids));
  }
  function row(profile: Profile) {
    const displayName = profile.browserName ?? profile.alias;
    const plan = tasks?.plans.find(
      (value) =>
        value.profileId === profile.id && !['STOPPED', 'COMPLETED', 'FAILED'].includes(value.state),
    );
    const activity = resolvedActivities.get(profile.id) ?? null;
    const inspection = inspections.find((item) => item.profileId === profile.id);
    const inspectionText = inspectionPresentation(profile, inspection, inspectionAvailable).title;
    const observedName = inspectionDisplayName(profile, inspection, inspectionAvailable);
    const account = inspection?.state === 'OBSERVED' ? inspection.account : profile.account;
    const fbId = account.id ?? profile.account.id;
    const extensionOutdated =
      profile.online && !marketplaceBridgeSupported(profile.extensionVersion, '0.3.21');
    const isRunningAny = Boolean(activity?.running);
    const isBusyAny = resolvedControls.isProfileBusy(profile.id);
    // Priority: offline > account problem > needs attention > running > connected.
    // An unknown account state is never shown as a problem.
    const tone: StatusTone = !profile.online
      ? 'idle'
      : ['logged-out', 'restricted', 'verification'].includes(account.state)
        ? 'err'
        : profile.unresolved ||
            extensionOutdated ||
            profile.phase === 'RECOVERING' ||
            (plan && ['PAUSED', 'PAUSING', 'STOPPING', 'REVIEW'].includes(plan.state))
          ? 'warn'
          : isRunningAny
            ? 'run'
            : 'ok';
    const tooltip = [
      displayName + (observedName ? ' · ' + observedName : ''),
      '连接：' + (phaseNames[profile.phase] ?? profile.phase),
      'FB 状态：' + inspectionText,
      ...(profile.unresolved ? [profile.unresolved + ' 项待核对'] : []),
      ...(extensionOutdated
        ? ['插件 ' + (profile.extensionVersion ?? '未知') + '，测试需刷新至 0.3.21']
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
    const rowItems: MenuItem[] = [
      {
        label: '显示浏览器窗口',
        icon: <IconWindow />,
        disabled: !profile.online || !onShow,
        title: profile.online ? '显示这份浏览器的工作页面' : '未连接，请先手动打开浏览器',
        onSelect: () => onShow?.(profile.id),
      },
      {
        label: '检查 FB 状态',
        icon: <IconRefresh />,
        disabled: busy || !inspectionAvailable,
        onSelect: () => onCheck([profile.id]),
      },
      {
        label: '清理其他标签页',
        icon: <IconClose />,
        disabled: !profile.online || busy,
        onSelect: () =>
          void mutate(async () => {
            const res = await api.cleanupProfileTabs([profile.id]);
            return res.cleanedProfiles
              ? `已为「${displayName}」清理 ${res.closedTabs} 个多余标签页，仅保留主页面`
              : `未清理：${res.skippedBusy} 个忙碌，${res.skippedOffline} 个离线`;
          }),
      },
      ...(plan && ['RUNNING', 'QUEUED'].includes(plan.state) && onTaskCommand
        ? [
            { separator: true } as MenuItem,
            {
              label: '暂停任务',
              icon: <IconPause />,
              disabled: busy,
              onSelect: () => onTaskCommand('pause', singleTarget),
            },
          ]
        : []),
      ...(plan && plan.state === 'PAUSED' && onTaskCommand
        ? [
            { separator: true } as MenuItem,
            {
              label: '继续任务',
              icon: <IconPlay />,
              disabled: busy,
              onSelect: () => onTaskCommand('resume', singleTarget),
            },
          ]
        : []),
      ...((plan && !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state) && onTaskCommand) ||
      (hasStoppableModule && stopModulesHandler)
        ? [
            ...(plan && ['RUNNING', 'QUEUED', 'PAUSED'].includes(plan.state)
              ? []
              : [{ separator: true } as MenuItem]),
            {
              label: '停止当前任务',
              icon: <IconStop />,
              danger: true,
              disabled: busy,
              onSelect: () => {
                if (
                  plan &&
                  !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state) &&
                  onTaskCommand
                ) {
                  onTaskCommand('stop', singleTarget);
                }
                if (hasStoppableModule && stopModulesHandler) {
                  stopModulesHandler([profile.id]);
                }
              },
            },
          ]
        : []),
      { separator: true },
      {
        label: '删除浏览器',
        icon: <IconClose />,
        danger: true,
        disabled: busy || isBusyAny,
        title: isBusyAny ? '请先停止该浏览器的运行任务后再删除' : '从列表中移除该浏览器资料',
        onSelect: () =>
          setDeletingProfiles({
            ids: [profile.id],
            label: `「${displayName}」`,
          }),
      },
    ];

    return (
      <div
        className={
          'profile-row' +
          (selected.has(profile.id) ? ' selected' : '') +
          (filteredId === profile.id ? ' is-filtered' : '') +
          (dropProfile === 'b:' + profile.id
            ? ' drop-before'
            : dropProfile === 'a:' + profile.id
              ? ' drop-after'
              : '')
        }
        key={profile.id}
        draggable={!busy}
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest('button,input')) return;
          if (e.shiftKey || e.ctrlKey || e.metaKey)
            selectProfile(profile.id, !selected.has(profile.id), e.shiftKey);
        }}
        onDragStart={(e) => {
          draggingProfiles.current = selected.has(profile.id)
            ? sortedProfiles.filter((p) => selected.has(p.id)).map((p) => p.id)
            : [profile.id];
          e.dataTransfer.setData('text/plain', JSON.stringify(draggingProfiles.current));
          e.dataTransfer.effectAllowed = 'move';
          const ghost = document.createElement('div');
          ghost.className = 'finder-drag-ghost';
          ghost.textContent = '移动 ' + draggingProfiles.current.length + ' 个浏览器';
          document.body.append(ghost);
          e.dataTransfer.setDragImage(ghost, 0, 0);
          setTimeout(() => ghost.remove(), 0);
        }}
        onDragEnd={() => {
          draggingProfiles.current = [];
          setDropProfile('');
        }}
        onDragOver={(e) => {
          if (!busy && draggingProfiles.current.length) {
            e.preventDefault();
            setDropProfile(
              (e.clientY <
              e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2
                ? 'b:'
                : 'a:') + profile.id,
            );
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropProfile('');
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (busy || draggingProfiles.current.includes(profile.id)) return;
          void moveProfilesTo(
            profile.groupId,
            draggingProfiles.current,
            profile.id,
            e.clientY >=
              e.currentTarget.getBoundingClientRect().top +
                e.currentTarget.getBoundingClientRect().height / 2,
          );
          draggingProfiles.current = [];
          setDropProfile('');
        }}
      >
        <input
          aria-label={'选择 ' + displayName}
          type="checkbox"
          checked={selected.has(profile.id)}
          onChange={(event) =>
            selectProfile(
              profile.id,
              event.target.checked,
              event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey,
            )
          }
        />
        <ProfileAvatar
          url={inspectionAvatarURL(profile, inspection, inspectionAvailable)}
          online={profile.online}
          refreshKey={inspection?.checkedAt ?? 0}
          tone={tone}
          toneLabel={toneNames[tone]}
        />
        <button
          className="profile-main"
          title={tooltip}
          aria-pressed={nameAction === 'filter' ? filteredId === profile.id : undefined}
          onClick={(event) =>
            nameAction === 'filter' && !event.shiftKey && !event.ctrlKey && !event.metaKey
              ? onInspect(profile.id)
              : selectProfile(profile.id, !selected.has(profile.id), event.shiftKey)
          }
        >
          <span className="profile-line">
            <strong>{displayName}</strong>
            <code className="fb-id">{fbId ?? '—'}</code>
          </span>
          {activity && (
            <span
              className={
                'task-line' +
                (activity.className ? ' ' + activity.className : '') +
                ' tone-' +
                activity.tone
              }
            >
              <span className="task-line-text">{activity.text}</span>
              {activity.progressView && (
                <TaskProgressView
                  type={activity.progressView.type}
                  progress={activity.progressView.progress}
                  budget={activity.progressView.budget}
                  maxLikes={activity.progressView.maxLikes}
                  compact
                />
              )}
            </span>
          )}
        </button>
        <PopoverMenu
          className="row-menu"
          label={'更多 · ' + displayName}
          trigger={<IconMore size={15} />}
          items={rowItems}
        />
      </div>
    );
  }
  return (
    <aside className="sidebar">
      <div className="sidebar-heading">
        <strong>浏览器</strong>
        <span className="count-chip" title="已连接 / 全部">
          {onlineCount}/{workspace.profiles.length}
        </span>
        <button
          type="button"
          className="btn btn-sm sidebar-select-ids-btn"
          title="按 ID 批量选中浏览器"
          aria-label="按 ID 选中浏览器"
          disabled={workspace.profiles.length === 0}
          onClick={() => setSelectByIdsOpen(true)}
        >
          按 ID 选中
        </button>
        <button
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
            placeholder="搜索名称、别名或 FB ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="filter-row">
          <GroupCheck
            {...matchedState}
            label="全选当前显示的浏览器"
            onChange={(checked) => onSelect(toggleSet(selected, matchedIds, checked))}
          />
          <div className="segmented">
            {[
              ['all', '全部'],
              ['online', '已连接'],
              ['selected', '已选'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'active' : ''}
                onClick={() => setFilter(value ?? 'all')}
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
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(async () => {
              await api.createGroup(groupName, 'blue');
              setGroupName('');
              setCreating(false);
            });
          }}
        >
          <input
            required
            autoFocus
            maxLength={80}
            placeholder="分组名称"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
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
          const all = workspace.profiles.filter(
            (profile) => (profile.groupId ?? 'ungrouped') === group.id,
          );
          const profiles = matched.filter(
            (profile) => (profile.groupId ?? 'ungrouped') === group.id,
          );
          const ids = all.map((profile) => profile.id);
          const visibleGroupIds = profiles.map((profile) => profile.id);
          const state = selectionState(selected, visibleGroupIds);
          const isClosed = closed.has(group.id);
          const running = ids.filter((id) => resolvedActivities.get(id)?.running === true).length;
          return (
            <section className={'group color-' + group.color} key={group.id}>
              <div
                className={'group-head' + (dropProfile === 'g:' + group.id ? ' is-drop' : '')}
                onDragOver={(e) => {
                  if (!busy && draggingProfiles.current.length) {
                    e.preventDefault();
                    setDropProfile('g:' + group.id);
                  }
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropProfile('');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (busy) return;
                  void moveProfilesTo(
                    group.id === 'ungrouped' ? null : group.id,
                    draggingProfiles.current,
                  );
                  draggingProfiles.current = [];
                  setDropProfile('');
                }}
              >
                <GroupCheck
                  {...state}
                  label={'选择整组 ' + group.name}
                  onChange={(checked) => onSelect(toggleSet(selected, visibleGroupIds, checked))}
                />
                <button
                  className={'group-title' + (isClosed ? ' is-closed' : '')}
                  aria-expanded={!isClosed}
                  onClick={() => setClosed(toggleSet(closed, [group.id], !isClosed))}
                >
                  <IconChevronDown size={14} />
                  <span>{group.name}</span>
                </button>
                {running > 0 && (
                  <span className="group-running" title="正在执行任务的浏览器数量">
                    <IconPlay size={10} /> {running}
                  </span>
                )}
                <span className="group-count">
                  {ids.filter((id) => selected.has(id)).length}/{ids.length}
                </span>
                {group.id !== 'ungrouped' && (
                  <PopoverMenu
                    className="group-menu"
                    label={'分组操作 · ' + group.name}
                    trigger={<IconMore size={15} />}
                    items={[
                      {
                        label: '↑ 上移分组',
                        disabled: busy,
                        onSelect: () => nudgeGroup(group.id, -1),
                      },
                      {
                        label: '↓ 下移分组',
                        disabled: busy,
                        onSelect: () => nudgeGroup(group.id, 1),
                      },
                      {
                        label: '重命名分组',
                        icon: <IconEdit />,
                        onSelect: () => setRenaming({ id: group.id, name: group.name }),
                      },
                      {
                        label: '删除分组',
                        icon: <IconClose />,
                        danger: true,
                        disabled: busy,
                        onSelect: () => setDeleting({ id: group.id, name: group.name }),
                      },
                    ]}
                  />
                )}
              </div>
              {!isClosed && profiles.map(row)}
              {!isClosed && profiles.length === 0 && (
                <p
                  className={'group-empty' + (dropProfile === 'g:' + group.id ? ' is-drop' : '')}
                  onDragOver={(e) => {
                    if (!busy && draggingProfiles.current.length) {
                      e.preventDefault();
                      setDropProfile('g:' + group.id);
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null))
                      setDropProfile('');
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (busy || !draggingProfiles.current.length) return;
                    void moveProfilesTo(
                      group.id === 'ungrouped' ? null : group.id,
                      draggingProfiles.current,
                    );
                    draggingProfiles.current = [];
                    setDropProfile('');
                  }}
                >
                  {all.length ? '没有匹配的浏览器' : '暂无浏览器'}
                </p>
              )}
            </section>
          );
        })}
        {workspace.profiles.length === 0 && (
          <div className="connection-guide">
            <strong>等待浏览器连接</strong>
            <p>打开已有的 Chrome 或 Brave，安装桥接扩展后会自动出现在这里，无需配对码。</p>
          </div>
        )}
      </div>
      {inspectionError && (
        <p className="inspection-read-error" role="status">
          {inspectionError}
        </p>
      )}
      {selected.size > 0 && (
        <div className="selection-bar compact-selection" aria-label="已选浏览器操作">
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
          <PopoverMenu
            label="移到分组"
            disabled={busy}
            align="start"
            trigger={<>移到分组 ▾</>}
            items={[
              { label: '未分组', onSelect: () => void moveProfilesTo(null) },
              ...workspace.groups.map((g) => ({
                label: g.name,
                onSelect: () => void moveProfilesTo(g.id),
              })),
              { label: '+ 新建分组并移入', onSelect: () => setCreateAndMove(true) },
            ]}
          />
          <button
            className="btn btn-sm compact-arrow"
            aria-label="上移"
            title="上移所选浏览器"
            disabled={busy}
            onClick={() => void nudgeProfiles(-1)}
          >
            ↑
          </button>
          <button
            className="btn btn-sm compact-arrow"
            aria-label="下移"
            title="下移所选浏览器"
            disabled={busy}
            onClick={() => void nudgeProfiles(1)}
          >
            ↓
          </button>
          <button
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void mutate(async () => {
                const res = await api.cleanupProfileTabs([...selected]);
                return `已清理 ${res.cleanedProfiles} 个浏览器，共关闭 ${res.closedTabs} 个多余标签页${res.skippedOffline > 0 ? `（${res.skippedOffline} 个离线未连接）` : ''}`;
              })
            }
          >
            清理标签
          </button>
          <button
            className="btn btn-sm"
            disabled={arrangingWindows || selected.size === 0 || selected.size > 100}
            title="在最后激活的浏览器所在屏幕上，按统一尺寸与固定间隔整齐排列所选窗口"
            onClick={() => {
              if (arrangingWindows) return;
              setArrangingWindows(true);
              void api
                .windowLayout({ action: 'apply', profileIds: [...selected] })
                .catch(() => {})
                .finally(() => {
                  setArrangingWindows(false);
                });
            }}
          >
            {arrangingWindows ? '整理中...' : '整理窗口'}
          </button>
          <button
            className="btn btn-sm btn-danger"
            disabled={busy || resolvedControls.totalStoppableCount === 0}
            onClick={() => {
              if (resolvedControls.stoppableTargets.length)
                onTaskCommand?.('stop', resolvedControls.stoppableTargets);
              if (resolvedControls.stoppableModuleProfileIds.length)
                stopModulesHandler?.(resolvedControls.stoppableModuleProfileIds);
            }}
          >
            停止
          </button>
          <PopoverMenu
            label="更多批量操作"
            align="end"
            trigger={<IconMore size={15} />}
            items={[
              {
                label: '检查 FB 状态',
                disabled: busy || !inspectionAvailable,
                onSelect: () => onCheck([...selected]),
              },
              {
                label: '暂停任务',
                disabled: busy || !resolvedControls.pausableTargets.length || !onTaskCommand,
                onSelect: () => onTaskCommand?.('pause', resolvedControls.pausableTargets),
              },
              {
                label: '继续任务',
                disabled: busy || !resolvedControls.resumableTargets.length || !onTaskCommand,
                onSelect: () => onTaskCommand?.('resume', resolvedControls.resumableTargets),
              },
              {
                label: '删除所选浏览器',
                disabled: busy || resolvedControls.totalStoppableCount > 0,
                danger: true,
                onSelect: () =>
                  setDeletingProfiles({
                    ids: [...selected],
                    label: '所选的 ' + selected.size + ' 个浏览器',
                  }),
              },
            ]}
          />
        </div>
      )}
      {selectByIdsOpen && (
        <SelectByIdsDialog
          title="按 ID 批量选中浏览器"
          kind="profiles"
          candidates={buildProfileCandidates(sortedProfiles, inspections)}
          onClose={() => setSelectByIdsOpen(false)}
          onApply={(matchedProfileIds, applyMode) => {
            const next =
              applyMode === 'replace'
                ? new Set(matchedProfileIds)
                : new Set([...selected, ...matchedProfileIds]);
            onSelect(next);
            const matchedSet = new Set(matchedProfileIds);
            const groupsToOpen = new Set(
              workspace.profiles
                .filter((p) => matchedSet.has(p.id))
                .map((p) => p.groupId ?? 'ungrouped'),
            );
            if (groupsToOpen.size > 0) {
              setClosed((prev) => {
                const nextClosed = new Set(prev);
                for (const gid of groupsToOpen) nextClosed.delete(gid);
                return nextClosed;
              });
            }
          }}
        />
      )}
      {createAndMove && (
        <NameDialog
          title="新建分组并移入"
          initial=""
          onClose={() => setCreateAndMove(false)}
          onSubmit={async (name) => {
            await mutate(async () => {
              const group = (await api.createGroup(name, 'blue')) as { id: string };
              await api.reorderProfiles(group.id, [...selected]);
            });
          }}
        />
      )}
      {deletingProfiles && (
        <ConfirmDialog
          title={'删除浏览器 ' + deletingProfiles.label}
          description="删除后将从左侧列表中移除该浏览器资料及配对信息（若该浏览器重新打开窗口，可重新自动连接）。"
          label="删除浏览器"
          onClose={() => setDeletingProfiles(null)}
          onConfirm={async () => {
            const idsToRemove = deletingProfiles.ids;
            await api.deleteProfiles(idsToRemove);
            const nextSelected = new Set(selected);
            for (const id of idsToRemove) nextSelected.delete(id);
            onSelect(nextSelected);
            await mutate(async () => `已删除 ${idsToRemove.length} 个浏览器`);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={'删除分组「' + deleting.name + '」'}
          description="组内浏览器会移到未分组，保留当前选择、别名和任务记录。"
          label="删除分组"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteGroup(deleting.id);
            await mutate(async () => '分组已删除，浏览器已移到未分组');
          }}
        />
      )}
      {renaming && (
        <NameDialog
          title="分组名称"
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            await api.renameGroup(renaming.id, name);
            await mutate(async () => undefined);
          }}
        />
      )}
    </aside>
  );
}
