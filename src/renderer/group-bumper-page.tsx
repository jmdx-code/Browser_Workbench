import { useEffect, useRef, useState } from 'react';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import type { BluestacksState } from '../shared/bluestacks.js';
import {
  extractBumperPageId,
  type BumperSettings,
  type BumperState,
  type BumperTarget,
} from '../shared/group-bumper.js';
import type { TargetFolder } from '../shared/target-list.js';
import { api } from './api.js';
import { FinderTargetList, orderedFinderItems } from './finder-target-list.js';
import {
  BumperAdvancedPopover,
  BumperCommentsModal,
  BumperSettingInput,
  blankBumperRow,
  IDLE_BUMPER_STATUS,
  type NumberSettingKey,
} from './group-bumper-controls.js';
import { extractGroupId, type DraftGroupEntry } from './group-inviter-grid.js';
import { IconAlertTriangle, IconClock, IconPlay, IconStop } from './icons.js';
import { Btn, errMsg } from './modules/shared/module-ui.js';
import {
  normalizeBumperSettings,
  REACTION_OPTIONS,
} from './modules/shared/step-settings-fields.js';
import { CarrierScopeBar } from './modules/shared/target-scope-bar.js';
import { TargetAddModal } from './target-add-modal.js';
import { UI_SELECT_SM, UiSwitch } from './ui/primitives.js';

export { normalizeBumperSettings };

const blank = blankBumperRow;
const IDLE_STATUS = IDLE_BUMPER_STATUS;

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
  const settingsActionName = pageMode ? 'page-settings' : 'settings';
  const commentsActionName = pageMode ? 'page-comments' : 'comments';
  const effectiveComments =
    (pageMode ? state?.pageComments : state?.comments) ?? state?.comments ?? [];
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
  useEffect(() => {
    setGroups(new Set());
    setPages(new Set());
    setActivePane('groups');
  }, [mode]);

  const [folders, setFolders] = useState<{ groups: TargetFolder[]; pages: TargetFolder[] }>({
    groups: [],
    pages: [],
  });
  const [addFolder, setAddFolder] = useState<string | null>(null);
  const [modal, setModal] = useState<'groups' | 'pages' | 'comments' | null>(null);
  const [rows, setRows] = useState<DraftGroupEntry[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<BumperSettings | null>(effectiveStateSettings);
  const latestSettingsRef = useRef<BumperSettings | null>(effectiveStateSettings);
  const dirtySettingsRef = useRef(false);
  const inFlightSavesRef = useRef(0);
  const saveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsJSON = JSON.stringify(effectiveStateSettings);

  useEffect(() => {
    if (
      settingsJSON &&
      !dirtySettingsRef.current &&
      inFlightSavesRef.current === 0 &&
      !saveTimerRef.current
    ) {
      const parsed = JSON.parse(settingsJSON) as BumperSettings;
      latestSettingsRef.current = parsed;
      setSettings(parsed);
    }
  }, [settingsJSON]);
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    },
    [],
  );

  const [commentText, setCommentText] = useState('');
  const [consume, setConsume] = useState(false);
  const commentBaseRef = useRef<Array<{ id: string; text: string }>>([]);
  const commentDirtyRef = useRef(false);
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

  function saveSettings(next: BumperSettings) {
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

  function updateSetting(key: NumberSettingKey, clamped: number, commit: boolean) {
    if (!settings) return;
    if (commit && saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const next = normalizeBumperSettings(
      { ...(latestSettingsRef.current ?? settings), [key]: clamped },
      effectiveStateSettings ?? settings,
    );
    latestSettingsRef.current = next;
    dirtySettingsRef.current = !commit;
    setSettings(next);
    if (commit) void saveSettings(next);
  }
  function applyPatchImmediate(patch: Partial<BumperSettings>) {
    const base = latestSettingsRef.current ?? settings;
    if (!base) return;
    const next = normalizeBumperSettings({ ...base, ...patch }, effectiveStateSettings ?? base);
    latestSettingsRef.current = next;
    dirtySettingsRef.current = false;
    setSettings(next);
    void saveSettings(next);
  }

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
      await saveSettings(normalized);
    }
  };

  const startRun = () =>
    void (async () => {
      await flushSettingsIfDirty();
      const payload = pageMode
        ? { profileIds: idleSelected, pageIds: selectedPages }
        : { profileIds: idleSelected, groupIds: selectedGroups, pageIds: selectedPages };
      if (bsMode) {
        if (await runBsAction(pageMode ? 'bumper/start-page' : 'bumper/start', payload))
          void api.bumperState().then(onState, () => {});
      } else await action(pageMode ? 'start-page' : 'start', payload);
    })();

  const triggerQuickSchedule = () =>
    onQuickSchedule &&
    void (async () => {
      await flushSettingsIfDirty();
      const ov = settings ? { ...settings } : undefined;
      const ovProps = ov
        ? bsMode
          ? { enableSound: ov.enableSound, settingsOverride: ov }
          : { settingsOverride: ov }
        : {};
      const step = pageMode
        ? {
            id: crypto.randomUUID(),
            type: (bsMode ? 'bluestacks-page-bumper' : 'page-bumper') as
              'bluestacks-page-bumper' | 'page-bumper',
            pageIds: selectedPages,
            ...ovProps,
          }
        : {
            id: crypto.randomUUID(),
            type: (bsMode ? 'bluestacks-group-bumper' : 'group-bumper') as
              'bluestacks-group-bumper' | 'group-bumper',
            groupIds: selectedGroups,
            pageIds: selectedPages,
            ...ovProps,
          };
      onQuickSchedule({
        carrier: bsMode ? 'bluestacks' : 'browser',
        name: `${bsMode ? '蓝蝶' : ''}${pageMode ? '专页顶贴' : '小组顶贴'}`,
        targetIds: [...selected],
        steps: [step] as QuickScheduleSeed['steps'],
      });
    })();

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

  const activeReactions = settings?.reactionTypes ?? ['care', 'love', 'like'];
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
          refreshing
            ? {
                label: '停止刷新头像',
                disabled: busy,
                onSelect: () => void action(kind + '/refresh-stop'),
              }
            : {
                label: busy ? '读取中…' : '刷新头像',
                disabled:
                  busy ||
                  !!state?.running ||
                  !!state?.pageBumperRunning ||
                  !!bluestacksState?.running ||
                  !!bluestacksState?.pageBumperRunning,
                onSelect: () =>
                  void action(kind + '/refresh', chosen.size ? { ids: [...chosen] } : {}),
              },
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
      <div className="bumper-sticky-header sticky top-0 z-20 overflow-hidden rounded-xl border border-[var(--line)] bg-white shadow-xs">
        <div className="bumper-heading flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
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
            {showStatusBadge &&
              statusText &&
              (isRunning && p.onOpenLiveRuns ? (
                <button
                  type="button"
                  className="m-0 inline-flex h-[22px] items-center gap-1 rounded-full border-0 bg-[var(--run-soft)] px-2 text-xs font-semibold whitespace-nowrap text-[var(--run)] transition-colors hover:bg-blue-100"
                  role="status"
                  title="点击查看实时任务队列"
                  onClick={p.onOpenLiveRuns}
                >
                  <span>{statusText}</span>
                  <span className="opacity-75">· 查看队列</span>
                </button>
              ) : (
                <span
                  className={`m-0 inline-flex h-[22px] items-center rounded-full px-2 text-xs whitespace-nowrap ${isRunning ? 'bg-[var(--run-soft)] font-semibold text-[var(--run)]' : 'bg-[var(--surface-3)] text-[var(--text-2)]'}`}
                  role="status"
                >
                  {statusText}
                </span>
              ))}
          </div>
          <div className="bumper-actions ml-auto flex shrink-0 flex-wrap items-center gap-2">
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
          <div className="bumper-search-highlight bumper-policy flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 bg-slate-50/75 px-3.5 py-2">
            {pageMode ? (
              <BumperSettingInput
                settingKey="maxPostsPerPage"
                label="最大扫描贴文数量"
                settings={settings}
                onUpdate={updateSetting}
              />
            ) : (
              <>
                <label className="bumper-policy-field inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-2)]">
                  <span>查找方式</span>
                  <select
                    className={UI_SELECT_SM}
                    aria-label="查找方式"
                    value={settings.searchMode}
                    onChange={(e) => {
                      const searchMode = e.target.value as BumperSettings['searchMode'];
                      const base = latestSettingsRef.current ?? settings;
                      const oldDef = base.searchMode === 'page_group_feed' ? 5 : 15;
                      const nextDef = searchMode === 'page_group_feed' ? 5 : 15;
                      applyPatchImmediate({
                        searchMode,
                        maxPostsPerGroupPage:
                          base.maxPostsPerGroupPage === oldDef
                            ? nextDef
                            : base.maxPostsPerGroupPage,
                      });
                    }}
                  >
                    <option value="time_sort">1. 时间排序查找</option>
                    <option value="page_group_feed">2. 直接打开专页的小组贴</option>
                    <option value="random_browse">3. 随机浏览</option>
                  </select>
                </label>
                {settings.searchMode !== 'random_browse' && (
                  <BumperSettingInput
                    settingKey="maxPostAgeHours"
                    label="最近几小时内"
                    settings={settings}
                    onUpdate={updateSetting}
                  />
                )}
              </>
            )}
            <span aria-hidden="true" className="hidden h-3.5 w-px bg-slate-200 sm:block" />
            <UiSwitch
              className="bumper-policy-field bumper-sound-toggle"
              checked={Boolean(settings.enableSound)}
              ariaLabel="开启声音"
              label="开启声音"
              onCheckedChange={(enableSound) => applyPatchImmediate({ enableSound })}
            />
            {!bsMode && (
              <UiSwitch
                className="bumper-policy-field bumper-sound-toggle"
                checked={Boolean(settings.useLongPressReaction)}
                ariaLabel="使用表情"
                label="使用表情"
                onCheckedChange={(useLongPressReaction) =>
                  applyPatchImmediate({ useLongPressReaction })
                }
              />
            )}
            {!bsMode && Boolean(settings.useLongPressReaction) && (
              <div
                className="bumper-reaction-picks flex flex-wrap items-center gap-1"
                role="group"
                aria-label="表情池"
              >
                {REACTION_OPTIONS.map((opt) => {
                  const on = activeReactions.includes(opt.id);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      aria-pressed={on}
                      className={
                        'bumper-reaction-chip inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium transition-colors ' +
                        (on
                          ? 'active border-[var(--brand)] bg-[var(--brand-soft)] font-semibold text-[var(--brand)]'
                          : 'border-[var(--line-strong)] bg-white text-[var(--text-2)] hover:border-slate-400 hover:bg-slate-50')
                      }
                      onClick={() => {
                        const next = on
                          ? activeReactions.filter((r) => r !== opt.id)
                          : [...activeReactions, opt.id];
                        applyPatchImmediate({ reactionTypes: next.length ? next : ['like'] });
                      }}
                    >
                      {opt.emoji} {opt.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
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
              {(
                [
                  ['groups', '小组列表', selectedGroups.length, state.groups.length],
                  ['pages', '专页列表', selectedPages.length, state.pages.length],
                ] as const
              ).map(([key, label, sel, tot]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={activePane === key}
                  className={
                    'bumper-pane-tab inline-flex items-center gap-1.5 rounded-md border-0 px-3 py-1 text-xs transition-colors ' +
                    (activePane === key
                      ? 'is-active bg-white font-semibold text-slate-900 shadow-2xs'
                      : 'bg-transparent font-medium text-[var(--text-2)] hover:text-slate-900')
                  }
                  onClick={() => setActivePane(key)}
                >
                  {label}
                  <em className="text-[11px] font-semibold tabular-nums not-italic text-[var(--text-3)]">
                    {sel}/{tot}
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
            {!pageMode && (
              <div
                className={
                  'flex min-h-0 min-w-0 flex-col' +
                  (activePane !== 'groups' ? ' bumper-pane-hidden max-[1280px]:hidden' : '')
                }
              >
                {renderTargets('groups', state.groups)}
              </div>
            )}
            <div
              className={
                'flex min-h-0 min-w-0 flex-col' +
                (!pageMode && activePane !== 'pages'
                  ? ' bumper-pane-hidden max-[1280px]:hidden'
                  : '')
              }
            >
              {renderTargets('pages', state.pages)}
            </div>
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
    </section>
  );
}
