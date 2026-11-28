import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import type { BluestacksState } from '../shared/bluestacks.js';
import { profileDisplayName, type Profile, type Workspace } from '../shared/contracts.js';
import {
  PosterSettings,
  type PendingOperationResolution,
  type PosterState,
  type PosterTaskAccountMode,
} from '../shared/group-poster.js';
import type { TargetFolder } from '../shared/target-list.js';
import { api } from './api.js';
import { orderedFinderItems } from './finder-target-list.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import { IconAlertTriangle, IconClock, IconPlay, IconStop } from './icons.js';
import {
  PendingReviewModal,
  PosterMaterialCardGrid,
  PosterMaterialDetailModal,
  PosterMaterialEditModal,
  PosterTaskDispatchModal,
  SharedPosterGroupsList,
} from './modules/poster-material-cards.js';
import {
  buildBsPosterScheduleSeed,
  buildGroupAddItems,
  buildMaterialScheduleSeed,
  emptyDraftRows,
} from './modules/poster-material-modals.js';
import { usePosterMaterials } from './modules/poster-material-hooks.js';
import {
  ControlledNumberInput,
  type ControlledNumberInputHandle,
} from './modules/shared/controlled-number-input.js';
import {
  BackdropModal,
  Btn,
  errMsg,
  ErrText,
  ModalHeading,
  readStoredFlag,
  RunStatusPill,
  writeStoredFlag,
} from './modules/shared/module-ui.js';
import { CarrierScopeBar } from './modules/shared/target-scope-bar.js';
import {
  createEmptyMaterialDraft,
  PosterMaterialMatrix,
  type MaterialDraft,
} from './poster-material-matrix.js';
import { TargetAddModal } from './target-add-modal.js';
import { UI_INPUT_SM, UI_ROW, UiSwitch } from './ui/primitives.js';
type ProfileGroup = Workspace['groups'][number];
const BS_POSTER_CLOSE_STORAGE_KEY = 'wb.bluestacksPoster.closeWindowOnFinish';
export function GroupPosterPage(p: {
  state: PosterState | null;
  selected: Set<string>;
  profiles?: readonly Profile[] | undefined;
  logProfiles?: readonly Profile[] | undefined;
  profileGroups?: readonly ProfileGroup[] | undefined;
  carrier?: 'browser' | 'bluestacks' | undefined;
  bluestacksState?: BluestacksState | null | undefined;
  onBluestacksState?: ((next: BluestacksState) => void) | undefined;
  selectedBluestacks?: ReadonlySet<string> | undefined;
  onSelectProfiles?: ((next: Set<string>) => void) | undefined;
  onSelectBluestacks?: ((next: Set<string>) => void) | undefined;
  onState: (next: PosterState) => void;
  onQuickSchedule?: ((seed: QuickScheduleSeed) => void) | undefined;
  onOpenRecords?: (() => void) | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
  onMessage: (text: string) => void;
}) {
  const {
    state,
    selected,
    profiles,
    profileGroups,
    carrier = 'browser',
    bluestacksState,
    onBluestacksState,
    selectedBluestacks,
    onSelectProfiles,
    onSelectBluestacks,
    onState,
    onQuickSchedule,
    onOpenRecords,
    onOpenLiveRuns,
    onMessage,
  } = p;
  const isBluestacks = carrier === 'bluestacks';
  const displayLogProfiles = p.logProfiles ?? profiles ?? [];
  const [activeTab, setActiveTab] = useState<'materials' | 'groups'>('materials');
  const [settings, setSettings] = useState<PosterSettings | null>(state?.settings ?? null);
  const [folders, setFolders] = useState<TargetFolder[]>([]);
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [modal, setModal] = useState<'groups' | 'materials' | null>(null);
  const [groupRows, setGroupRows] = useState<DraftGroupEntry[]>(() => emptyDraftRows(8));
  const [chosenGroupIds, setChosenGroupIds] = useState<Set<string>>(new Set());
  const [selectedCardIds, setSelectedCardIds] = useState<Set<string>>(new Set());
  const [bsMaxGroups, setBsMaxGroups] = useState(3);
  const [bsPostTimeline, setBsPostTimeline] = useState(false);
  const [bsCloseWindow, setBsCloseWindow] = useState(() =>
    readStoredFlag(BS_POSTER_CLOSE_STORAGE_KEY),
  );
  const updateBsCloseWindow = (next: boolean) => {
    setBsCloseWindow(next);
    writeStoredFlag(BS_POSTER_CLOSE_STORAGE_KEY, next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dispatchMaterialIds, setDispatchMaterialIds] = useState<string[]>([]);
  const [detailMaterialId, setDetailMaterialId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<{ row: MaterialDraft; isNew: boolean } | null>(null);
  const [pendingReviewOpen, setPendingReviewOpen] = useState(false);
  const maxPostsRef = useRef<ControlledNumberInputHandle>(null);
  const bsMaxGroupsRef = useRef<ControlledNumberInputHandle>(null);
  const settingsRef = useRef<PosterSettings | null>(state?.settings ?? null);
  const reportErr = (e: unknown) => {
    const msg = errMsg(e, String(e));
    setError(msg);
    onMessage(msg);
  };
  async function runWithBusy<T>(fn: () => Promise<T>, fb: T): Promise<T> {
    setBusy(true);
    setError('');
    try {
      return await fn();
    } catch (e) {
      reportErr(e);
      return fb;
    } finally {
      setBusy(false);
    }
  }
  const action = (route: string, body: unknown = {}) =>
    runWithBusy(async () => {
      const next = await api.posterAction(route, body);
      onState(next);
      return next;
    }, null);
  const runBsAction = (route: string, body: unknown, okMsg: string) =>
    runWithBusy(async () => {
      onBluestacksState?.(await api.bluestacksAction(route, body));
      onMessage(okMsg);
      return true;
    }, false);
  const mat = usePosterMaterials({
    state,
    selectedCardIds,
    busy,
    action,
    onError: setError,
    onState,
    onMessage,
  });
  useEffect(() => {
    void api
      .targetFolders('shared_groups')
      .then(setFolders)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (state?.settings) {
      settingsRef.current = state.settings;
      setSettings(state.settings);
    }
  }, [state?.settings]);
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key !== 'Escape' ||
        busy ||
        pendingReviewOpen ||
        (modal === 'materials' && mat.matrixRef.current?.isEditing()) ||
        document.querySelector('[data-grid-cell-editing="1"]') ||
        document.querySelector('dialog[open]')
      )
        return;
      e.stopPropagation();
      setModal(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, busy, pendingReviewOpen, mat.matrixRef]);
  const isRunning = isBluestacks
    ? Boolean(bluestacksState?.posterRunning)
    : Boolean(state?.running);
  const selectedProfiles = [...selected].sort();
  const selectedBsSet = selectedBluestacks ?? new Set<string>();
  const pendingOps = state?.pendingReviewOperations ?? [];
  const pendingItems = useMemo(
    () =>
      pendingOps.map((op) => {
        const prof = displayLogProfiles.find((pr) => pr.id === op.profileId);
        const acct = prof
          ? profileDisplayName(prof, prof.account.name || op.accountId || op.profileId)
          : op.accountId || op.profileId;
        const matchedMat = op.materialId ? mat.drafts.find((d) => d.id === op.materialId) : null;
        const matPreview = matchedMat?.caption.trim().slice(0, 24);
        return {
          id: op.id,
          targetLabel: `${op.groupName || op.groupId} (${op.groupId})${matPreview ? ` · ${matPreview}` : ''}`,
          accountLabel: acct,
          updatedAt: op.updatedAt,
          reviewReason: op.reason ?? '',
        };
      }),
    [pendingOps, displayLogProfiles, mat.drafts],
  );
  const orderedSelectedGroupIds = useMemo(
    () =>
      orderedFinderItems(state?.groups ?? [], folders)
        .filter((g) => chosenGroupIds.has(g.id))
        .map((g) => g.id),
    [state?.groups, folders, chosenGroupIds],
  );
  const resolvedGroups = () =>
    orderedSelectedGroupIds.length
      ? orderedSelectedGroupIds
      : orderedFinderItems(state?.groups ?? [], folders).map((g) => g.id);
  async function handleBluestacksBatchStart() {
    if (!selectedBsSet.size) return onMessage('请先选择至少 1 台蓝蝶模拟器窗口');
    if (!mat.activeBatchMaterialIds.length) return onMessage('请先添加或勾选贴文素材');
    const targetGroups = resolvedGroups();
    if (!targetGroups.length && !bsPostTimeline)
      return onMessage('请先在「目标小组库」添加并勾选小组，或开启「同时发时间线」');
    if (mat.dirtyMaterials && !(await mat.persistMaterials(mat.drafts))) return;
    const maxGroups = (await bsMaxGroupsRef.current?.flush()) ?? bsMaxGroups;
    await runBsAction(
      'poster/start',
      {
        instanceIds: [...selectedBsSet],
        materialIds: mat.activeBatchMaterialIds,
        groupIds: targetGroups,
        maxGroupsPerInstance: Math.max(1, Math.min(50, maxGroups)),
        postToTimeline: bsPostTimeline,
        ...(bsCloseWindow ? { closeWindowOnFinish: true } : {}),
      },
      `已启动蓝蝶小组发帖（${selectedBsSet.size} 台蓝蝶 · ${mat.activeBatchMaterialIds.length} 条素材）`,
    );
  }
  function updateSettingField<K extends keyof PosterSettings>(key: K, rawValue: PosterSettings[K]) {
    const base = settingsRef.current ?? settings;
    if (!base) return;
    const parsed = PosterSettings.safeParse({ ...base, [key]: rawValue });
    const next = parsed.success ? parsed.data : base;
    settingsRef.current = next;
    setSettings(next);
    return action('settings', next);
  }
  const closeMaterialsModal = () => {
    if (modal === 'materials') mat.commitMatrixPending();
    setModal(null);
  };
  const handleOpenAddGroups = () => {
    setGroupRows(emptyDraftRows(8));
    setError('');
    setModal('groups');
  };
  const handleDeleteGroups = async (ids: string[]) => {
    if (!(await action('groups/delete', { ids }))) throw Error('删除未完成');
  };
  const submitBsDispatch = async (input: {
    instanceIds: string[];
    materialIds: string[];
    groupIds: string[];
    maxGroupsPerInstance: number;
    postToTimeline: boolean;
  }) =>
    (await mat.ensureMaterialsPersisted(input.materialIds)) &&
    runBsAction(
      'poster/start',
      { ...input, ...(bsCloseWindow ? { closeWindowOnFinish: true } : {}) },
      `已启动蓝蝶发帖任务（${input.instanceIds.length} 台蓝蝶 · ${input.materialIds.length} 条素材）`,
    );
  const submitTaskDispatch = async (input: {
    materialIds: string[];
    groupIds: string[];
    accountMode: PosterTaskAccountMode;
    profileIds: string[];
    scheduledAt: number | null;
    closeBrowserOnFinish: boolean;
  }) => {
    if (settingsRef.current) {
      const next = {
        ...settingsRef.current,
        maxPostsPerAccount:
          (await maxPostsRef.current?.flush()) ?? settingsRef.current.maxPostsPerAccount,
        closeBrowserOnFinish: input.closeBrowserOnFinish,
      };
      if (JSON.stringify(next) !== JSON.stringify(state?.settings)) {
        settingsRef.current = next;
        setSettings(next);
        await action('settings', next);
      }
    }
    if (!(await mat.ensureMaterialsPersisted(input.materialIds))) return false;
    return runWithBusy(async () => {
      let latestState: PosterState | null = null;
      let createdCount = 0;
      for (const materialId of input.materialIds) {
        const postedSet = new Set(state?.postedGroupIdsByMaterial?.[materialId] ?? []);
        const eligibleGroups = input.groupIds.filter((gid) => !postedSet.has(gid));
        const targetGroups = eligibleGroups.length ? eligibleGroups : input.groupIds;
        latestState = await api.posterAction('tasks/create', {
          materialId,
          groupIds: targetGroups,
          accountMode: input.accountMode,
          profileIds: input.profileIds,
          scheduledAt: input.scheduledAt,
          closeBrowserOnFinish: input.closeBrowserOnFinish,
        });
        createdCount += 1;
      }
      if (latestState) onState(latestState);
      if (createdCount > 0) {
        onMessage(
          input.scheduledAt
            ? `已创建 ${createdCount} 个定时发帖任务（将于 ${new Date(input.scheduledAt).toLocaleString()} 自动启动，发完为止）`
            : createdCount > 1
              ? `已创建并启动 ${createdCount} 个贴文发帖任务`
              : '已创建并启动贴文发帖任务',
        );
      }
      return createdCount > 0;
    }, false);
  };
  const resolvePendingOp = async (operationId: string, resolution: PendingOperationResolution) => {
    const next = await action('pending-operations/resolve', { operationId, resolution });
    if (next) {
      onMessage(
        resolution === 'not_applied'
          ? `已解锁待核对操作 ${operationId}，可重新发帖`
          : `已确认操作 ${operationId} 发布成功`,
      );
      if (!(next.pendingReviewOperations ?? []).length) setPendingReviewOpen(false);
    }
  };
  const cancelTask = async (id: string) => void (await action('tasks/cancel', { id }));
  const deleteTask = async (id: string) => void (await action('tasks/delete', { id }));
  const statusText = isBluestacks ? bluestacksState?.posterStatusText : state?.statusText;
  const dispatchRows = dispatchMaterialIds
    .map((id) => mat.drafts.find((d) => d.id === id))
    .filter((d): d is MaterialDraft => Boolean(d));
  const detailRow = detailMaterialId ? mat.drafts.find((d) => d.id === detailMaterialId) : null;
  return (
    <section className="poster-page flex min-h-0 flex-1 flex-col gap-3">
      {(profiles || isBluestacks) && (
        <CarrierScopeBar
          isBs={isBluestacks}
          bluestacksState={bluestacksState}
          profiles={profiles}
          profileGroups={profileGroups}
          selected={isBluestacks ? selectedBsSet : selected}
          onSelect={isBluestacks ? onSelectBluestacks : onSelectProfiles}
        />
      )}
      <div className="bumper-sticky-header sticky top-0 z-20 rounded-xl border border-[var(--line)] bg-white/95 px-4 py-2.5 shadow-xs backdrop-blur-xs">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <div
              className="inline-flex rounded-lg border border-[var(--line)] bg-slate-100 p-0.5"
              role="tablist"
            >
              {(
                [
                  ['materials', `贴文素材库 (${mat.validMaterialIds.length})`],
                  ['groups', `目标小组库 (${state?.groups.length ?? 0})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === key}
                  onClick={() => setActiveTab(key)}
                  className={
                    activeTab === key
                      ? 'rounded-md bg-white px-2.5 py-1 text-xs font-semibold text-slate-900 shadow-xs'
                      : 'rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900'
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            {isBluestacks ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--line)] bg-slate-50/80 px-2.5 py-1">
                <label className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]">
                  <span>单台最多发</span>
                  <ControlledNumberInput
                    ref={bsMaxGroupsRef}
                    ariaLabel="单台蓝蝶最多发帖小组数"
                    className={`${UI_INPUT_SM} w-14 text-center tabular-nums`}
                    min={1}
                    max={50}
                    defaultValue={3}
                    disabled={busy || isRunning}
                    value={bsMaxGroups}
                    onCommit={setBsMaxGroups}
                  />
                  <span>组</span>
                </label>
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]">
                  <UiSwitch
                    ariaLabel="同时发时间线"
                    label="同时发时间线"
                    checked={bsPostTimeline}
                    disabled={busy || isRunning}
                    onCheckedChange={setBsPostTimeline}
                  />
                </span>
                <span
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]"
                  title="每台蓝蝶完成本轮发帖后自动关闭模拟器窗口释放内存"
                >
                  <UiSwitch
                    ariaLabel="蓝蝶发帖完毕关窗"
                    label="完后关窗"
                    checked={bsCloseWindow}
                    disabled={busy || isRunning}
                    onCheckedChange={updateBsCloseWindow}
                  />
                </span>
              </div>
            ) : (
              settings && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--line)] bg-slate-50/80 px-2.5 py-1">
                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]">
                    <span>单号本轮上限</span>
                    <ControlledNumberInput
                      ref={maxPostsRef}
                      ariaLabel="单号本轮上限"
                      className={`${UI_INPUT_SM} w-16 text-center tabular-nums`}
                      min={1}
                      max={200}
                      defaultValue={10}
                      value={settings.maxPostsPerAccount}
                      onCommit={(val) => updateSettingField('maxPostsPerAccount', val)}
                    />
                  </label>
                  <UiSwitch
                    ariaLabel="发帖完毕关闭浏览器"
                    label="完后关窗"
                    checked={Boolean(settings.closeBrowserOnFinish)}
                    disabled={busy}
                    onCheckedChange={(val) => void updateSettingField('closeBrowserOnFinish', val)}
                  />
                </div>
              )
            )}
          </div>
          <div className={UI_ROW}>
            {pendingOps.length > 0 && (
              <Btn
                className="border-amber-300 bg-amber-50 font-semibold text-amber-900 hover:not-disabled:border-amber-400 hover:not-disabled:bg-amber-100"
                onClick={() => setPendingReviewOpen(true)}
                title="查看提交后未确认结果的待核对发帖操作，可核对后解锁重试或确认已发"
              >
                <IconAlertTriangle size={13} /> 待核对 ({pendingOps.length})
              </Btn>
            )}
            <RunStatusPill text={statusText} running={isRunning} onOpenLiveRuns={onOpenLiveRuns} />
            <Btn onClick={handleOpenAddGroups}>＋ 添加小组 (共 {state?.groups.length ?? 0} 个)</Btn>
            <Btn onClick={() => onOpenRecords?.()}>发帖记录 ({state?.total ?? 0} 条)</Btn>
            {isBluestacks && onQuickSchedule && (
              <Btn
                disabled={busy || !mat.activeBatchMaterialIds.length}
                title="将所选素材与小组一键加入蓝蝶定时排班"
                onClick={() =>
                  onQuickSchedule(
                    buildBsPosterScheduleSeed(
                      [...selectedBsSet],
                      mat.activeBatchMaterialIds,
                      resolvedGroups(),
                      bsMaxGroups,
                      bsPostTimeline,
                    ),
                  )
                }
              >
                <IconClock size={13} /> 加入排班
              </Btn>
            )}
            {isBluestacks && !isRunning && (
              <Btn
                v="primary"
                disabled={busy || !selectedBsSet.size || !mat.validMaterialIds.length}
                onClick={() => void handleBluestacksBatchStart()}
              >
                <IconPlay size={12} /> 开始蓝蝶发帖 ({mat.activeBatchMaterialIds.length}条)
              </Btn>
            )}
            {isRunning && (
              <Btn
                v="danger"
                sm={false}
                disabled={busy}
                onClick={() =>
                  isBluestacks
                    ? void runBsAction('poster/stop', {}, '已发送停止蓝蝶发帖指令')
                    : void action('stop')
                }
              >
                <IconStop size={12} /> {isBluestacks ? '停止蓝蝶发帖' : '停止全部发帖'}
              </Btn>
            )}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {activeTab === 'groups' ? (
          <SharedPosterGroupsList
            state={state}
            selected={chosenGroupIds}
            onSelect={setChosenGroupIds}
            busy={busy}
            onFolders={setFolders}
            onDelete={handleDeleteGroups}
            onChanged={async () => onState(await api.posterState())}
            onOpenAddGroups={handleOpenAddGroups}
            onRefreshGroups={(ids) => void action('groups/refresh', ids?.length ? { ids } : {})}
            onStopRefreshGroups={() => void action('groups/refresh-stop', {})}
          />
        ) : (
          <div className="finder-card flex min-h-0 flex-1 flex-col rounded-xl border border-[var(--line)] bg-white p-3.5 shadow-xs">
            <div className="finder-header mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2.5">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <strong>贴文素材库 ({mat.validMaterialIds.length})</strong>
                {mat.dirtyMaterials && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                    保存中…
                  </span>
                )}
              </div>
            </div>
            <PosterMaterialCardGrid
              rows={mat.drafts}
              state={state}
              persistedIds={mat.persistedMaterialIds}
              pauseThumbnailGeneration={modal === 'materials'}
              busy={busy}
              selectedCardIds={selectedCardIds}
              onSelectedCardIdsChange={setSelectedCardIds}
              onOpenDispatch={(row) => setDispatchMaterialIds([row.id])}
              onOpenBatchDispatch={(pickedRows) =>
                setDispatchMaterialIds(pickedRows.map((r) => r.id))
              }
              onQuickScheduleMaterial={
                onQuickSchedule
                  ? (row) =>
                      onQuickSchedule(
                        buildMaterialScheduleSeed(
                          row,
                          state,
                          folders,
                          isBluestacks ? selectedBsSet : selected,
                          settings,
                          {
                            carrier: isBluestacks ? 'bluestacks' : 'browser',
                            bsMaxGroups,
                            bsPostTimeline,
                          },
                        ),
                      )
                  : undefined
              }
              onOpenDetail={(row) => setDetailMaterialId(row.id)}
              onEditCard={(row) => setEditTarget({ row, isNew: false })}
              onAddCard={() =>
                setEditTarget({
                  row: { ...createEmptyMaterialDraft(), createdAt: Date.now() },
                  isNew: true,
                })
              }
              onAddLocalFiles={mat.onAddLocalFiles}
              onDeleteCard={mat.onDeleteCard}
              onBatchDeleteCards={mat.onBatchDeleteCards}
              onBatchUpdateCards={mat.onBatchUpdateCards}
              onOpenTableEditor={() => setModal('materials')}
              onCancelTask={cancelTask}
              onDeleteTask={deleteTask}
              onThumbnailSaved={mat.handleThumbnailSaved}
            />
          </div>
        )}
      </div>
      {dispatchRows.length > 0 && (
        <PosterTaskDispatchModal
          materials={dispatchRows}
          state={state}
          folders={folders}
          profiles={profiles ?? []}
          profileGroups={profileGroups ?? []}
          initialSelectedProfileIds={selectedProfiles}
          initialCarrier={carrier}
          initialCloseBrowserOnFinish={Boolean(settings?.closeBrowserOnFinish)}
          bluestacksInstances={bluestacksState?.instances}
          bluestacksFolders={bluestacksState?.folders}
          initialSelectedBluestacksIds={[...selectedBsSet]}
          onSelectProfiles={onSelectProfiles}
          onSelectBluestacks={onSelectBluestacks}
          busy={busy}
          blockEscape={modal === 'groups' || pendingReviewOpen}
          onClose={() => setDispatchMaterialIds([])}
          onOpenAddGroups={handleOpenAddGroups}
          onDeleteGroups={handleDeleteGroups}
          onRefreshGroups={(ids) => void action('groups/refresh', ids?.length ? { ids } : {})}
          onStopRefreshGroups={() => void action('groups/refresh-stop')}
          onStateChanged={async () => onState(await api.posterState())}
          onFoldersChanged={setFolders}
          onSubmitBluestacks={submitBsDispatch}
          onSubmitTask={submitTaskDispatch}
        />
      )}
      {detailRow && (
        <PosterMaterialDetailModal
          material={detailRow}
          state={state}
          profiles={displayLogProfiles}
          busy={busy}
          blockEscape={modal === 'groups' || pendingReviewOpen}
          onClose={() => setDetailMaterialId(null)}
          onCancelTask={cancelTask}
          onDeleteTask={deleteTask}
          onOpenRecords={onOpenRecords}
          onOpenPendingReview={() => setPendingReviewOpen(true)}
          onMessage={onMessage}
        />
      )}
      {editTarget && (
        <PosterMaterialEditModal
          initial={editTarget.row}
          isNew={editTarget.isNew}
          busy={busy}
          onClose={() => setEditTarget(null)}
          onSaveItem={(u) => mat.onSaveEditItem(u, Boolean(editTarget.isNew))}
        />
      )}
      {pendingReviewOpen && (
        <PendingReviewModal
          title="发帖待核对操作"
          items={pendingItems}
          busy={busy}
          error={error}
          onResolve={resolvePendingOp}
          onClose={() => setPendingReviewOpen(false)}
        />
      )}
      <TargetAddModal
        open={modal === 'groups'}
        description=""
        folders={folders}
        addFolder={addFolder}
        onFolderChange={setAddFolder}
        rows={groupRows}
        onRowsChange={setGroupRows}
        busy={busy}
        error={error}
        onError={setError}
        normalizeId={extractGroupId}
        onClose={() => setModal(null)}
        onSubmit={(e) => {
          e.preventDefault();
          const items = buildGroupAddItems(groupRows, addFolder);
          if (!items.length || items.some((r) => !r.id))
            return setError('请至少填写有效的小组 ID 或链接');
          void action('groups/add', { items }).then((next) => next && setModal(null));
        }}
      />
      {modal === 'materials' && (
        <BackdropModal
          label="全屏编辑贴文素材库"
          modalClass="!gap-0 !p-0 flex h-[min(86vh,840px)] w-[min(1280px,calc(100vw_-_32px))] flex-col overflow-hidden"
          busy={busy}
          blockEscape
          onClose={closeMaterialsModal}
        >
          <ModalHeading title="全屏编辑贴文素材库" closeText="×" onClose={closeMaterialsModal} />
          <PosterMaterialMatrix
            ref={mat.matrixRef}
            rows={mat.drafts}
            persistedIds={mat.persistedMaterialIds}
            dirty={mat.dirtyMaterials}
            busy={busy}
            isFullscreen
            onToggleFullscreen={closeMaterialsModal}
            onChange={mat.onMatrixChange}
            onSave={mat.persistMaterials}
            onDeleteSelected={mat.onDeleteMatrixSelected}
            onThumbnailSaved={mat.handleThumbnailSaved}
            onError={reportErr}
          />
          <ErrText msg={error} className="mx-4 mt-0 mb-3" />
        </BackdropModal>
      )}
    </section>
  );
}
