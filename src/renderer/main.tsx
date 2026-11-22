import './style.css';
import './design-system.css';
import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { bluestacksDisplayTitle } from '../shared/bluestacks.js';
import type { Profile, SavedCombination } from '../shared/contracts.js';
import type { DesktopBridge } from '../shared/desktop.js';
import type { ResourceUsageSummaryValue } from '../shared/resource-table.js';
import type { TaskCommand } from '../shared/task-contracts.js';
import { ActiveAccountsPage } from './active-accounts-page.js';
import { api } from './api.js';
import { useCardColors } from './card-colors.js';
import type { EditorHandle } from './editor.js';
import { FeatureNavRail } from './feature-nav-rail.js';
import { buildWorkbenchProjection } from './modules/profile-activity-projector.js';
import { useFeatureModulesPolling } from './modules/shared/use-feature-module-polling.js';
import type { ResourceEditorHandle } from './resource-table-editor.js';
import { SidebarResizer } from './sidebar-resizer.js';
import { Sidebar } from './sidebar.js';
import { useSoftwareUpdate } from './software-update-panel.js';
import { attentionPlans } from './task-alerts.js';
import { useInspections } from './use-inspections.js';
import { useTasks } from './use-tasks.js';
import { useWorkspace } from './use-workspace.js';
import { WorkbenchOverlays } from './workbench-overlays.js';
import { WorkbenchTopbar } from './workbench-topbar.js';

const AutoSchedulerPage = lazy(() =>
  import('./auto-scheduler-page.js').then((m) => ({ default: m.AutoSchedulerPage })),
);
const Editor = lazy(() => import('./editor.js').then((m) => ({ default: m.Editor })));
const GroupBumperPage = lazy(() =>
  import('./group-bumper-page.js').then((m) => ({ default: m.GroupBumperPage })),
);
const GroupInviterPage = lazy(() =>
  import('./group-inviter-page.js').then((m) => ({ default: m.GroupInviterPage })),
);
const GroupPosterPage = lazy(() =>
  import('./group-poster-page.js').then((m) => ({ default: m.GroupPosterPage })),
);
const GoogleSheetsPage = lazy(() =>
  import('./modules/sheets/google-sheets-page.js').then((m) => ({ default: m.GoogleSheetsPage })),
);
const BluestacksSidebar = lazy(() =>
  import('./modules/bluestacks-sidebar.js').then((m) => ({ default: m.BluestacksSidebar })),
);
const BluestacksActivePage = lazy(() =>
  import('./modules/bluestacks-active-page.js').then((m) => ({ default: m.BluestacksActivePage })),
);
const BluestacksPosterPage = lazy(() =>
  import('./modules/bluestacks-poster-page.js').then((m) => ({ default: m.BluestacksPosterPage })),
);
const BluestacksInviterPage = lazy(() =>
  import('./modules/bluestacks-inviter-page.js').then((m) => ({
    default: m.BluestacksInviterPage,
  })),
);
const TaskRecordsPage = lazy(() =>
  import('./task-records.js').then((m) => ({ default: m.TaskRecordsPage })),
);
declare const __WORKBENCH_VERSION__: string;
declare global {
  interface Window {
    workbenchDesktop?: DesktopBridge;
  }
}

class WorkbenchErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; label?: string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidUpdate(prevProps: { resetKey?: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="empty" role="alert" style={{ padding: 24, gap: 10 }}>
          <strong>{this.props.label || '页面加载出现异常'}</strong>
          <p className="muted" style={{ maxWidth: 480, wordBreak: 'break-word' }}>
            {this.state.error.message || '请尝试重新加载页面'}
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => this.setState({ error: null })}
            >
              重试渲染
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => window.location.reload()}
            >
              重新加载页面
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
type View =
  | { kind: 'home' }
  | { kind: 'edit'; row: SavedCombination }
  | { kind: 'auto-scheduler' }
  | { kind: 'records' }
  | { kind: 'group-inviter' }
  | { kind: 'group-bumper' }
  | { kind: 'page-bumper' }
  | { kind: 'group-poster' }
  | { kind: 'sheets-groups' }
  | { kind: 'sheets-pages' }
  | { kind: 'sheets-schedule' }
  | { kind: 'sheets-records' }
  | { kind: 'bluestacks-active' }
  | { kind: 'bluestacks-group-poster' }
  | { kind: 'bluestacks-group-bumper' }
  | { kind: 'bluestacks-page-bumper' }
  | { kind: 'bluestacks-group-inviter' };
type DetailTarget = { profileId: string; planId: string; round?: number };
function App() {
  const { workspace, error, refresh } = useWorkspace();
  const inspections = useInspections();
  const tasks = useTasks();
  const cardColors = useCardColors();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedBluestacks, setSelectedBluestacks] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>({ kind: 'home' });
  const [recordFilter, setRecordFilter] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailTarget | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [diagModalOpen, setDiagModalOpen] = useState(false);
  const updates = useSoftwareUpdate();
  const [updateMenu, setUpdateMenu] = useState(false);
  const [menuSection, setMenuSection] = useState<'update' | 'google-sheets' | 'logs' | undefined>(
    undefined,
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const [aliasing, setAliasing] = useState<Profile | null>(null);
  const editor = useRef<EditorHandle>(null);
  const resourceEditor = useRef<ResourceEditorHandle>(null);
  const [resourceRow, setResourceRow] = useState<SavedCombination | null>(null);
  const [resourceSummaries, setResourceSummaries] = useState<ResourceUsageSummaryValue[] | null>(
    null,
  );
  const mods = useFeatureModulesPolling(view.kind);
  const {
    groupBumper,
    setGroupBumper,
    groupInviter,
    setGroupInviter,
    groupPoster,
    setGroupPoster,
    bluestacks,
    setBluestacks,
    autoScheduler,
    setAutoScheduler,
    googleSheets,
    setGoogleSheets,
    refreshGoogleSheets,
  } = mods;
  const resourceGeneration = useRef(0);
  async function applyUpdate() {
    if (resourceEditor.current && !(await resourceEditor.current.persist())) return;
    if (editor.current && !(await editor.current.persist())) return;
    await updates.apply();
  }
  const refreshResources = useCallback(async () => {
    const generation = ++resourceGeneration.current;
    await api
      .resourceSummaries()
      .then((v) => generation === resourceGeneration.current && setResourceSummaries(v))
      .catch(() => generation === resourceGeneration.current && setResourceSummaries(null));
  }, []);
  useEffect(() => {
    if (view.kind !== 'home' && view.kind !== 'edit') return;
    void refreshResources();
    const timer = setInterval(() => void refreshResources(), 5000);
    return () => {
      clearInterval(timer);
      resourceGeneration.current++;
    };
  }, [refreshResources, view.kind]);
  useEffect(
    () =>
      window.workbenchDesktop?.onBeforeClose(async () => {
        if (resourceEditor.current && !(await resourceEditor.current.persist())) return false;
        return editor.current ? editor.current.persist() : true;
      }),
    [],
  );
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  async function navigate(next: View) {
    if (resourceEditor.current && !(await resourceEditor.current.persist())) return;
    if (view.kind === 'edit' && editor.current && !(await editor.current.persist())) return;
    setResourceRow(null);
    setView(next);
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
  function checkProfiles(ids: string[]) {
    void mutate(async () => {
      const rows = await inspections.request(ids);
      const queued = rows.filter((row) => ['QUEUED', 'READING'].includes(row.state)).length;
      if (queued > 0) {
        setTimeout(() => {
          void inspections.refresh(true);
          void refresh(true);
        }, 1800);
        setTimeout(() => {
          void inspections.refresh(true);
          void refresh(true);
        }, 4200);
        return `已触发识别 ${queued} 个在线浏览器的 FB 账号与头像（自动读取已打开的 Facebook 页面）`;
      }
      return '暂无可识别的空闲在线浏览器（请确认浏览器已打开 Facebook 且未在执行任务）';
    });
  }
  function commandPlans(command: TaskCommand['command'], plans: TaskCommand['plans']) {
    void mutate(async () => {
      const { results } = await tasks.command({ command, plans });
      const accepted = results.filter((row) => row.accepted);
      const failed = results.filter((row) => !row.accepted);
      const labels = { pause: '暂停', resume: '继续', stop: '停止' };
      const reasons = [...new Set(failed.map((row) => row.reason))];
      return (
        `${labels[command]}请求已处理 ${accepted.length} 份；${failed.length} 份未完成` +
        (reasons.length ? `（${reasons.join('、')}）` : '') +
        (command === 'resume' ? '。原任务按并发设置重新排队。' : '。实际状态见任务记录。')
      );
    });
  }
  const plans = tasks.runtime?.plans ?? [];
  const attentionCount = workspace ? attentionPlans(plans, workspace.profiles).length : 0;
  const onlineCount = workspace?.profiles.filter((row) => row.online).length ?? 0;
  const restartDisabled =
    plans.some((plan) => ['QUEUED', 'RUNNING', 'PAUSING', 'STOPPING'].includes(plan.state)) ||
    Boolean(
      groupInviter?.running ||
      groupBumper?.running ||
      groupBumper?.pageBumperRunning ||
      groupPoster?.running ||
      bluestacks?.running ||
      bluestacks?.pageBumperRunning ||
      bluestacks?.activeRunning ||
      bluestacks?.posterRunning ||
      bluestacks?.inviterRunning ||
      autoScheduler?.running ||
      (googleSheets?.runningScheduleCount ?? 0) > 0 ||
      (googleSheets?.runningRecordsCount ?? 0) > 0 ||
      (googleSheets?.activeProfiles?.length ?? 0) > 0,
    );
  const mergedProfiles = useMemo<Profile[]>(() => {
    const base = workspace?.profiles ?? [];
    const bsList = bluestacks?.instances ?? [];
    if (!bsList.length) return base;
    const seen = new Set(base.map((p) => p.id));
    const extras: Profile[] = bsList
      .filter((inst) => !seen.has(inst.id))
      .map((inst, idx) => ({
        id: inst.id,
        alias: `[蓝蝶] ${bluestacksDisplayTitle(inst)}`,
        browserName: `[蓝蝶] ${bluestacksDisplayTitle(inst)}`,
        groupId: null,
        order: 10000 + idx,
        online: inst.online,
        phase: inst.online ? 'READY' : 'OFFLINE',
        synced: inst.online,
        unresolved: 0,
        extensionVersion: null,
        capabilities: [],
        presentation: null,
        account: {
          state: inst.accountState === 'missing-app' ? 'unknown' : inst.accountState,
          id: inst.accountId || null,
          name: inst.accountName || null,
          avatar: inst.avatarUrl,
        },
      }));
    return [...base, ...extras];
  }, [workspace?.profiles, bluestacks?.instances]);
  const projection = useMemo(
    () =>
      buildWorkbenchProjection({
        viewKind: view.kind,
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
  const stopModuleProfilesInternal = useCallback(
    async (ids: string[]) => {
      const uniqueIds = [...new Set(ids)];
      const jobs: Array<{ label: string; run: () => Promise<void> }> = [];
      const sIds = uniqueIds.filter((id) => projection.schedulerRunningIds.includes(id));
      if (sIds.length) {
        jobs.push({
          label: '定时排班',
          run: async () => {
            setAutoScheduler(
              await api.autoSchedulerAction('stop', {
                targetIds: sIds,
                keepWindowsOpen: true,
              }),
            );
          },
        });
      }
      const bIds = uniqueIds.filter((id) => projection.bumperRunningIds.includes(id));
      if (bIds.length) {
        jobs.push({
          label: '顶贴',
          run: async () => {
            setGroupBumper(await api.bumperAction('stop', { profileIds: bIds }));
          },
        });
      }
      const pIds = uniqueIds.filter((id) => projection.posterRunningIds.includes(id));
      if (pIds.length) {
        jobs.push({
          label: '小组发帖',
          run: async () => {
            setGroupPoster(await api.posterAction('stop', { profileIds: pIds }));
          },
        });
      }
      const inviteIds = uniqueIds.filter((id) => projection.inviterRunningIds.includes(id));
      if (inviteIds.length) {
        jobs.push({
          label: '小组邀请人',
          run: async () => {
            setGroupInviter(await api.stopGroupInviterProfiles({ profileIds: inviteIds }));
          },
        });
      }
      const sheetIds = uniqueIds.filter((id) => projection.sheetsRunningIds.includes(id));
      if (sheetIds.length) {
        jobs.push({
          label: '云表任务',
          run: async () => {
            setGoogleSheets(await api.googleSheetsStopProfiles(sheetIds));
          },
        });
      }
      const settled = await Promise.allSettled(jobs.map((j) => j.run()));
      const failures: string[] = [];
      settled.forEach((res, idx) => {
        if (res.status === 'rejected') {
          const msg = res.reason instanceof Error ? res.reason.message : '失败';
          failures.push(`${jobs[idx]?.label ?? '模块'}：${msg}`);
        }
      });
      return { uniqueCount: uniqueIds.length, failures };
    },
    [
      projection.schedulerRunningIds,
      projection.bumperRunningIds,
      projection.posterRunningIds,
      projection.inviterRunningIds,
      projection.sheetsRunningIds,
      setAutoScheduler,
      setGroupBumper,
      setGroupPoster,
      setGroupInviter,
      setGoogleSheets,
    ],
  );
  const stopProfilesUnified = useCallback(
    (planTargets: TaskCommand['plans'], moduleProfileIds: string[]) => {
      void mutate(async () => {
        const parts: string[] = [];
        const failures: string[] = [];
        const ops: Array<Promise<void>> = [];
        if (planTargets.length) {
          ops.push(
            tasks
              .command({ command: 'stop', plans: planTargets })
              .then(({ results }) => {
                const accepted = results.filter((row) => row.accepted);
                const failed = results.filter((row) => !row.accepted);
                const reasons = [...new Set(failed.map((row) => row.reason))];
                parts.push(
                  `活跃任务已处理 ${accepted.length} 份` +
                    (failed.length ? `（${failed.length} 份未完成：${reasons.join('、')}）` : ''),
                );
              })
              .catch((err) => {
                failures.push(`活跃任务：${err instanceof Error ? err.message : '失败'}`);
              }),
          );
        }
        if (moduleProfileIds.length) {
          ops.push(
            stopModuleProfilesInternal(moduleProfileIds).then((res) => {
              if (res.uniqueCount > 0) parts.push(`模块任务 ${res.uniqueCount} 个浏览器`);
              failures.push(...res.failures);
            }),
          );
        }
        await Promise.all(ops);
        const summary = parts.length ? `已发送停止指令（${parts.join('；')}）` : '无需要停止的任务';
        return failures.length ? `${summary}；部分失败：${failures.join('；')}` : summary;
      });
    },
    [mutate, tasks, stopModuleProfilesInternal],
  );
  const handlePosterState = useCallback(
    (next: Parameters<typeof setGroupPoster>[0]) => {
      setGroupPoster(next);
      void mods.refreshGroupInviter();
    },
    [setGroupPoster, mods.refreshGroupInviter],
  );
  const forceRefreshWorkspace = useCallback(() => refresh(true), [refresh]);
  return (
    <div className="app">
      <WorkbenchTopbar
        version={__WORKBENCH_VERSION__}
        breadcrumbText={projection.breadcrumbText}
        busy={busy}
        error={error}
        onlineCount={onlineCount}
        totalProfilesCount={workspace?.profiles.length ?? 0}
        updateStatus={updates.status}
        updateError={updates.error}
        schedulerSettings={autoScheduler?.settings ?? null}
        onSaveGlobalConcurrency={async (patch) => {
          try {
            let base = autoScheduler?.settings;
            if (!base) {
              const latest = await api.autoSchedulerState().catch(() => null);
              if (latest) {
                setAutoScheduler(latest);
                base = latest.settings;
              }
            }
            if (!base) {
              setMessage('全局并发设置尚未加载完成，请稍后再试');
              return false;
            }
            const next = await api.autoSchedulerAction('settings', { ...base, ...patch });
            setAutoScheduler(next);
            tasks.refresh();
            mods.refreshBumper();
            mods.refreshPoster();
            void mods.refreshGroupInviter();
            mods.refreshBluestacks(false);
            setMessage(
              `已更新全局并发：浏览器 ${next.settings.browserConcurrency} 窗 · 蓝蝶 ${next.settings.bluestacksConcurrency} 窗`,
            );
            return true;
          } catch (err) {
            setMessage(err instanceof Error ? err.message : '保存全局并发失败');
            return false;
          }
        }}
        onOpenDiagnosticModal={() => setDiagModalOpen(true)}
        onOpenMenu={() => setMenuOpen(true)}
        onOpenUpdateMenu={() => {
          setUpdateMenu(true);
          setMenuOpen(true);
        }}
        onApplyUpdate={applyUpdate}
        onNotify={setMessage}
      />
      {!workspace ? (
        <main className="loading">
          <h2>{error ? '控制服务连接失败' : '正在连接本机控制服务…'}</h2>
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => void refresh(true)}>
            重新连接
          </button>
        </main>
      ) : (
        <div className="app-body">
          <FeatureNavRail
            activeModule={projection.activeModule}
            items={projection.navItems}
            onSelectModule={(mod) =>
              void navigate({ kind: mod === 'active-accounts' ? 'home' : mod })
            }
          />
          {view.kind === 'bluestacks-active' ||
          view.kind === 'bluestacks-group-poster' ||
          view.kind === 'bluestacks-group-bumper' ||
          view.kind === 'bluestacks-page-bumper' ||
          view.kind === 'bluestacks-group-inviter' ? (
            <Suspense fallback={<aside className="sidebar" aria-busy="true" />}>
              <BluestacksSidebar
                mode={view.kind}
                state={bluestacks}
                onChange={setBluestacks}
                selected={selectedBluestacks}
                onSelect={setSelectedBluestacks}
                onError={setMessage}
              />
            </Suspense>
          ) : (
            <Sidebar
              tasks={tasks.runtime}
              onTaskCommand={commandPlans}
              workspace={workspace}
              selected={selected}
              onSelect={setSelected}
              nameAction={view.kind === 'records' ? 'filter' : 'select'}
              filteredId={view.kind === 'records' ? recordFilter : null}
              onInspect={(id) => setRecordFilter((current) => (current === id ? null : id))}
              mutate={mutate}
              inspections={inspections.rows}
              inspectionAvailable={inspections.available}
              inspectionError={inspections.error}
              busy={busy}
              onCheck={checkProfiles}
              onRename={setAliasing}
              onShow={(id) =>
                void mutate(() => api.showBrowser(id).then(() => '已显示对应浏览器页面'))
              }
              activities={projection.projectedActivities}
              selectionControls={projection.projectedControls}
              bumperCounts={
                view.kind === 'group-bumper'
                  ? groupBumper?.profileCounts
                  : view.kind === 'page-bumper'
                    ? (groupBumper?.pageBumperProfileCounts ?? {})
                    : undefined
              }
              bumperRunningIds={projection.bumperRunningIds}
              groupInviterCounts={
                view.kind === 'group-inviter' ? (groupInviter?.profileCounts ?? {}) : null
              }
              groupInviterRunningIds={projection.inviterRunningIds}
              onStopModules={(ids) => stopProfilesUnified([], ids)}
              onStopProfiles={stopProfilesUnified}
              onRefreshWorkspace={forceRefreshWorkspace}
              onNotify={setMessage}
            />
          )}
          <SidebarResizer />
          <main className={'workspace view-' + view.kind}>
            {error && (
              <div className="error-note" role="alert">
                {error}
                <button className="btn btn-sm" onClick={() => void refresh(true)}>
                  重新连接
                </button>
              </div>
            )}
            {tasks.error && (
              <p className="error-note" role="alert">
                {tasks.error}
              </p>
            )}
            {view.kind === 'home' && (
              <ActiveAccountsPage
                workspace={workspace}
                selected={selected}
                tasks={tasks}
                cardColors={cardColors}
                busy={busy}
                resourceSummaries={resourceSummaries}
                selectionControls={projection.projectedControls}
                onSetResourceSummaries={setResourceSummaries}
                onOpenResources={setResourceRow}
                onEditCombination={(row) => setView({ kind: 'edit', row })}
                onRefreshWorkspace={forceRefreshWorkspace}
                onRefreshResources={refreshResources}
                onMutate={mutate}
                onNotify={setMessage}
              />
            )}
            <WorkbenchErrorBoundary resetKey={view.kind} label="当前功能页面加载异常">
              <Suspense
                fallback={
                  <div className="empty" role="status">
                    <strong>正在加载页面…</strong>
                  </div>
                }
              >
                {view.kind === 'auto-scheduler' && (
                  <AutoSchedulerPage
                    state={autoScheduler}
                    onState={setAutoScheduler}
                    profiles={workspace.profiles}
                    profileGroups={workspace.groups}
                    selectedProfileIds={selected}
                    combinations={workspace.combinations}
                    bumperState={groupBumper}
                    posterState={groupPoster}
                    bluestacksState={bluestacks}
                    onMessage={setMessage}
                  />
                )}
                {view.kind === 'records' && (
                  <TaskRecordsPage
                    runtime={tasks.runtime}
                    profiles={mergedProfiles}
                    inspections={inspections.rows}
                    loaded={!!tasks.runtime}
                    filterId={recordFilter}
                    onClearFilter={() => setRecordFilter(null)}
                    onOpen={(profileId, planId, round) => setDetail({ profileId, planId, round })}
                    groupInviterState={groupInviter}
                    groupBumperState={groupBumper}
                    onGroupBumperState={setGroupBumper}
                    groupPosterState={groupPoster}
                    googleSheetsOverview={googleSheets}
                    onOpenCleanupSettings={() => {
                      setMenuSection('logs');
                      setMenuOpen(true);
                    }}
                    onNotify={setMessage}
                  />
                )}
                {view.kind === 'bluestacks-active' && (
                  <BluestacksActivePage
                    bluestacksState={bluestacks}
                    onBluestacksState={setBluestacks}
                    selected={selectedBluestacks}
                    combinations={workspace.combinations}
                    onMessage={setMessage}
                  />
                )}
                {view.kind === 'bluestacks-group-poster' && (
                  <BluestacksPosterPage
                    bluestacksState={bluestacks}
                    onBluestacksState={setBluestacks}
                    selected={selectedBluestacks}
                    materials={groupPoster?.materials ?? []}
                    groups={groupPoster?.groups ?? groupBumper?.groups ?? []}
                    groupAvatarRefreshing={
                      groupPoster?.groupAvatarRefreshing || groupInviter?.groupAvatarRefreshing
                    }
                    onSyncSharedGroups={async () => {
                      await Promise.allSettled([
                        api.bumperState().then(setGroupBumper),
                        api.posterState().then(setGroupPoster),
                        api.groupInviterState().then(setGroupInviter),
                      ]);
                    }}
                    onMessage={setMessage}
                  />
                )}
                {view.kind === 'bluestacks-group-inviter' && (
                  <BluestacksInviterPage
                    bluestacksState={bluestacks}
                    onBluestacksState={setBluestacks}
                    selected={selectedBluestacks}
                    groups={groupBumper?.groups ?? []}
                    inviterState={groupInviter}
                    onSyncSharedGroups={async () => {
                      await Promise.allSettled([
                        api.bumperState().then(setGroupBumper),
                        api.posterState().then(setGroupPoster),
                        api.groupInviterState().then(setGroupInviter),
                      ]);
                    }}
                    onMessage={setMessage}
                  />
                )}
                {(view.kind === 'group-bumper' ||
                  view.kind === 'page-bumper' ||
                  view.kind === 'bluestacks-group-bumper' ||
                  view.kind === 'bluestacks-page-bumper') && (
                  <GroupBumperPage
                    key={view.kind}
                    mode={view.kind}
                    state={groupBumper}
                    selected={
                      view.kind === 'bluestacks-group-bumper' ||
                      view.kind === 'bluestacks-page-bumper'
                        ? selectedBluestacks
                        : selected
                    }
                    profiles={mergedProfiles}
                    bluestacksState={bluestacks}
                    onBluestacksState={setBluestacks}
                    onState={(next) => {
                      setGroupBumper(next);
                      void mods.refreshGroupInviter();
                      mods.refreshPoster();
                    }}
                    onMessage={setMessage}
                  />
                )}
                {view.kind === 'group-poster' && (
                  <GroupPosterPage
                    state={groupPoster}
                    selected={selected}
                    profiles={workspace.profiles}
                    profileGroups={workspace.groups}
                    onState={handlePosterState}
                    onMessage={setMessage}
                  />
                )}
                {(view.kind === 'sheets-groups' ||
                  view.kind === 'sheets-pages' ||
                  view.kind === 'sheets-schedule' ||
                  view.kind === 'sheets-records') && (
                  <GoogleSheetsPage
                    key={view.kind}
                    kind={
                      view.kind === 'sheets-groups'
                        ? 'group_library'
                        : view.kind === 'sheets-pages'
                          ? 'page_library'
                          : view.kind === 'sheets-schedule'
                            ? 'post_schedule'
                            : 'post_records'
                    }
                    overview={googleSheets}
                    onOverview={setGoogleSheets}
                    profileGroups={workspace.groups}
                    profiles={workspace.profiles}
                    bluestacksState={bluestacks}
                    onOpenAuthMenu={() => {
                      setMenuSection('google-sheets');
                      setMenuOpen(true);
                    }}
                    onAfterLibrarySync={() => {
                      mods.refreshBumper();
                      mods.refreshPoster();
                      void mods.refreshGroupInviter();
                    }}
                    onNotify={setMessage}
                  />
                )}
                {view.kind === 'group-inviter' && (
                  <GroupInviterPage
                    state={groupInviter}
                    onRefresh={async () => setGroupInviter(await api.groupInviterState())}
                    loaded={mods.groupInviterLoaded}
                    selectedProfileIds={selected}
                    busy={busy}
                    onAddGroups={async (items) => {
                      setGroupInviter(await api.addInviterGroups({ items }));
                      void api.bumperState().then(setGroupBumper, () => {});
                      void api.posterState().then(setGroupPoster, () => {});
                      setMessage(`已保存 ${items.length} 个小组，正在后台获取小组头像`);
                    }}
                    onDeleteGroups={(groupIds) =>
                      mutate(async () => {
                        setGroupInviter(await api.deleteInviterGroups({ groupIds }));
                        void api.bumperState().then(setGroupBumper, () => {});
                        void api.posterState().then(setGroupPoster, () => {});
                        return `已删除 ${groupIds.length} 个小组`;
                      })
                    }
                    onSaveInvitesPerGroup={async (invitesPerGroup) =>
                      setGroupInviter(await api.saveGroupInviterSettings({ invitesPerGroup }))
                    }
                    onStart={(groupIds, invitesPerGroup) =>
                      mutate(async () => {
                        const targetIds = (
                          groupInviter?.running
                            ? [...selected].filter((id) => !groupInviter.profileCounts[id]?.running)
                            : [...selected]
                        ).sort();
                        const next = await api.startGroupInviter({
                          profileIds: targetIds,
                          groupIds,
                          invitesPerGroup,
                        });
                        setGroupInviter(next);
                        const skipped = targetIds.filter((id) =>
                          next.profileCounts[id]?.status?.startsWith('跳过'),
                        ).length;
                        return `已启动小组邀请人：${Math.max(0, targetIds.length - skipped)} 个账号 × ${groupIds.length} 个小组${skipped > 0 ? `（已自动跳过 ${skipped} 个不可用或运行中账号）` : ''}`;
                      })
                    }
                    onStop={() =>
                      mutate(async () => {
                        setGroupInviter(await api.stopGroupInviter());
                        return '已发送停止小组邀请人指令';
                      })
                    }
                    onMessage={setMessage}
                  />
                )}
                {view.kind === 'edit' && (
                  <Editor
                    ref={editor}
                    key={view.row.id}
                    initial={view.row}
                    selectedProfiles={workspace.profiles.filter((profile) =>
                      selected.has(profile.id),
                    )}
                    onResources={() => setResourceRow(view.row)}
                    resourceUsage={
                      resourceSummaries?.find((item) => item.combinationId === view.row.id) ?? null
                    }
                    resourceUsageLoaded={resourceSummaries !== null}
                    onSaved={forceRefreshWorkspace}
                    onClose={() => void navigate({ kind: 'home' })}
                    notify={setMessage}
                  />
                )}
              </Suspense>
            </WorkbenchErrorBoundary>
          </main>
        </div>
      )}
      <WorkbenchOverlays
        workspace={workspace}
        message={message}
        onMessage={setMessage}
        detail={detail}
        onCloseDetail={() => setDetail(null)}
        plans={plans}
        inspections={inspections}
        busy={busy}
        onCommand={commandPlans}
        onRename={setAliasing}
        onCheck={checkProfiles}
        onOpenResource={setResourceRow}
        menuOpen={menuOpen}
        updateMenu={updateMenu}
        menuSection={menuSection}
        onGoogleSheetsChanged={refreshGoogleSheets}
        onCloseMenu={() => {
          setMenuOpen(false);
          setUpdateMenu(false);
          setMenuSection(undefined);
        }}
        updates={updates}
        onApplyUpdate={applyUpdate}
        selected={selected}
        runtime={tasks.runtime}
        restartDisabled={restartDisabled}
        onRefreshTasks={tasks.refresh}
        mutate={mutate}
        resourceRow={resourceRow}
        resourceEditorRef={resourceEditor}
        onSavedResource={refreshResources}
        aliasing={aliasing}
        onCloseAliasing={() => setAliasing(null)}
        onRefreshWorkspace={forceRefreshWorkspace}
        diagModalOpen={diagModalOpen}
        diagUiContext={projection.diagUiContext}
        onCloseDiagModal={() => setDiagModalOpen(false)}
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
