import { useState, type ReactNode } from 'react';
import type { BluestacksInstance } from '../../shared/bluestacks.js';
import type { Profile, Workspace } from '../../shared/contracts.js';
import type { PosterState, PosterTaskAccountMode } from '../../shared/group-poster.js';
import type { TargetFolder } from '../../shared/target-list.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import {
  FinderTargetList,
  orderedFinderItems,
  type FinderDisabledItemInfo,
} from '../finder-target-list.js';
import { IconGlobe, IconSmartphone } from '../icons.js';
import { UI_CARD, UI_INPUT_SM, UI_SELECT_SM, UiSwitch } from '../ui/primitives.js';
import {
  PosterMaterialSummaryBox,
  PosterMediaPreviewModal,
  posterRowBadge,
} from './poster-material-modals.js';
import { BackdropModal, Btn, ModalHeading } from './shared/module-ui.js';

type ProfileGroup = Workspace['groups'][number];
type FolderItem = { id: string; name: string };

const modeBtnCls = (active: boolean) =>
  `flex-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium inline-flex items-center justify-center gap-1.5 ${active ? 'border-slate-900 bg-slate-900 text-white' : 'border-[var(--line)] bg-white text-slate-700 hover:bg-slate-50'}`;
const pickInitSet = (
  init: readonly string[] | undefined,
  all: ReadonlyArray<{ id: string; online: boolean }>,
) => {
  const valid = (init ?? []).filter((id) => all.some((x) => x.id === id));
  const online = all.filter((x) => x.online);
  return new Set(valid.length ? valid : (online.length ? online : all).map((x) => x.id));
};

function TargetSelectCard(p: {
  title: string;
  rightText: string;
  onlineCount: number;
  groups: ReadonlyArray<{ id: string; name: string }>;
  selectAriaLabel: string;
  onSelectAllOnline: () => void;
  onSelectGroup: (groupId: string) => void;
  children: ReactNode;
}) {
  return (
    <div className={`${UI_CARD} flex flex-col gap-2 p-3`}>
      <div className="flex items-center justify-between text-xs">
        <strong className="font-semibold text-slate-900">{p.title}</strong>
        <span className="text-[var(--text-3)]">{p.rightText}</span>
      </div>
      {p.children}
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn disabled={p.onlineCount === 0} onClick={p.onSelectAllOnline}>
          全选在线 ({p.onlineCount})
        </Btn>
        {p.groups.length > 0 && (
          <select
            className={UI_SELECT_SM}
            aria-label={p.selectAriaLabel}
            value=""
            onChange={(e) => e.target.value && p.onSelectGroup(e.target.value)}
          >
            <option value="">按分组快选…</option>
            {p.groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

export function PosterTaskDispatchModal(p: {
  material: MaterialDraft;
  state: PosterState | null;
  folders: readonly TargetFolder[];
  profiles: readonly Profile[];
  profileGroups?: readonly ProfileGroup[];
  initialSelectedProfileIds: readonly string[];
  initialCarrier?: 'browser' | 'bluestacks';
  bluestacksInstances?: readonly BluestacksInstance[];
  bluestacksFolders?: readonly FolderItem[];
  initialSelectedBluestacksIds?: readonly string[];
  onSelectProfiles?: (next: Set<string>) => void;
  onSelectBluestacks?: (next: Set<string>) => void;
  busy: boolean;
  onClose: () => void;
  onOpenAddGroups?: () => void;
  onDeleteGroups?: (ids: string[]) => Promise<unknown>;
  onRefreshGroups?: (ids?: string[]) => void;
  onStopRefreshGroups?: () => void;
  onStateChanged?: () => Promise<unknown>;
  onFoldersChanged?: (folders: TargetFolder[]) => void;
  onSubmitTask: (input: {
    materialId: string;
    groupIds: string[];
    accountMode: PosterTaskAccountMode;
    profileIds: string[];
    scheduledAt: number | null;
  }) => Promise<boolean>;
  onSubmitBluestacks?: (input: {
    materialId: string;
    groupIds: string[];
    instanceIds: string[];
    maxGroupsPerInstance: number;
    postToTimeline: boolean;
  }) => Promise<boolean>;
}) {
  const { material, state, profiles, busy, onClose } = p;
  const canUseBs = Boolean(p.onSubmitBluestacks && p.bluestacksInstances);
  const [carrier, setCarrier] = useState<'browser' | 'bluestacks'>(
    canUseBs && p.initialCarrier === 'bluestacks' ? 'bluestacks' : 'browser',
  );
  const allGroups = orderedFinderItems(state?.groups ?? [], [...p.folders]);
  const postedIds = new Set(state?.postedGroupIdsByMaterial?.[material.id] ?? []);
  const activeList = state?.activeGroupsByMaterial?.[material.id] ?? [];
  const disabledItems = new Map<string, FinderDisabledItemInfo>();
  for (const gid of postedIds)
    disabledItems.set(gid, {
      badge: '已发过',
      tone: 'muted',
      title: '该贴文已在此小组发过，自动置灰跳过',
    });
  for (const info of activeList)
    if (!disabledItems.has(info.groupId))
      disabledItems.set(info.groupId, {
        badge: info.state === 'posting' ? '正在发' : '排队中',
        tone: 'run',
        title: '该贴文正在此小组发送或排队中',
      });

  const [chosenGroupIds, setChosenGroupIds] = useState<Set<string>>(
    () => new Set(allGroups.filter((g) => !disabledItems.has(g.id)).map((g) => g.id)),
  );
  const onlineProfiles = profiles.filter((pr) => pr.online);
  const hasValidInit = p.initialSelectedProfileIds.some((id) =>
    profiles.some((pr) => pr.id === id),
  );
  const [accountMode, setAccountMode] = useState<PosterTaskAccountMode>(() =>
    hasValidInit || !onlineProfiles.length ? 'selected' : 'all_online',
  );
  const [chosenProfileIds, setChosenProfileIds] = useState<Set<string>>(() =>
    pickInitSet(p.initialSelectedProfileIds, profiles),
  );
  const bsList = p.bluestacksInstances ?? [];
  const onlineBs = bsList.filter((i) => i.online);
  const [chosenBsIds, setChosenBsIds] = useState<Set<string>>(() =>
    pickInitSet(p.initialSelectedBluestacksIds, bsList),
  );
  const [bsMaxGroups, setBsMaxGroups] = useState(3);
  const [bsPostTimeline, setBsPostTimeline] = useState(false);
  const [localError, setLocalError] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);

  const selectedGroups = allGroups
    .filter((g) => chosenGroupIds.has(g.id) && !disabledItems.has(g.id))
    .map((g) => g.id);
  const updateBrowserSel = (next: Set<string>) => {
    setChosenProfileIds(next);
    setAccountMode('selected');
    p.onSelectProfiles?.(next);
  };
  const updateBsSel = (next: Set<string>) => {
    setChosenBsIds(next);
    p.onSelectBluestacks?.(next);
  };

  const handleConfirm = async () => {
    setLocalError('');
    if (carrier === 'bluestacks' && p.onSubmitBluestacks) {
      if (!selectedGroups.length && !bsPostTimeline)
        return setLocalError('请至少选择 1 个未发过的目标小组，或开启「同时发时间线」');
      if (!chosenBsIds.size) return setLocalError('请至少选择 1 台蓝蝶模拟器窗口');
      if (
        await p.onSubmitBluestacks({
          materialId: material.id,
          groupIds: selectedGroups,
          instanceIds: [...chosenBsIds],
          maxGroupsPerInstance: Math.max(1, Math.min(50, bsMaxGroups)),
          postToTimeline: bsPostTimeline,
        })
      )
        onClose();
      return;
    }
    if (!selectedGroups.length) return setLocalError('请至少选择 1 个未发过的目标小组');
    if (accountMode === 'selected' && !chosenProfileIds.size)
      return setLocalError('请至少选择 1 个浏览器账号，或切换为“全部在线账号”');
    if (
      await p.onSubmitTask({
        materialId: material.id,
        groupIds: selectedGroups,
        accountMode,
        profileIds: accountMode === 'selected' ? [...chosenProfileIds] : [],
        scheduledAt: null,
      })
    )
      onClose();
  };

  return (
    <BackdropModal
      label="创建贴文发帖任务"
      modalClass="!gap-0 !p-0 flex h-[min(680px,88vh)] w-[min(1040px,95vw)] flex-col overflow-hidden"
      busy={busy}
      blockEscape={previewOpen}
      onClose={onClose}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1.15fr_1fr]">
        <div className="flex min-h-0 flex-col border-b border-[var(--line)] p-3 md:border-r md:border-b-0">
          <FinderTargetList
            title="小组列表"
            countLabel="累计发帖"
            listKind="shared_groups"
            items={(state?.groups ?? []).map((i) => ({ ...i, count: i.totalBumpedCount }))}
            selected={chosenGroupIds}
            onSelect={setChosenGroupIds}
            disabled={busy}
            disabledItems={disabledItems}
            onFolders={p.onFoldersChanged}
            onDelete={async (ids) => p.onDeleteGroups && void (await p.onDeleteGroups(ids))}
            onChanged={async () => p.onStateChanged && void (await p.onStateChanged())}
            tools={
              p.onOpenAddGroups ? <Btn onClick={p.onOpenAddGroups}>＋ 添加小组</Btn> : undefined
            }
            moreItems={
              p.onRefreshGroups
                ? [
                    state?.groupAvatarRefreshing
                      ? {
                          label: '停止刷新头像',
                          disabled: busy,
                          onSelect: () => p.onStopRefreshGroups?.(),
                        }
                      : {
                          label: busy ? '读取中…' : '刷新头像',
                          disabled: busy || Boolean(state?.running),
                          onSelect: () =>
                            p.onRefreshGroups?.(
                              chosenGroupIds.size ? [...chosenGroupIds] : undefined,
                            ),
                        },
                  ]
                : undefined
            }
          />
        </div>
        <div className="flex min-h-0 flex-col">
          <ModalHeading
            className="poster-dispatch-right-head"
            title="创建发帖任务"
            disabled={busy}
            closeText="×"
            onClose={onClose}
          />
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <PosterMaterialSummaryBox
              row={material}
              badge={posterRowBadge(material)}
              onPreview={() => setPreviewOpen(true)}
              extraBadges={
                material.aiLabel && material.aiLabel !== 'default' ? (
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${material.aiLabel === 'on' ? 'bg-violet-100 text-violet-800' : 'bg-slate-200 text-slate-700'}`}
                  >
                    AI声明：{material.aiLabel === 'on' ? '开启' : '关闭'}
                  </span>
                ) : undefined
              }
              metaRow={
                <div className="flex flex-wrap gap-2 text-[11px] text-slate-700">
                  <span>
                    已发小组：<strong>{postedIds.size}</strong> 个（已置灰）
                  </span>
                  {activeList.length > 0 && (
                    <span className="text-blue-700">
                      发送中/排队：<strong>{activeList.length}</strong> 个
                    </span>
                  )}
                  <span>
                    本次已选：<strong>{selectedGroups.length}</strong> 个小组
                  </span>
                </div>
              }
            />
            {canUseBs && (
              <div className={`${UI_CARD} flex flex-col gap-2 p-3`}>
                <div className="flex items-center justify-between text-xs">
                  <strong className="font-semibold text-slate-900">发布载体</strong>
                  <span className="text-[var(--text-3)]">可按本次需求切至浏览器或蓝蝶执行</span>
                </div>
                <div className="flex gap-2" role="tablist" aria-label="选择发帖载体">
                  {(
                    [
                      [
                        'browser',
                        <IconGlobe key="g" size={13} />,
                        `Chrome 浏览器 (${onlineProfiles.length}/${profiles.length})`,
                      ],
                      [
                        'bluestacks',
                        <IconSmartphone key="s" size={13} />,
                        `蓝蝶模拟器 (${onlineBs.length}/${bsList.length})`,
                      ],
                    ] as const
                  ).map(([id, icon, text]) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={carrier === id}
                      className={modeBtnCls(carrier === id)}
                      onClick={() => setCarrier(id)}
                    >
                      {icon} {text}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {carrier === 'browser' ? (
              <TargetSelectCard
                title="使用发帖账号"
                rightText={`当前在线 ${onlineProfiles.length} 个浏览器`}
                onlineCount={onlineProfiles.length}
                groups={p.profileGroups ?? []}
                selectAriaLabel="按分组快选发帖浏览器"
                onSelectAllOnline={() => updateBrowserSel(new Set(onlineProfiles.map((x) => x.id)))}
                onSelectGroup={(gid) =>
                  updateBrowserSel(
                    new Set(profiles.filter((x) => x.groupId === gid).map((x) => x.id)),
                  )
                }
              >
                <div className="flex gap-2" role="group" aria-label="发帖账号选择方式">
                  {(
                    [
                      ['all_online', '全部在线账号（动态）'],
                      ['selected', `指定账号 (${chosenProfileIds.size})`],
                    ] as const
                  ).map(([m, text]) => (
                    <button
                      key={m}
                      type="button"
                      className={modeBtnCls(accountMode === m)}
                      onClick={() => setAccountMode(m)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <div className="rounded-lg bg-slate-50 px-2.5 py-2 text-xs text-slate-600">
                  {accountMode === 'all_online' ? (
                    <p className="m-0">
                      已开启<strong>「全部在线账号」</strong>
                      ：仅调用当时在线的浏览器并发发送；若要指定分组或自动唤醒离线号，请切换为「指定账号」。
                    </p>
                  ) : (
                    <p className="m-0">
                      已同步当前选中的 <strong>{chosenProfileIds.size}</strong>{' '}
                      个指定浏览器（离线号将在启动时自动唤醒打开）。
                    </p>
                  )}
                </div>
              </TargetSelectCard>
            ) : (
              <TargetSelectCard
                title="使用蓝蝶模拟器"
                rightText={`已选 ${chosenBsIds.size} 台（在线 ${onlineBs.length} 台）`}
                onlineCount={onlineBs.length}
                groups={p.bluestacksFolders ?? []}
                selectAriaLabel="按分组快选蓝蝶窗口"
                onSelectAllOnline={() => updateBsSel(new Set(onlineBs.map((i) => i.id)))}
                onSelectGroup={(fid) =>
                  updateBsSel(new Set(bsList.filter((i) => i.folderId === fid).map((i) => i.id)))
                }
              >
                <div className="mt-1 flex flex-wrap items-center gap-4 text-xs text-slate-700">
                  <label className="inline-flex items-center gap-1.5">
                    <span>单台最多发</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={bsMaxGroups}
                      onChange={(e) =>
                        setBsMaxGroups(Math.max(1, Math.min(50, Number(e.target.value) || 3)))
                      }
                      className={`${UI_INPUT_SM} w-14 text-center tabular-nums`}
                    />
                    <span>组</span>
                  </label>
                  <UiSwitch
                    ariaLabel="弹窗同时发时间线"
                    label="同时发时间线"
                    checked={bsPostTimeline}
                    onCheckedChange={setBsPostTimeline}
                  />
                </div>
              </TargetSelectCard>
            )}
            {localError && (
              <p className="m-0 text-xs font-medium text-rose-600" role="alert">
                {localError}
              </p>
            )}
          </div>
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--line)] bg-slate-50 px-4 py-3">
            <Btn
              v="primary"
              sm={false}
              disabled={
                busy ||
                (carrier === 'browser' && !selectedGroups.length) ||
                (carrier === 'bluestacks' && !selectedGroups.length && !bsPostTimeline)
              }
              onClick={() => void handleConfirm()}
            >
              {busy
                ? '正在提交…'
                : `立即开始${carrier === 'bluestacks' ? '蓝蝶' : ''}发帖（${selectedGroups.length} 个小组）`}
            </Btn>
            <Btn sm={false} disabled={busy} onClick={onClose}>
              取消
            </Btn>
          </footer>
        </div>
      </div>
      {previewOpen && (
        <PosterMediaPreviewModal row={material} onClose={() => setPreviewOpen(false)} />
      )}
    </BackdropModal>
  );
}
