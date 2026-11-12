import { useEffect, useRef, useState } from 'react';
import type { Profile, Workspace } from '../../shared/contracts.js';
import type { PosterTaskAccountMode } from '../../shared/group-poster.js';
import { IconChevronDown, IconSearch } from '../icons.js';
import { ProfileAvatar, type StatusTone } from '../profile-avatar.js';
import { SelectByIdsDialog, buildProfileCandidates } from '../select-by-ids-dialog.js';
import { selectionState, toggleSet } from '../selection.js';

type ProfileGroup = Workspace['groups'][number];

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

const toneNames: Record<StatusTone, string> = {
  idle: '离线',
  ok: '已连接',
  run: '运行中',
  warn: '需要留意',
  err: '账号状态异常',
};

export function PosterProfileSelector({
  profiles,
  groups = [],
  selected,
  onSelect,
  accountMode = 'selected',
  onAccountModeChange,
}: {
  profiles: readonly Profile[];
  groups?: readonly ProfileGroup[] | undefined;
  selected: ReadonlySet<string>;
  onSelect: (ids: Set<string>) => void;
  accountMode?: PosterTaskAccountMode | undefined;
  onAccountModeChange?: ((mode: PosterTaskAccountMode) => void) | undefined;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'selected'>('all');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [selectByIdsOpen, setSelectByIdsOpen] = useState(false);
  const rangeAnchor = useRef<string | null>(null);

  const applySelection = (next: Set<string>) => {
    onAccountModeChange?.('selected');
    onSelect(next);
  };

  const sortedProfiles = [...profiles].sort(
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
        (profile.account.id ?? '')
      )
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === 'all' || (filter === 'online' ? profile.online : selected.has(profile.id))),
  );
  const matchedIds = matched.map((profile) => profile.id);
  const matchedState = selectionState(selected, matchedIds);
  const visibleGroups = [
    ...[...groups].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
    { id: 'ungrouped', name: '未分组', color: 'gray', order: -1 },
  ];
  const visibleIds = visibleGroups.flatMap((group) =>
    closed.has(group.id)
      ? []
      : matched
          .filter((profile) => (profile.groupId ?? 'ungrouped') === group.id)
          .map((profile) => profile.id),
  );
  const onlineCount = profiles.filter((profile) => profile.online).length;

  function selectProfile(id: string, checked: boolean, shift: boolean) {
    const start = rangeAnchor.current ? visibleIds.indexOf(rangeAnchor.current) : -1;
    const end = visibleIds.indexOf(id);
    const ids =
      shift && start >= 0 && end >= 0
        ? visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)
        : [id];
    applySelection(toggleSet(selected, ids, checked));
    rangeAnchor.current = id;
  }

  return (
    <div className="sidebar poster-embedded-sidebar" aria-label="发帖浏览器选择列表">
      <div className="sidebar-heading">
        <strong>发帖账号</strong>
        <span className="count-chip" title="已连接 / 全部">
          {onlineCount}/{profiles.length}
        </span>
        <small style={{ marginLeft: 4 }}>
          {accountMode === 'all_online' ? '全部在线号' : `已选 ${selected.size}`}
        </small>
        {onAccountModeChange && (
          <button
            type="button"
            className={
              'btn btn-sm poster-all-online-btn' +
              (accountMode === 'all_online' ? ' btn-primary' : '')
            }
            title="开启后：立即或定时到点时自动调用当时所有在线的浏览器账号"
            onClick={() =>
              onAccountModeChange(accountMode === 'all_online' ? 'selected' : 'all_online')
            }
            style={{ marginLeft: 'auto' }}
          >
            {accountMode === 'all_online' ? '✓ 全部在线账号' : '全部在线账号'}
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm sidebar-select-ids-btn"
          title="按 ID 批量选中浏览器"
          aria-label="按 ID 选中浏览器"
          disabled={profiles.length === 0}
          onClick={() => setSelectByIdsOpen(true)}
          style={onAccountModeChange ? undefined : { marginLeft: 'auto' }}
        >
          按 ID 选中
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
            onChange={(checked) => applySelection(toggleSet(selected, matchedIds, checked))}
          />
          <div className="segmented">
            {(
              [
                ['all', '全部'],
                ['online', '已连接'],
                ['selected', '已选'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={filter === value ? 'active' : ''}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {accountMode === 'all_online' && (
        <div className="poster-all-online-banner">
          当前已选「全部在线账号」：到点将自动调用所有在线号（勾选下方任意账号可切换为指定账号）
        </div>
      )}
      <div className="profile-list">
        {visibleGroups.map((group) => {
          const all = profiles.filter((profile) => (profile.groupId ?? 'ungrouped') === group.id);
          const groupProfiles = matched.filter(
            (profile) => (profile.groupId ?? 'ungrouped') === group.id,
          );
          if (all.length === 0 && group.id !== 'ungrouped') return null;
          const ids = all.map((profile) => profile.id);
          const visibleGroupIds = groupProfiles.map((profile) => profile.id);
          const state = selectionState(selected, visibleGroupIds);
          const isClosed = closed.has(group.id);
          return (
            <section className={'group color-' + group.color} key={group.id}>
              <div className="group-head">
                <GroupCheck
                  {...state}
                  label={'选择整组 ' + group.name}
                  onChange={(checked) =>
                    applySelection(toggleSet(selected, visibleGroupIds, checked))
                  }
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
                <span className="group-count">
                  {ids.filter((id) => selected.has(id)).length}/{ids.length}
                </span>
              </div>
              {!isClosed &&
                groupProfiles.map((profile) => {
                  const displayName = profile.browserName ?? profile.alias;
                  const fbId = profile.account.id;
                  const tone: StatusTone = !profile.online
                    ? 'idle'
                    : ['logged-out', 'restricted', 'verification'].includes(profile.account.state)
                      ? 'err'
                      : profile.unresolved || profile.phase === 'RECOVERING'
                        ? 'warn'
                        : 'ok';
                  return (
                    <div
                      key={profile.id}
                      className={'profile-row' + (selected.has(profile.id) ? ' selected' : '')}
                      onClick={(e) => {
                        if (e.target instanceof Element && e.target.closest('button,input')) return;
                        selectProfile(profile.id, !selected.has(profile.id), e.shiftKey);
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
                        url={profile.account.avatar ?? null}
                        online={profile.online}
                        refreshKey={0}
                        tone={tone}
                        toneLabel={toneNames[tone]}
                      />
                      <button
                        type="button"
                        className="profile-main"
                        onClick={(event) =>
                          selectProfile(profile.id, !selected.has(profile.id), event.shiftKey)
                        }
                      >
                        <span className="profile-line">
                          <strong>{displayName}</strong>
                          <code className="fb-id">{fbId ?? '—'}</code>
                        </span>
                        <span className={'task-line tone-' + tone}>
                          <span className="task-line-text">
                            {profile.online
                              ? profile.account.name || '已连接 · 就绪'
                              : profile.account.name
                                ? `${profile.account.name} · 离线自动启动`
                                : '离线（启动时自动打开）'}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              {!isClosed && groupProfiles.length === 0 && (
                <p className="group-empty">{all.length ? '没有匹配的浏览器' : '暂无浏览器'}</p>
              )}
            </section>
          );
        })}
      </div>
      {selectByIdsOpen && (
        <SelectByIdsDialog
          title="按 ID 批量选中 · 浏览器"
          kind="profiles"
          candidates={buildProfileCandidates(sortedProfiles, [])}
          onClose={() => setSelectByIdsOpen(false)}
          onApply={(matchedIdsFromDialog, applyMode) => {
            applySelection(
              applyMode === 'replace'
                ? new Set(matchedIdsFromDialog)
                : new Set([...selected, ...matchedIdsFromDialog]),
            );
          }}
        />
      )}
    </div>
  );
}
