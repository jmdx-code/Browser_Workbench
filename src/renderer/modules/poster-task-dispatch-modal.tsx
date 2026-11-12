import { useState } from 'react';
import type { Profile, Workspace } from '../../shared/contracts.js';
import type { PosterState, PosterTaskAccountMode } from '../../shared/group-poster.js';

type ProfileGroup = Workspace['groups'][number];
import type { TargetFolder } from '../../shared/target-list.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import {
  FinderTargetList,
  orderedFinderItems,
  type FinderDisabledItemInfo,
} from '../finder-target-list.js';
import { formatCreatedDate, PosterMaterialCardPreview } from './poster-material-cards.js';
import { posterRowBadge } from './poster-material-thumbnail-cell.js';
import { PosterProfileSelector } from './poster-profile-selector.js';

function toLocalDateTimeInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PosterTaskDispatchModal({
  material,
  state,
  folders,
  profiles,
  profileGroups,
  initialSelectedProfileIds,
  initialSelectedGroupIds,
  initialTimingMode,
  busy,
  onClose,
  onOpenAddGroups,
  onDeleteGroups,
  onRefreshGroups,
  onStopRefreshGroups,
  onStateChanged,
  onFoldersChanged,
  onSubmitTask,
}: {
  material: MaterialDraft;
  state: PosterState | null;
  folders: readonly TargetFolder[];
  profiles: readonly Profile[];
  profileGroups?: readonly ProfileGroup[] | undefined;
  initialSelectedProfileIds: readonly string[];
  initialSelectedGroupIds?: readonly string[] | undefined;
  initialTimingMode?: 'immediate' | 'scheduled' | undefined;
  busy: boolean;
  onClose: () => void;
  onOpenAddGroups?: (() => void) | undefined;
  onDeleteGroups?: ((ids: string[]) => Promise<unknown>) | undefined;
  onRefreshGroups?: ((ids?: string[]) => void) | undefined;
  onStopRefreshGroups?: (() => void) | undefined;
  onStateChanged?: (() => Promise<unknown>) | undefined;
  onFoldersChanged?: ((folders: TargetFolder[]) => void) | undefined;
  onSubmitTask: (input: {
    materialId: string;
    groupIds: string[];
    accountMode: PosterTaskAccountMode;
    profileIds: string[];
    scheduledAt: number | null;
  }) => Promise<boolean>;
}) {
  const allGroups = orderedFinderItems(state?.groups ?? [], [...folders]);
  const postedGroupIds = new Set(state?.postedGroupIdsByMaterial?.[material.id] ?? []);
  const activeGroupList = state?.activeGroupsByMaterial?.[material.id] ?? [];
  const activeGroupMap = new Map(activeGroupList.map((item) => [item.groupId, item]));
  const disabledItems = new Map<string, FinderDisabledItemInfo>();
  for (const gid of postedGroupIds) {
    disabledItems.set(gid, {
      badge: '已发过',
      tone: 'muted',
      title: '该贴文已在此小组发过，自动置灰跳过',
    });
  }
  for (const [gid, info] of activeGroupMap.entries()) {
    if (!disabledItems.has(gid)) {
      disabledItems.set(gid, {
        badge: info.state === 'posting' ? '正在发' : '排队中',
        tone: 'run',
        title: '该贴文正在此小组发送或排队中',
      });
    }
  }
  const isGroupDisabled = (gid: string) => disabledItems.has(gid);
  const [chosenGroupIds, setChosenGroupIds] = useState<Set<string>>(() => {
    const prechosen = (initialSelectedGroupIds ?? []).filter((id) => !isGroupDisabled(id));
    if (prechosen.length > 0) return new Set(prechosen);
    return new Set(allGroups.filter((g) => !isGroupDisabled(g.id)).map((g) => g.id));
  });
  const onlineProfiles = profiles.filter((p) => p.online);
  const validInitialIds = initialSelectedProfileIds.filter((id) =>
    profiles.some((p) => p.id === id),
  );
  const [accountMode, setAccountMode] = useState<PosterTaskAccountMode>(() =>
    initialTimingMode === 'scheduled' || validInitialIds.length > 0 || onlineProfiles.length === 0
      ? 'selected'
      : 'all_online',
  );
  const [userTouchedAccountMode, setUserTouchedAccountMode] = useState(false);
  const [chosenProfileIds, setChosenProfileIds] = useState<Set<string>>(
    () =>
      new Set(
        validInitialIds.length > 0
          ? validInitialIds
          : onlineProfiles.length > 0
            ? onlineProfiles.map((p) => p.id)
            : profiles.map((p) => p.id),
      ),
  );
  const [timingMode, setTimingMode] = useState<'immediate' | 'scheduled'>(
    initialTimingMode ?? 'immediate',
  );
  const [scheduledDateTime, setScheduledDateTime] = useState<string>(() =>
    toLocalDateTimeInputValue(Date.now() + 10 * 60_000),
  );
  const [localError, setLocalError] = useState('');

  const effectiveSelectedGroups = allGroups
    .filter((g) => chosenGroupIds.has(g.id) && !isGroupDisabled(g.id))
    .map((g) => g.id);
  const applyQuickScheduleOffset = (minutesFromNow: number) => {
    setScheduledDateTime(toLocalDateTimeInputValue(Date.now() + minutesFromNow * 60_000));
  };
  const applyTomorrowMorning = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setScheduledDateTime(toLocalDateTimeInputValue(d.getTime()));
  };
  const handleConfirm = async () => {
    setLocalError('');
    if (effectiveSelectedGroups.length === 0) {
      setLocalError('请至少选择 1 个未发过的目标小组');
      return;
    }
    if (accountMode === 'selected' && chosenProfileIds.size === 0) {
      setLocalError('请至少勾选 1 个浏览器账号，或切换为“全部在线账号”');
      return;
    }
    let scheduledAt: number | null = null;
    if (timingMode === 'scheduled') {
      const parsedMs = new Date(scheduledDateTime).getTime();
      if (!Number.isFinite(parsedMs) || parsedMs <= Date.now()) {
        setLocalError('请选择未来的定时开始时间');
        return;
      }
      scheduledAt = parsedMs;
    }
    const ok = await onSubmitTask({
      materialId: material.id,
      groupIds: effectiveSelectedGroups,
      accountMode,
      profileIds: accountMode === 'selected' ? [...chosenProfileIds] : [],
      scheduledAt,
    });
    if (ok) onClose();
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="创建贴文发帖任务">
      <div className="modal bumper-modal poster-dispatch-modal poster-dispatch-three-col-modal">
        <div className="poster-dispatch-three-cols">
          <div className="poster-dispatch-col poster-dispatch-finder-col">
            <FinderTargetList
              title="小组列表"
              countLabel="累计发帖"
              listKind="shared_groups"
              items={(state?.groups ?? []).map((i) => ({ ...i, count: i.totalBumpedCount }))}
              selected={chosenGroupIds}
              onSelect={setChosenGroupIds}
              disabled={busy}
              disabledItems={disabledItems}
              onFolders={onFoldersChanged}
              onDelete={async (ids) => {
                if (onDeleteGroups) await onDeleteGroups(ids);
              }}
              onChanged={async () => {
                if (onStateChanged) await onStateChanged();
              }}
              tools={
                onOpenAddGroups ? (
                  <button type="button" className="btn btn-sm" onClick={onOpenAddGroups}>
                    ＋ 添加小组
                  </button>
                ) : undefined
              }
              moreItems={
                onRefreshGroups
                  ? [
                      state?.groupAvatarRefreshing
                        ? {
                            label: '停止刷新头像',
                            disabled: busy,
                            onSelect: () => onStopRefreshGroups?.(),
                          }
                        : {
                            label: busy ? '读取中…' : '刷新头像',
                            disabled: busy || Boolean(state?.running),
                            onSelect: () =>
                              onRefreshGroups(
                                chosenGroupIds.size ? [...chosenGroupIds] : undefined,
                              ),
                          },
                    ]
                  : undefined
              }
            />
          </div>

          <div className="poster-dispatch-col poster-dispatch-accounts-col">
            <PosterProfileSelector
              profiles={profiles}
              groups={profileGroups}
              selected={chosenProfileIds}
              onSelect={setChosenProfileIds}
              accountMode={accountMode}
              onAccountModeChange={(mode) => {
                setUserTouchedAccountMode(true);
                setAccountMode(mode);
              }}
            />
          </div>

          <div className="poster-dispatch-col poster-dispatch-right-col">
            <div className="bumper-modal-heading poster-dispatch-right-head">
              <h2>创建发帖任务</h2>
              <button className="btn" aria-label="关闭弹窗" onClick={onClose}>
                ×
              </button>
            </div>

            <div className="poster-dispatch-right-body">
              <div className="poster-dispatch-post-card">
                <div className="poster-dispatch-post-card-media">
                  <PosterMaterialCardPreview row={material} onPreview={() => {}} />
                </div>
                <div className="poster-dispatch-post-card-info">
                  <div className="poster-dispatch-post-badges">
                    <span className={'poster-cache-badge ' + posterRowBadge(material).cls}>
                      {posterRowBadge(material).text}
                    </span>
                    {material.aiLabel && material.aiLabel !== 'default' && (
                      <span className={'poster-ai-badge is-' + material.aiLabel}>
                        AI声明：{material.aiLabel === 'on' ? '开启' : '关闭'}
                      </span>
                    )}
                    <span className="poster-dispatch-meta-item">
                      {formatCreatedDate(material.createdAt)}
                    </span>
                  </div>
                  <div className="poster-dispatch-post-stats-row">
                    <span>
                      已发小组：<strong>{postedGroupIds.size}</strong> 个（已置灰）
                    </span>
                    {activeGroupList.length > 0 && (
                      <span className="poster-dispatch-meta-item is-active">
                        发送中/排队：<strong>{activeGroupList.length}</strong> 个
                      </span>
                    )}
                    <span>
                      本次已选：<strong>{effectiveSelectedGroups.length}</strong> 个小组
                    </span>
                  </div>
                  <div className="poster-dispatch-post-caption">
                    {material.caption.trim() || '（无文字文案，仅发送图片/视频媒体）'}
                  </div>
                </div>
              </div>

              <div className="poster-dispatch-section">
                <div className="poster-dispatch-section-title">
                  <strong>使用发帖账号</strong>
                  <span>当前在线 {onlineProfiles.length} 个浏览器</span>
                </div>

                <div className="poster-mode-switch" role="group" aria-label="发帖账号选择方式">
                  <button
                    type="button"
                    className={
                      'poster-mode-btn' + (accountMode === 'all_online' ? ' is-active' : '')
                    }
                    onClick={() => {
                      setUserTouchedAccountMode(true);
                      setAccountMode('all_online');
                    }}
                  >
                    🌐 全部在线账号（动态）
                  </button>
                  <button
                    type="button"
                    className={'poster-mode-btn' + (accountMode === 'selected' ? ' is-active' : '')}
                    onClick={() => {
                      setUserTouchedAccountMode(true);
                      setAccountMode('selected');
                    }}
                  >
                    👤 指定勾选账号 ({chosenProfileIds.size})
                  </button>
                </div>

                <div className="poster-mode-hint-box">
                  {accountMode === 'all_online' ? (
                    <p>
                      已开启<strong>「全部在线账号」</strong>：立即或定时到点时，仅调用
                      <strong>当时处于在线状态</strong>
                      的浏览器并发发送（不会自动启动已关闭的浏览器；如需到点自动启动账号，请切换为「指定勾选账号」）。
                    </p>
                  ) : (
                    <p>
                      已选择左侧列表勾选的 <strong>{chosenProfileIds.size}</strong>{' '}
                      个指定浏览器账号发送本条贴文（其中离线状态浏览器将在启动或定时到点时自动唤醒打开）。
                    </p>
                  )}
                </div>
              </div>

              <div className="poster-dispatch-section">
                <div className="poster-dispatch-section-title">
                  <strong>发帖执行时间</strong>
                </div>

                <div className="poster-mode-switch" role="group" aria-label="发帖执行时间方式">
                  <button
                    type="button"
                    className={'poster-mode-btn' + (timingMode === 'immediate' ? ' is-active' : '')}
                    onClick={() => setTimingMode('immediate')}
                  >
                    ⚡ 立即发帖
                  </button>
                  <button
                    type="button"
                    className={'poster-mode-btn' + (timingMode === 'scheduled' ? ' is-active' : '')}
                    onClick={() => {
                      setTimingMode('scheduled');
                      if (!userTouchedAccountMode && accountMode === 'all_online') {
                        setAccountMode('selected');
                      }
                    }}
                  >
                    ⏰ 定时任务（发完为止）
                  </button>
                </div>

                {timingMode === 'scheduled' && (
                  <div className="poster-schedule-box">
                    <label className="poster-schedule-field">
                      <span>预定开始时间：</span>
                      <input
                        type="datetime-local"
                        aria-label="预定开始发帖时间"
                        value={scheduledDateTime}
                        onChange={(e) => setScheduledDateTime(e.target.value)}
                      />
                    </label>
                    <div className="poster-schedule-presets">
                      <span>快捷：</span>
                      {[5, 15, 30, 60].map((mins) => (
                        <button
                          key={mins}
                          type="button"
                          className="btn btn-sm"
                          onClick={() => applyQuickScheduleOffset(mins)}
                        >
                          {mins === 60 ? '1小时后' : `${mins}分钟后`}
                        </button>
                      ))}
                      <button type="button" className="btn btn-sm" onClick={applyTomorrowMorning}>
                        明天 09:00
                      </button>
                    </div>
                    <p className="poster-schedule-note">
                      • 只定开始时间，不定结束时间，启动后一直发完所选小组为止；
                      <br />•
                      指定勾选账号模式下，到点时已勾选的离线浏览器将自动启动连接；若所有可用账号均受限或用完，将自动结束并记录结果。
                    </p>
                  </div>
                )}
              </div>
            </div>

            {localError && (
              <p className="form-error" role="alert">
                {localError}
              </p>
            )}

            <div className="poster-dispatch-right-footer">
              <button
                type="button"
                className="btn btn-primary poster-dispatch-submit-btn"
                disabled={busy || effectiveSelectedGroups.length === 0}
                onClick={() => void handleConfirm()}
              >
                {busy
                  ? '正在提交…'
                  : timingMode === 'scheduled'
                    ? `⏰ 确认创建定时任务（${effectiveSelectedGroups.length} 个小组）`
                    : `🚀 立即开始发帖（${effectiveSelectedGroups.length} 个小组）`}
              </button>
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
