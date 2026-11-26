import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import type { BluestacksState } from '../shared/bluestacks.js';
import type { Profile, Workspace } from '../shared/contracts.js';
import {
  PosterSettings,
  type PosterState,
  type PosterTaskAccountMode,
} from '../shared/group-poster.js';
import type { TargetFolder } from '../shared/target-list.js';
import { api } from './api.js';
import { FinderTargetList, orderedFinderItems } from './finder-target-list.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import { IconClock, IconPlay, IconStop } from './icons.js';
import {
  PosterMaterialCardGrid,
  PosterMaterialDetailModal,
  PosterMaterialEditModal,
  PosterTaskDispatchModal,
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
import { BackdropModal, Btn, errMsg, ModalHeading } from './modules/shared/module-ui.js';
import { CarrierScopeBar } from './modules/shared/target-scope-bar.js';
import {
  createEmptyMaterialDraft,
  PosterMaterialMatrix,
  type MaterialDraft,
} from './poster-material-matrix.js';
import { TargetAddModal } from './target-add-modal.js';
import { UI_INPUT_SM, UiSwitch } from './ui/primitives.js';

type ProfileGroup = Workspace['groups'][number];

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dispatchMaterialId, setDispatchMaterialId] = useState<string | null>(null);
  const [detailMaterialId, setDetailMaterialId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<{ row: MaterialDraft; isNew: boolean } | null>(null);

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
        (modal === 'materials' && mat.matrixRef.current?.isEditing()) ||
        document.querySelector('[data-grid-cell-editing="1"]')
      )
        return;
      setModal(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modal, busy, mat.matrixRef]);

  const isRunning = isBluestacks
    ? Boolean(bluestacksState?.posterRunning)
    : Boolean(state?.running);
  const selectedProfiles = [...selected].sort();
  const selectedBsSet = selectedBluestacks ?? new Set<string>();
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
      },
      `已启动蓝蝶小组发帖（${selectedBsSet.size} 台蓝蝶 · ${mat.activeBatchMaterialIds.length} 条素材）`,
    );
  }

  function updateSettingField<K extends keyof PosterSettings>(key: K, rawValue: number) {
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
    materialId: string;
    groupIds: string[];
    maxGroupsPerInstance: number;
    postToTimeline: boolean;
  }) =>
    (await mat.ensureMaterialsPersisted(input.materialId)) &&
    runBsAction(
      'poster/start',
      { ...input, materialIds: [input.materialId], materialId: undefined },
      `已启动蓝蝶发帖任务（${input.instanceIds.length} 台蓝蝶）`,
    );

  const submitTaskDispatch = async (input: {
    materialId: string;
    groupIds: string[];
    accountMode: PosterTaskAccountMode;
    profileIds: string[];
    scheduledAt: number | null;
  }) => {
    if (settingsRef.current) {
      const next = {
        ...settingsRef.current,
        maxPostsPerAccount:
          (await maxPostsRef.current?.flush()) ?? settingsRef.current.maxPostsPerAccount,
      };
      if (JSON.stringify(next) !== JSON.stringify(state?.settings)) {
        settingsRef.current = next;
        setSettings(next);
        await action('settings', next);
      }
    }
    if (!(await mat.ensureMaterialsPersisted(input.materialId))) return false;
    const ok = await action('tasks/create', input);
    if (ok)
      onMessage(
        input.scheduledAt
          ? `已创建定时发帖任务（将于 ${new Date(input.scheduledAt).toLocaleString()} 自动启动，发完为止）`
          : '已创建并启动贴文发帖任务',
      );
    return Boolean(ok);
  };

  const statusText = isBluestacks ? bluestacksState?.posterStatusText : state?.statusText;
  const dispatchRow = dispatchMaterialId
    ? mat.drafts.find((d) => d.id === dispatchMaterialId)
    : null;
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
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
                </div>
              )
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {statusText &&
              (isRunning && onOpenLiveRuns ? (
                <button
                  type="button"
                  className="m-0 inline-flex h-[22px] items-center gap-1 rounded-full border-0 bg-[var(--run-soft)] px-2 text-xs font-semibold whitespace-nowrap text-[color:var(--run)] transition-colors hover:bg-blue-100"
                  role="status"
                  title="点击查看实时任务队列"
                  onClick={onOpenLiveRuns}
                >
                  <span>{statusText}</span>
                  <span className="opacity-75">· 查看队列</span>
                </button>
              ) : (
                <span
                  className={`m-0 inline-flex h-[22px] items-center rounded-full px-2 text-xs whitespace-nowrap ${isRunning ? 'bg-[var(--run-soft)] font-semibold text-[color:var(--run)]' : 'bg-[var(--surface-3)] text-[color:var(--text-2,#5b6470)]'}`}
                  role="status"
                >
                  {statusText}
                </span>
              ))}
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
          <FinderTargetList
            title="小组列表"
            countLabel="累计发帖"
            listKind="shared_groups"
            items={(state?.groups ?? []).map((i) => ({ ...i, count: i.totalBumpedCount }))}
            selected={chosenGroupIds}
            onSelect={setChosenGroupIds}
            disabled={busy}
            onFolders={setFolders}
            onDelete={handleDeleteGroups}
            onChanged={async () => onState(await api.posterState())}
            tools={<Btn onClick={handleOpenAddGroups}>＋ 添加小组</Btn>}
            moreItems={[
              state?.groupAvatarRefreshing
                ? {
                    label: '停止刷新头像',
                    disabled: busy,
                    onSelect: () => void action('groups/refresh-stop'),
                  }
                : {
                    label: busy ? '读取中…' : '刷新头像',
                    disabled: busy || Boolean(state?.running),
                    onSelect: () =>
                      void action(
                        'groups/refresh',
                        chosenGroupIds.size ? { ids: [...chosenGroupIds] } : {},
                      ),
                  },
            ]}
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
              onOpenDispatch={(row) => setDispatchMaterialId(row.id)}
              onQuickScheduleMaterial={
                onQuickSchedule
                  ? (row) =>
                      onQuickSchedule(
                        buildMaterialScheduleSeed(row, state, folders, selected, settings),
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
              onCancelTask={async (id) => void (await action('tasks/cancel', { id }))}
              onDeleteTask={async (id) => void (await action('tasks/delete', { id }))}
              onThumbnailSaved={mat.handleThumbnailSaved}
            />
          </div>
        )}
      </div>

      {dispatchRow && (
        <PosterTaskDispatchModal
          material={dispatchRow}
          state={state}
          folders={folders}
          profiles={profiles ?? []}
          profileGroups={profileGroups ?? []}
          initialSelectedProfileIds={selectedProfiles}
          initialCarrier={carrier}
          bluestacksInstances={bluestacksState?.instances}
          bluestacksFolders={bluestacksState?.folders}
          initialSelectedBluestacksIds={[...selectedBsSet]}
          onSelectProfiles={onSelectProfiles}
          onSelectBluestacks={onSelectBluestacks}
          busy={busy}
          onClose={() => setDispatchMaterialId(null)}
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
          onClose={() => setDetailMaterialId(null)}
          onCancelTask={async (id) => void (await action('tasks/cancel', { id }))}
          onDeleteTask={async (id) => void (await action('tasks/delete', { id }))}
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
          {error && (
            <p className="mx-4 mt-0 mb-3 text-xs font-medium text-rose-600" role="alert">
              {error}
            </p>
          )}
        </BackdropModal>
      )}
    </section>
  );
}
