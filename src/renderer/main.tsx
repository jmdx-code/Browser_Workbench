import './ui/tailwind.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { QuickScheduleSeed } from '../shared/auto-scheduler.js';
import { bluestacksDisplayTitle } from '../shared/bluestacks.js';
import type { Profile, SavedCombination } from '../shared/contracts.js';
import type { DesktopBridge } from '../shared/desktop.js';
import type { PostBumpStatusValue } from '../shared/post-bump-records.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import { api } from './api.js';
import { useCardColors } from './card-colors.js';
import { FeatureNavRail } from './feature-nav-rail.js';
import { IconPanelOpen } from './icons.js';
import { buildLiveRunCards } from './modules/live-run-cards.js';
import type { SheetsModuleId } from './modules/module-contracts.js';
import type { PostBumpRecordTypeFilter } from './modules/post-bump-records-page.js';
import { buildWorkbenchProjection } from './modules/profile-activity-projector.js';
import { useFeatureModulesPolling } from './modules/shared/use-feature-module-polling.js';
import type { ActivityRecordModuleFilter } from './modules/unified-activity-records.js';
import type { ResourceEditorHandle } from './resource-table-editor.js';
import { useSoftwareUpdate } from './software-update-panel.js';
import { attentionPlans } from './task-alerts.js';
import { useTasks } from './use-tasks.js';
import {
  useInspections,
  useWorkbenchActions,
  useWorkspace,
  useWorkspaceEvents,
} from './use-workbench-actions.js';
import { WorkbenchOverlays } from './workbench-overlays.js';
import { WorkbenchTopbar } from './workbench-topbar.js';
import {
  WorkbenchErrorBoundary,
  WorkbenchSidebarPane,
  WorkbenchViewRouter,
  type LedgerFilterState,
  type ShellCtx,
  type View,
} from './workbench-view-router.js';

declare const __WORKBENCH_VERSION__: string;
declare global {
  interface Window {
    workbenchDesktop?: DesktopBridge;
  }
}

const BS_TO_BROWSER: Record<string, View['kind']> = {
  'bluestacks-active': 'home',
  'bluestacks-group-poster': 'group-poster',
  'bluestacks-group-bumper': 'group-bumper',
  'bluestacks-page-bumper': 'page-bumper',
  'bluestacks-group-inviter': 'group-inviter',
};
const BROWSER_TO_BS: Record<string, View['kind']> = {
  home: 'bluestacks-active',
  edit: 'bluestacks-active',
  'group-poster': 'bluestacks-group-poster',
  'group-bumper': 'bluestacks-group-bumper',
  'page-bumper': 'bluestacks-page-bumper',
  'group-inviter': 'bluestacks-group-inviter',
};

const pruneSelection = (
  ids: readonly string[],
  setSelected: (fn: (prev: Set<string>) => Set<string>) => void,
) => {
  const valid = new Set(ids);
  setSelected((prev) => {
    for (const id of prev)
      if (!valid.has(id)) return new Set([...prev].filter((x) => valid.has(x)));
    return prev;
  });
};

function App() {
  const [view, setView] = useState<View>({ kind: 'home' }),
    [carrier, setCarrier] = useState<'browser' | 'bluestacks'>('browser'),
    lastSheetsKindRef = useRef<SheetsModuleId>('sheets-schedule'),
    isBluestacksView = view.kind.startsWith('bluestacks-');

  const sseRefreshRef = useRef<((topics: ReadonlySet<string>) => void) | null>(null);
  const { connected: sseConnected } = useWorkspaceEvents((topics) =>
    sseRefreshRef.current?.(topics),
  );
  const { workspace, error, refresh } = useWorkspace(sseConnected);
  const inspections = useInspections(carrier !== 'bluestacks' && !isBluestacksView, sseConnected);
  const tasks = useTasks(sseConnected),
    cardColors = useCardColors(),
    mods = useFeatureModulesPolling(view.kind, sseConnected);
  const { groupBumper, groupInviter, groupPoster, bluestacks, autoScheduler, googleSheets } = mods;

  const resourceGen = useRef(0),
    [resourceSummaries, setResourceSummaries] = useState<ResourceUsageSummaryValue[] | null>(null);
  const refreshResources = useCallback(async () => {
    const gen = ++resourceGen.current;
    await api.resourceSummaries().then(
      (v) => gen === resourceGen.current && setResourceSummaries(v),
      () => gen === resourceGen.current && setResourceSummaries(null),
    );
  }, []);

  sseRefreshRef.current = (topics) => {
    for (const [topic, fn] of [
      [
        'workspace',
        () => {
          void refresh(true);
          if (view.kind === 'home' || view.kind === 'edit') void refreshResources();
        },
      ],
      ['tasks', tasks.nudge],
      ['inspections', () => void inspections.refresh(true)],
      ['group-bumper', mods.refreshBumper],
      ['group-poster', mods.refreshPoster],
      ['group-inviter', () => void mods.refreshGroupInviter()],
      ['bluestacks', () => mods.refreshBluestacks(false)],
      ['auto-scheduler', mods.refreshAutoScheduler],
      ['google-sheets', mods.refreshGoogleSheets],
      ['runtime-summary', mods.refreshRuntimeSummaryNow],
    ] as const)
      if (topics.has(topic)) fn();
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (workspace) {
      pruneSelection(
        workspace.profiles.map((p) => p.id),
        setSelected,
      );
    }
  }, [workspace]);
  const [selectedBluestacks, setSelectedBluestacks] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (bluestacks) {
      pruneSelection(
        bluestacks.instances.map((i) => i.id),
        setSelectedBluestacks,
      );
    }
  }, [bluestacks]);

  const [recordFilter, setRecordFilter] = useState<string | null>(null),
    [ledger, setLedger] = useState<LedgerFilterState>({
      type: 'all',
      status: 'all',
      subView: 'ledger',
      activeModule: 'all',
      nonce: 0,
    }),
    [detail, setDetail] = useState<{ profileId: string; planId: string; round?: number } | null>(
      null,
    ),
    [menuOpen, setMenuOpen] = useState(false),
    [diagModalOpen, setDiagModalOpen] = useState(false),
    [liveQueueOpen, setLiveQueueOpen] = useState(false),
    [deviceSidebarCollapsed, setDeviceSidebarCollapsed] = useState(() => {
      try {
        return window.localStorage.getItem('workbench.device-sidebar-collapsed.v1') === '1';
      } catch {
        return false;
      }
    }),
    [quickScheduleSeed, setQuickScheduleSeed] = useState<QuickScheduleSeed | null>(null),
    updates = useSoftwareUpdate(),
    [updateMenu, setUpdateMenu] = useState(false),
    [menuSection, setMenuSection] = useState<'update' | 'google-sheets' | 'logs' | undefined>(
      undefined,
    ),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    mutating = useRef(false),
    [aliasing, setAliasing] = useState<Profile | null>(null),
    resourceEditor = useRef<ResourceEditorHandle>(null),
    [resourceRow, setResourceRow] = useState<SavedCombination | null>(null);
  const applyUpdate = async () => {
    if (!resourceEditor.current || (await resourceEditor.current.persist())) await updates.apply();
  };

  useEffect(() => {
    if (view.kind !== 'home' && view.kind !== 'edit') return;
    void refreshResources();
    const timer = setInterval(() => void refreshResources(), sseConnected ? 25_000 : 5000);
    return () => {
      clearInterval(timer);
      resourceGen.current++;
    };
  }, [refreshResources, view.kind, sseConnected]);
  useEffect(
    () =>
      window.workbenchDesktop?.onBeforeClose(async () =>
        resourceEditor.current ? resourceEditor.current.persist() : true,
      ),
    [],
  );
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'workbench.device-sidebar-collapsed.v1',
        deviceSidebarCollapsed ? '1' : '0',
      );
    } catch {}
  }, [deviceSidebarCollapsed]);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(t);
  }, [message]);

  const navigate = useCallback(async (next: View) => {
    if (resourceEditor.current && !(await resourceEditor.current.persist())) return;
    setResourceRow(null);
    if (next.kind.startsWith('bluestacks-')) setCarrier('bluestacks');
    else if (next.kind in BROWSER_TO_BS) setCarrier('browser');
    if (next.kind.startsWith('sheets-')) lastSheetsKindRef.current = next.kind as SheetsModuleId;
    setView(next);
  }, []);

  async function handleSwitchCarrier(nextCarrier: 'browser' | 'bluestacks') {
    if (
      nextCarrier === carrier ||
      (resourceEditor.current && !(await resourceEditor.current.persist()))
    )
      return;
    setResourceRow(null);
    setCarrier(nextCarrier);
    setView((prev) => {
      if (prev.kind === 'edit') return { ...prev, carrier: nextCarrier };
      const mapped =
        nextCarrier === 'bluestacks' ? BROWSER_TO_BS[prev.kind] : BS_TO_BROWSER[prev.kind];
      return mapped ? ({ kind: mapped } as View) : prev;
    });
  }

  const mutate = useCallback(
    async (work: () => Promise<unknown>) => {
      if (mutating.current) return;
      mutating.current = true;
      setBusy(true);
      try {
        const result = await work();
        await refresh(true);
        setMessage(typeof result === 'string' ? result : '已保存');
      } catch (failure) {
        setMessage(failure instanceof Error ? failure.message : '操作失败');
      } finally {
        setBusy(false);
        mutating.current = false;
      }
    },
    [refresh],
  );

  const plans = tasks.runtime?.plans ?? [],
    attentionCount = workspace ? attentionPlans(plans, workspace.profiles).length : 0,
    onlineCount = workspace?.profiles.filter((row) => row.online).length ?? 0;
  const restartDisabled =
    plans.some((p) => ['QUEUED', 'RUNNING'].includes(p.state)) ||
    [
      groupInviter?.running,
      groupBumper?.running,
      groupBumper?.pageBumperRunning,
      groupPoster?.running,
      bluestacks?.running,
      bluestacks?.pageBumperRunning,
      bluestacks?.activeRunning,
      bluestacks?.posterRunning,
      bluestacks?.inviterRunning,
      autoScheduler?.running,
      (googleSheets?.runningScheduleCount ?? 0) > 0,
      (googleSheets?.runningRecordsCount ?? 0) > 0,
      (googleSheets?.activeProfiles?.length ?? 0) > 0,
    ].some(Boolean);

  const mergedProfiles = useMemo<Profile[]>(() => {
    const base = workspace?.profiles ?? [],
      bsList = bluestacks?.instances ?? [];
    if (!bsList.length) return base;
    const seen = new Set(base.map((p) => p.id));
    return [
      ...base,
      ...bsList
        .filter((i) => !seen.has(i.id))
        .map((i, idx) => ({
          id: i.id,
          alias: `[蓝蝶] ${bluestacksDisplayTitle(i)}`,
          browserName: `[蓝蝶] ${bluestacksDisplayTitle(i)}`,
          groupId: null,
          order: 10000 + idx,
          online: i.online,
          phase: i.online ? 'READY' : 'OFFLINE',
          synced: i.online,
          unresolved: 0,
          extensionVersion: null,
          capabilities: [],
          presentation: null,
          account: {
            state: i.accountState === 'missing-app' ? 'unknown' : i.accountState,
            id: i.accountId || null,
            name: i.accountName || null,
            avatar: i.avatarUrl,
          },
        })),
    ];
  }, [workspace?.profiles, bluestacks?.instances]);

  const projection = useMemo(
    () =>
      buildWorkbenchProjection({
        viewKind: view.kind,
        carrier,
        profiles: workspace?.profiles,
        selected,
        tasks: tasks.runtime,
        groupBumper,
        groupInviter,
        groupPoster,
        bluestacks,
        autoScheduler,
        googleSheets,
        attentionCount,
        message,
      }),
    [
      view.kind,
      carrier,
      workspace?.profiles,
      selected,
      tasks.runtime,
      groupBumper,
      groupInviter,
      groupPoster,
      bluestacks,
      autoScheduler,
      googleSheets,
      attentionCount,
      message,
    ],
  );
  const liveRunCards = useMemo(
    () =>
      buildLiveRunCards({
        profiles: workspace?.profiles ?? [],
        runtime: tasks.runtime,
        combinations: workspace?.combinations ?? [],
        autoScheduler,
        groupBumper,
        groupPoster,
        groupInviter,
        googleSheets,
        bluestacks,
      }),
    [
      workspace?.profiles,
      workspace?.combinations,
      tasks.runtime,
      autoScheduler,
      groupBumper,
      groupPoster,
      groupInviter,
      googleSheets,
      bluestacks,
    ],
  );
  const actions = useWorkbenchActions({
    mutate,
    refresh,
    tasks,
    inspections,
    projection,
    mods,
    setMessage,
    liveRunCards,
  });
  const forceRefreshWorkspace = useCallback(() => refresh(true), [refresh]);
  const openQuickSchedule = useCallback(
    (seed: QuickScheduleSeed) => {
      if (!groupBumper) mods.refreshBumper();
      if (!groupPoster) mods.refreshPoster();
      if (!groupInviter) void mods.refreshGroupInviter();
      if (!bluestacks) mods.refreshBluestacks(false);
      setQuickScheduleSeed(seed);
    },
    [groupBumper, groupPoster, groupInviter, bluestacks, mods],
  );
  const openLedgerRecords = useCallback(
    (opts: {
      type?: PostBumpRecordTypeFilter;
      status?: 'all' | PostBumpStatusValue;
      subView?: 'ledger' | 'active';
      activeModule?: ActivityRecordModuleFilter;
    }) => {
      setLedger((prev) => ({
        type: opts.type ?? 'all',
        status: opts.status ?? 'all',
        subView: opts.subView ?? 'ledger',
        activeModule: opts.activeModule ?? 'all',
        nonce: prev.nonce + 1,
      }));
      void navigate({ kind: 'records' });
    },
    [navigate],
  );

  const shell: ShellCtx | null = workspace
    ? {
        workspace,
        mergedProfiles,
        inspections,
        tasks,
        mods,
        busy,
        selected,
        setSelected,
        selectedBluestacks,
        setSelectedBluestacks,
        projection,
        actions,
        mutate,
        forceRefreshWorkspace,
        setMessage,
      }
    : null;
  const isSheetView = view.kind.startsWith('sheets-');
  const isSplitCanvasView =
    view.kind === 'group-bumper' ||
    view.kind === 'page-bumper' ||
    view.kind === 'group-inviter' ||
    view.kind === 'bluestacks-group-bumper' ||
    view.kind === 'bluestacks-page-bumper' ||
    view.kind === 'bluestacks-group-inviter';
  const workspaceLayoutCls = isSheetView
    ? 'flex h-full min-h-0 flex-col overflow-hidden p-0'
    : isSplitCanvasView
      ? 'flex h-full min-h-0 flex-col overflow-hidden px-[18px] pt-3 pb-3.5 max-[1080px]:px-3.5'
      : 'overflow-y-auto px-6 pt-3 pb-8 max-[1080px]:px-3.5 max-[850px]:pb-6';
  const showDeviceSidebar = !deviceSidebarCollapsed;
  const bsOnlineCount = (bluestacks?.instances ?? []).filter((i) => i.online).length;
  const bsTotalCount = bluestacks?.instances.length ?? 0;
  const totalProfilesCount = workspace?.profiles.length ?? 0;
  const closeMenu = () => {
    setMenuOpen(false);
    setUpdateMenu(false);
    setMenuSection(undefined);
  };

  return (
    <div className="app flex h-screen min-h-[480px] w-full flex-col overflow-x-hidden bg-[var(--bg)]">
      <WorkbenchTopbar
        version={__WORKBENCH_VERSION__}
        breadcrumbText={projection.breadcrumbText}
        busy={busy}
        error={error}
        carrier={carrier}
        onlineCount={onlineCount}
        totalProfilesCount={workspace?.profiles.length ?? 0}
        bluestacksOnlineCount={(bluestacks?.instances ?? []).filter((i) => i.online).length}
        bluestacksTotalCount={bluestacks?.instances.length ?? 0}
        onSwitchCarrier={(next) => void handleSwitchCarrier(next)}
        runningCount={liveRunCards.length}
        onOpenWindowLayout={() => void navigate({ kind: 'window-layout' })}
        onOpenLiveRuns={() => setLiveQueueOpen(true)}
        updateStatus={updates.status}
        updateError={updates.error}
        schedulerSettings={autoScheduler?.settings ?? null}
        onSaveGlobalConcurrency={actions.handleSaveGlobalConcurrency}
        onOpenMenu={() => workspace && setMenuOpen(true)}
        onOpenUpdateMenu={() => {
          if (!workspace) return;
          setUpdateMenu(true);
          setMenuOpen(true);
        }}
        onApplyUpdate={applyUpdate}
      />
      {!shell ? (
        <main className="mx-auto my-20 grid justify-items-center gap-3 px-4 text-center">
          <h2 className="text-base font-semibold text-slate-900">
            {error ? '控制服务连接失败' : '正在连接本机控制服务…'}
          </h2>
          {error && <p className="max-w-md text-xs text-[var(--text-3)]">{error}</p>}
          <button
            type="button"
            className="btn btn-primary inline-flex h-8 items-center justify-center rounded-md border border-[var(--brand)] bg-[var(--brand)] px-4 text-[13px] font-semibold text-white hover:bg-[var(--brand-hover)]"
            onClick={() => void refresh(true)}
          >
            重新连接
          </button>
        </main>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden max-[600px]:flex-col">
          <FeatureNavRail
            activeModule={projection.activeModule}
            carrier={carrier}
            items={projection.navItems}
            onSelectModule={(mod) =>
              void navigate(
                mod === 'active-accounts'
                  ? { kind: 'home' }
                  : mod.startsWith('sheets-')
                    ? { kind: lastSheetsKindRef.current }
                    : { kind: mod },
              )
            }
          />
          {showDeviceSidebar ? (
            <WorkbenchSidebarPane
              shell={shell}
              carrier={carrier}
              viewKind={view.kind}
              onRename={setAliasing}
              onInspect={() => setLiveQueueOpen(true)}
              onHideSidebar={() => setDeviceSidebarCollapsed(true)}
            />
          ) : (
            <div
              className="flex w-9 shrink-0 flex-col items-center gap-2 border-r border-[var(--line)] bg-[var(--sidebar-bg)] pt-2 select-none"
              aria-label="设备栏已折叠"
            >
              <button
                type="button"
                aria-label="展开设备栏"
                title="展开左侧浏览器 / 蓝蝶设备栏"
                className="inline-grid h-7 w-7 place-content-center rounded-md border border-[var(--line)] bg-white text-[var(--text-2)] shadow-2xs transition-colors hover:border-[var(--brand)] hover:bg-[var(--brand-soft)] hover:text-[var(--brand)]"
                onClick={() => setDeviceSidebarCollapsed(false)}
              >
                <IconPanelOpen size={15} />
              </button>
              <button
                type="button"
                title="点击展开左侧设备栏"
                className="flex flex-1 cursor-pointer flex-col items-center justify-start rounded-md border-0 bg-transparent px-1 py-2 text-[11px] font-medium text-[var(--text-3)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text)] [writing-mode:vertical-rl]"
                onClick={() => setDeviceSidebarCollapsed(false)}
              >
                {carrier === 'bluestacks'
                  ? `蓝蝶 ${bsOnlineCount}/${bsTotalCount}`
                  : `浏览器 ${onlineCount}/${totalProfilesCount}`}
              </button>
            </div>
          )}
          <main
            className={`workspace min-w-0 flex-1 bg-[var(--bg)] ${workspaceLayoutCls} view-${view.kind}`}
          >
            {error && (
              <div
                className="mt-3 mb-2 flex items-center gap-2.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700"
                role="alert"
              >
                <span className="flex-1">{error}</span>
                <button
                  type="button"
                  className="btn btn-sm inline-flex h-7 items-center rounded-md border border-rose-200 bg-white px-2.5 text-xs font-medium text-rose-700 hover:bg-rose-100"
                  onClick={() => void refresh(true)}
                >
                  重新连接
                </button>
              </div>
            )}
            {tasks.error && (
              <p
                className="mt-3 mb-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 text-xs text-rose-700"
                role="alert"
              >
                {tasks.error}
              </p>
            )}
            <WorkbenchViewRouter
              shell={shell}
              router={{
                view,
                setView,
                carrier,
                cardColors,
                resourceSummaries,
                setResourceSummaries,
                onOpenResources: setResourceRow,
                refreshResources,
                openQuickSchedule,
                onOpenLiveRuns: () => setLiveQueueOpen(true),
                openLedgerRecords,
                ledger,
                recordFilter,
                setRecordFilter,
                onOpenDetail: (profileId, planId, round) => setDetail({ profileId, planId, round }),
                onOpenMenuSection: (section) => {
                  setMenuSection(section);
                  setMenuOpen(true);
                },
                navigate,
              }}
            />
          </main>
        </div>
      )}
      <WorkbenchOverlays
        shell={shell}
        message={message}
        detail={detail}
        onCloseDetail={() => setDetail(null)}
        plans={plans}
        onRename={setAliasing}
        onOpenResource={setResourceRow}
        menuOpen={menuOpen}
        updateMenu={updateMenu}
        menuSection={menuSection}
        onCloseMenu={closeMenu}
        updates={updates}
        onApplyUpdate={applyUpdate}
        restartDisabled={restartDisabled}
        resourceRow={resourceRow}
        resourceEditorRef={resourceEditor}
        onSavedResource={refreshResources}
        aliasing={aliasing}
        onCloseAliasing={() => setAliasing(null)}
        diagModalOpen={diagModalOpen}
        onOpenDiagModal={() => setDiagModalOpen(true)}
        onCloseDiagModal={() => setDiagModalOpen(false)}
        onOpenWindowLayout={() => {
          closeMenu();
          void navigate({ kind: 'window-layout' });
        }}
        quickScheduleSeed={quickScheduleSeed}
        onCloseQuickSchedule={() => setQuickScheduleSeed(null)}
        liveQueueOpen={liveQueueOpen}
        onCloseLiveQueue={() => setLiveQueueOpen(false)}
        liveRunCards={liveRunCards}
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw Error('ROOT_ELEMENT_MISSING');
createRoot(root).render(
  <WorkbenchErrorBoundary label="工作台界面运行异常">
    <App />
  </WorkbenchErrorBoundary>,
);
