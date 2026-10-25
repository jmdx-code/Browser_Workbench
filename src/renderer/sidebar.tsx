import { profileTaskResultLabel } from '../shared/profile-task-result.js';
import { useEffect, useRef, useState } from 'react';
import type { Profile, Workspace } from '../shared/contracts.js';
import { selectionState, toggleSet } from './selection.js';
import { api } from './api.js';
import { NameDialog } from './name-dialog.js';
import { ConfirmDialog } from './confirm-dialog.js';
import type { Inspection } from '../shared/profile-inspection.js';
import {
  inspectionPresentation,
  inspectionAvatarURL,
  inspectionDisplayName,
} from './inspection-presentation.js';
import { ProfileAvatar, type StatusTone } from './profile-avatar.js';
import { taskTimingLabel } from '../shared/task-timing.js';
import { marketplaceBridgeSupported } from '../shared/task-features.js';
import type { z } from 'zod';
import type { TaskRuntimeOverview, TaskCommand } from '../shared/task-contracts.js';
import type { GroupInviterProfileStat } from '../shared/group-inviter.js';
import { TaskProgressView } from './task-progress.js';
import { taskReasonDescription } from '../shared/task-issues.js';
import { PopoverMenu, type MenuItem } from './popover-menu.js';
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
const taskNames = {
  feed: '浏览首页',
  video: '浏览 Reels',
  post: '发布内容',
  marketplace: '浏览商城',
  friends: '接受好友请求',
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
  groupInviterCounts,
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
  groupInviterCounts?: Record<string, GroupInviterProfileStat> | null;
  groupInviterRunningIds?: string[];
  onStopGroupInviterProfiles?: (profileIds: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('online');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [groupName, setGroupName] = useState('');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [aliasing, setAliasing] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [deletingProfiles, setDeletingProfiles] = useState<{
    ids: string[];
    label: string;
  } | null>(null);
  const rangeAnchor = useRef<string | null>(null);
  const matched = workspace.profiles.filter(
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
  const selectedPlans = tasks?.plans.filter((plan) => selected.has(plan.profileId)) ?? [];
  const pausable = selectedPlans.filter((plan) => ['RUNNING', 'QUEUED'].includes(plan.state));
  const resumable = selectedPlans.filter((plan) => plan.state === 'PAUSED');
  const stoppable = selectedPlans.filter(
    (plan) => !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state),
  );
  const stoppableInviterIds = (groupInviterRunningIds ?? []).filter((id) => selected.has(id));
  const totalStoppableCount = new Set([
    ...stoppable.map((plan) => plan.profileId),
    ...stoppableInviterIds,
  ]).size;
  const visibleGroups = [
    ...workspace.groups,
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
  const targets = (plans: typeof selectedPlans) =>
    plans.map((plan) => ({
      profileId: plan.profileId,
      planId: plan.id,
      expectedState: plan.state,
      expectedUpdatedAt: plan.updatedAt,
    }));
  function stopBrowsers() {
    void mutate(async () => {
      const { results } = await api.stop([...selected]);
      const sent = results.filter((row) => row.requested).length;
      const failed = results.filter((row) => !row.requested);
      const reasons = [
        ...new Set(failed.map((row) => (row.reason === 'OFFLINE' ? '离线' : row.reason))),
      ];
      return (
        '停止请求已发送 ' +
        sent +
        ' 份；' +
        failed.length +
        ' 份未发送' +
        (reasons.length ? '（' + reasons.join('、') + '）' : '') +
        '。实际停止状态见资料列表。'
      );
    });
  }
  function row(profile: Profile) {
    const displayName = profile.browserName ?? profile.alias;
    const plan = tasks?.plans.find(
      (value) =>
        value.profileId === profile.id && !['STOPPED', 'COMPLETED', 'FAILED'].includes(value.state),
    );
    const lastResult = tasks?.profileResults?.find((value) => value.profileId === profile.id);
    const lastStatus = lastResult ? profileTaskResultLabel(lastResult) : undefined;
    const step = tasks?.currentSteps.find((value) => value.jobId === plan?.id);
    const inspection = inspections.find((item) => item.profileId === profile.id);
    const inspectionText = inspectionPresentation(profile, inspection, inspectionAvailable).title;
    const observedName = inspectionDisplayName(profile, inspection, inspectionAvailable);
    const account = inspection?.state === 'OBSERVED' ? inspection.account : profile.account;
    const fbId = account.id ?? profile.account.id;
    const extensionOutdated =
      profile.online && !marketplaceBridgeSupported(profile.extensionVersion, '0.3.21');
    const inviterActive = groupInviterRunningIds?.includes(profile.id) === true;
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
          : (plan && ['RUNNING', 'QUEUED'].includes(plan.state)) || inviterActive
            ? 'run'
            : 'ok';
    const taskTone =
      plan?.state === 'RUNNING'
        ? 'run'
        : plan?.state === 'QUEUED'
          ? 'queue'
          : plan?.state === 'REVIEW'
            ? 'warn'
            : 'pause';
    const reasonSummary = plan?.reason ? taskReasonDescription(plan.reason)?.summary : undefined;
    const activeStepSpec =
      plan && step ? plan.snapshot.steps.find((item) => item.id === step.id) : undefined;
    const stepIndexPrefix =
      plan && plan.snapshot.steps.length > 1
        ? `[${plan.position + 1}/${plan.snapshot.steps.length}] `
        : '';
    const stepLabel = !plan
      ? ''
      : plan.state === 'QUEUED'
        ? plan.timing
          ? taskTimingLabel(plan.timing)
          : reasonSummary
            ? '排队中 · ' + reasonSummary
            : '排队中'
        : plan.state === 'REVIEW'
          ? '待核对'
          : plan.state === 'PAUSED'
            ? reasonSummary && !/^(USER_|MANUAL_)/.test(plan.reason)
              ? '已暂停 · ' + reasonSummary
              : '已暂停'
            : plan.state === 'PAUSING'
              ? '正在暂停'
              : plan.state === 'STOPPING'
                ? '正在停止'
                : step
                  ? stepIndexPrefix +
                    (step.destination === 'story' ? '发布快拍' : taskNames[step.type]) +
                    ' · 执行中'
                  : '运行中';
    const tooltip = [
      displayName + (observedName ? ' · ' + observedName : ''),
      '别名：' + profile.alias,
      '连接：' + (phaseNames[profile.phase] ?? profile.phase),
      'FB 状态：' + inspectionText,
      ...(!plan && lastResult && lastStatus
        ? [
            lastStatus.text,
            '结束：' + new Date(lastResult.finishedAt).toLocaleString(),
            ...(lastResult.reason
              ? [taskReasonDescription(lastResult.reason)?.summary ?? lastResult.reason]
              : []),
          ]
        : []),
      ...(profile.unresolved ? [profile.unresolved + ' 项待核对'] : []),
      ...(extensionOutdated
        ? ['插件 ' + (profile.extensionVersion ?? '未知') + '，测试需刷新至 0.3.21']
        : []),
      ...(plan
        ? [
            '任务：' +
              plan.snapshot.name +
              ' · 第' +
              plan.round +
              '轮' +
              (plan.snapshot.loop.mode === 'finite'
                ? '/' + plan.snapshot.loop.rounds
                : '（循环）') +
              ' · 第' +
              (plan.position + 1) +
              '/' +
              plan.snapshot.steps.length +
              '项',
            ...(plan.reason ? [taskReasonDescription(plan.reason)?.summary ?? plan.reason] : []),
          ]
        : []),
    ].join('\n');
    const rowItems: MenuItem[] = [
      {
        label: '显示浏览器窗口',
        icon: <IconWindow />,
        disabled: busy || !profile.online || !onShow || (!!plan && plan.state !== 'RUNNING'),
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
        disabled:
          !profile.online ||
          busy ||
          !!(plan && !['COMPLETED', 'FAILED', 'STOPPED', 'PAUSED'].includes(plan.state)) ||
          inviterActive,
        onSelect: () =>
          void mutate(async () => {
            const res = await api.cleanupProfileTabs([profile.id]);
            return res.cleanedProfiles
              ? `已为「${displayName}」清理 ${res.closedTabs} 个多余标签页，仅保留主页面`
              : `未清理：${res.skippedBusy} 个忙碌，${res.skippedOffline} 个离线`;
          }),
      },
      { label: '修改别名', icon: <IconEdit />, onSelect: () => setAliasing(profile) },
      ...(plan && ['RUNNING', 'QUEUED'].includes(plan.state) && onTaskCommand
        ? [
            { separator: true } as MenuItem,
            {
              label: '暂停任务',
              icon: <IconPause />,
              disabled: busy,
              onSelect: () => onTaskCommand('pause', targets([plan])),
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
              onSelect: () => onTaskCommand('resume', targets([plan])),
            },
          ]
        : []),
      ...((plan && !['COMPLETED', 'FAILED', 'STOPPED'].includes(plan.state) && onTaskCommand) ||
      (inviterActive && onStopGroupInviterProfiles)
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
                  onTaskCommand('stop', targets([plan]));
                }
                if (inviterActive && onStopGroupInviterProfiles) {
                  onStopGroupInviterProfiles([profile.id]);
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
        disabled: busy || !!plan || inviterActive,
        title:
          plan || inviterActive ? '请先停止该浏览器的运行任务后再删除' : '从列表中移除该浏览器资料',
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
          (filteredId === profile.id ? ' is-filtered' : '')
        }
        key={profile.id}
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
            nameAction === 'filter'
              ? onInspect(profile.id)
              : selectProfile(profile.id, !selected.has(profile.id), event.shiftKey)
          }
        >
          <span className="profile-line">
            <strong>{displayName}</strong>
            <code className="fb-id">{fbId ?? '—'}</code>
          </span>
          {groupInviterCounts && (
            <span
              className={
                'task-line group-inviter-profile-stat tone-' +
                (inviterActive
                  ? 'run'
                  : /失败|未确认|不可|异常|离线/.test(groupInviterCounts[profile.id]?.status ?? '')
                    ? 'err'
                    : /停止/.test(groupInviterCounts[profile.id]?.status ?? '')
                      ? 'pause'
                      : 'ok')
              }
            >
              <span className="task-line-text">
                本次邀请 {groupInviterCounts[profile.id]?.sessionInvited ?? 0} 人 · 累计{' '}
                {groupInviterCounts[profile.id]?.totalInvited ?? 0} 人
                {groupInviterCounts[profile.id]?.status
                  ? ' · ' + groupInviterCounts[profile.id]?.status
                  : ''}
              </span>
            </span>
          )}
          {plan && (
            <span className={'task-line tone-' + taskTone}>
              <span className="task-line-text">
                {plan.state === 'RUNNING' && step
                  ? stepLabel
                  : plan.snapshot.name + ' · ' + stepLabel}
              </span>
              {step && plan.state === 'RUNNING' && (
                <TaskProgressView
                  type={step.type}
                  progress={step.progress}
                  budget={step.budget}
                  maxLikes={
                    activeStepSpec && 'maxLikes' in activeStepSpec
                      ? activeStepSpec.maxLikes
                      : undefined
                  }
                  compact
                />
              )}
            </span>
          )}
          {!plan && !inviterActive && lastStatus && (
            <span className={'task-line tone-' + lastStatus.tone}>
              <span className="task-line-text">{lastStatus.text}</span>
            </span>
          )}
          {!groupInviterCounts && !plan && inviterActive && (
            <span className="task-line tone-run">
              <span className="task-line-text">小组邀请人 · 运行中</span>
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
          const running = ids.filter(
            (id) =>
              tasks?.plans.some((plan) => plan.profileId === id && plan.state === 'RUNNING') ||
              groupInviterRunningIds?.includes(id),
          ).length;
          if (group.id === 'ungrouped' && !all.length && workspace.groups.length) return null;
          return (
            <section className={'group color-' + group.color} key={group.id}>
              <div className="group-head">
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
                <p className="group-empty">{all.length ? '没有匹配的浏览器' : '暂无浏览器'}</p>
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
        <div className="selection-bar" aria-label="已选浏览器操作">
          <div className="selection-bar-head">
            <strong>已选 {selected.size}</strong>
            <button className="btn btn-ghost btn-sm" onClick={() => onSelect(new Set())}>
              清空
            </button>
          </div>
          <div className="selection-bar-actions">
            <button
              className="btn btn-sm"
              disabled={busy}
              title="仅保留主 Facebook 页面，跳过忙碌或离线浏览器"
              onClick={() =>
                void mutate(async () => {
                  const res = await api.cleanupProfileTabs([...selected]);
                  return (
                    `已清理 ${res.cleanedProfiles} 个浏览器，共关闭 ${res.closedTabs} 个多余标签页` +
                    (res.skippedBusy || res.skippedOffline
                      ? `；跳过 ${res.skippedBusy} 个忙碌、${res.skippedOffline} 个离线`
                      : '')
                  );
                })
              }
            >
              <IconClose size={14} /> 清理标签页
            </button>
            <button
              className="btn btn-sm"
              title="检查所选浏览器的 Facebook 状态（只读）"
              disabled={busy || !inspectionAvailable}
              onClick={() => onCheck([...selected])}
            >
              <IconRefresh size={14} /> 检查
            </button>
            <button
              className="btn btn-sm"
              title="暂停所选浏览器的任务"
              disabled={busy || !onTaskCommand || !pausable.length}
              onClick={() => onTaskCommand?.('pause', targets(pausable))}
            >
              <IconPause size={14} /> 暂停{pausable.length ? ` ${pausable.length}` : ''}
            </button>
            <button
              className="btn btn-sm"
              title="继续所选浏览器已暂停的任务"
              disabled={busy || !onTaskCommand || !resumable.length}
              onClick={() => onTaskCommand?.('resume', targets(resumable))}
            >
              <IconPlay size={12} /> 继续{resumable.length ? ` ${resumable.length}` : ''}
            </button>
            <button
              className="btn btn-sm btn-danger"
              title="停止所选浏览器的任务"
              disabled={
                busy || totalStoppableCount === 0 || (!onTaskCommand && !onStopGroupInviterProfiles)
              }
              onClick={() => {
                if (stoppable.length && onTaskCommand) onTaskCommand('stop', targets(stoppable));
                if (stoppableInviterIds.length && onStopGroupInviterProfiles)
                  onStopGroupInviterProfiles(stoppableInviterIds);
              }}
            >
              <IconStop size={13} /> 停止{totalStoppableCount ? ` ${totalStoppableCount}` : ''}
            </button>
            <PopoverMenu
              label="更多批量操作"
              align="start"
              trigger={<IconMore size={15} />}
              items={[
                { separator: true, label: '移到分组' },
                {
                  label: '未分组',
                  onSelect: () => void mutate(() => api.move([...selected], null)),
                },
                ...workspace.groups.map((group) => ({
                  label: group.name,
                  onSelect: () => void mutate(() => api.move([...selected], group.id)),
                })),
                { separator: true },
                {
                  label: '停止所选浏览器控制',
                  icon: <IconStop />,
                  danger: true,
                  disabled: busy,
                  title: '向所选浏览器发送停止控制请求',
                  onSelect: stopBrowsers,
                },
                {
                  label: `删除所选浏览器 (${selected.size})`,
                  icon: <IconClose />,
                  danger: true,
                  disabled:
                    busy ||
                    stoppable.length > 0 ||
                    [...selected].some((id) => groupInviterRunningIds?.includes(id)),
                  title:
                    stoppable.length > 0 ||
                    [...selected].some((id) => groupInviterRunningIds?.includes(id))
                      ? '所选浏览器中存在运行中任务，请先停止任务后再删除'
                      : '从列表中批量移除所选浏览器资料',
                  onSelect: () =>
                    setDeletingProfiles({
                      ids: [...selected],
                      label: `所选的 ${selected.size} 个浏览器`,
                    }),
                },
              ]}
            />
          </div>
        </div>
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
      {aliasing && (
        <NameDialog
          title="浏览器别名"
          initial={aliasing.alias}
          onClose={() => setAliasing(null)}
          onSubmit={async (alias) => {
            await api.rename(aliasing.id, alias);
            await mutate(async () => '别名已保存');
          }}
        />
      )}
    </aside>
  );
}
