import { useEffect, useState, type ReactNode } from 'react';
import type { BluestacksInstance } from '../../shared/bluestacks.js';
import type { Profile, Workspace } from '../../shared/contracts.js';
import type { PosterState, PosterTaskAccountMode } from '../../shared/group-poster.js';
import type { TargetFolder } from '../../shared/target-list.js';
import type { MaterialDraft } from '../../domain/poster-material-table.js';
import {
  FinderTargetList,
  orderedFinderItems,
  refreshAvatarMenuItem,
  type FinderDisabledItemInfo,
} from '../finder-target-list.js';
import { IconGlobe, IconSmartphone } from '../icons.js';
import { UI_CARD, UI_INPUT_SM, UI_ROW_SM, UI_SELECT_SM, UiSwitch } from '../ui/primitives.js';
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
const pickInitSet = (init: readonly string[] | undefined, all: ReadonlyArray<{ id: string }>) =>
  new Set((init ?? []).filter((id) => all.some((x) => x.id === id)));
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
      <div className={UI_ROW_SM}>
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
export function SharedPosterGroupsList(p: {
  state: PosterState | null;
  selected: Set<string>;
  onSelect: (next: Set<string>) => void;
  busy: boolean;
  disabledItems?: Map<string, FinderDisabledItemInfo> | undefined;
  onFolders: (folders: TargetFolder[]) => void;
  onDelete: (ids: string[]) => Promise<void>;
  onChanged: () => Promise<void>;
  onOpenAddGroups?: (() => void) | undefined;
  onRefreshGroups?: ((ids?: string[]) => void) | undefined;
  onStopRefreshGroups?: (() => void) | undefined;
}) {
  return (
    <FinderTargetList
      title="小组列表"
      countLabel="累计发帖"
      listKind="shared_groups"
      items={(p.state?.groups ?? []).map((i) => ({ ...i, count: i.totalBumpedCount }))}
      selected={p.selected}
      onSelect={p.onSelect}
      disabled={p.busy}
      disabledItems={p.disabledItems}
      onFolders={p.onFolders}
      onDelete={p.onDelete}
      onChanged={p.onChanged}
      tools={p.onOpenAddGroups ? <Btn onClick={p.onOpenAddGroups}>＋ 添加小组</Btn> : undefined}
      moreItems={
        p.onRefreshGroups
          ? [
              refreshAvatarMenuItem({
                refreshing: Boolean(p.state?.groupAvatarRefreshing),
                busy: p.busy,
                disabled: p.busy || Boolean(p.state?.running),
                onStop: () => p.onStopRefreshGroups?.(),
                onStart: () => p.onRefreshGroups?.(p.selected.size ? [...p.selected] : undefined),
              }),
            ]
          : undefined
      }
    />
  );
}
export function PosterTaskDispatchModal(p: {
  materials: readonly MaterialDraft[];
  state: PosterState | null;
  folders: readonly TargetFolder[];
  profiles: readonly Profile[];
  profileGroups?: readonly ProfileGroup[];
  initialSelectedProfileIds: readonly string[];
  initialCarrier?: 'browser' | 'bluestacks';
  initialCloseBrowserOnFinish?: boolean;
  bluestacksInstances?: readonly BluestacksInstance[];
  bluestacksFolders?: readonly FolderItem[];
  initialSelectedBluestacksIds?: readonly string[];
  onSelectProfiles?: (next: Set<string>) => void;
  onSelectBluestacks?: (next: Set<string>) => void;
  busy: boolean;
  blockEscape?: boolean;
  onClose: () => void;
  onOpenAddGroups?: () => void;
  onDeleteGroups?: (ids: string[]) => Promise<unknown>;
  onRefreshGroups?: (ids?: string[]) => void;
  onStopRefreshGroups?: () => void;
  onStateChanged?: () => Promise<unknown>;
  onFoldersChanged?: (folders: TargetFolder[]) => void;
  onSubmitTask: (input: {
    materialIds: string[];
    groupIds: string[];
    accountMode: PosterTaskAccountMode;
    profileIds: string[];
    scheduledAt: number | null;
    closeBrowserOnFinish: boolean;
  }) => Promise<boolean>;
  onSubmitBluestacks?: (input: {
    materialIds: string[];
    groupIds: string[];
    instanceIds: string[];
    maxGroupsPerInstance: number;
    postToTimeline: boolean;
  }) => Promise<boolean>;
}) {
  const { materials, state, profiles, busy, onClose } = p;
  const primaryMaterial = materials[0];
  if (!primaryMaterial) return null;
  const isBatch = materials.length > 1;
  const canUseBs = Boolean(p.onSubmitBluestacks && p.bluestacksInstances);
  const [carrier, setCarrier] = useState<'browser' | 'bluestacks'>(
    canUseBs && p.initialCarrier === 'bluestacks' ? 'bluestacks' : 'browser',
  );
  const allGroups = orderedFinderItems(state?.groups ?? [], [...p.folders]);
  const disabledItems = new Map<string, FinderDisabledItemInfo>();
  const postedIds = new Set(state?.postedGroupIdsByMaterial?.[primaryMaterial.id] ?? []);
  const activeList = state?.activeGroupsByMaterial?.[primaryMaterial.id] ?? [];
  if (isBatch) {
    for (const g of allGroups) {
      if (materials.every((m) => (state?.postedGroupIdsByMaterial?.[m.id] ?? []).includes(g.id)))
        disabledItems.set(g.id, {
          badge: '全部已发',
          tone: 'muted',
          title: '所选全部贴文均已在此小组发过，自动置灰跳过',
        });
    }
  } else {
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
  }
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
  const [closeBrowserOnFinish, setCloseBrowserOnFinish] = useState(
    Boolean(p.initialCloseBrowserOnFinish),
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (
        busy ||
        previewOpen ||
        p.blockEscape ||
        document.querySelector('dialog[open]') ||
        document.querySelector('[data-grid-cell-editing="1"]')
      ) {
        return;
      }
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, previewOpen, p.blockEscape, onClose]);
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
    const materialIds = materials.map((m) => m.id);
    if (carrier === 'bluestacks' && p.onSubmitBluestacks) {
      if (!selectedGroups.length && !bsPostTimeline)
        return setLocalError('请至少选择 1 个未发过的目标小组，或开启「同时发时间线」');
      if (!chosenBsIds.size) return setLocalError('请至少选择 1 台蓝蝶模拟器窗口');
      if (
        await p.onSubmitBluestacks({
          materialIds,
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
        materialIds,
        groupIds: selectedGroups,
        accountMode,
        profileIds: accountMode === 'selected' ? [...chosenProfileIds] : [],
        scheduledAt: null,
        closeBrowserOnFinish,
      })
    )
      onClose();
  };
  return (
    <BackdropModal
      label={isBatch ? '批量创建发帖任务' : '创建贴文发帖任务'}
      modalClass="!gap-0 !p-0 flex h-[min(680px,88vh)] w-[min(1040px,95vw)] flex-col overflow-hidden"
      busy={busy}
      blockEscape
      onClose={() => {
        if (!previewOpen && !p.blockEscape && !document.querySelector('dialog[open]')) onClose();
      }}
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1.15fr_1fr]">
        <div className="flex min-h-0 flex-col border-b border-[var(--line)] p-3 md:border-r md:border-b-0">
          <SharedPosterGroupsList
            state={state}
            selected={chosenGroupIds}
            onSelect={setChosenGroupIds}
            busy={busy}
            disabledItems={disabledItems}
            onFolders={(f) => p.onFoldersChanged?.(f)}
            onDelete={async (ids) => p.onDeleteGroups && void (await p.onDeleteGroups(ids))}
            onChanged={async () => p.onStateChanged && void (await p.onStateChanged())}
            onOpenAddGroups={p.onOpenAddGroups}
            onRefreshGroups={p.onRefreshGroups}
            onStopRefreshGroups={p.onStopRefreshGroups}
          />
        </div>
        <div className="flex min-h-0 flex-col">
          <ModalHeading
            className="poster-dispatch-right-head"
            title={isBatch ? `批量创建发帖任务 (${materials.length} 条素材)` : '创建发帖任务'}
            disabled={busy}
            closeText="×"
            onClose={onClose}
          />
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
            <PosterMaterialSummaryBox
              row={primaryMaterial}
              badge={posterRowBadge(primaryMaterial)}
              onPreview={() => setPreviewOpen(true)}
              extraBadges={
                <>
                  {isBatch && (
                    <span className="inline-flex items-center rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white">
                      共 {materials.length} 条素材批量
                    </span>
                  )}
                  {!isBatch && primaryMaterial.aiLabel && primaryMaterial.aiLabel !== 'default' && (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${primaryMaterial.aiLabel === 'on' ? 'bg-violet-100 text-violet-800' : 'bg-slate-200 text-slate-700'}`}
                    >
                      AI声明：{primaryMaterial.aiLabel === 'on' ? '开启' : '关闭'}
                    </span>
                  )}
                </>
              }
              metaRow={
                <div className="flex flex-wrap gap-2 text-[11px] text-slate-700">
                  {!isBatch && (
                    <span>
                      已发小组：<strong>{postedIds.size}</strong> 个（已置灰）
                    </span>
                  )}
                  {!isBatch && activeList.length > 0 && (
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
            {isBatch && (
              <div className="flex flex-wrap gap-1 rounded-lg border border-[var(--line)] bg-slate-50 p-2 text-[11px] text-slate-700">
                {materials.map((m, idx) => (
                  <span
                    key={m.id}
                    className="max-w-[180px] truncate rounded-md border border-slate-200 bg-white px-2 py-0.5"
                    title={m.caption || m.mediaSource}
                  >
                    #{idx + 1} {m.caption.trim() || '（媒体贴文）'}
                  </span>
                ))}
              </div>
            )}
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
                <div
                  className={`rounded-lg px-2.5 py-2 text-xs ${
                    accountMode === 'selected' && chosenProfileIds.size === 0
                      ? 'border border-amber-200 bg-amber-50 text-amber-800'
                      : 'bg-slate-50 text-slate-600'
                  }`}
                >
                  {accountMode === 'all_online' ? (
                    <p className="m-0">
                      已开启<strong>「全部在线账号」</strong>
                      ：仅调用当时在线的浏览器并发发送；若要指定分组或自动唤醒离线号，请切换为「指定账号」。
                    </p>
                  ) : chosenProfileIds.size === 0 ? (
                    <p className="m-0">
                      当前未勾选指定浏览器 (0)，请先在左侧勾选浏览器，或切换为「全部在线账号」
                    </p>
                  ) : (
                    <p className="m-0">
                      已同步当前选中的 <strong>{chosenProfileIds.size}</strong>{' '}
                      个指定浏览器（离线号将在启动时自动唤醒打开）。
                    </p>
                  )}
                </div>
                <div className="pt-0.5">
                  <UiSwitch
                    ariaLabel="发帖任务完毕关窗"
                    label="完后关窗（无队列剩余任务时关闭浏览器）"
                    checked={closeBrowserOnFinish}
                    disabled={busy}
                    onCheckedChange={setCloseBrowserOnFinish}
                  />
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
                {chosenBsIds.size === 0 && (
                  <p className="m-0 mt-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                    当前未勾选蓝蝶实例 (0)，请先在左侧或上方选择蓝蝶窗口。
                  </p>
                )}
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
                (carrier === 'browser' &&
                  (!selectedGroups.length ||
                    (accountMode === 'selected' && !chosenProfileIds.size))) ||
                (carrier === 'bluestacks' &&
                  (!chosenBsIds.size || (!selectedGroups.length && !bsPostTimeline)))
              }
              onClick={() => void handleConfirm()}
            >
              {busy
                ? '正在提交…'
                : `立即开始${carrier === 'bluestacks' ? '蓝蝶' : ''}${isBatch ? `批量` : ''}发帖（${isBatch ? `${materials.length} 条 × ` : ''}${selectedGroups.length} 个小组）`}
            </Btn>
            <Btn sm={false} disabled={busy} onClick={onClose}>
              取消
            </Btn>
          </footer>
        </div>
      </div>
      {previewOpen && (
        <PosterMediaPreviewModal row={primaryMaterial} onClose={() => setPreviewOpen(false)} />
      )}
    </BackdropModal>
  );
}
