import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import type { BluestacksState } from '../shared/bluestacks.js';
import {
  extractBumperPageId,
  type BumperSettings,
  type BumperState,
  type BumperTarget,
  type PendingOperationResolution,
} from '../shared/group-bumper.js';
import type { TargetFolder } from '../shared/target-list.js';
import { api } from './api.js';
import {
  FinderTargetList,
  orderedFinderItems,
  refreshAvatarMenuItem,
} from './finder-target-list.js';
import {
  BumperAdvancedPopover,
  BumperCommentsModal,
  BumperPolicyBar,
  blankBumperRow,
  bumperCloseKey,
  IDLE_BUMPER_STATUS,
  mapBumperPendingItems,
  readStoredBumperClose,
  type BumperSettingsWithClose,
  type NumberSettingKey,
} from './group-bumper-controls.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import { IconAlertTriangle, IconClock, IconPlay, IconStop } from './icons.js';
import { PendingReviewModal } from './modules/poster-material-detail-modal.js';
import {
  Btn,
  errMsg,
  readStoredFlag,
  RunStatusPill,
  writeStoredFlag,
} from './modules/shared/module-ui.js';
import { normalizeBumperSettings } from './modules/shared/step-settings-fields.js';
import { CarrierScopeBar } from './modules/shared/target-scope-bar.js';
import { TargetAddModal } from './target-add-modal.js';
import { UiSwitch } from './ui/primitives.js';
export { normalizeBumperSettings };
const blank = blankBumperRow;
const IDLE_STATUS = IDLE_BUMPER_STATUS;
const bsBumperCloseKey = (pageMode: boolean) =>
  pageMode
    ? 'wb.bluestacksPageBumper.closeWindowOnFinish'
    : 'wb.bluestacksGroupBumper.closeWindowOnFinish';
type BumperPageProps = {
  state: BumperState | null;
  selected: ReadonlySet<string>;
  profiles?: ReadonlyArray<{
    id: string;
    name?: string | null;
    browserName?: string | null;
    alias?: string | null;
    groupId?: string | null;
    online?: boolean | undefined;
  }>;
  profileGroups?: ReadonlyArray<{ id: string; name: string }> | undefined;
  onSelectProfiles?: ((next: Set<string>) => void) | undefined;
  onSelectBluestacks?: ((next: Set<string>) => void) | undefined;
  onState: (s: BumperState) => void;
  onMessage: (s: string) => void;
  mode?: 'group-bumper' | 'page-bumper' | 'bluestacks-group-bumper' | 'bluestacks-page-bumper';
  bluestacksState?: BluestacksState | null | undefined;
  onBluestacksState?: ((s: BluestacksState) => void) | undefined;
  onQuickSchedule?: ((seed: QuickScheduleSeed) => void) | undefined;
  onOpenRecords?: (() => void) | undefined;
  onOpenLiveRuns?: (() => void) | undefined;
};
export function GroupBumperPage(p: BumperPageProps) {
  const {
    state,
    selected,
    onState,
    onMessage,
    mode = 'group-bumper',
    bluestacksState,
    onBluestacksState,
    onQuickSchedule,
    onOpenRecords,
  } = p;
  const pageMode = mode === 'page-bumper' || mode === 'bluestacks-page-bumper';
  const bsMode = mode === 'bluestacks-group-bumper' || mode === 'bluestacks-page-bumper';
  const pick = <T,>(bsPage: T, bsGrp: T, brPage: T, brGrp: T) =>
    bsMode ? (pageMode ? bsPage : bsGrp) : pageMode ? brPage : brGrp;
  const isRunning = Boolean(
    pick(
      bluestacksState?.pageBumperRunning,
      bluestacksState?.running,
      state?.pageBumperRunning,
      state?.running,
    ),
  );
  const statusText = pick(
    bluestacksState?.pageBumperStatusText,
    bluestacksState?.statusText,
    state?.pageBumperStatusText,
    state?.statusText,
  );
  const effectiveStateSettings =
    pick(
      bluestacksState?.pageBumperSettings,
      bluestacksState?.bumperSettings,
      state?.pageSettings,
      state?.settings,
    ) ??
    state?.pageSettings ??
    state?.settings ??
    null;
  const [settingsActionName, commentsActionName] = pageMode
    ? ['page-settings', 'page-comments']
    : ['settings', 'comments'];
  const effectiveComments = pageMode ? (state?.pageComments ?? []) : (state?.comments ?? []);
  const effectiveTotal =
    pick(bluestacksState?.pageTotal, bluestacksState?.total, state?.pageTotal, state?.total) ??
    state?.total ??
    0;
  const runningIds = new Set(
    [
      ...Object.entries((bsMode ? bluestacksState?.profileCounts : state?.profileCounts) ?? {}),
      ...Object.entries(
        (bsMode ? bluestacksState?.pageBumperProfileCounts : state?.pageBumperProfileCounts) ?? {},
      ),
    ]
      .filter(([, s]) => s.running)
      .map(([id]) => id),
  );
  const idleSelected = [...selected].filter((id) => !runningIds.has(id));
  const [chosenGroups, setGroups] = useState<Set<string>>(new Set());
  const [chosenPages, setPages] = useState<Set<string>>(new Set());
  const [activePane, setActivePane] = useState<'groups' | 'pages'>('groups');
  const [folders, setFolders] = useState<{ groups: TargetFolder[]; pages: TargetFolder[] }>({
    groups: [],
    pages: [],
  });
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [modal, setModal] = useState<'groups' | 'pages' | 'comments' | null>(null);
  const [pendingReviewOpen, setPendingReviewOpen] = useState(false);
  const [rows, setRows] = useState<DraftGroupEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<BumperSettings | null>(effectiveStateSettings);
  const [closeBrowserOnFinish, setCloseBrowserOnFinish] = useState<boolean>(() =>
    readStoredBumperClose(pageMode, effectiveStateSettings),
  );
  const [bsCloseWindowOnFinish, setBsCloseWindowOnFinish] = useState<boolean>(() =>
    readStoredFlag(bsBumperCloseKey(pageMode)),
  );
  const latestSettingsRef = useRef<BumperSettings | null>(effectiveStateSettings);
  const dirtySettingsRef = useRef(false);
  const inFlightSavesRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsJSON = JSON.stringify(effectiveStateSettings);
  const [commentText, setCommentText] = useState('');
  const [consume, setConsume] = useState(false);
  const commentBaseRef = useRef<Array<{ id: string; text: string }>>([]);
  const commentDirtyRef = useRef(false);
  useEffect(() => {
    setGroups(new Set());
    setPages(new Set());
    setActivePane('groups');
    setModal(null);
    setPendingReviewOpen(false);
    commentDirtyRef.current = false;
    commentBaseRef.current = [];
    setCommentText('');
    setCloseBrowserOnFinish(readStoredBumperClose(pageMode, effectiveStateSettings));
    setBsCloseWindowOnFinish(readStoredFlag(bsBumperCloseKey(pageMode)));
  }, [mode, pageMode]);
  useEffect(() => {
    if (
      settingsJSON &&
      !dirtySettingsRef.current &&
      inFlightSavesRef.current === 0 &&
      !saveTimerRef.current
    ) {
      const parsed = JSON.parse(settingsJSON) as BumperSettingsWithClose;
      latestSettingsRef.current = parsed;
      setSettings(parsed);
      if (typeof parsed.closeBrowserOnFinish === 'boolean')
        setCloseBrowserOnFinish(parsed.closeBrowserOnFinish);
    }
  }, [settingsJSON]);
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    if (modal !== 'comments' || commentDirtyRef.current) return;
    commentBaseRef.current = effectiveComments.map(({ id, text }) => ({ id, text }));
    setCommentText(effectiveComments.map((c) => c.text).join('\n'));
  }, [modal, effectiveComments]);
  async function runApi<T>(work: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError('');
    try {
      return await work();
    } catch (e) {
      const msg = errMsg(e, '操作失败');
      setError(msg);
      onMessage(msg);
      return null;
    } finally {
      setBusy(false);
    }
  }
  const action = (name: string, input: unknown = {}) =>
    runApi(async () => {
      const next = await api.bumperAction(name, input);
      onState(next);
      return next;
    });
  const runBsAction = (name: string, input: unknown = {}) =>
    runApi(async () => {
      const next = await api.bluestacksAction(name, input);
      onBluestacksState?.(next);
      return next;
    });
  function saveSettings(next: BumperSettingsWithClose) {
    inFlightSavesRef.current += 1;
    const run = async () => {
      try {
        const res = bsMode
          ? await runBsAction(settingsActionName, next)
          : await action(settingsActionName, next);
        if (!res && effectiveStateSettings) {
          latestSettingsRef.current = effectiveStateSettings;
          setSettings(effectiveStateSettings);
        }
        return res;
      } finally {
        inFlightSavesRef.current = Math.max(0, inFlightSavesRef.current - 1);
      }
    };
    const chained = saveChainRef.current.then(run, run);
    saveChainRef.current = chained;
    return chained;
  }
  function open(kind: NonNullable<typeof modal>) {
    setError('');
    setModal(kind);
    setAddFolder(null);
    if (kind === 'groups' || kind === 'pages') setRows(Array.from({ length: 5 }, blank));
    if (kind === 'comments') {
      commentBaseRef.current = effectiveComments.map(({ id, text }) => ({ id, text }));
      commentDirtyRef.current = false;
      setCommentText(effectiveComments.map((c) => c.text).join('\n'));
      setConsume(settings?.consumeCommentOnUse ?? false);
    }
  }
  const selectedGroups = orderedFinderItems(state?.groups ?? [], folders.groups)
    .filter((g) => chosenGroups.has(g.id))
    .map((g) => g.id);
  const selectedPages = orderedFinderItems(state?.pages ?? [], folders.pages)
    .filter((g) => chosenPages.has(g.id))
    .map((g) => g.id);
  const applySettingsNext = (next: BumperSettings, commit: boolean) => {
    latestSettingsRef.current = next;
    dirtySettingsRef.current = !commit;
    setSettings(next);
    if (commit) void saveSettings(!bsMode ? { ...next, closeBrowserOnFinish } : next);
  };
  function updateSetting(key: NumberSettingKey, clamped: number, commit: boolean) {
    if (!settings) return;
    if (commit && saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    applySettingsNext(
      normalizeBumperSettings(
        { ...(latestSettingsRef.current ?? settings), [key]: clamped },
        effectiveStateSettings ?? settings,
      ),
      commit,
    );
  }
  function applyPatchImmediate(patch: Partial<BumperSettings>) {
    const base = latestSettingsRef.current ?? settings;
    if (base)
      applySettingsNext(
        normalizeBumperSettings({ ...base, ...patch }, effectiveStateSettings ?? base),
        true,
      );
  }
  const handleToggleCloseOnFinish = (nextClose: boolean) => {
    setCloseBrowserOnFinish(nextClose);
    writeStoredFlag(bumperCloseKey(pageMode), nextClose);
    const base = latestSettingsRef.current ?? settings;
    if (base) {
      const next = normalizeBumperSettings(base, effectiveStateSettings ?? base);
      latestSettingsRef.current = next;
      dirtySettingsRef.current = false;
      setSettings(next);
      void saveSettings({ ...next, closeBrowserOnFinish: nextClose });
    }
  };
  const handleToggleBsCloseOnFinish = (nextClose: boolean) => {
    setBsCloseWindowOnFinish(nextClose);
    writeStoredFlag(bsBumperCloseKey(pageMode), nextClose);
  };
  const flushSettingsIfDirty = async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const cur = latestSettingsRef.current ?? settings;
    if (!cur) return;
    const normalized = normalizeBumperSettings(cur, effectiveStateSettings ?? cur);
    if (
      dirtySettingsRef.current ||
      JSON.stringify(normalized) !== JSON.stringify(effectiveStateSettings)
    ) {
      dirtySettingsRef.current = false;
      latestSettingsRef.current = normalized;
      setSettings(normalized);
      await saveSettings(!bsMode ? { ...normalized, closeBrowserOnFinish } : normalized);
    }
  };
  const startRun = () =>
    void (async () => {
      await flushSettingsIfDirty();
      const basePayload = pageMode
        ? { profileIds: idleSelected, pageIds: selectedPages }
        : { profileIds: idleSelected, groupIds: selectedGroups, pageIds: selectedPages };
      const payload = bsMode
        ? bsCloseWindowOnFinish
          ? { ...basePayload, closeWindowOnFinish: true }
          : basePayload
        : closeBrowserOnFinish
          ? { ...basePayload, closeBrowserOnFinish: true }
          : basePayload;
      if (bsMode) {
        if (await runBsAction(pageMode ? 'bumper/start-page' : 'bumper/start', payload))
          void api.bumperState().then(onState, () => {});
      } else await action(pageMode ? 'start-page' : 'start', payload);
    })();
  const triggerQuickSchedule = () =>
    onQuickSchedule &&
    void (async () => {
      await flushSettingsIfDirty();
      const step = pageMode
        ? {
            id: crypto.randomUUID(),
            type: (bsMode ? 'bluestacks-page-bumper' : 'page-bumper') as
              'bluestacks-page-bumper' | 'page-bumper',
            pageIds: selectedPages,
          }
        : {
            id: crypto.randomUUID(),
            type: (bsMode ? 'bluestacks-group-bumper' : 'group-bumper') as
              'bluestacks-group-bumper' | 'group-bumper',
            groupIds: selectedGroups,
            pageIds: selectedPages,
          };
      onQuickSchedule({
        carrier: bsMode ? 'bluestacks' : 'browser',
        name: `${bsMode ? '蓝蝶' : ''}${pageMode ? '专页顶贴' : '小组顶贴'}`,
        targetIds: [...selected],
        steps: [step] as QuickScheduleSeed['steps'],
      });
    })();
  const pendingOps = state?.pendingReviewOperations ?? [];
  const pendingItems = useMemo(
    () => mapBumperPendingItems(pendingOps, p.profiles),
    [pendingOps, p.profiles],
  );
  const resolvePendingOp = async (operationId: string, resolution: PendingOperationResolution) => {
    const next = await action('pending-operations/resolve', { operationId, resolution });
    if (next) {
      onMessage(
        resolution === 'not_applied'
          ? `已解锁待核对操作 ${operationId}，可重新执行`
          : `已确认操作 ${operationId} 执行成功`,
      );
      if (!(next.pendingReviewOperations ?? []).length) setPendingReviewOpen(false);
    }
  };
  const showStatusBadge = Boolean(isRunning || (statusText && !IDLE_STATUS.has(statusText)));
  const startDisabled =
    busy || !idleSelected.length || (!pageMode && !selectedGroups.length) || !selectedPages.length;
  const quickScheduleBtn = onQuickSchedule ? (
    <Btn
      sm={false}
      disabled={busy || (!pageMode && !selectedGroups.length) || !selectedPages.length}
      title="将当前顶贴参数与目标一键导入定时排班（支持单次或按周执行）"
      onClick={triggerQuickSchedule}
    >
      <IconClock size={13} /> 加入排班
    </Btn>
  ) : null;
  const commentFallback = settings
    ? [
        ...(settings.likeProbability > 0 ? ['点赞'] : []),
        ...(!bsMode && (settings.shareToStoryProbability ?? 0) > 0 ? ['分享快拍'] : []),
      ].join('/')
    : '';
  function renderTargets(kind: 'groups' | 'pages', items: BumperTarget[]) {
    const chosen = kind === 'groups' ? chosenGroups : chosenPages;
    const refreshing = state
      ? kind === 'groups'
        ? state.groupAvatarRefreshing
        : state.pageAvatarRefreshing
      : false;
    return (
      <FinderTargetList
        title={kind === 'groups' ? '小组列表' : '专页列表'}
        countLabel={kind === 'groups' ? '累计顶贴' : '累计获顶'}
        listKind={kind === 'groups' ? 'shared_groups' : 'bumper_pages'}
        items={items.map((i) => ({ ...i, count: i.totalBumpedCount }))}
        selected={chosen}
        onSelect={kind === 'groups' ? setGroups : setPages}
        disabled={busy}
        onFolders={(next) => setFolders((prev) => ({ ...prev, [kind]: next }))}
        onDelete={async (ids) => {
          if (!(await action(kind + '/delete', { ids }))) throw Error('删除未完成');
        }}
        onChanged={async () => onState(await api.bumperState())}
        tools={
          <Btn disabled={busy} onClick={() => open(kind)}>
            ＋ 添加{kind === 'groups' ? '小组' : '主页'}
          </Btn>
        }
        moreItems={[
          refreshAvatarMenuItem({
            refreshing: Boolean(refreshing),
            busy,
            disabled:
              busy ||
              !!state?.running ||
              !!state?.pageBumperRunning ||
              !!bluestacksState?.running ||
              !!bluestacksState?.pageBumperRunning,
            onStop: () => void action(`${kind}/refresh-stop`, {}),
            onStart: () => void action(`${kind}/refresh`, chosen.size ? { ids: [...chosen] } : {}),
          }),
        ]}
      />
    );
  }
  return (
    <section className="records-page bumper-page flex h-full min-h-0 flex-col gap-2.5">
      {(p.onSelectProfiles || p.onSelectBluestacks) && (
        <CarrierScopeBar
          isBs={bsMode}
          bluestacksState={bluestacksState}
          profiles={p.profiles}
          profileGroups={p.profileGroups}
          selected={selected}
          onSelect={bsMode ? p.onSelectBluestacks : p.onSelectProfiles}
        />
      )}
      <div className="bumper-sticky-header sticky top-0 z-20 min-w-0 rounded-xl border border-[var(--line)] bg-white shadow-xs">
        <div className="bumper-heading flex min-w-0 flex-wrap items-center justify-between gap-2 px-3.5 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Btn onClick={() => open('comments')}>留言列表 ({effectiveComments.length} 条)</Btn>
            <Btn onClick={() => onOpenRecords?.()}>顶贴记录 ({effectiveTotal} 条)</Btn>
            {settings && (
              <BumperAdvancedPopover
                settings={settings}
                bsMode={bsMode}
                pageMode={pageMode}
                onUpdate={updateSetting}
              />
            )}
            {bsMode && (
              <span
                className="inline-flex h-7 items-center rounded-md border border-[var(--line)] bg-slate-50 px-2"
                title="每台蓝蝶完成本轮顶贴后自动关闭模拟器窗口释放内存"
              >
                <UiSwitch
                  ariaLabel="蓝蝶顶贴完毕关窗"
                  label="完后关窗"
                  checked={bsCloseWindowOnFinish}
                  disabled={busy || isRunning}
                  onCheckedChange={handleToggleBsCloseOnFinish}
                />
              </span>
            )}
            {!bsMode && pendingOps.length > 0 && (
              <Btn
                className="border-amber-300 bg-amber-50 font-semibold text-amber-900 hover:not-disabled:border-amber-400 hover:not-disabled:bg-amber-100"
                onClick={() => setPendingReviewOpen(true)}
                title="查看未确认回执的待核对操作，核对后解锁重试或确认已发"
              >
                <IconAlertTriangle size={12} /> 待核对 ({pendingOps.length})
              </Btn>
            )}
            {settings && settings.commentProbability > 0 && effectiveComments.length <= 0 && (
              <span
                className="bumper-warning-banner inline-flex h-7 items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 text-[11.5px] font-medium whitespace-nowrap text-amber-800"
                role="note"
                title={
                  commentFallback
                    ? `留言列表为空，当前仅会执行${commentFallback}（如需评论请点击「留言列表」添加话术）`
                    : '留言列表为空，请添加话术或在高级参数开启点赞/分享快拍'
                }
              >
                <IconAlertTriangle size={12} />
                <span>
                  {commentFallback
                    ? `留言列表为空仅${commentFallback}`
                    : '留言列表为空（未启用其他动作）'}
                </span>
              </span>
            )}
            {showStatusBadge && (
              <RunStatusPill
                text={statusText}
                running={isRunning}
                onOpenLiveRuns={p.onOpenLiveRuns}
              />
            )}
          </div>
          <div className="bumper-actions ml-auto flex max-w-full flex-wrap items-center gap-2">
            {isRunning ? (
              <>
                {idleSelected.length > 0 && (
                  <Btn v="primary" sm={false} disabled={startDisabled} onClick={startRun}>
                    <IconPlay size={12} /> 追加运行已选闲置
                    {bsMode ? `窗口 (${idleSelected.length}窗)` : `号 (${idleSelected.length}号)`}
                  </Btn>
                )}
                {quickScheduleBtn}
                <Btn
                  v="danger"
                  sm={false}
                  disabled={busy}
                  onClick={() =>
                    void (bsMode
                      ? runBsAction(pageMode ? 'bumper/stop-page' : 'bumper/stop', {})
                      : action(pageMode ? 'stop-page' : 'stop'))
                  }
                >
                  <IconStop size={12} /> 停止全部运行
                </Btn>
              </>
            ) : (
              <>
                {quickScheduleBtn}
                <Btn
                  v="primary"
                  sm={false}
                  disabled={startDisabled}
                  onClick={startRun}
                  title={
                    !idleSelected.length
                      ? `请先在左侧选择${bsMode ? '蓝蝶窗口' : '浏览器'}`
                      : !pageMode && !selectedGroups.length
                        ? '请至少选择一个目标小组'
                        : !selectedPages.length
                          ? '请至少选择一个目标专页'
                          : undefined
                  }
                >
                  <IconPlay size={12} />{' '}
                  {pageMode
                    ? `运行 (${idleSelected.length}${bsMode ? '窗' : '号'} · ${selectedPages.length}专页)`
                    : `运行 (${idleSelected.length}${bsMode ? '窗' : '号'} · ${selectedGroups.length}组 · ${selectedPages.length}主页)`}
                </Btn>
              </>
            )}
          </div>
        </div>
        {settings && (
          <BumperPolicyBar
            settings={settings}
            latestSettings={latestSettingsRef.current ?? settings}
            pageMode={pageMode}
            bsMode={bsMode}
            closeBrowserOnFinish={closeBrowserOnFinish}
            onUpdate={updateSetting}
            onPatchImmediate={applyPatchImmediate}
            onToggleCloseOnFinish={handleToggleCloseOnFinish}
          />
        )}
      </div>
      {!state ? (
        <div
          className="flex min-h-[240px] flex-1 items-center justify-center rounded-xl border border-dashed border-[var(--line-strong)] bg-white p-8 text-center text-sm text-[var(--text-2)]"
          role="status"
        >
          <strong>正在加载顶贴配置与目标列表…</strong>
        </div>
      ) : (
        <>
          {!pageMode && (
            <div
              className="bumper-pane-tabs hidden items-center gap-1 self-start rounded-lg border border-[var(--line)] bg-slate-100 p-0.5 max-[1280px]:inline-flex"
              role="tablist"
              aria-label="切换目标列表"
            >
              {[
                {
                  key: 'groups' as const,
                  label: '小组列表',
                  sel: selectedGroups.length,
                  tot: state.groups.length,
                },
                {
                  key: 'pages' as const,
                  label: '专页列表',
                  sel: selectedPages.length,
                  tot: state.pages.length,
                },
              ].map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={activePane === t.key}
                  className={`bumper-pane-tab inline-flex items-center gap-1.5 rounded-md border-0 px-3 py-1 text-xs transition-colors ${activePane === t.key ? 'is-active bg-white font-semibold text-slate-900 shadow-2xs' : 'bg-transparent font-medium text-[var(--text-2)] hover:text-slate-900'}`}
                  onClick={() => setActivePane(t.key)}
                >
                  {t.label}
                  <em className="text-[11px] font-semibold tabular-nums not-italic text-[var(--text-3)]">
                    {t.sel}/{t.tot}
                  </em>
                </button>
              ))}
            </div>
          )}
          <div
            className={
              'bumper-columns grid min-h-0 flex-1 gap-3 ' +
              (pageMode ? 'is-single grid-cols-1' : 'grid-cols-2 max-[1280px]:grid-cols-1')
            }
          >
            {(pageMode
              ? ([['pages', state.pages]] as const)
              : ([
                  ['groups', state.groups],
                  ['pages', state.pages],
                ] as const)
            ).map(([kind, list]) => (
              <div
                key={kind}
                className={
                  'flex min-h-0 min-w-0 flex-col' +
                  (!pageMode && activePane !== kind
                    ? ' bumper-pane-hidden max-[1280px]:hidden'
                    : '')
                }
              >
                {renderTargets(kind, list)}
              </div>
            ))}
          </div>
        </>
      )}
      {(modal === 'groups' || modal === 'pages') && (
        <TargetAddModal
          open
          title={modal === 'groups' ? '添加小组' : '添加主页'}
          description=""
          folders={folders[modal]}
          addFolder={addFolder}
          onFolderChange={setAddFolder}
          folderAriaLabel={modal === 'pages' ? '添加主页归入分组' : '添加小组归入分组'}
          rows={rows}
          onRowsChange={setRows}
          busy={busy}
          error={error}
          onError={setError}
          entityLabel={modal === 'pages' ? '主页' : '小组'}
          normalizeId={modal === 'pages' ? extractBumperPageId : extractGroupId}
          footerClassName="bumper-modal-footer mt-1 flex shrink-0 items-center justify-end gap-2"
          onClose={() => setModal(null)}
          onSubmit={(e) => {
            e.preventDefault();
            const norm = modal === 'pages' ? extractBumperPageId : extractGroupId;
            const items = rows
              .filter((r) => r.groupId.trim() || r.groupName.trim())
              .map((r) => ({ id: norm(r.groupId), name: r.groupName.trim(), folderId: addFolder }));
            if (!items.length || items.some((r) => !/^[A-Za-z0-9._-]+$/.test(r.id)))
              return setError('请至少填写有效的 ID 或链接');
            void action(`${modal}/add`, { items }).then((next) => next && setModal(null));
          }}
        />
      )}
      {modal === 'comments' && (
        <BumperCommentsModal
          busy={busy}
          error={error}
          pageMode={pageMode}
          commentText={commentText}
          consume={consume}
          onCommentTextChange={(v) => {
            commentDirtyRef.current = true;
            setCommentText(v);
          }}
          onConsumeChange={setConsume}
          onClear={() => {
            commentDirtyRef.current = true;
            setCommentText('');
          }}
          onSave={() =>
            void action(commentsActionName, {
              texts: commentText
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean),
              scope: pageMode ? 'page' : 'group',
              ...(bsMode ? {} : { consumeCommentOnUse: consume }),
              baseComments: commentBaseRef.current,
            }).then(async (next) => {
              if (!next) return;
              if (bsMode && settings && consume !== settings.consumeCommentOnUse) {
                const synced = normalizeBumperSettings(
                  { ...settings, consumeCommentOnUse: consume },
                  effectiveStateSettings ?? settings,
                );
                latestSettingsRef.current = synced;
                setSettings(synced);
                await saveSettings(synced);
              }
              setModal(null);
            })
          }
          onClose={() => setModal(null)}
        />
      )}
      {pendingReviewOpen && (
        <PendingReviewModal
          title="顶贴待核对操作"
          items={pendingItems}
          busy={busy}
          error={error}
          onResolve={resolvePendingOp}
          onClose={() => setPendingReviewOpen(false)}
        />
      )}
    </section>
  );
}
